// Standalone extraction of the injected transport pattern used in the tests.
// This factory performs no network requests and contains no real WhatsApp state.
export function createSimulatedTransport(){
 const instances=new Map(),sent=[];
 async function transport(options){
  const id=options.folder.replaceAll('\\','/').split('/').at(-1);
  if(instances.get(id)?.active)throw Error('Simulated instance already open');
  const state={active:true,options,sendFailure:null,closed:false,loggedOut:false};
  const control={
   get active(){return state.active;},
   connection:update=>options.onConnection(update),
   message:(value,sdk={})=>options.onMessage(value,sdk),
   receipt:value=>options.onReceipt(value),
   failure:error=>options.onFailure(error),
   failNextSend(error=Error('Synthetic uncertain result')){state.sendFailure=error;},
   get closed(){return state.closed;},get loggedOut(){return state.loggedOut;},
  };
  instances.set(id,control);
  return {
   user:{id:'15550000001:1@s.whatsapp.net'},
   async send(payload){if(!state.active)throw Error('Simulated transport closed');sent.push({instanceId:id,payload:structuredClone(payload)});if(state.sendFailure){const error=state.sendFailure;state.sendFailure=null;throw error;}return {messageId:'synthetic-'+sent.length};},
   async close(){state.active=false;state.closed=true;},
   async logout(){state.active=false;state.loggedOut=true;},
   decode:encoded=>JSON.parse(Buffer.from(encoded,'base64').toString('utf8')),
   download:async()=>Buffer.from('synthetic-media'),
  };
 }
 return {transport,instances,sent};
}
