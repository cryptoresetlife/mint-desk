import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProjectMarket,marketSales} from '../project-market.mjs';
const address='0x'+'1'.repeat(40),buyer='0x'+'2'.repeat(40),seller='0x'+'3'.repeat(40),hash='0x'+'4'.repeat(64);
const now=Date.UTC(2026,8,19),p={chainId:4663,address,slug:'wrong-slug'};
const sale={event_type:'sale',chain:'robinhood',quantity:1,nft:{contract:address,identifier:'7'},buyer,seller,transaction:hash,event_timestamp:now/1000-10,payment:{quantity:'20020000',decimals:6,symbol:'USDG'}};
test('成交价格保留币种和小数，仅取24h同链同合约单件二级成交并去重',()=>{
 const invalid=[{...sale,event_type:'mint'},{...sale,chain:'ethereum'},{...sale,nft:{contract:buyer}},{...sale,quantity:3},{...sale,seller:buyer},{...sale,seller:'0x'+'0'.repeat(40)},{...sale,event_timestamp:now/1000-86401},{...sale,event_timestamp:now/1000+1},{...sale,payment:{...sale.payment,decimals:undefined}}];
 const rows=marketSales([sale,...invalid,sale],p,now);assert.equal(rows.length,1);assert.deepEqual(rows[0].price,{value:'20.02',symbol:'USDG'});
});
test('按合约识别系列、分开地板和成交、合并并发请求并缓存，不返回密钥',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-market-')),keyFile=path.join(dir,'key.json');await writeFile(keyFile,JSON.stringify({apiKey:'test-only-secret'}));let calls=[];
 try{const service=new ProjectMarket(keyFile,{now:()=>now,fetcher:async(url,opt)=>{calls.push(url);assert.equal(opt.headers['x-api-key'],'test-only-secret');assert.equal(opt.redirect,'error');const body=url.includes('/contract/')?{address,chain:'robinhood',collection:'correct-slug'}:url.includes('/stats')?{total:{floor_price:698,floor_price_symbol:'USDG'}}:{asset_events:[sale]};return {ok:true,status:200,json:async()=>body};}});
 const [a,b]=await Promise.all([service.get(p),service.get(p)]);assert.deepEqual(a,b);assert.equal(calls.length,3);assert.equal(a.slug,'correct-slug');assert.deepEqual(a.floor,{value:'698',symbol:'USDG'});assert.equal(a.sales[0].price.value,'20.02');assert.ok(!JSON.stringify(a).includes('test-only-secret'));await service.get(p);assert.equal(calls.length,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('没有Key不请求；错误合约不借用行情；接口部分失败仍保留系列链接',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-market-')),file=path.join(dir,'key.json');
 try{let count=0;const no=new ProjectMarket(file,{fetcher:async()=>{count++;}});await assert.rejects(()=>no.get(p),/API Key/);assert.equal(count,0);await writeFile(file,JSON.stringify({apiKey:'fixture-key'}));
 const wrong=new ProjectMarket(file,{fetcher:async()=>({ok:true,json:async()=>({address:buyer,chain:'robinhood',collection:'wrong'})})});await assert.rejects(()=>wrong.get(p),/不匹配/);
 const partial=new ProjectMarket(file,{now:()=>now,fetcher:async url=>url.includes('/contract/')?{ok:true,json:async()=>({address,chain:'robinhood',collection:'correct'})}:{ok:false,status:403}});const r=await partial.get(p);assert.equal(r.floor,null);assert.deepEqual(r.sales,[]);assert.equal(r.warnings.length,2);assert.equal(r.url,'https://opensea.io/collection/correct/overview');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('名称跳转只查合约，校验链与地址，并发合并并缓存系列链接',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-link-')),file=path.join(dir,'key.json');
 try{await writeFile(file,JSON.stringify({apiKey:'fixture-key'}));let count=0;
 const service=new ProjectMarket(file,{now:()=>now,fetcher:async url=>{count++;assert.ok(url.endsWith('/chain/robinhood/contract/'+address));return {ok:true,json:async()=>({address,chain:'robinhood',collection:{slug:'matching-collection'}})};}});
 const [a,b]=await Promise.all([service.link(p),service.link(p)]);assert.deepEqual(a,b);assert.equal(count,1);assert.equal(a.url,'https://opensea.io/collection/matching-collection/overview');await service.link(p);assert.equal(count,1);
 const mismatch=new ProjectMarket(file,{fetcher:async()=>({ok:true,json:async()=>({address,chain:'ethereum',collection:'wrong-chain'})})});await assert.rejects(()=>mismatch.link(p),/不匹配/);
 const invalid=new ProjectMarket(file,{fetcher:async()=>({ok:true,json:async()=>({address,chain:'robinhood',collection:'../bad?redirect=evil'})})});await assert.rejects(()=>invalid.link(p),/系列链接/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
