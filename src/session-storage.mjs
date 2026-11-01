import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, unlink, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const locks = new Map();
async function serialized(file, action) {
  const previous = locks.get(file) || Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  locks.set(file, result);
  try { return await result; }
  finally { if (locks.get(file) === result) locks.delete(file); }
}
const marker = 'bird-whatsapp-session';
export async function sessionKeyringFromEnv(env = process.env) {
  if (!env.BIRD_SESSION_KEY_FILE) {
    if (env.BIRD_SESSION_ENCRYPTION_REQUIRED === 'true') throw new Error('Session encryption key is required');
    return null;
  }
  const config = JSON.parse(await readFile(env.BIRD_SESSION_KEY_FILE, 'utf8'));
  const keys = new Map();
  for (const [id, encoded] of Object.entries(config.keys || {})) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof encoded !== 'string') throw new Error('Invalid session keyring');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Invalid session key');
    keys.set(id, key);
  }
  if (!keys.has(config.active)) throw new Error('Active session key unavailable');
  return { active: config.active, keys };
}
function aad(instance, file, keyId) { return Buffer.from(JSON.stringify([marker, 1, instance, file, keyId])); }
export function sealSession(text, keyring, instance, file) {
  if (!keyring) return text;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyring.keys.get(keyring.active), nonce);
  cipher.setAAD(aad(instance, file, keyring.active));
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return JSON.stringify({ format: marker, version: 1, key: keyring.active, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
export function openSession(text, keyring, instance, file, allowLegacy = false) {
  const envelope = JSON.parse(text);
  if (envelope?.format !== marker) {
    if (envelope?.format || !allowLegacy || !envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Unencrypted or invalid WhatsApp session');
    return text;
  }
  const key = keyring?.keys.get(envelope.key);
  if (envelope.version !== 1 || !key) throw new Error('WhatsApp session key unavailable');
  const nonce = Buffer.from(envelope.nonce || '', 'base64'), tag = Buffer.from(envelope.tag || '', 'base64');
  if (nonce.length !== 12 || tag.length !== 16 || typeof envelope.data !== 'string') throw new Error('Invalid WhatsApp session envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad(instance, file, envelope.key)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
}
async function safeFolder(folder) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid WhatsApp session directory');
}
async function safeFile(file) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid WhatsApp session file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function atomicWrite(file, text) {
  await safeFile(file);
  const temporary = file + '.' + randomBytes(12).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function normalizedName(file) {
  const name = file.replace(/\//g, '__').replace(/:/g, '-');
  if (!name || name === '.' || name.includes('..') || /[\\\0]/.test(name) || path.basename(name) !== name) throw new Error('Invalid WhatsApp session filename');
  return name;
}
export async function createSessionFiles(folder, { keyring, allowLegacy = !keyring, BufferJSON = JSON } = {}) {
  await safeFolder(folder);
  const instance = path.basename(path.resolve(folder));
  return {
    async read(logicalName) {
      const name = normalizedName(logicalName), file = path.join(folder, name);
      return serialized(file, async () => {
        await safeFile(file);
        let text;
        try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        // Existing invalid credentials must fail closed, never trigger a fresh QR.
        return JSON.parse(openSession(text, keyring, instance, name, allowLegacy), BufferJSON.reviver);
      });
    },
    async write(value, logicalName) {
      const name = normalizedName(logicalName), file = path.join(folder, name);
      return serialized(file, () => atomicWrite(file, sealSession(JSON.stringify(value, BufferJSON.replacer), keyring, instance, name)));
    },
    async remove(logicalName) {
      const file = path.join(folder, normalizedName(logicalName));
      return serialized(file, async () => { await safeFile(file); try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
    },
  };
}
export async function encryptedMultiFileAuthState(folder, baileys, options) {
  const files = await createSessionFiles(folder, { ...options, BufferJSON: baileys.BufferJSON });
  const creds = (await files.read('creds.json')) || baileys.initAuthCreds();
  // v7 migrates PN Signal sessions to LIDs using device-list. Older auth
  // folders have the sessions but no device-list; recover that index from
  // authenticated records without replacing pairing credentials or sessions.
  const legacyDevices = new Map();
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const match = entry.isFile() && entry.name.match(/^session-(\d{10,15})\.(\d{1,2})\.json$/);
    if (!match) continue;
    const record = await files.read(entry.name);
    if (!record?._sessions || typeof record._sessions !== 'object') continue;
    const devices = legacyDevices.get(match[1]) || new Set();
    devices.add(match[2]);
    legacyDevices.set(match[1], devices);
  }
  for (const [user, devices] of legacyDevices) {
    const existing = await files.read(`device-list-${user}.json`);
    if (existing !== null && !Array.isArray(existing)) throw new Error('Invalid WhatsApp device index');
    const merged = [...new Set([...(existing || []), ...devices])];
    if (!existing || merged.length !== existing.length) await files.write(merged, `device-list-${user}.json`);
  }
  return {
    state: { creds, keys: {
      async get(type, ids) {
        const entries = await Promise.all(ids.map(async id => {
          let value = await files.read(`${type}-${id}.json`);
          if (type === 'app-state-sync-key' && value) value = baileys.proto.Message.AppStateSyncKeyData.create(value);
          return [id, value];
        }));
        return Object.fromEntries(entries);
      },
      async set(data) {
        await Promise.all(Object.entries(data).flatMap(([category, items]) => Object.entries(items).map(([id, value]) => value ? files.write(value, `${category}-${id}.json`) : files.remove(`${category}-${id}.json`))));
      },
    } },
    saveCreds: () => files.write(creds, 'creds.json'),
  };
}

// Offline only: preflight every file before replacing any; partial conversion
// remains readable with the same key and allowLegacy during recovery.
export async function migrateSessionTree(root, keyring, { apply = false, decrypt = false } = {}) {
  if (!keyring) throw new Error('Migration requires the session keyring');
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unexpected session directory entry');
    const folder = path.join(root, entry.name);
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith('.json') || item.isSymbolicLink()) throw new Error('Unexpected session file');
      const file = path.join(folder, item.name), original = await readFile(file, 'utf8');
      const plain = openSession(original, keyring, entry.name, item.name, true);
      const output = decrypt ? plain : sealSession(plain, keyring, entry.name, item.name);
      if (!decrypt && openSession(output, keyring, entry.name, item.name) !== plain) throw new Error('Session verification failed');
      files.push({ file, original, output });
    }
  }
  if (apply) for (const item of files) {
    if (await readFile(item.file, 'utf8') !== item.original) throw new Error('Session changed during migration; stop the service first');
    await atomicWrite(item.file, item.output);
  }
  return { files: files.length, applied: apply, encrypted: !decrypt };
}
