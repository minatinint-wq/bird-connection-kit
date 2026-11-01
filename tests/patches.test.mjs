import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {inflate,deflateSync} from 'node:zlib';
import {promisify} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['lib/Utils/history.js','lib/Socket/messages-recv.js'];
async function patched(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bird-kit-patches-'));t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('bird-kit-patches-'));await fs.rm(directory,{recursive:true,force:true});});
 const dependency=path.join(root,'node_modules/@whiskeysockets/baileys');assert.equal(JSON.parse(await fs.readFile(path.join(dependency,'package.json'),'utf8')).version,'7.0.0-rc14');
 for(const file of files){await fs.mkdir(path.dirname(path.join(directory,file)),{recursive:true});await fs.copyFile(path.join(dependency,file),path.join(directory,file));}
 const patches=(await fs.readdir(path.join(root,'patches'))).filter(f=>f.endsWith('.patch')).sort().map(f=>path.join(root,'patches',f));
 execFileSync('git',['apply','--check',...patches],{cwd:directory,stdio:'pipe'});execFileSync('git',['apply',...patches],{cwd:directory,stdio:'pipe'});
 return {history:await fs.readFile(path.join(directory,files[0]),'utf8'),receive:await fs.readFile(path.join(directory,files[1]),'utf8')};
}
function historyFunction(source,download){
 const begin=source.indexOf('let birdActiveHistoryDownloads'),end=source.indexOf('export const processHistoryMessage',begin);assert.ok(begin>=0&&end>begin);
 const body=source.slice(begin,end).replace('export const downloadHistory','const downloadHistory');
 return vm.runInNewContext(body+'\ndownloadHistory;',{Buffer,downloadContentFromMessage:download,inflatePromise:promisify(inflate),proto:{HistorySync:{decode:value=>value}}});
}
test('Diffs apply to pristine SDK and bounded history uses serial downloads, capacity, timeout and inflated-size limits',async t=>{
 const source=await patched(t);let active=0,peak=0;
 const fn=historyFunction(source.history,async(_message,type,options)=>{assert.equal(type,'md-msg-hist');assert.equal(options.options.timeout,15000);active++;peak=Math.max(peak,active);return Readable.from((async function*(){try{await new Promise(r=>setTimeout(r,5));yield deflateSync(Buffer.from('synthetic history'));}finally{active--;}})());});
 const results=Array.from({length:4},()=>fn({}));await assert.rejects(fn({}),/history_download_busy/);for(const result of await Promise.all(results))assert.equal(result.toString(),'synthetic history');assert.equal(peak,1);
 let oversized=true;const inflateLimit=historyFunction(source.history,async()=>Readable.from([deflateSync(Buffer.alloc(oversized?17*1024*1024:10))]));await assert.rejects(inflateLimit({}));oversized=false;assert.equal((await inflateLimit({})).length,10);
 const compressedLimit=historyFunction(source.history,async()=>Readable.from([Buffer.alloc(4*1024*1024+1)]));await assert.rejects(compressedLimit({}),/history_compressed_limit/);
});
test('Live classification treats offline="0" as notify rather than offline history',async t=>{
 const {receive}=await patched(t);assert.ok(receive.includes("const isOffline = node.attrs.offline === '1' || node.attrs.offline === true;"));
 const assignment=receive.match(/const isOffline = ([^;]+);/)[1];for(const [offline,expected]of [['0',false],['1',true],[false,false],[true,true],[undefined,false]])assert.equal(vm.runInNewContext(assignment,{node:{attrs:{offline}}}),expected);
});
test('Retransmission never bypasses getMessage and rechecks authorization after asynchronous session repair',async t=>{
 const {receive}=await patched(t),start=receive.indexOf('    const sendMessagesAgain = async '),end=receive.indexOf('    const handleReceipt = async ',start),body=receive.slice(start,end);assert.ok(start>=0&&end>start);
 const relayed=[];let allowed=true,revokeDuringRepair=false,reads=0;
 const context={getMessage:async()=>{reads++;return allowed?{conversation:'Synthetic authorized content'}:undefined;},messageRetryManager:{getRecentMessage:()=>{throw Error('Cache bypass');},markRetrySuccess:()=>{}},jidDecode:()=>({device:1}),signalRepository:{jidToSignalProtocolAddress:()=> 'synthetic',getSessionInfo:async()=>undefined},extractE2ESessionFromRetryReceipt:()=>null,getBinaryNodeChildUInt:()=>undefined,enableAutoSessionRecreation:false,assertSessions:async()=>{if(revokeDuringRepair)allowed=false;},isJidGroup:()=>false,logger:{debug:()=>{},warn:()=>{},info:()=>{}},willSendMessageAgain:async()=>true,updateSendMessageAgainCount:async()=>{},relayMessage:async(...args)=>relayed.push(args)};
 const send=vm.runInNewContext('(function(){'+body+'\nreturn sendMessagesAgain;})()',context),key={remoteJid:'15550000001@s.whatsapp.net'};
 await send(key,['synthetic-id'],{attrs:{count:'1'}},{});assert.equal(relayed.length,1);assert.equal(reads,2);
 relayed.length=0;reads=0;allowed=true;revokeDuringRepair=true;await send(key,['synthetic-id'],{attrs:{count:'1'}},{});assert.equal(relayed.length,0);assert.equal(reads,2);
 allowed=false;await send(key,['synthetic-id'],{attrs:{count:'1'}},{});assert.equal(relayed.length,0);
 assert.ok(receive.includes('bird-persistent-retry-budget-v1'));assert.ok(receive.includes('await msgRetryCache.get(birdRetryKey)'));
});
