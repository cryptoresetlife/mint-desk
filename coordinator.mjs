import path from 'node:path';
import {readdir,readFile} from 'node:fs/promises';
import {amount,requireThat,Stop} from './lib.mjs';
import {acquireRunLock} from './run-lock.mjs';

export const walletBudget=p=>amount(p.maxPriceEth,'价格',true)*BigInt(p.quantity)+amount(p.maxGasEth,'gas');
const key=(p,address)=>`${p.chainId}-${address.toLowerCase()}`;
// One process owns each wallet's OS guard; jobs share the guard, never a nonce.
// Multiple jobs wait/prewarm together. Only one send/receipt lane per wallet.
export class WalletCoordinator {
 constructor(){this.entries=new Map();this.tail=Promise.resolve();}
 reserved(p,address,except){const e=this.entries.get(key(p,address));return [...(e?.claims??[])].reduce((n,[id,c])=>n+(id===except?0n:c.budget),0n);}
 busy(p,address){return !!this.entries.get(key(p,address))?.owner;}
 async register(job,rpc){
  const previous=this.tail;let done;this.tail=new Promise(r=>done=r);await previous;
  const touched=[];
  const claimKey=job.claimKey??job.p.address.toLowerCase();
  try{
   for(const w of job.wallets){
    job.check();const k=key(job.p,w.address);let e=this.entries.get(k);
    if(e?.claims.has(job.id))continue;
    requireThat(![...(e?.claims.values()??[])].some(c=>c.contract===claimKey),'同一钱包对此系列已有等待任务。');
    const balance=BigInt(await rpc.send('eth_getBalance',[w.address,'pending'])),cap=walletBudget(job.p);
    e=this.entries.get(k);
    requireThat(![...(e?.claims.values()??[])].some(c=>c.contract===claimKey),'同一钱包对此系列已有等待任务。');
    requireThat(balance>=this.reserved(job.p,w.address)+cap,'余额不足以覆盖此钱包所有任务的 mint 与 gas 授权上限。请调整预算或减少任务。');
    if(!e){const guard=await acquireRunLock(path.join(job.dir,k+'.lock'));e={claims:new Map(),guard,owner:null};this.entries.set(k,e);}
    e.claims.set(job.id,{budget:cap,contract:claimKey});touched.push(k);
   }
   job.check();
  }catch(error){for(const k of touched){const e=this.entries.get(k);e.claims.delete(job.id);await this.cleanup(k,e);}throw error;}
  finally{done();}
 }
 async cleanup(k,e){if(!e.claims.size&&!e.owner){this.entries.delete(k);await e.guard.release();}}
 async unregister(job){for(const w of job.wallets){const k=key(job.p,w.address),e=this.entries.get(k);if(!e)continue;e.claims.delete(job.id);await this.cleanup(k,e);}}
 complete(job,w){const c=this.entries.get(key(job.p,w.address))?.claims.get(job.id);if(c)c.budget=0n;}
 setBudget(job,w,budget){const c=this.entries.get(key(job.p,w.address))?.claims.get(job.id);requireThat(c&&budget>=0n&&budget<=c.budget,'预算只能在完成操作后减少。');c.budget=budget;}
 take(job,w){
  const k=key(job.p,w.address),e=this.entries.get(k);if(!e?.claims.has(job.id)||e.owner)return null;
  const owner={job:job.id};e.owner=owner;let released=false;
  return {release:async()=>{if(released)return;released=true;if(e.owner===owner)e.owner=null;await this.cleanup(k,e);}};
 }
 // A timed-out/stopped broadcast is still a durable attempt. Never reuse its
 // nonce merely because another RPC says pending==latest or the app restarted.
 async historyBarrier(dir,p,address,rpc){
  let files;try{files=await readdir(dir);}catch(e){if(e.code==='ENOENT')return 0n;throw new Stop('交易记录不可读，暂停协调发送。');}
  const suffix='-'+address.toLowerCase()+'.json';let floor=0n;
  for(const file of files.filter(f=>f.startsWith(p.chainId+'-')&&f.endsWith(suffix))){
   let record;try{record=JSON.parse(await readFile(path.join(dir,file),'utf8'));}catch{throw new Stop('历史交易记录损坏，暂停协调发送。');}
   requireThat(record.chainId===p.chainId&&record.address?.toLowerCase()===address.toLowerCase()&&/^0x[0-9a-f]{64}$/i.test(record.hash??'')&&Number.isSafeInteger(record.nonce)&&record.nonce>=0,'历史交易记录无法核验，暂停协调发送。');
   const receipt=await rpc.send('eth_getTransactionReceipt',[record.hash]);
   requireThat(receipt&&['0x0','0x1'].includes(receipt.status),'前序交易尚未确认或结果不明，协调等待；不会复用交易序号。');
   requireThat(!receipt.transactionHash||receipt.transactionHash.toLowerCase()===record.hash.toLowerCase(),'前序交易回执不匹配，协调等待。');
   const next=BigInt(record.nonce)+1n;if(next>floor)floor=next;
  }
  return floor;
 }
}
export const coordinator=new WalletCoordinator();
