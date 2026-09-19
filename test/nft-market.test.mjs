import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Wallet,TypedDataEncoder,Transaction,parseEther,ZeroAddress,keccak256,verifyTypedData} from 'ethers';
import {NftMarket,ListingJob,feePlan,buildOrder,activeListingMap,SEAPORT,CONDUITS,NFT_ABI,ORDER_TYPES,listingAmount,listingCurrency} from '../nft-market.mjs';
import {WalletCoordinator} from '../coordinator.mjs';
const contract='0x'+ 'a'.repeat(40),feeRecipient='0x'+'b'.repeat(40);
async function fixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'mint-nfts-')),signer=Wallet.createRandom(),wallet={id:'w',address:signer.address,signer},n={chainId:4663,walletId:'w',owner:signer.address,contract,tokenId:'7',standard:'erc721',slug:'fixture',name:'Fixture NFT',url:'https://opensea.io/assets/robinhood/'+contract+'/7'};
 const domain={name:'Seaport',version:'1.6',chainId:4663,verifyingContract:SEAPORT};
 const state={standard:'erc721',approved:false,nonce:0,posts:[],broadcasts:[],active:[],unknown:false,lost:false,fee:2.5,signatureCount:0,currency:{chain:'robinhood',address:ZeroAddress,decimals:18,symbol:'ETH'},currencyDecimals:null,currencySymbol:null,currencyCode:'0x6000'};
 const collection=()=>({pricing_currencies:{listing_currency:state.currency},collection:'fixture',contracts:[{chain:'robinhood',address:contract}],fees:[{recipient:feeRecipient,fee:state.fee,required:true}]});
 const api={request:async(endpoint,body)=>{
  if(endpoint.startsWith('account/'))return {listings:state.active};
  if(endpoint.includes('/account/'))return {nfts:[{contract,identifier:'7',token_standard:state.standard,name:'Fixture NFT',collection:'fixture'}]};
  if(endpoint==='collections/fixture')return collection();
  if(endpoint.includes('/nfts/7'))return {nft:{contract,identifier:'7',token_standard:state.standard,collection:'fixture'}};
  if(endpoint.startsWith('orders/')){state.posts.push(body);const hash=TypedDataEncoder.hashStruct('OrderComponents',ORDER_TYPES,body.parameters);if(state.unknown)throw Error('timeout');assert.equal(verifyTypedData(domain,ORDER_TYPES,body.parameters,body.signature),signer.address);return {order_hash:hash};}
  throw Error('unexpected API '+endpoint);
 }};
 const rpc={call:async(_abi,to,name,args)=>{
  if(name==='decimals')return [BigInt(state.currencyDecimals??state.currency.decimals)];if(name==='symbol')return [state.currencySymbol??state.currency.symbol];
  if(name==='information')return ['1.6',TypedDataEncoder.hashDomain(domain),'0x00000000f9490004c11cef243f5400493c00ad63'];
  if(name==='getConduit')return [CONDUITS[4663].address,true];if(name==='getChannelStatus'){assert.equal(to.toLowerCase(),'0x00000000f9490004c11cef243f5400493c00ad63');assert.deepEqual(args,[CONDUITS[4663].address,SEAPORT]);return [true];}if(name==='supportsInterface')return [true];
  if(name==='ownerOf')return [state.lost?ZeroAddress:signer.address];if(name==='balanceOf')return [1n];
  if(name==='isApprovedForAll')return [state.standard==='erc1155'&&state.approved];if(name==='getApproved')return [state.approved?CONDUITS[4663].address:ZeroAddress];
  if(name==='getCounter')return [0n];if(name==='getOrderHash')return [TypedDataEncoder.hashStruct('OrderComponents',ORDER_TYPES,args[0])];throw Error('unexpected call '+name);
 },send:async(method,params=[])=>{
  if(method==='eth_getCode')return state.currencyCode;
  if(method==='eth_chainId')return '0x1237';if(method==='eth_getBlockByNumber')return {timestamp:'0x'+Math.floor(Date.now()/1000).toString(16)};
  if(method==='eth_getBalance')return parseEther('1').toString();if(method==='eth_getTransactionCount')return '0x'+state.nonce.toString(16);if(method==='eth_estimateGas')return '0xc350';if(method==='eth_gasPrice')return '0xf4240';
  if(method==='eth_sendRawTransaction'){const tx=Transaction.from(params[0]);assert.equal(tx.to.toLowerCase(),contract);assert.equal(tx.value,0n);assert.equal(tx.nonce,state.nonce);const data=NFT_ABI.parseTransaction({data:tx.data});assert.equal(data.name,state.standard==='erc721'?'approve':'setApprovalForAll');assert.equal(data.args[0].toLowerCase(),CONDUITS[4663].address);assert.equal(data.args[1],state.standard==='erc721'?7n:true);state.broadcasts.push(tx);state.approved=true;state.nonce++;return keccak256(params[0]);}
  if(method==='eth_getTransactionReceipt')return {status:'0x1',transactionHash:params[0]};throw Error('unexpected RPC '+method);
 }};
 const market=new NftMarket({records:path.join(dir,'attempts'),dir:path.join(dir,'listings'),api,rpcFactory:()=>rpc,coord:new WalletCoordinator()});
 const inventory=await market.inventory(wallet,4663,'https://mock.invalid');const request={itemIds:[inventory.items[0].id],priceEth:'0.1',maxGasEth:'0.001',hours:24};
 return {dir,signer,wallet,n,domain,state,market,rpc,request,collection,cleanup:async()=>rm(dir,{recursive:true,force:true})};
}
test('listing fixes asset, quantity, chain, price, seller proceeds and fees; zero price and unsupported zone fail closed',async()=>{
 const f=await fixture();try{const fees=feePlan(f.collection(),f.n,parseEther('0.1'));assert.equal(fees.net,parseEther('0.0975').toString());const order=buildOrder(f.n,parseEther('0.1'),fees,4,100,200);assert.equal(order.offer.length,1);assert.equal(order.offer[0].identifierOrCriteria,'7');assert.equal(order.offer[0].startAmount,'1');assert.equal(order.consideration[0].recipient,f.wallet.address);assert.equal(order.consideration.reduce((a,b)=>a+BigInt(b.startAmount),0n),parseEther('0.1'));assert.equal(order.zone,ZeroAddress);assert.equal(order.orderType,0);assert.throws(()=>feePlan({...f.collection(),required_zone:contract},f.n,parseEther('0.1')),/特殊交易区域/);await assert.rejects(()=>f.market.preview({...f.request,priceEth:'0'},[f.wallet],'https://mock.invalid'),/大于 0/);}finally{await f.cleanup();}
});
test('preview is read-only, shows approval and net proceeds, and refuses insufficient gas cap',async()=>{
 const f=await fixture();try{const r=await f.market.preview(f.request,[f.wallet],'https://mock.invalid');assert.equal(r.rows[0].netEth,'0.0975');assert.equal(r.rows[0].approvalNeeded,true);assert.equal(f.state.posts.length,0);assert.equal(f.state.broadcasts.length,0);await assert.rejects(()=>f.market.preview({...f.request,maxGasEth:'0.000000001'},[f.wallet],'https://mock.invalid'),/超过预算/);}finally{await f.cleanup();}
});
test('end-to-end: approve only selected ERC721 to fixed conduit; sign exact order once; no secret persists',async()=>{
 const f=await fixture();try{const r=await f.market.preview(f.request,[f.wallet],'https://mock.invalid');const job=new ListingJob({id:'list-test',review:f.market.reviews.get(r.reviewId),wallet:f.wallet,market:f.market});await job.run();assert.equal(job.status,'已完成',JSON.stringify(job.view()));assert.equal(f.state.broadcasts.length,1);assert.equal(f.state.posts.length,1);assert.equal(f.state.posts[0].protocol_address,SEAPORT);assert.equal(job.results[0].priceEth,'0.1');assert.equal(f.market.coord.entries.size,0);for(const sub of ['attempts','listings'])for(const file of await readdir(path.join(f.dir,sub))){const text=await readFile(path.join(f.dir,sub,file),'utf8');assert.ok(!text.includes(f.signer.privateKey));assert.ok(!text.includes(f.state.posts[0].signature));}await assert.rejects(()=>f.market.preview(f.request,[f.wallet],'https://mock.invalid'),/未过期/);}finally{await f.cleanup();}
});
test('fee changes or ownership loss between preview and run never approve or post',async()=>{
 for(const mode of ['fee','lost']){const f=await fixture();try{const r=await f.market.preview(f.request,[f.wallet],'https://mock.invalid');if(mode==='fee')f.state.fee=5;else f.state.lost=true;const job=new ListingJob({id:mode,review:f.market.reviews.get(r.reviewId),wallet:f.wallet,market:f.market});await job.run();assert.equal(job.status,'已结束');assert.equal(f.state.broadcasts.length,0);assert.equal(f.state.posts.length,0);}finally{await f.cleanup();}}
});
test('uncertain API submission keeps durable hash and blocks repeated listing after restart',async()=>{
 const f=await fixture();try{const r=await f.market.preview(f.request,[f.wallet],'https://mock.invalid');f.state.unknown=true;const job=new ListingJob({id:'uncertain',review:f.market.reviews.get(r.reviewId),wallet:f.wallet,market:f.market});await job.run();assert.equal(job.status,'已结束');assert.equal(f.state.posts.length,1);assert.equal(job.results[0].status,'提交待核实');const restarted=new NftMarket({records:f.market.records,dir:f.market.dir,api:f.market.api,rpcFactory:()=>f.rpc});const result=await restarted.inventory(f.wallet,4663,'https://mock.invalid');await assert.rejects(()=>restarted.preview({...f.request,itemIds:[result.items[0].id]},[f.wallet],'https://mock.invalid'),/未过期/);assert.equal(f.state.posts.length,1);}finally{await f.cleanup();}
});
test('stop while waiting for same-wallet mint lane never signs or broadcasts and preserves mint claim',async()=>{
 const f=await fixture();let lane,mint;try{const r=await f.market.preview(f.request,[f.wallet],'https://mock.invalid');mint={id:'mint',p:{chainId:4663,address:contract,quantity:1,maxPriceEth:'0',maxGasEth:'0.001'},wallets:[f.wallet],dir:f.market.records,check(){}};await f.market.coord.register(mint,f.rpc);lane=f.market.coord.take(mint,f.wallet);const job=new ListingJob({id:'waiting-list',review:f.market.reviews.get(r.reviewId),wallet:f.wallet,market:f.market});job.wait=async()=>{job.stop();job.check();};await job.run();assert.equal(job.status,'已停止');assert.equal(f.state.posts.length,0);assert.equal(f.state.broadcasts.length,0);assert.equal(f.market.coord.busy(mint.p,f.wallet.address),true);}finally{await lane?.release();if(mint)await f.market.coord.unregister(mint);await f.cleanup();}
});
test('mint receipt supplements delayed API inventory, but transferred NFT is not eligible',async()=>{
 const f=await fixture();try{await mkdir(f.market.records,{recursive:true});const file=path.join(f.market.records,`4663-${contract}-${f.wallet.address.toLowerCase()}.json`);await writeFile(file,JSON.stringify({address:f.wallet.address,nft:contract}));await writeFile(file+'.receipt',JSON.stringify({success:true,tokenIds:['7']}));f.state.lost=true;const result=await f.market.inventory(f.wallet,4663,'https://mock.invalid');assert.equal(result.items[0].minted,true);assert.equal(result.items[0].owned,false);await assert.rejects(()=>f.market.preview(f.request,[f.wallet],'https://mock.invalid'),/未持有/);}finally{await f.cleanup();}
});
test('market status matches exact chain, owner, contract and token; incomplete data never fabricates unlisted state',()=>{
 const owner=Wallet.createRandom().address,listing={chain:'robinhood',status:'ACTIVE',order_hash:'0x'+'1'.repeat(64),protocol_data:{parameters:{offerer:owner,endTime:'9999999999',offer:[{token:contract,identifierOrCriteria:'7'}]}},price:{current:{value:'100000000000000000',decimals:18,currency:'ETH'}}};assert.equal(activeListingMap([listing],owner,4663).get(contract+':7').price,'0.1 ETH');assert.equal(activeListingMap([listing],owner,1).size,0);assert.throws(()=>activeListingMap([{...listing,protocol_data:null}],owner,4663),/不完整/);
});
test('compact account listings use explicit asset; other chains and inactive orders do not mark this NFT listed',()=>{
 const owner=Wallet.createRandom().address,row={chain:'robinhood',status:'ACTIVE',asset:{contract,identifier:'7'}};assert.ok(activeListingMap([row],owner,4663).has(contract+':7'));assert.equal(activeListingMap([{...row,status:'INACTIVE'}],owner,4663).size,0);assert.throws(()=>activeListingMap([{...row,status:undefined}],owner,4663),/未知/);
});
test('ERC1155 listing sells one unit and explicitly uses fixed conduit collection approval',async()=>{
 const f=await fixture();try{f.state.standard='erc1155';const inventory=await f.market.inventory(f.wallet,4663,'https://mock.invalid'),r=await f.market.preview({...f.request,itemIds:[inventory.items[0].id]},[f.wallet],'https://mock.invalid');assert.equal(r.rows[0].standard,'erc1155');const job=new ListingJob({id:'erc1155',review:f.market.reviews.get(r.reviewId),wallet:f.wallet,market:f.market});await job.run();assert.equal(job.status,'已完成',JSON.stringify(job.view()));assert.equal(f.state.posts[0].parameters.offer[0].itemType,3);assert.equal(f.state.posts[0].parameters.offer[0].startAmount,'1');}finally{await f.cleanup();}
});
test('USDG 6 decimals: displayed proceeds and signed ERC20 consideration match; gas remains ETH and seller never approves payment tokens',async()=>{
 const f=await fixture();try{
  f.state.currency={chain:'robinhood',address:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',decimals:6,symbol:'USDG'};
  const {currency}=await f.market.currency(f.request.itemIds,[f.wallet],'https://mock.invalid');
  const request={...f.request,price: '20.123456',currency},r=await f.market.preview(request,[f.wallet],'https://mock.invalid');
  assert.equal(r.rows[0].price,'20.123456');assert.equal(r.rows[0].net,'19.62037');assert.equal(r.rows[0].fees[0].amountText,'0.503086');assert.equal(r.rows[0].netEth,undefined);assert.equal(r.maxBudget,'0.001');
  const job=new ListingJob({id:'usdg',review:f.market.reviews.get(r.reviewId),wallet:f.wallet,market:f.market});await job.run();assert.equal(job.status,'已完成',JSON.stringify(job.view()));
  const order=f.state.posts[0].parameters;assert.equal(order.consideration.reduce((a,b)=>a+BigInt(b.startAmount),0n),20123456n);for(const item of order.consideration){assert.equal(item.itemType,1);assert.equal(item.token,currency.address);}assert.equal(order.offer[0].itemType,2);assert.equal(f.state.broadcasts.length,1);assert.equal(f.state.broadcasts[0].to.toLowerCase(),contract);assert.equal(job.results[0].currency.symbol,'USDG');assert.equal(job.results[0].priceEth,undefined);assert.match(job.logs.at(-1).message,/20\.123456 USDG/);
 }finally{await f.cleanup();}
});
test('old ETH form is rejected for USDG; excess precision, zero, exponent and overflow cannot be silently rounded',async()=>{
 const f=await fixture();try{f.state.currency={chain:'robinhood',address:feeRecipient,decimals:6,symbol:'USDG'};const c=listingCurrency(f.collection(),f.n);
  await assert.rejects(()=>f.market.preview(f.request,[f.wallet],'https://mock.invalid'),/币种/);
  for(const value of ['0.0000001','1e6','-1','0','9'.repeat(78)])assert.throws(()=>listingAmount(value,c));assert.equal(listingAmount('0.000001',c),1n);
  assert.equal(f.state.broadcasts.length,0);assert.equal(f.state.posts.length,0);
 }finally{await f.cleanup();}
});
test('native ETH, WETH and USDC use correct item types and integer units for all seller and fee outputs',async()=>{
 const f=await fixture();try{for(const [symbol,decimals,address,native]of [['ETH',18,ZeroAddress,true],['WETH',18,feeRecipient,false],['USDC',6,feeRecipient,false]]){
  f.state.currency={chain:'robinhood',address,decimals,symbol};const c=listingCurrency(f.collection(),f.n),price=listingAmount('3.25',c),fees=feePlan(f.collection(),f.n,price),order=buildOrder(f.n,price,fees,0,100,200,undefined,c);
  for(const item of order.consideration){assert.equal(item.itemType,native?0:1);assert.equal(item.token,address);}assert.equal(order.consideration.reduce((a,b)=>a+BigInt(b.startAmount),0n),325n*10n**BigInt(decimals-2));
 }}finally{await f.cleanup();}
});
test('wrong chain, token precision/symbol, missing contract and missing currency metadata block before signing',async()=>{
 for(const mode of ['chain','decimals','symbol','code','missing']){const f=await fixture();try{f.state.currency={chain:'robinhood',address:feeRecipient,decimals:6,symbol:'USDG'};
  if(mode==='chain')f.state.currency.chain='ethereum';if(mode==='decimals')f.state.currencyDecimals=18;if(mode==='symbol')f.state.currencySymbol='FAKE';if(mode==='code')f.state.currencyCode='0x';if(mode==='missing')f.state.currency=null;
  await assert.rejects(()=>f.market.currency(f.request.itemIds,[f.wallet],'https://mock.invalid'));assert.equal(f.state.posts.length,0);assert.equal(f.state.broadcasts.length,0);
 }finally{await f.cleanup();}}
});
test('currency change after preview stops before approval or signing; old reviewed amount is not converted',async()=>{
 const f=await fixture();try{const r=await f.market.preview(f.request,[f.wallet],'https://mock.invalid');f.state.currency={chain:'robinhood',address:feeRecipient,decimals:6,symbol:'USDG'};const job=new ListingJob({id:'changed-currency',review:f.market.reviews.get(r.reviewId),wallet:f.wallet,market:f.market});await job.run();assert.equal(job.status,'已结束');assert.match(job.wallets[0].note,/币种/);assert.equal(f.state.broadcasts.length,0);assert.equal(f.state.posts.length,0);}finally{await f.cleanup();}
});
test('mixed-currency selection must be split; currency identity is required in preview',async()=>{
 const f=await fixture();try{const base=[...f.market.items.values()][0],other={...base,id:base.id+'-other',tokenId:'8'};f.market.items.set(other.id,other);const original=f.market.collection.bind(f.market);f.market.collection=async n=>{const v=await original({...n,tokenId:'7'});if(n.tokenId==='8')v.collection.pricing_currencies.listing_currency={chain:'robinhood',address:feeRecipient,decimals:6,symbol:'USDG'};return v;};await assert.rejects(()=>f.market.currency([base.id,other.id],[f.wallet],'https://mock.invalid'),/分批/);await assert.rejects(()=>f.market.preview({...f.request,currency:{symbol:'ETH'}},[f.wallet],'https://mock.invalid'),/币种/);}finally{await f.cleanup();}
});

test('cost preview uses saved acquisition basis without changing the signed order amount',async()=>{
 const f=await fixture();try{const n=f.market.selected(f.request.itemIds,[f.wallet])[0];await f.market.costs.save(n,{symbol:'ETH',paid:'0.01',gasEth:'0.001'});const r=await f.market.preview(f.request,[f.wallet],'https://mock.invalid');assert.equal(r.rows[0].cost.source,'manual');assert.equal(r.rows[0].outcome.status,'ok');assert.equal(parseEther(r.rows[0].outcome.profit),parseEther(r.rows[0].net)-parseEther('0.011')-parseEther(r.rows[0].estimatedGas));assert.equal(f.state.broadcasts.length,0);assert.equal(f.state.signatureCount,0);assert.equal(f.market.reviews.get(r.reviewId).price,parseEther('0.1').toString());}finally{await f.cleanup();}
});
