import test from 'node:test';
import assert from 'node:assert/strict';
import {reconnectDecision,createMessageRetryBudget,shouldIgnoreWhatsAppJid} from '../src/connection-policy.mjs';
import {createPhoneResendCache} from '../src/phone-resend-cache.mjs';

test('Fatal disconnect codes stop retries and preserve the attempt count',()=>{
 for(const code of [401,403,411,440,500,'401'])assert.deepEqual(reconnectDecision({code,previousAttempts:3}),{retry:false,attempts:3,reason:'session'});
});
test('Transient reconnection backs off with bounded jitter and stops after six unstable retries',()=>{
 const delays=[];for(let previousAttempts=0;previousAttempts<6;previousAttempts++){const result=reconnectDecision({code:408,previousAttempts,random:0.5});assert.equal(result.retry,true);delays.push(result.delayMs);}
 assert.deepEqual(delays,[15000,30000,60000,120000,240000,300000]);assert.equal(reconnectDecision({code:428,previousAttempts:6}).reason,'unstable');
 assert.equal(reconnectDecision({code:515,random:0}).delayMs,13500);assert.equal(reconnectDecision({code:515,random:1}).delayMs,16500);
 assert.equal(reconnectDecision({previousAttempts:6,connectedForMs:300000,random:0.5}).attempts,1);
});
test('Undecryptable-message budget retains exhausted counts, expires and stays bounded',()=>{
 let now=0;const cache=createMessageRetryBudget({now:()=>now,ttlMs:100,maxEntries:2,limit:2});
 cache.set('first',1);cache.del('first');assert.equal(cache.get('first'),undefined);cache.set('exhausted',2);cache.del('exhausted');assert.equal(cache.get('exhausted'),2);
 cache.set('second',2);cache.set('third',2);assert.equal(cache.get('exhausted'),undefined);now=101;assert.equal(cache.get('third'),undefined);cache.flushAll();
});
test('Phone placeholder resend budget cannot be reopened by delete and caps account requests',()=>{
 let now=0;const cache=createPhoneResendCache({now:()=>now,intervalMs:100,ttlMs:1000,limit:2});
 cache.set('one',1);cache.del('one');assert.equal(cache.get('one'),true);cache.set('two',1);assert.equal(cache.get('three'),true);cache.set('three',1);
 now=101;assert.equal(cache.get('three'),undefined);assert.equal(cache.get('one'),true);now=1001;assert.equal(cache.get('one'),undefined);cache.flushAll();
});
test('Group ignore policy is explicit rather than an identity conversion',()=>{
 assert.equal(shouldIgnoreWhatsAppJid('123@g.us',true),true);assert.equal(shouldIgnoreWhatsAppJid('123@g.us',false),false);assert.equal(shouldIgnoreWhatsAppJid('15550000001@s.whatsapp.net',true),false);
});
