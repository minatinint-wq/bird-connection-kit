import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePhoneIdentity} from '../src/phone-identity.mjs';

test('Phone JIDs and native alternate identity resolve without querying the SDK',async()=>{
 const lookup=()=>{throw Error('Must not look up known phone identity');};
 for(const jid of ['15550000001@s.whatsapp.net','15550000001:2@s.whatsapp.net'])assert.equal(await resolvePhoneIdentity({key:{remoteJid:jid}},lookup),jid);
 assert.equal(await resolvePhoneIdentity({key:{remoteJid:'777777777777@lid',remoteJidAlt:'15550000002@s.whatsapp.net'}},lookup),'15550000002@s.whatsapp.net');
});
test('LID uses the trusted SDK mapping, never its own digits as a phone number',async()=>{
 const message={key:{remoteJid:'15550000001@lid'}};
 assert.equal(await resolvePhoneIdentity(message,async lid=>{assert.equal(lid,message.key.remoteJid);return '15550000002@s.whatsapp.net';}),'15550000002@s.whatsapp.net');
 for(const mapping of [null,'15550000001','bad@s.whatsapp.net','777777@lid'])assert.equal(await resolvePhoneIdentity(message,async()=>mapping),null);
 assert.equal(await resolvePhoneIdentity(message,async()=>{throw Error('Unavailable mapping');}),null);
 assert.equal(await resolvePhoneIdentity(message),null);
});
test('Groups and non-contact JIDs do not enter phone identity mapping',async()=>{
 for(const remoteJid of ['123456@g.us','status@broadcast','12345@newsletter','not-a-jid'])assert.equal(await resolvePhoneIdentity({key:{remoteJid}},()=>{throw Error('Must not query');}),null);
});
