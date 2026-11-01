import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {baileysTransport} from '../src/baileys-transport.mjs';
import {createSimulatedTransport} from './helpers/simulated-transport.mjs';

test('Simulated transport delivers injected events and receipts, records sends and distinguishes close from logout',async()=>{
 const fake=createSimulatedTransport(),events=[],options={folder:'/synthetic/instance-a',onConnection:async v=>events.push(v),onMessage:async v=>events.push(v),onReceipt:async v=>events.push(v),onFailure:async v=>events.push(v)};
 const engine=await fake.transport(options),control=fake.instances.get('instance-a');await control.connection({qr:'synthetic-not-scannable-qr'});await control.connection({connection:'open'});await control.message({synthetic:true});await control.receipt({syntheticReceipt:true});assert.equal(events.length,4);
 assert.equal((await engine.send({to:'15550000002',text:'Synthetic message'})).messageId,'synthetic-1');control.failNextSend();await assert.rejects(engine.send({text:'Uncertain synthetic send'}),/uncertain/);assert.equal(fake.sent.length,2);await engine.close();assert.equal(control.closed,true);assert.equal(control.loggedOut,false);await assert.rejects(engine.send({}),/closed/);
 const another=await fake.transport({...options,folder:'/synthetic/instance-b'});await another.logout();assert.equal(fake.instances.get('instance-b').loggedOut,true);
});
test('Real adapter wiring uses fake SDK, live-notify messages, trusted LID mapping, encrypted auth and silent logs',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bird-kit-transport-'));t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('bird-kit-transport-'));await fs.rm(directory,{recursive:true,force:true});});
 const ev=new EventEmitter(),received=[],connections=[],receipts=[],failures=[],sent=[];let config,ended=false,loggedOut=false;
 const socket={ev,user:{id:'15550000001:1@s.whatsapp.net'},signalRepository:{lidMapping:{getPNForLID:async()=>'15550000002@s.whatsapp.net'}},sendMessage:async(to,content)=>{sent.push({to,content});return {key:{id:'synthetic-sent'},message:{conversation:'Synthetic'}};},end:()=>{ended=true;},logout:async()=>{loggedOut=true;}};
 const encode=value=>({finish:()=>Buffer.from(JSON.stringify(value))}),decode=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
 const sdk={default:options=>{config=options;return socket;},DEFAULT_CONNECTION_CONFIG:{version:[0,0,0]},BufferJSON:JSON,initAuthCreds:()=>({synthetic:true}),proto:{Message:{encode,decode,AppStateSyncKeyData:{create:value=>value}},WebMessageInfo:{decode}},downloadMediaMessage:async()=>Buffer.from('synthetic-media')};
 const engine=await baileysTransport({folder:path.join(directory,'synthetic-instance'),keyring:{active:'test',keys:new Map([['test',randomBytes(32)]])},sdkFactory:async()=>sdk,onConnection:async v=>connections.push(v),onMessage:async v=>received.push(v),onReceipt:async v=>receipts.push(v),onFailure:e=>failures.push(e),getMessage:async()=>undefined});
 assert.equal(config.logger.level,'silent');assert.equal(config.syncFullHistory,false);assert.equal(config.shouldSyncHistoryMessage(),false);assert.equal(config.maxMsgRetryCount,2);assert.equal(config.shouldIgnoreJid('123@g.us'),true);assert.equal(config.shouldIgnoreJid('status@broadcast'),true);assert.equal(config.shouldIgnoreJid('123@newsletter'),true);
 ev.emit('connection.update',{connection:'open'});ev.emit('messages.upsert',{type:'append',messages:[{key:{id:'ignored'}}]});ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'synthetic-inbound',remoteJid:'777777777777@lid'},message:{conversation:'Synthetic'}}]});ev.emit('messages.update',[{key:{id:'synthetic-sent'},update:{status:3}}]);
 for(let n=0;n<20&&!received.length;n++)await new Promise(r=>setTimeout(r,5));assert.equal(received.length,1);assert.equal(received[0].key.remoteJidAlt,'15550000002@s.whatsapp.net');assert.equal(connections.length,1);assert.equal(receipts.length,1);assert.equal(failures.length,0);
 const result=await engine.send({to:'15550000002',text:'Synthetic response'});assert.equal(result.messageId,'synthetic-sent');assert.equal(sent[0].to,'15550000002@s.whatsapp.net');await engine.close();assert.equal(ended,true);assert.equal(loggedOut,false);await engine.logout();assert.equal(loggedOut,true);
});
