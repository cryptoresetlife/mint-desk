import { formatEther, keccak256 } from 'ethers';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Rpc, Stop, requireThat, safeError, json, identity, snapshot, validateSale, fingerprint, prepare, sendOnce, prior, recordPath, mintedIds, publicSale, amount } from './lib.mjs';
import {coordinator,walletBudget} from './coordinator.mjs';

export async function limited(items,n,fn) {
  let i=0;const results=await Promise.allSettled(Array.from({length:Math.min(n,items.length)},async()=>{while(i<items.length){const v=items[i++];await fn(v);}}));
  const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
}
export async function preflight(p,wallets,dir,coord=coordinator) {
  const rpc=new Rpc(p.rpcUrl),id=await identity(rpc,p),s=await snapshot(rpc,p);
  validateSale(p,s);
  const rows=[];
  await limited(wallets,4,async w=>{
    try {
      const old=await prior(dir,p,w.address);requireThat(!old,'本软件已有此钱包对此系列的交易记录，请在历史记录核实，不会再自动发送。');
      const [sale,b,pending,latest]=await Promise.all([snapshot(rpc,p,w.address),rpc.send('eth_getBalance',[w.address,'pending']),rpc.send('eth_getTransactionCount',[w.address,'pending']),rpc.send('eth_getTransactionCount',[w.address,'latest'])]);
      validateSale(p,sale);requireThat(pending===latest||coord.busy(p,w.address),'钱包存在本软件未协调的待确认交易。');
      const reserved=coord.reserved(p,w.address),required=reserved+walletBudget(p);requireThat(BigInt(b)>=required,'余额不足以覆盖已有任务与本次任务的全部授权预算。');
      requireThat(BigInt(b)>sale.price*BigInt(p.quantity),'余额不足以支付 mint 与 gas。');
      let gas=null,note='未开售；gas 在临近开售时预演或开售后估算。';
      if(sale.timestamp>=sale.start&&!coord.busy(p,w.address)){const preview=await prepare(rpc,p,w,sale);gas=formatEther(preview.maxCost);note='当前模拟通过；未广播。';}
      if(coord.busy(p,w.address))note='另一个项目正在发送或等待回执；本项目可同时等待，轮到后重新估算。';
      rows.push({address:w.address,ok:true,balanceEth:formatEther(BigInt(b)),reservedEth:formatEther(reserved),requiredEth:formatEther(required),gasEth:gas,note});
    }catch(e){rows.push({address:w.address,ok:false,note:safeError(e)});}
  });
  return {projectId:p.id,name:id.name,codeHash:id.codeHash,sale:publicSale(s),wallets:rows,
    maxMintEth:formatEther(amount(p.maxPriceEth,'价格',true)*BigInt(p.quantity)*BigInt(wallets.length)),
    maxGasEth:formatEther(amount(p.maxGasEth,'gas')*BigInt(wallets.length)),checkedAt:Date.now()};
}
export class MintJob {
  constructor({id,project,wallets,dir,review,coord=coordinator}) {
    this.coordinator=coord;this.id=id;this.p={...project};this.wallets=wallets.map(w=>({...w,status:'等待',note:'尚未发送',prepared:null}));
    this.dir=dir;this.review=review;this.controller=new AbortController();this.logs=[];this.status='启动中';this.sale=null;this.createdAt=Date.now();
  }
  log(message){this.logs.push({at:Date.now(),message});if(this.logs.length>150)this.logs.shift();}
  check(){if(this.controller.signal.aborted)throw new Stop('已停止；已广播的交易仍会在链上处理。');}
  stop(){this.controller.abort();this.status='正在停止';}
  wait(ms){return delay(ms,null,{signal:this.controller.signal});}
  view(){return {id:this.id,projectId:this.p.id,name:this.p.name,chainId:this.p.chainId,address:this.p.address,status:this.status,createdAt:this.createdAt,sale:this.sale,logs:this.logs,wallets:this.wallets.map(({address,status,note,hash,gasEth,tokenIds})=>({address,status,note,hash,gasEth,tokenIds}))};}
  async receipt(rpc,w) {
    const end=Date.now()+180000;
    while(Date.now()<end&&!this.controller.signal.aborted) {
      try {
        const r=await rpc.send('eth_getTransactionReceipt',[w.hash]);
        if(r) {
          const ids=mintedIds(r,this.p,w.address),ok=BigInt(r.status)===1n&&ids.length===this.p.quantity;
          w.status=ok?'已入块成功':'已入块未成功';w.tokenIds=ids;
          w.gasEth=formatEther(BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice));
          w.note=ok?'收到预期 NFT；尚不代表最终确认。':'交易消耗 gas，未确认预期 NFT；不会重发。';
          await writeFile(recordPath(this.dir,this.p,w.address)+'.receipt',json({hash:w.hash,success:ok,tokenIds:ids,gasEth:w.gasEth,receipt:r}));return;
        }
      }catch{}
      await this.wait(1500).catch(()=>{});
    }
    w.note='尚未确认结果；交易哈希已保留，请查询历史。不会自动重发。';
  }
  async run() {
    const rpc=new Rpc(this.p.rpcUrl),receiptTasks=[];
    try {
      await this.coordinator.register(this,rpc);
      for(const w of this.wallets){this.check();requireThat(!(await prior(this.dir,this.p,w.address)),'已有历史交易记录，停止启动。');}
      const ident=await identity(rpc,this.p);requireThat(ident.codeHash===this.review.codeHash,'NFT 合约代码已变化，请重新检查。');
      this.status='运行中';this.log('任务已授权：多项目同时等待；不同钱包并行，同钱包逐笔协调，前一笔确认后发送下一笔。');
      let lastRead=0,lastVerify=Date.now(),state,lastPrep=0,lastError=0;
      while(this.wallets.some(w=>w.status==='等待')) {
        this.check();
        try {
          if(Date.now()-lastRead>=1000) {
            const fresh=await snapshot(rpc,this.p);validateSale(this.p,fresh);
            if(state&&fingerprint(state)!==fingerprint(fresh)){for(const w of this.wallets)w.prepared=null;this.log('公售参数变化，重新检查和准备交易。');}
            state=fresh;this.sale=publicSale(state);lastRead=Date.now();
          }
          if(Date.now()-lastVerify>10000) {const id=await identity(rpc,this.p);requireThat(id.codeHash===this.review.codeHash,'合约代码变化，停止。');lastVerify=Date.now();}
          const seconds=state.start-state.timestamp,waiting=this.wallets.filter(w=>w.status==='等待');
          if(seconds<=60) {
            const stale=waiting.filter(w=>(!w.prepared||Date.now()-w.prepared.at>10000)&&(w.retryAt??0)<=Date.now());
            const hasReady=waiting.some(w=>w.prepared&&Date.now()-w.prepared.at<=15000);
            if(stale.length&&Date.now()-lastPrep>1000&&(seconds>2||!hasReady)) {
              await limited(stale,4,async w=>{
                this.check();w.prepared=null;
                if(this.coordinator.busy(this.p,w.address)){w.note='协调排队：其他项目正在发送或等待回执。';w.retryAt=Date.now()+1000;return;}
                try {
                  const floor=await this.coordinator.historyBarrier(this.dir,this.p,w.address,rpc);
                  const s=await snapshot(rpc,this.p,w.address);validateSale(this.p,s);
                  const p=await prepare(rpc,this.p,w,s,s.timestamp<s.start);this.check();requireThat(BigInt(p.tx.nonce)>=floor,'RPC 交易序号尚未更新，协调等待。');
                  if(p.fingerprint===fingerprint(state)){w.prepared=p;w.gasEth=formatEther(p.maxCost);w.note='已在内存预签名，等待真实 pending 模拟通过。';}
                }catch(e){if(this.controller.signal.aborted)throw e;w.retryAt=Date.now()+(seconds>0?5000:2000);w.note=safeError(e);}
              });lastPrep=Date.now();lastRead=0;continue;
            }
            if(seconds<=2) {
              const ready=waiting.filter(w=>w.prepared&&Date.now()-w.prepared.at<=15000);
              // Each wallet has its own live gate. A passing gate on one address
              // cannot authorize another address's eligibility or nonce.
              await limited(ready,20,async w=>{
                this.check();const p=w.prepared;const lane=this.coordinator.take(this,w);if(!lane){w.note='协调排队：其他项目正在发送或等待回执。';return;}let receiptOwnsLane=false;
                try {
                  const floor=await this.coordinator.historyBarrier(this.dir,this.p,w.address,rpc);this.check();
                  const [r,nonce,bal,latestNonce]=await Promise.all([rpc.send('eth_call',[p.request,'pending']),rpc.send('eth_getTransactionCount',[w.address,'pending']),rpc.send('eth_getBalance',[w.address,'pending']),rpc.send('eth_getTransactionCount',[w.address,'latest'])]);
                  this.check();requireThat(r==='0x','pending 模拟未通过。');
                  requireThat(Date.now()-p.at<=15000&&Date.now()-lastRead<2500,'准备数据过期，重新检查。');
                  requireThat(BigInt(nonce)===BigInt(latestNonce)&&BigInt(nonce)>=floor,'前序交易未确认或 RPC 序号落后，协调等待。');
                  requireThat(BigInt(bal)>=this.coordinator.reserved(this.p,w.address),'余额不足以覆盖此钱包其他等待任务的预算。');
                  requireThat(BigInt(nonce)===BigInt(p.tx.nonce),'nonce 已变化，重新准备。');
                  requireThat(BigInt(bal)>=p.tx.value+p.maxCost,'余额已变化，重新准备。');
                  w.status='提交中';
                  const broadcastRpc=this.p.chainId===4663?{send:async(method,params)=>{
                    requireThat(method==='eth_sendRawTransaction','广播通道只允许已签名交易。');
                    const expected=keccak256(params[0]);
                    return Promise.any([rpc,new Rpc('https://sequencer.mainnet.chain.robinhood.com')].map(async target=>{
                      const hash=await target.send(method,params);requireThat(hash?.toLowerCase()===expected.toLowerCase(),'广播哈希不符。');return hash;
                    }));
                  }}:rpc;
                  const sent=await sendOnce({rpc:broadcastRpc,p:this.p,w,prepared:p,dir:this.dir,check:()=>this.check()});
                  w.hash=sent.hash;w.status=sent.uncertain?'结果待核实':'已广播';w.note=sent.uncertain?'广播回应不确定，不会重发。':'交易已提交，正在等待回执。';w.prepared=null;
                  this.log(`${w.address.slice(0,8)}… ${w.status}`);receiptOwnsLane=true;receiptTasks.push(this.receipt(rpc,w).finally(async()=>{if(['已入块成功','已入块未成功'].includes(w.status))this.coordinator.complete(this,w);await lane.release();}));
                }catch(e){
                  if(w.status==='提交中'){w.status='停止';w.note=safeError(e);}else if(e.revert!=='NotActive'){w.prepared=null;w.note=safeError(e);}
                }finally{if(!receiptOwnsLane)await lane.release();}
              });
            }
          }
          await this.wait(seconds<=2?100:seconds<=60?1000:5000);
        }catch(e){
          this.check();
          // Business-condition failures stop the task; transient RPC errors
          // invalidate preparations before any retry.
          if(e instanceof Stop&&!/请求超时|RPC 拒绝|RPC 返回|区块数据|节点区块时间/.test(e.message))throw e;
          for(const w of this.wallets)w.prepared=null;lastRead=0;
          if(Date.now()-lastError>5000){this.log(safeError(e));lastError=Date.now();}await this.wait(1000);
        }
      }
      this.status='等待回执';await Promise.allSettled(receiptTasks);this.status=this.controller.signal.aborted?'已停止':'已完成';
    }catch(e){this.log(this.controller.signal.aborted?'已停止；已广播交易不能撤回。':safeError(e));this.status=this.controller.signal.aborted?'已停止':'已结束';}
    finally {
      for(const w of this.wallets){w.signer=null;w.prepared=null;if(w.status==='等待')w.status='停止';}
      await Promise.allSettled(receiptTasks);
      await this.coordinator.unregister(this);this.finished=true;
    }
  }
}
