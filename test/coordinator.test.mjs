import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {Wallet,parseEther,keccak256,Transaction,ZeroAddress} from 'ethers';
import {WalletCoordinator,walletBudget} from '../coordinator.mjs';
import {MintJob} from '../engine.mjs';
import {CHAINS,sea,nft,recordPath} from '../lib.mjs';
const project=n=>({id:'p'+n,chainId:4663,address:'0x'+n.toString(16).padStart(40,'0'),quantity:1,maxPriceEth:'0.01',maxGasEth:'0.001',rpcUrl:'https://mock.invalid',name:'Fixture '+n});
const makeJob=(id,p,ws,dir)=>({id,p,wallets:ws,dir,check(){}});
test('two projects share wallet guard; one sending lane per wallet, different wallets parallel; release only own claims',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-coord-')),c=new WalletCoordinator(),ws=[{address:Wallet.createRandom().address},{address:Wallet.createRandom().address}],rpc={send:async()=>parseEther('1').toString()};
 const a=makeJob('a',project(1),ws,dir),b=makeJob('b',project(2),[ws[0]],dir);
 try{await Promise.all([c.register(a,rpc),c.register(b,rpc)]);assert.equal(c.reserved(a.p,ws[0].address),walletBudget(a.p)*2n);
 const first=c.take(a,ws[0]);assert.ok(first);assert.equal(c.take(b,ws[0]),null);const other=c.take(a,ws[1]);assert.ok(other);await other.release();await first.release();
 const second=c.take(b,ws[0]);assert.ok(second);await second.release();c.complete(a,ws[0]);assert.equal(c.reserved(a.p,ws[0].address),walletBudget(b.p));await c.unregister(a);assert.equal(c.entries.size,1);
 }finally{await c.unregister(a);await c.unregister(b);await rm(dir,{recursive:true,force:true});}
});
test('concurrent budget admission cannot double spend reservations; duplicate series rejected',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-budget-')),c=new WalletCoordinator(),w={address:Wallet.createRandom().address},rpc={send:async()=>parseEther('0.015').toString()},a=makeJob('a',project(1),[w],dir),b=makeJob('b',project(2),[w],dir);
 try{const r=await Promise.allSettled([c.register(a,rpc),c.register(b,rpc)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(c.reserved(a.p,w.address),walletBudget(a.p));await assert.rejects(()=>c.register(makeJob('c',project(1),[w],dir),rpc),/已有等待任务/);
 }finally{await c.unregister(a);await c.unregister(b);await rm(dir,{recursive:true,force:true});}
});

test('failed multi-wallet admission rolls back only its own claims; stopping a waiting job preserves another send lane',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-rollback-')),c=new WalletCoordinator(),ws=[{address:Wallet.createRandom().address},{address:Wallet.createRandom().address}],rpc={send:async(_,[address])=>parseEther(address===ws[0].address?'1':'0').toString()},a=makeJob('a',project(1),[ws[0]],dir),b=makeJob('b',project(2),ws,dir),d=makeJob('d',project(3),[ws[0]],dir);let lane;
 try{await c.register(a,rpc);lane=c.take(a,ws[0]);await assert.rejects(()=>c.register(b,rpc),/余额不足/);assert.equal(c.entries.size,1);assert.equal(c.reserved(a.p,ws[0].address),walletBudget(a.p));await c.register(d,rpc);await c.unregister(d);assert.equal(c.busy(a.p,ws[0].address),true);assert.equal(c.take(b,ws[0]),null);await lane.release();assert.equal(c.busy(a.p,ws[0].address),false);assert.equal(c.take(d,ws[0]),null);}
 finally{await lane?.release();await c.unregister(a);await c.unregister(b);await c.unregister(d);await rm(dir,{recursive:true,force:true});}
});
test('unknown prior broadcast blocks after restart even if pending nonce looks free; receipt sets nonce floor',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-barrier-')),c=new WalletCoordinator(),w=Wallet.createRandom(),p=project(1),hash='0x'+'1'.repeat(64);
 try{await writeFile(recordPath(dir,p,w.address),JSON.stringify({hash,chainId:4663,address:w.address,nonce:7}));await assert.rejects(()=>c.historyBarrier(dir,p,w.address,{send:async()=>null}),/尚未确认/);assert.equal(await c.historyBarrier(dir,p,w.address,{send:async()=>({status:'0x0',transactionHash:hash})}),8n);await assert.rejects(()=>c.historyBarrier(dir,p,w.address,{send:async()=>({status:'0x1',transactionHash:'0x'+'2'.repeat(64)})}),/不匹配/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('end to end: two live projects for one wallet send distinct sequential nonces only after receipt; never replace earlier transaction',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-multi-')),savedFetch=globalThis.fetch,savedHash=CHAINS[4663].seaHash,c=new WalletCoordinator(),signer=Wallet.createRandom(),w={address:signer.address,signer},sent=new Map();let latest=0;const now=Math.floor(Date.now()/1000);
 CHAINS[4663].seaHash=keccak256('0x00');
 globalThis.fetch=async(url,opt)=>{const {method,params}=JSON.parse(opt.body);let result;
  if(method==='eth_chainId')result='0x1237';else if(method==='eth_getCode')result='0x00';else if(method==='eth_getBlockByNumber')result={number:'0x10',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
  else if(method==='eth_getBalance')result=parseEther('1').toString();else if(method==='eth_getTransactionCount')result='0x'+(params[1]==='pending'?sent.size:latest).toString(16);
  else if(method==='eth_estimateGas')result='0x186a0';else if(method==='eth_gasPrice')result='0xf4240';
  else if(method==='eth_call'){let call;try{call=sea.parseTransaction({data:params[0].data});}catch{}
   if(call?.name==='getPublicDrop')result=sea.encodeFunctionResult('getPublicDrop',[[0,now-20,now+120,2,0,false]]);
   else if(call?.name==='getFeeRecipientIsAllowed')result=sea.encodeFunctionResult('getFeeRecipientIsAllowed',[true]);else if(call?.name==='mintPublic')result='0x';
   else{const call=nft.parseTransaction({data:params[0].data});result=call.name==='name'?nft.encodeFunctionResult('name',['Fixture']):nft.encodeFunctionResult('getMintStats',[0,0,100]);}}
  else if(method==='eth_sendRawTransaction'){const tx=Transaction.from(params[0]);if(!sent.has(tx.hash)){assert.equal(tx.nonce,latest,'cannot send until previous receipt');assert.equal(tx.nonce,sent.size,'no nonce replacement');sent.set(tx.hash,{tx,at:Date.now()});}result=tx.hash;}
  else if(method==='eth_getTransactionReceipt'){const record=sent.get(params[0]);if(!record||Date.now()-record.at<40)result=null;else{latest=Math.max(latest,record.tx.nonce+1);const contract=sea.parseTransaction({data:record.tx.data}).args[0];result={transactionHash:record.tx.hash,status:'0x1',gasUsed:'0x10000',effectiveGasPrice:'0xf4240',logs:[{address:contract,...nft.encodeEventLog(nft.getEvent('Transfer'),[ZeroAddress,signer.address,1])}]};}}
  else throw Error('Unexpected '+method);return {ok:true,json:async()=>({result})};
 };
 const jobs=[1,2].map(n=>new MintJob({id:'job'+n,project:project(n),wallets:[w],dir,coord:c,review:{codeHash:keccak256('0x00')}}));
 for(const job of jobs)job.wait=async()=>new Promise(r=>setTimeout(r,15));const timer=setTimeout(()=>jobs.forEach(j=>j.stop()),6000);
 try{await Promise.all(jobs.map(j=>j.run()));assert.equal(sent.size,2,JSON.stringify(jobs.map(j=>j.view()),(_,v)=>typeof v==="bigint"?v.toString():v));assert.deepEqual([...sent.values()].map(r=>r.tx.nonce),[0,1]);assert.ok(jobs.every(j=>j.wallets[0].status==='已入块成功'));assert.equal(c.entries.size,0);}
 finally{clearTimeout(timer);jobs.forEach(j=>j.stop());globalThis.fetch=savedFetch;CHAINS[4663].seaHash=savedHash;await rm(dir,{recursive:true,force:true});}
});
