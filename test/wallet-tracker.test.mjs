import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {ZeroAddress} from 'ethers';
import {WalletTracker,TRANSFERS,FILLS,trackerSettings,decodeTransfers,classifyTransfer,trackerAlerts} from '../wallet-tracker.mjs';
import {SEAPORT} from '../nft-market.mjs';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),C='0x'+'3'.repeat(40),N='0x'+'4'.repeat(40),H='0x'+'a'.repeat(64),BH='0x'+'b'.repeat(64);
const w={address:A,label:'A',group:'test',cluster:'',focus:true};
function transfer(from=ZeroAddress,to=A){return {...TRANSFERS.encodeEventLog(TRANSFERS.getEvent('Transfer'),[from,to,7]),address:N,logIndex:'0x1',transactionHash:H,blockNumber:'0x64',blockHash:BH};}
const tx={hash:H,blockHash:BH,chainId:'0x1237',from:A,value:'0x5'},receipt={status:'0x1',transactionHash:H,blockHash:BH,gasUsed:'0x10',effectiveGasPrice:'0x2',logs:[]};
test('public wallet validation, deduplication and limits',()=>{assert.equal(trackerSettings({wallets:[w,w]}).wallets.length,1);assert.throws(()=>trackerSettings({wallets:[{address:'0x'+'1'.repeat(64)}]}));assert.throws(()=>trackerSettings({wallets:[{...w,label:'f'.repeat(64)}]}));assert.throws(()=>trackerSettings({wallets:[w],threshold:1}));});
test('NFT transfers decode; ERC20 and removed logs excluded',()=>{assert.equal(decodeTransfers(transfer())[0].tokenId,'7');assert.deepEqual(decodeTransfers({...transfer(),removed:true}),[]);assert.deepEqual(decodeTransfers({...transfer(),topics:transfer().topics.slice(0,3),data:'0x'+''.padStart(64,'0')}),[]);const b={...transfer(),...TRANSFERS.encodeEventLog(TRANSFERS.getEvent('TransferBatch'),[A,ZeroAddress,A,[1,2],[3,4]])};assert.deepEqual(decodeTransfers(b).map(x=>x.quantity),['3','4']);});
test('active mint requires payer; failures and wrong chain excluded',()=>{const t=decodeTransfers(transfer())[0];assert.equal(classifyTransfer(t,tx,receipt,w).kind,'mint');assert.equal(classifyTransfer(t,{...tx,from:B},receipt,w).actionable,false);assert.equal(classifyTransfer(t,tx,{...receipt,status:'0x0'},w),null);assert.equal(classifyTransfer(t,{...tx,chainId:'0x1'},receipt,w),null);assert.equal(classifyTransfer(decodeTransfers(transfer(B,A))[0],tx,receipt,w).kind,'received');});
test('Seaport matching verifies token and parties, classifies both sides',()=>{const log={address:SEAPORT,...FILLS.encodeEventLog(FILLS.getEvent('OrderFulfilled'),[H,B,ZeroAddress,A,[[2,N,7,1]],[[0,ZeroAddress,0,50,B]]])};const r={...receipt,logs:[log]},t=decodeTransfers(transfer(B,A))[0];assert.equal(classifyTransfer(t,tx,r,w).kind,'buy');assert.equal(classifyTransfer(t,tx,r,{...w,address:B}).kind,'sell');assert.equal(classifyTransfer(t,tx,r,w).payment.value,'50');assert.equal(classifyTransfer({...t,tokenId:'8'},tx,r,w).kind,'received');});
test('alerts suppress historical, passive and related-wallet duplicates',()=>{const now=Date.now(),base={contract:N,at:now,kind:'mint',actionable:true,historical:false,focus:false,cluster:''},events=[A,B,C].map((wallet,i)=>({...base,wallet,id:String(i)})),c=trackerSettings({wallets:[w]});assert.equal(trackerAlerts(events,c,now).length,1);assert.equal(trackerAlerts(events.map(e=>({...e,cluster:'same'})),c,now).length,0);assert.equal(trackerAlerts(events.map(e=>({...e,historical:true})),c,now).length,0);assert.equal(trackerAlerts(events.map(e=>({...e,actionable:false})),c,now).length,0);assert.equal(trackerAlerts([{...events[0],focus:true,label:'A'}],c,now).length,1);});
test('RPC failures do not skip blocks; checkpoint persists, restart history silent',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'mint-tracker-test-'));let fail=true,calls=[];const hash=n=>'0x'+Number(n).toString(16).padStart(64,'0');const rpc={send:async(m,p=[])=>{calls.push(m);if(m==='eth_chainId')return '0x1237';if(m==='eth_getBlockByNumber'){const n=p[0]==='latest'?102:Number(BigInt(p[0]));return {number:'0x'+n.toString(16),hash:hash(n),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};}if(m==='eth_getLogs'){if(fail)throw Error('network');return [];}throw Error('Unexpected '+m);}};
 try{const tr=new WalletTracker(root,{rpcFactory:()=>rpc});await tr.init();await tr.save({wallets:[w],lookbackBlocks:10});await tr.start('mock');while(tr.busy)await new Promise(r=>setTimeout(r,5));assert.equal(tr.cursor,90);assert.ok(tr.error);fail=false;await tr.tick();assert.equal(tr.cursor,100);assert.equal(tr.error,null);tr.stop();const next=new WalletTracker(root);await next.init();assert.equal(next.cursor,100);assert.ok(calls.every(m=>!m.includes('sendTransaction')&&!m.includes('sendRaw')));}finally{await rm(root,{recursive:true,force:true});}
});
test('nonempty scan deduplicates six filters and verifies receipts; reorg and stop cannot advance range',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mint-tracker-test-'));let changed=false,endReads=0,interrupt=false,tr;
 const rpc={call:async(_abi,_to,name)=>name==='name'?['Test NFT']:[true],send:async(m,p=[])=>{
  if(m==='eth_chainId')return '0x1237';
  if(m==='eth_getBlockByNumber'){const n=p[0]==='latest'?102:Number(BigInt(p[0]));if(n===100)endReads++;return {number:'0x'+n.toString(16),timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),hash:n===100?(changed&&endReads>1?'0x'+'c'.repeat(64):BH):'0x'+'d'.repeat(64)};}
  if(m==='eth_getLogs'){if(interrupt)tr.stop();return [transfer()];}
  if(m==='eth_getTransactionByHash')return tx;
  if(m==='eth_getTransactionReceipt')return receipt;
  throw Error(m);
 }};
 try{tr=new WalletTracker(root,{rpcFactory:()=>rpc});await tr.init();await tr.save({wallets:[w],lookbackBlocks:1});await tr.start('mock');while(tr.busy)await new Promise(r=>setTimeout(r,5));tr.stop();assert.equal(tr.events.length,1);assert.equal(tr.events[0].name,'Test NFT');assert.equal(tr.cursor,100);
  await tr.save({wallets:[w],lookbackBlocks:1});changed=true;endReads=0;await tr.start('mock');while(tr.busy)await new Promise(r=>setTimeout(r,5));tr.stop();assert.equal(tr.cursor,99);assert.equal(tr.events.length,0);assert.ok(tr.error);
  changed=false;interrupt=true;endReads=0;await tr.start('mock');while(tr.busy)await new Promise(r=>setTimeout(r,5));assert.equal(tr.running,false);assert.equal(tr.cursor,99);
 }finally{tr?.stop();await rm(root,{recursive:true,force:true});}
});
