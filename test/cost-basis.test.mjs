import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {CostStore,manualCost,recordedCost,costOutcome} from '../cost-basis.mjs';
const eth={native:true,symbol:'ETH',decimals:18},usd={native:false,symbol:'USDG',decimals:6};
const n={chainId:4663,owner:'0x'+'a'.repeat(40),contract:'0x'+'b'.repeat(40),tokenId:'7'};
test('historical mint costs require matching successful receipt and allocate actual payment plus gas per unit',()=>{
 const a={chainId:4663,address:n.owner,nft:n.contract,hash:'0x123',quantity:2,value:'4000000000000000'},r={hash:a.hash,success:true,tokenIds:['7','8'],receipt:{transactionHash:a.hash,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00'}};
 assert.deepEqual(recordedCost(a,r,n),{source:'mint-record',symbol:'ETH',paid:'0.002',gasEth:'0.0000105',hash:a.hash,quantity:2});
 for(const bad of [{...r,success:false},{...r,hash:'0x456'},{...r,tokenIds:['7']},{...r,tokenIds:['7','7']}])assert.equal(recordedCost(a,bad,n),null);
 assert.equal(recordedCost({...a,chainId:1},r,n),null);assert.equal(recordedCost(a,r,{...n,tokenId:'9'}),null);
});
test('cost inputs distinguish unknown gas from zero; invalid precision and negative inputs fail',()=>{
 assert.equal(manualCost({symbol:'ETH',paid:'0',gasEth:''}).gasEth,null);
 for(const paid of ['-1','1e4','NaN','0.1234567890123456789'])assert.throws(()=>manualCost({symbol:'ETH',paid,gasEth:'0'}));
 assert.throws(()=>manualCost({symbol:'FAKE',paid:'1',gasEth:'0'}));
});
test('quote profits include acquisition gas and estimated approval; missing FX never produces false profit',()=>{
 const cost=manualCost({symbol:'ETH',paid:'0.001',gasEth:'0.00001'});
 assert.equal(costOutcome(cost,'2.97',usd,'0.000005','').status,'rate');
 const out=costOutcome(cost,'2.97',usd,'0.000005','2500',100);
 assert.equal(out.total,'2.5375');assert.equal(out.profit,'0.4325');assert.equal(out.breakEven,'2.563132');
 assert.equal(costOutcome(cost,'0.003',eth,'0.000005','',100).profit,'0.001985');
 assert.equal(costOutcome(null,'3',usd,'0','').status,'missing');
 assert.equal(costOutcome({...cost,gasEth:null},'3',usd,'0','2500').status,'incomplete');
 assert.equal(costOutcome({...cost,symbol:'USDC'},'3',usd,'0','2500').status,'currency');
 assert.equal(costOutcome(manualCost({symbol:'USDG',paid:'4',gasEth:'0'}),'2.97',usd,'0','').profit,'-1.03');
});
test('manual costs persist by wallet/chain/NFT and clearing never removes other wallet records',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-cost-'));try{
 const store=new CostStore(path.join(dir,'costs'),path.join(dir,'attempts')),b={symbol:'USDG',paid:'2',gasEth:'0'};
 await store.save(n,b);assert.equal((await store.get(n)).paid,'2.0');
 assert.equal(await store.get({...n,owner:'0x'+'c'.repeat(40)}),null);
 await store.save({...n,tokenId:'8'},{...b,paid:'4'});
 assert.equal(await store.save(n,{clear:true}),null);assert.equal((await store.get({...n,tokenId:'8'})).paid,'4.0');
 await mkdir(path.join(dir,'costs'),{recursive:true});await writeFile(store.file(n),'broken');assert.equal((await store.get(n)).source,'invalid');
 }finally{await rm(dir,{recursive:true,force:true});}
});
