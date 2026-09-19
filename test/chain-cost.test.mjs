import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,ZeroAddress} from 'ethers';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SEA,sea,nft} from '../lib.mjs';
import {verifiedMintCost,lookupMintCost} from '../chain-cost.mjs';
import {CostStore,costOutcome} from '../cost-basis.mjs';
const owner='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20),fee='0x'+'33'.repeat(20),hash='0x'+'aa'.repeat(32),blockHash='0x'+'bb'.repeat(32);
const events=new Interface(['event SeaDropMint(address indexed nftContract,address indexed minter,address indexed feeRecipient,address payer,uint256 quantityMinted,uint256 unitMintPrice,uint256 feeBps,uint256 dropStageIndex)']);
function fixture(q=1){
 const n={chainId:4663,owner,contract,tokenId:'7',standard:'erc721'};
 const tx={hash,blockHash,blockNumber:'0x10',chainId:'0x1237',from:owner,to:SEA,value:'0x'+(65n*BigInt(q)).toString(16),input:sea.encodeFunctionData('mintPublic',[contract,fee,owner,q])+'12345678'};
 const log=e=>({...e,address:contract,transactionHash:hash,blockHash,removed:false});
 const logs=Array.from({length:q},(_,i)=>log(nft.encodeEventLog(nft.getEvent('Transfer'),[ZeroAddress,owner,7+i])));
 logs.push({...log(events.encodeEventLog(events.getEvent('SeaDropMint'),[contract,owner,fee,owner,q,65,100,0])),address:SEA});
 const r={transactionHash:hash,blockHash,blockNumber:'0x10',status:'0x1',from:owner,to:SEA,gasUsed:'0x65',effectiveGasPrice:'0x1',logs};return {n,tx,r};
}
test('verified direct mint accepts attribution suffix, records payment and actual gas',()=>{const {n,tx,r}=fixture();const c=verifiedMintCost(n,tx,r);assert.equal(c.paid,'0.000000000000000065');assert.equal(c.gasEth,'0.000000000000000101');assert.equal(c.source,'chain-mint');});
test('batch mint allocates by verified unique token count, rounds up gas',()=>{const {n,tx,r}=fixture(2);const c=verifiedMintCost(n,tx,r);assert.equal(c.quantity,2);assert.equal(c.gasEth,'0.000000000000000051');r.logs[1]=r.logs[0];assert.throws(()=>verifiedMintCost(n,tx,r));});
for(const [name,mutate]of Object.entries({
 'failed receipt':f=>f.r.status='0x0',
 'other payer':f=>f.tx.from=fee,
 'wrong network':f=>f.tx.chainId='0x1',
 'unrelated transaction':f=>f.tx.to=contract,
 'unknown token':f=>f.n.tokenId='999',
 'reorg':f=>f.r.logs[0].removed=true,
 'mismatched price':f=>f.tx.value='0x0',
 'missing actual gas':f=>delete f.r.effectiveGasPrice,
 'incomplete mint events':f=>f.r.logs.pop()
}))test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>verifiedMintCost(f.n,f.tx,f.r));});
test('network mismatch stops discovery without accessing API or writing transactions',async()=>{let called=false;await assert.rejects(lookupMintCost(fixture().n,{send:async m=>{assert.equal(m,'eth_chainId');return '0x1';}},{request:async()=>{called=true;}}));assert.equal(called,false);});
test('unknown mint index yields explanation instead of zero cost',async()=>{await assert.rejects(lookupMintCost(fixture().n,{send:async()=> '0x1237'},{request:async()=>({asset_events:[],next:null})}),/尚未查到/);});
test('chain cache persists while manual cost retains priority; clearing restores chain',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'mint-chain-cost-'));try{const store=new CostStore(dir,path.join(dir,'attempts'));const {n,tx,r}=fixture();const c={...verifiedMintCost(n,tx,r),historyOnly:false};await store.saveChain(n,c);assert.equal((await store.get(n)).source,'chain-mint');await store.save(n,{symbol:'ETH',paid:'0.5',gasEth:''});await store.saveChain(n,c);assert.equal((await store.get(n)).paid,'0.5');assert.equal((await store.save(n,{clear:true})).source,'chain-mint');assert.equal(await store.get({...n,owner:fee}),null);}finally{await rm(dir,{recursive:true,force:true});}});
test('incomplete or transferred history does not produce current profit',()=>{const c={source:'chain-mint',paid:'0',gasEth:'0.0001',symbol:'ETH',historyOnly:true,historyNote:'转手记录不完整'};assert.equal(costOutcome(c,'1',{native:true,symbol:'ETH',decimals:18},'0','',100).status,'history');});
