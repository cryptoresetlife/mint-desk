import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Wallet, parseEther, ZeroAddress, keccak256 } from 'ethers';
import { settings, amount, Rpc, Stop, SEA, FEE, CHAINS, sea, nft, mintRequest, gasPlan, validateSale, validateSigned, sendOnce, recordPath, mintedIds, identity, prepare, snapshot } from '../lib.mjs';
import { limited, MintJob } from '../engine.mjs';
const p={chainId:4663,address:'0x116eaa62241751e0c98da43d458600c6c17cd361',quantity:2,maxPriceEth:'0.002',maxGasEth:'0.1',rpcUrl:'http://127.0.0.1:18547'};
const s={block:'0x10',timestamp:100,start:90,end:200,price:parseEther('0.001'),limit:3n,minted:0n,total:90n,supply:100n,restricted:true,allowed:true,feeBps:1000n};
const w={signer:Wallet.createRandom()};w.address=w.signer.address;
const tx={chainId:4663,type:0,to:SEA,data:mintRequest(p,w.address,s).data,value:parseEther('0.002'),nonce:0,gasLimit:100000n,gasPrice:1000000n};
test('自填 0.1 gas 合法；零、负数和错误单位不接受',()=>{assert.equal(settings(p).maxGasEth,'0.1');for(const v of ['0','-1','1e-3','NaN','0.1234567890123456789'])assert.throws(()=>amount(v,'gas'));});
test('价格取当前链上价乘数量，而非填写的最高预算',()=>{assert.equal(BigInt(mintRequest(p,w.address,s).value),parseEther('0.002'));assert.equal(sea.parseTransaction({data:tx.data}).args[3],2n);});
test('gas 余量、gas 上限和付费 mint 余额同时计入',()=>{const r=gasPlan(100000n,1000000n,parseEther('1'),parseEther('0.5'),'0.1');assert.equal(r.gasLimit,125000n);assert.equal(r.gasPrice,1200000n);assert.throws(()=>gasPlan(100000n,100000000000n,parseEther('1'),0n,'0.001'));assert.throws(()=>gasPlan(100000n,1000000n,parseEther('0.5'),parseEther('0.5'),'0.1'));});
test('公售价格、库存、钱包额度、费用接收许可及结束检查',()=>{validateSale(p,s);for(const changes of [{price:parseEther('0.003')},{total:99n},{minted:2n},{allowed:false},{end:100},{start:0}])assert.throws(()=>validateSale(p,{...s,...changes}));});
test('签名必须匹配链、付款人、接收系列、数量与授权预算',async()=>{const raw=await w.signer.signTransaction(tx);validateSigned(raw,p,w.address,tx);for(const change of [{chainId:1},{quantity:1},{maxPriceEth:'0'},{maxGasEth:'0.000000001'}])assert.throws(()=>validateSigned(raw,{...p,...change},w.address,tx));const wrong=await w.signer.signTransaction({...tx,to:w.address});assert.throws(()=>validateSigned(wrong,p,w.address,tx));});
test('广播超时也持久保留哈希，第二次无法再发送；没有私钥或签名原文落盘',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'mint-test-'));try{const raw=await w.signer.signTransaction(tx);let calls=0;const rpc={send:async()=>{calls++;throw Error('timeout');}};const args={rpc,p,w,prepared:{raw,tx},dir};const r=await sendOnce(args);assert.equal(r.uncertain,true);assert.equal(r.hash,keccak256(raw));await assert.rejects(sendOnce(args));assert.equal(calls,1);const text=await readFile(recordPath(dir,p,w.address),'utf8');assert.ok(!text.includes(w.signer.privateKey));assert.ok(!text.includes(raw));}finally{await rm(dir,{recursive:true,force:true});}});
test('停止信号在广播前再次检查，不发送交易',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'mint-test-'));try{let checked=0,sent=0;const raw=await w.signer.signTransaction(tx);const r=await sendOnce({p,w,prepared:{raw,tx},dir,rpc:{send:async()=>{sent++;}},check:()=>{if(++checked>=2)throw new Stop('stopped');}});assert.equal(sent,0);assert.equal(r.uncertain,true);assert.equal((await readdir(dir)).length,1);}finally{await rm(dir,{recursive:true,force:true});}});
test('多个并发发送只有一个能创建广播记录',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'mint-test-'));try{const raw=await w.signer.signTransaction(tx);let sent=0;const args={p,w,prepared:{raw,tx},dir,rpc:{send:async()=>{sent++;return keccak256(raw);}}};const results=await Promise.allSettled([sendOnce(args),sendOnce(args)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(sent,1);}finally{await rm(dir,{recursive:true,force:true});}});
test('RPC 错误不会暴露 API key 和原始签名',async()=>{const rpc=new Rpc('https://example.com/private-key',async()=>({ok:true,json:async()=>({error:{message:'secret signed raw data',data:'secret'}})}));await assert.rejects(rpc.send('eth_call'),e=>!e.message.includes('secret')&&!e.message.includes('private-key'));});
test('错链在签名前拒绝',async()=>{const rpc={send:async m=>m==='eth_chainId'?'0x1':'0x00',call:async()=>['NFT']};await assert.rejects(identity(rpc,p),/链 ID/);});
test('钱包回执只接受目标 NFT 从零地址铸造到指定钱包的 Transfer',()=>{const event=nft.encodeEventLog(nft.getEvent('Transfer'),[ZeroAddress,w.address,42]);const r={logs:[{address:p.address,...event}]};assert.deepEqual(mintedIds(r,p,w.address),['42']);assert.deepEqual(mintedIds(r,p,Wallet.createRandom().address),[]);assert.deepEqual(mintedIds({logs:[{...r.logs[0],address:SEA}]},p,w.address),[]);});
test('并发工作不等待第一项完成才启动第二项；失败时等全部 worker 收尾',async()=>{let peak=0,n=0,done=0;await limited([1,2,3,4],2,async()=>{n++;peak=Math.max(peak,n);await new Promise(r=>setTimeout(r,10));n--;done++;});assert.equal(peak,2);assert.equal(done,4);let ended=false;await assert.rejects(limited([1,2],2,async v=>{if(v===1)throw Error();await new Promise(r=>setTimeout(r,10));ended=true;}));assert.equal(ended,true);});
test('提前预演没有预期 mint 日志时不签名',async()=>{let signed=false;const rpc={send:async m=>m==='eth_estimateGas'?'0x10000':[{timestamp:'0x5a',calls:[{status:'0x1',gasUsed:'0x100',logs:[]}]}]};await assert.rejects(prepare(rpc,p,{address:w.address,signer:{signTransaction:()=>{signed=true;}}},{...s,timestamp:80},true));assert.equal(signed,false);});
test('pending nonce 不一致不签名',async()=>{let signed=false;const rpc={send:async(m,args)=>({eth_estimateGas:'0x10000',eth_call:'0x',eth_gasPrice:'0x100',eth_getBalance:'0xde0b6b3a7640000',eth_getTransactionCount:args?.[1]==='pending'?'0x2':'0x1'})[m]};await assert.rejects(prepare(rpc,p,{address:w.address,signer:{signTransaction:()=>{signed=true;}}},s),/nonce/);assert.equal(signed,false);});
test('全部 sale 字段在同一区块读取，旧区块拒绝',async()=>{const calls=[],rpc={send:async()=>({number:'0x20',timestamp:'0x1'}),call:async(a,to,name,args,tag)=>{calls.push(tag);return name==='getPublicDrop'?[{mintPrice:0n,startTime:1n,endTime:100n,maxTotalMintableByWallet:1n,feeBps:0n,restrictFeeRecipients:false}]:name==='getMintStats'?[0n,0n,100n]:[true];}};await assert.rejects(snapshot(rpc,p),/时间/);assert.deepEqual(calls,['0x20','0x20','0x20']);});
test('运行状态导出不包含私钥、RPC key 或预签名原文',()=>{const job=new MintJob({id:'test',project:{...p,rpcUrl:'https://example.com/secret'},wallets:[w],dir:'unused',review:{}});job.wallets[0].prepared={raw:'private-raw'};const text=JSON.stringify(job.view());assert.ok(!text.includes('private-raw'));assert.ok(!text.includes('secret'));assert.ok(!text.includes(w.signer.privateKey));job.stop();assert.throws(()=>job.check());});
for(const stopping of [false,true])test(stopping?'完整任务：pending 返回前停止，不广播':'完整任务：模拟 RPC 完成两钱包并发签名、一次广播与回执核验',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mint-e2e-')),savedFetch=globalThis.fetch,savedHash=CHAINS[4663].seaHash;
  const signers=[Wallet.createRandom(),Wallet.createRandom()],ws=signers.map(signer=>({address:signer.address,signer}));
  const receipts=new Map(),gateCalls=new Map();let sends=0,job;
  CHAINS[4663].seaHash=keccak256('0x00');
  globalThis.fetch=async(_url,opt)=>{
    const {method,params}=JSON.parse(opt.body);let result;
    if(method==='eth_chainId')result='0x1237';
    else if(method==='eth_getCode')result='0x00';
    else if(method==='eth_getBlockByNumber')result={number:'0x10',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
    else if(method==='eth_call'){
      const req=params[0];let parsed;try{parsed=sea.parseTransaction({data:req.data});}catch{}
      if(parsed?.name==='getPublicDrop'){const t=Math.floor(Date.now()/1000);result=sea.encodeFunctionResult('getPublicDrop',[[parseEther('0.001'),t-100,t+1000,5,1000,true]]);}
      else if(parsed?.name==='getFeeRecipientIsAllowed')result=sea.encodeFunctionResult('getFeeRecipientIsAllowed',[true]);
      else if(parsed?.name==='mintPublic'){const count=(gateCalls.get(req.from)||0)+1;gateCalls.set(req.from,count);if(stopping&&count===2)job.stop();result='0x';}
      else {const parsedNft=nft.parseTransaction({data:req.data});result=parsedNft.name==='name'?nft.encodeFunctionResult('name',['Test NFT']):nft.encodeFunctionResult('getMintStats',[0,90,100]);}
    }else if(method==='eth_estimateGas')result='0x186a0';
    else if(method==='eth_gasPrice')result='0xf4240';
    else if(method==='eth_getBalance')result='0xde0b6b3a7640000';
    else if(method==='eth_getTransactionCount')result='0x0';
    else if(method==='eth_sendRawTransaction'){
      sends++;const {Transaction}=await import('ethers'),t=Transaction.from(params[0]);result=t.hash;
      receipts.set(result,{status:'0x1',gasUsed:'0x10000',effectiveGasPrice:'0xf4240',logs:[42,43].map(id=>({address:p.address,...nft.encodeEventLog(nft.getEvent('Transfer'),[ZeroAddress,t.from,id])}))});
    }else if(method==='eth_getTransactionReceipt')result=receipts.get(params[0])||null;
    else throw Error('Unexpected method '+method);
    return {ok:true,json:async()=>({result})};
  };
  try {
    job=new MintJob({id:'test',project:{...p,rpcUrl:'https://mock.invalid'},wallets:ws,dir,review:{codeHash:keccak256('0x00')}});
    await job.run();assert.equal(sends,stopping?0:4);assert.equal(receipts.size,stopping?0:2);assert.equal(job.status,stopping?'已停止':'已完成');
    if(!stopping){assert.ok(job.wallets.every(w=>w.status==='已入块成功'));assert.ok(job.wallets.every(w=>w.tokenIds.length===2));}
    assert.ok(job.wallets.every(w=>w.signer===null));
  }finally{globalThis.fetch=savedFetch;CHAINS[4663].seaHash=savedHash;await rm(dir,{recursive:true,force:true});}
});
