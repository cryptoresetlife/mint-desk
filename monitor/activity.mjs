// Bounded, in-memory samples. Block time (not arrival time) defines the windows.
export class MintActivity {
 constructor(now=Date.now){this.now=now;this.reset();}
 reset(){this.events=new Map();this.startedAt=this.now();this.gaps=0;}
 gap(){this.events.clear();this.startedAt=this.now();this.gaps++;}
 add(event,time){
  const now=this.now(),id=`${event.hash}:${event.index}`;
  if(event.removed){this.events.delete(id);return;}
  if(!Number.isFinite(time)||time>now+2000||time<=now-300000)return;
  if(!/^0x[0-9a-f]{40}$/i.test(event.minter??'')||!/^0x[0-9a-f]{40}$/i.test(event.payer??''))return;
  const quantity=Number(event.quantity);
  if(!Number.isSafeInteger(quantity)||quantity<=0)return;
  this.prune();
  if(this.events.size>=20000&&!this.events.has(id)){this.gap();return;}
  this.events.set(id,{...event,time,quantity});
 }
 prune(){const cutoff=this.now()-300000;for(const [id,e] of this.events)if(e.time<=cutoff)this.events.delete(id);}
 snapshot(){
  this.prune();const now=this.now(),groups=new Map(),result=new Map();
  for(const e of this.events.values()){const a=e.address.toLowerCase();if(!groups.has(a))groups.set(a,[]);groups.get(a).push(e);}
  for(const [address,events]of groups){
   const recent=events.filter(e=>e.time>now-60000),tx5=new Set(events.map(e=>e.tx)),tx1=new Set(recent.map(e=>e.tx));
   const units=events.reduce((n,e)=>n+e.quantity,0),byMinter=new Map(),byPayer=new Map();
   for(const e of events){byMinter.set(e.minter,(byMinter.get(e.minter)||0)+e.quantity);byPayer.set(e.payer,(byPayer.get(e.payer)||0)+e.quantity);}
   const oldTx=new Set(events.filter(e=>e.time<=now-60000).map(e=>e.tx)).size;
   result.set(address,{sampleSeconds:Math.min(300,Math.max(0,Math.floor((now-this.startedAt)/1000))),complete:now-this.startedAt>=300000,gaps:this.gaps,transactions1m:tx1.size,transactions5m:tx5.size,mints1m:recent.reduce((n,e)=>n+e.quantity,0),mints5m:units,wallets1m:new Set(recent.map(e=>e.minter)).size,wallets5m:byMinter.size,payers5m:byPayer.size,topWalletShare:Math.max(...byMinter.values())/units,topPayerShare:Math.max(...byPayer.values())/units,previousPerMinute:oldTx/4,acceleration:oldTx?tx1.size/(oldTx/4):null,lastMintUtc:new Date(Math.max(...events.map(e=>e.time))).toISOString(),sampledAtUtc:new Date(now).toISOString()});
  }
  return result;
 }
 empty(){return {sampleSeconds:Math.min(300,Math.max(0,Math.floor((this.now()-this.startedAt)/1000))),complete:this.now()-this.startedAt>=300000,gaps:this.gaps,transactions1m:0,transactions5m:0,mints1m:0,mints5m:0,wallets1m:0,wallets5m:0,payers5m:0,topWalletShare:null,topPayerShare:null,previousPerMinute:0,acceleration:null,lastMintUtc:null,sampledAtUtc:new Date(this.now()).toISOString()};}
}
