import P from 'pino';
import { encryptedMultiFileAuthState } from './session-storage.mjs';
import { createMessageRetryBudget } from './connection-policy.mjs';
import { createPhoneResendCache } from './phone-resend-cache.mjs';
import { resolvePhoneIdentity } from './phone-identity.mjs';
export async function baileysTransport({folder,keyring,onConnection,onMessage,onReceipt,onFailure,getMessage,sdkFactory=()=>import('@whiskeysockets/baileys')}) {
  const sdk=await sdkFactory();
  const {state,saveCreds}=await encryptedMultiFileAuthState(folder,sdk,{keyring,allowLegacy:false});
  const socket=sdk.default({auth:state,version:sdk.DEFAULT_CONNECTION_CONFIG.version,logger:P({level:'silent'}),printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,shouldIgnoreJid:jid=>jid.endsWith('@g.us')||jid.endsWith('@broadcast')||jid.endsWith('@newsletter'),maxMsgRetryCount:2,msgRetryCounterCache:createMessageRetryBudget(),placeholderResendCache:createPhoneResendCache(),getMessage});
  socket.ev.on('creds.update',()=>{void saveCreds().catch(onFailure);});
  socket.ev.on('connection.update',update=>{void onConnection(update).catch(onFailure);});
  socket.ev.on('messages.upsert',({messages,type})=>{if(type!=='notify')return;for(const message of messages)void (async()=>{const phone=await resolvePhoneIdentity(message,lid=>socket.signalRepository.lidMapping.getPNForLID(lid));await onMessage(phone?{...message,key:{...message.key,remoteJidAlt:phone}}:message,sdk);})().catch(onFailure);});
  socket.ev.on('messages.update',updates=>{for(const update of updates)void onReceipt(update).catch(onFailure);});
  return {
    async send(payload){
      let content={text:payload.text};
      if(payload.media){const m=payload.media,buffer=Buffer.from(m.base64,'base64');content={ [m.type]:buffer,mimetype:m.mimetype,...(m.type==='image'?{caption:payload.text}:{}),...(m.type==='document'?{fileName:m.filename,caption:payload.text}:{}) };}
      const result=await socket.sendMessage(payload.to+'@s.whatsapp.net',content);
      return {messageId:result?.key?.id,proto:result?.message?Buffer.from(sdk.proto.Message.encode(result.message).finish()).toString('base64'):null};
    },
    decode:encoded=>sdk.proto.Message.decode(Buffer.from(encoded,'base64')),
    download:encoded=>sdk.downloadMediaMessage(sdk.proto.WebMessageInfo.decode(Buffer.from(encoded,'base64')),'stream',{options:{signal:AbortSignal.timeout(30000)}}, {logger:P({level:'silent'}),reuploadRequest:socket.updateMediaMessage}),
    close:()=>socket.end(new Error('API Bird controlled pause')),
    logout:()=>socket.logout(),
    get user(){return socket.user;},
  };
}
