import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'node_modules/@whiskeysockets/baileys');
const version=JSON.parse(await fs.readFile(path.join(target,'package.json'),'utf8')).version;
if(version!=='7.0.0-rc14')throw Error('These diffs apply only to Baileys 7.0.0-rc14.');
const mode=process.argv[2];if(!['--check','--apply'].includes(mode))throw Error('Use --check or --apply.');
const patches=(await fs.readdir(path.join(root,'patches'))).filter(f=>f.endsWith('.patch')).sort().map(f=>path.join(root,'patches',f));
// Preflight the complete set before writing; fail on incompatible or already
// modified dependencies. There is no automatic package-install hook.
const directory='--directory=node_modules/@whiskeysockets/baileys';
execFileSync('git',['apply',directory,'--check',...patches],{cwd:root,stdio:'pipe'});
if(mode==='--apply')execFileSync('git',['apply',directory,...patches],{cwd:root,stdio:'pipe'});
console.log(mode==='--apply'?'Patches applied.':'Patch set applies cleanly.');
