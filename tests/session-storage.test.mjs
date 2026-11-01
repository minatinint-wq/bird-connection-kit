import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {sealSession,openSession,sessionKeyringFromEnv,createSessionFiles,encryptedMultiFileAuthState,migrateSessionTree} from '../src/session-storage.mjs';

const ring=()=>({active:'test',keys:new Map([['test',randomBytes(32)]])});
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bird-kit-session-'));t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('bird-kit-session-'));await fs.rm(directory,{recursive:true,force:true});});return directory;}
const sdk={BufferJSON:JSON,initAuthCreds:()=>({synthetic:true}),proto:{Message:{AppStateSyncKeyData:{create:value=>({...value,converted:true})}}}};

test('AES-GCM uses fresh nonces, authenticates content and binds key id, instance and filename',()=>{
 const keys=ring(),plain=JSON.stringify({synthetic:'private test value'}),sealed=sealSession(plain,keys,'instance-a','creds.json');assert.notEqual(sealSession(plain,keys,'instance-a','creds.json'),sealed);assert.equal(sealed.includes('private test value'),false);assert.equal(openSession(sealed,keys,'instance-a','creds.json'),plain);
 for(const [keyring,instance,file] of [[ring(),'instance-a','creds.json'],[keys,'instance-b','creds.json'],[keys,'instance-a','session.json']])assert.throws(()=>openSession(sealed,keyring,instance,file));
 const modified=JSON.parse(sealed);modified.tag=Buffer.alloc(16).toString('base64');assert.throws(()=>openSession(JSON.stringify(modified),keys,'instance-a','creds.json'));
 assert.throws(()=>openSession('{"synthetic":true}',keys,'instance-a','creds.json'));assert.throws(()=>openSession('not-json',keys,'instance-a','creds.json'));
});
test('Keyring is required when configured and validates canonical 32-byte keys; rotation preserves older envelopes',async t=>{
 const directory=await fixture(t),file=path.join(directory,'test-keyring.json'),key=ring(),old=sealSession('{"synthetic":true}',key,'a','b');
 await assert.rejects(sessionKeyringFromEnv({BIRD_SESSION_ENCRYPTION_REQUIRED:'true'}),/required/);
 await fs.writeFile(file,JSON.stringify({active:'test',keys:{test:key.keys.get('test').toString('base64')}}));assert.equal((await sessionKeyringFromEnv({BIRD_SESSION_KEY_FILE:file})).active,'test');
 await fs.writeFile(file,JSON.stringify({active:'bad',keys:{test:'not-a-key'}}));await assert.rejects(sessionKeyringFromEnv({BIRD_SESSION_KEY_FILE:file}));
 key.keys.set('next',randomBytes(32));key.active='next';assert.equal(openSession(old,key,'a','b'),'{"synthetic":true}');assert.equal(JSON.parse(sealSession('{}',key,'a','b')).key,'next');
});
test('Atomic encrypted files serialize competing writes, survive reopening and reject path traversal',async t=>{
 const directory=await fixture(t),folder=path.join(directory,'synthetic-instance'),keyring=ring(),files=await createSessionFiles(folder,{keyring});assert.equal(await files.read('missing.json'),null);
 await Promise.all(Array.from({length:20},(_,n)=>files.write({n,synthetic:true},'creds.json')));assert.deepEqual(await files.read('creds.json'),{n:19,synthetic:true});
 const persisted=await fs.readFile(path.join(folder,'creds.json'),'utf8');assert.equal(persisted.includes('synthetic'),false);assert.deepEqual(await(await createSessionFiles(folder,{keyring})).read('creds.json'),{n:19,synthetic:true});
 for(const name of ['../creds.json','..','bad\\name','\0bad'])await assert.rejects(files.write({},name));assert.equal((await fs.readdir(folder)).filter(f=>f.endsWith('.tmp')).length,0);
 await files.remove('creds.json');assert.equal(await files.read('creds.json'),null);
});
test('Auth adapter persists credentials and Signal keys, reconstructs device index and refuses corrupt existing state',async t=>{
 const directory=await fixture(t),folder=path.join(directory,'synthetic-instance'),keyring=ring();let auth=await encryptedMultiFileAuthState(folder,sdk,{keyring,allowLegacy:false});assert.equal(auth.state.creds.synthetic,true);
 auth.state.creds.counter=1;await auth.saveCreds();await auth.state.keys.set({session:{'15550000001.0':{_sessions:{synthetic:{}}}},'app-state-sync-key':{fake:{synthetic:true}}});
 auth=await encryptedMultiFileAuthState(folder,sdk,{keyring,allowLegacy:false});assert.equal(auth.state.creds.counter,1);const files=await createSessionFiles(folder,{keyring});assert.deepEqual(await files.read('device-list-15550000001.json'),['0']);assert.equal((await auth.state.keys.get('app-state-sync-key',['fake'])).fake.converted,true);
 await auth.state.keys.set({session:{'15550000001.0':null}});assert.equal((await auth.state.keys.get('session',['15550000001.0']))['15550000001.0'],null);
 await fs.writeFile(path.join(folder,'creds.json'),'corrupt synthetic state');await assert.rejects(encryptedMultiFileAuthState(folder,sdk,{keyring,allowLegacy:false}));
});
test('Offline migration preflights all files and only encrypts when explicitly applied',async t=>{
 const directory=await fixture(t),root=path.join(directory,'sessions'),folder=path.join(root,'synthetic-instance'),keyring=ring();await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'creds.json');await fs.writeFile(file,'{"synthetic":true}');
 assert.equal((await migrateSessionTree(root,keyring)).applied,false);assert.equal(await fs.readFile(file,'utf8'),'{"synthetic":true}');await fs.writeFile(path.join(folder,'bad.json'),'invalid');await assert.rejects(migrateSessionTree(root,keyring,{apply:true}));assert.equal(await fs.readFile(file,'utf8'),'{"synthetic":true}');await fs.unlink(path.join(folder,'bad.json'));
 assert.equal((await migrateSessionTree(root,keyring,{apply:true})).encrypted,true);const files=await createSessionFiles(folder,{keyring});assert.deepEqual(await files.read('creds.json'),{synthetic:true});
});
