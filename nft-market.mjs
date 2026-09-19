import {readFile,readdir,mkdir,open,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {Interface,ZeroAddress,ZeroHash,TypedDataEncoder,formatEther,formatUnits,parseUnits,keccak256,Transaction,verifyTypedData} from 'ethers';
import {Rpc,Stop,requireThat,amount,gasPlan,json,safeError} from './lib.mjs';
import {coordinator} from './coordinator.mjs';
import {CostStore,costOutcome} from './cost-basis.mjs';
import {lookupMintCost} from './chain-cost.mjs';

// Protocol addresses from ProjectOpenSea/opensea-sdk constants and utils/chain.
export const SEAPORT='0x0000000000000068f116a894984e2db1123eb395';
export const CONDUITS={1:{address:'0x1e0049783f008a0085193e00003d00cd54003c71',key:'0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000'},4663:{address:'0x963f00d3ff000064ffcba824b800c0000000c300',key:'0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e'}};
export const NFT_ABI=new Interface(['function supportsInterface(bytes4) view returns(bool)','function ownerOf(uint256) view returns(address)','function balanceOf(address,uint256) view returns(uint256)','function getApproved(uint256) view returns(address)','function isApprovedForAll(address,address) view returns(bool)','function approve(address,uint256)','function setApprovalForAll(address,bool)']);
const OFFER='tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)';
const CONSIDERATION='tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
const COMPONENTS=`tuple(address offerer,address zone,${OFFER}[] offer,${CONSIDERATION}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)`;
export const PORT_ABI=new Interface(['function information() view returns(string,bytes32,address)','function getCounter(address) view returns(uint256)',`function getOrderHash(${COMPONENTS}) view returns(bytes32)`]);
const CONTROLLER_ABI=new Interface(['function getConduit(bytes32) view returns(address,bool)','function getChannelStatus(address,address) view returns(bool)']);
const fields=s=>s.split(',').map(v=>{const[type,name]=v.split(' ');return {name,type};});
export const ORDER_TYPES={OfferItem:fields('uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount'),ConsiderationItem:fields('uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient'),OrderComponents:fields('address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter')};
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const addr=v=>/^0x[0-9a-f]{40}$/i.test(v??'')&&!eq(v,ZeroAddress);
const token=v=>/^\d{1,78}$/.test(String(v??''))&&BigInt(v)<2n**256n;
const chainName=id=>id===4663?'robinhood':id===1?'ethereum':null;
const itemKey=n=>`${n.chainId}-${n.owner.toLowerCase()}-${n.contract.toLowerCase()}-${n.tokenId}`;
const nftKey=n=>`${n.contract.toLowerCase()}:${n.tokenId}`;
const CURRENCY_ABI=new Interface(['function decimals() view returns(uint8)','function symbol() view returns(string)']);
export function listingCurrency(collection,n){
 requireThat(collection.collection===n.slug&&collection.contracts?.some(c=>c.chain===chainName(n.chainId)&&eq(c.address,n.contract)),'系列与 NFT 合约不匹配。');
 const c=collection.pricing_currencies?.listing_currency;
 requireThat(c&&c.chain===chainName(n.chainId)&&/^0x[0-9a-f]{40}$/i.test(c.address??'')&&Number.isInteger(c.decimals)&&c.decimals>=0&&c.decimals<=36&&/^[A-Za-z0-9._-]{1,24}$/.test(c.symbol??''),'平台未返回可核验的上架币种，请到 OpenSea 核实。');
 const native=eq(c.address,ZeroAddress);requireThat(!native||(c.decimals===18&&c.symbol==='ETH'),'原生币信息不匹配。');
 return {chainId:n.chainId,address:c.address.toLowerCase(),symbol:c.symbol,decimals:c.decimals,native};
}
export async function verifyCurrency(rpc,c){
 requireThat(Number(BigInt(await rpc.send('eth_chainId')))===c.chainId,'报价币种与 RPC 网络不一致。');
 if(c.native)return;
 const [code,decimals,symbol]=await Promise.all([rpc.send('eth_getCode',[c.address,'latest']),rpc.call(CURRENCY_ABI,c.address,'decimals',[]),rpc.call(CURRENCY_ABI,c.address,'symbol',[])]);
 requireThat(/^0x[0-9a-f]+$/i.test(code)&&code!=='0x0'&&Number(decimals[0])===c.decimals&&symbol[0]===c.symbol,'报价代币的合约、精度或名称与链上不一致。');
}
export function listingAmount(value,c){
 requireThat(typeof value==='string'&&/^\d{1,78}(\.\d{1,36})?$/.test(value),'售价必须是普通十进制数字。');
 requireThat((value.split('.')[1]?.length??0)<=c.decimals,`${c.symbol} 售价最多 ${c.decimals} 位小数。`);
 const result=parseUnits(value,c.decimals);requireThat(result>0n&&result<2n**256n,'售价必须大于 0 且在允许范围内。');return result;
}
export class OpenSeaClient {
 constructor(keyFile,fetcher=fetch){this.keyFile=keyFile;this.fetcher=fetcher;this.cooldown=0;}
 async request(endpoint,body){
  requireThat(Date.now()>=this.cooldown,'OpenSea 限流，请稍后再试。');
  let key;try{key=JSON.parse(await readFile(this.keyFile,'utf8')).apiKey;}catch{}
  requireThat(typeof key==='string'&&key.trim(),'请先在监控设置中填写自己的 OpenSea API Key。');
  requireThat(!/^(0x)?[a-f0-9]{64}$/i.test(key),'API Key 格式不正确，不会发送。');
  let r;try{r=await this.fetcher('https://api.opensea.io/api/v2/'+endpoint,{method:body?'POST':'GET',headers:{'x-api-key':key,...(body?{'content-type':'application/json'}:{})},body:body?json(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new Stop('OpenSea 连接未完成；提交过的订单需核实结果。');}
  if(r.status===429)this.cooldown=Date.now()+60000;
  requireThat(r.ok,`OpenSea 请求未完成（HTTP ${r.status}），请检查接口权限或稍后核实。`);
  try{return await r.json();}catch{throw new Stop('OpenSea 返回格式异常。');}
 }
}
export function feePlan(collection,n,price){
 requireThat(collection.collection===n.slug&&collection.contracts?.some(c=>c.chain===chainName(n.chainId)&&eq(c.address,n.contract)),'系列与 NFT 合约不匹配。');
 requireThat(!collection.is_disabled,'该系列已被平台禁用。');
 requireThat(!collection.required_zone||eq(collection.required_zone,ZeroAddress),'该系列需要特殊交易区域，当前请到 OpenSea 上架。');
 listingCurrency(collection,n);
 requireThat(Array.isArray(collection.fees)&&collection.fees.length<=20,'平台未返回明确费用，暂不签名。');
 const fees=collection.fees.map(f=>{
  const text=String(f.fee);requireThat(/^\d{1,3}(\.\d{1,6})?$/.test(text)&&addr(f.recipient),'平台费用格式异常。');
  const [i,d='']=text.split('.'),frac=d.padEnd(3,'0');const bps=BigInt(i)*100n+BigInt(frac.slice(0,2))+(Number(frac[2])>=5?1n:0n);
  return {recipient:f.recipient.toLowerCase(),bps:Number(bps),amount:(price*bps/10000n).toString(),required:!!f.required};
 });
 requireThat(fees.reduce((v,f)=>v+f.bps,0)<10000,'费用必须小于售价。');
 const total=fees.reduce((v,f)=>v+BigInt(f.amount),0n),net=price-total;requireThat(net>0n,'预计到账必须大于 0。');return {fees,total:total.toString(),net:net.toString()};
}
export function buildOrder(n,price,fees,counter,start,end,salt='0x'+randomBytes(32).toString('hex'),currency={native:true,address:ZeroAddress}){
 const consideration=[{recipient:n.owner,amount:fees.net},...fees.fees.filter(f=>BigInt(f.amount)>0n)].map(f=>({itemType:currency.native?0:1,token:currency.address,identifierOrCriteria:'0',startAmount:f.amount,endAmount:f.amount,recipient:f.recipient}));
 const order={offerer:n.owner,zone:ZeroAddress,offer:[{itemType:n.standard==='erc721'?2:3,token:n.contract,identifierOrCriteria:n.tokenId,startAmount:'1',endAmount:'1'}],consideration,orderType:0,startTime:String(start),endTime:String(end),zoneHash:ZeroHash,salt:BigInt(salt).toString(),conduitKey:CONDUITS[n.chainId].key,counter:String(counter)};
 requireThat(consideration.reduce((v,f)=>v+BigInt(f.startAmount),0n)===price,'订单金额不匹配。');return order;
}
export async function verifyProtocol(rpc,chainId){
 requireThat(Number(BigInt(await rpc.send('eth_chainId')))===chainId,'RPC 网络与 NFT 不一致。');
 const [block,info]=await Promise.all([rpc.send('eth_getBlockByNumber',['latest',false]),rpc.call(PORT_ABI,SEAPORT,'information',[])]);
 requireThat(block?.timestamp&&Math.abs(Number(BigInt(block.timestamp))-Date.now()/1000)<90,'节点时间落后，暂停上架。');
 requireThat(info[0]==='1.6'&&eq(info[2],'0x00000000f9490004c11cef243f5400493c00ad63'),'Seaport 版本或控制器不匹配。');
 const domain={name:'Seaport',version:'1.6',chainId,verifyingContract:SEAPORT};requireThat(eq(info[1],TypedDataEncoder.hashDomain(domain)),'Seaport 签名域不匹配。');
 const conduit=CONDUITS[chainId],resolved=await rpc.call(CONTROLLER_ABI,info[2],'getConduit',[conduit.key]);
 requireThat(resolved[1]&&eq(resolved[0],conduit.address),'OpenSea 转移通道不匹配。');
 requireThat((await rpc.call(CONTROLLER_ABI,info[2],'getChannelStatus',[conduit.address,SEAPORT]))[0],'Seaport 转移通道未开放。');return domain;
}
export async function ownership(rpc,n){
 requireThat(['erc721','erc1155'].includes(n.standard),'仅支持 ERC-721 / ERC-1155 NFT。');
 requireThat((await rpc.call(NFT_ABI,n.contract,'supportsInterface',[n.standard==='erc721'?'0x80ac58cd':'0xd9b67a26']))[0],'NFT 标准与链上接口不匹配。');
 const balance=n.standard==='erc721'?(eq((await rpc.call(NFT_ABI,n.contract,'ownerOf',[n.tokenId]))[0],n.owner)?1n:0n):(await rpc.call(NFT_ABI,n.contract,'balanceOf',[n.owner,n.tokenId]))[0];
 requireThat(balance>=1n,'钱包当前未持有该 NFT。');return balance;
}
export async function approval(rpc,n){
 const conduit=CONDUITS[n.chainId].address;
 if((await rpc.call(NFT_ABI,n.contract,'isApprovedForAll',[n.owner,conduit]))[0])return null;
 if(n.standard==='erc721'&&eq((await rpc.call(NFT_ABI,n.contract,'getApproved',[n.tokenId]))[0],conduit))return null;
 return {from:n.owner,to:n.contract,value:'0x0',data:n.standard==='erc721'?NFT_ABI.encodeFunctionData('approve',[conduit,n.tokenId]):NFT_ABI.encodeFunctionData('setApprovalForAll',[conduit,true])};
}
export function activeListingMap(rows,owner,chainId){
 const out=new Map();for(const r of rows){requireThat(typeof r.chain==='string','上架网络信息缺失。');if(r.chain!==chainName(chainId))continue;
  const p=r.protocol_data?.parameters;
  // The account endpoint also returns compact orders without protocol_data.
  // Its explicit asset identifies the NFT; never infer one from a collection.
  if(p)requireThat(eq(p.offerer,owner)&&Array.isArray(p.offer),'上架钱包或订单格式不匹配。');
  const offers=p?.offer??(addr(r.asset?.contract)&&token(r.asset?.identifier)?[{token:r.asset.contract,identifierOrCriteria:r.asset.identifier}]:null);
  requireThat(offers,'上架状态返回不完整，暂不创建新订单。');
  requireThat(['ACTIVE','INACTIVE','FULFILLED','EXPIRED','CANCELLED'].includes(r.status),'上架状态字段未知。');if(r.status!=='ACTIVE')continue;
  for(const o of offers){requireThat(addr(o.token)&&token(o.identifierOrCriteria),'上架 NFT 标识无效。');const price=r.price?.current;out.set(o.token.toLowerCase()+':'+BigInt(o.identifierOrCriteria).toString(),{hash:r.order_hash,price:price&&Number.isInteger(price.decimals)&&price.decimals>=0&&price.decimals<=36&&/^\d+$/.test(price.value)?`${formatUnits(price.value,price.decimals)} ${String(price.currency).slice(0,20)}`:'价格待核验',end:p?.endTime?Number(p.endTime):null});}
 }return out;
}
export class NftMarket {
 constructor({keyFile,records,dir,api,rpcFactory=url=>new Rpc(url),coord=coordinator}){this.api=api??new OpenSeaClient(keyFile);this.records=records;this.dir=dir;this.rpcFactory=rpcFactory;this.coord=coord;this.items=new Map();this.reviews=new Map();this.costs=new CostStore(path.join(path.dirname(dir),'costs'),records);}
 async chainCost(n,rpcUrl,hash=''){const found=await lookupMintCost(n,this.rpcFactory(rpcUrl),this.api,hash);n.cost=await this.costs.saveChain(n,found);this.reviews.clear();return {cost:n.cost,found};}
 async active(owner,chainId){let next='',rows=[],seen=new Set();for(let i=0;i<10;i++){const r=await this.api.request(`account/${owner}/listings?chains=${chainName(chainId)}&limit=50${next?'&after='+encodeURIComponent(next):''}`);requireThat(Array.isArray(r.listings),'上架状态格式异常。');rows.push(...r.listings);if(!r.next)return activeListingMap(rows,owner,chainId);requireThat(typeof r.next==='string'&&!seen.has(r.next),'上架分页异常。');next=r.next;seen.add(next);}throw new Stop('上架订单超过本次查询范围，暂不重复上架。');}
 async local(n){try{return JSON.parse(await readFile(path.join(this.dir,itemKey(n)+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw new Stop('本地上架记录不可读。');}}
 async minted(owner,chainId){const found=new Map();let files=[];try{files=await readdir(this.records);}catch{}for(const f of files.filter(f=>f.startsWith(chainId+'-')&&f.endsWith('-'+owner.toLowerCase()+'.json.receipt'))){try{const receipt=JSON.parse(await readFile(path.join(this.records,f),'utf8')),attempt=JSON.parse(await readFile(path.join(this.records,f.slice(0,-8)),'utf8'));if(receipt.success&&eq(attempt.address,owner)&&addr(attempt.nft))for(const id of receipt.tokenIds??[])if(token(id))found.set(attempt.nft.toLowerCase()+':'+id,{contract:attempt.nft,identifier:id,token_standard:'erc721',name:'本软件 mint #'+id,collection:null});}catch{}}return found;}
 async inventory(wallet,chainId,rpcUrl,next=''){
  requireThat(chainName(chainId),'不支持该网络。');requireThat(typeof next==='string'&&next.length<3000,'分页参数无效。');
  const rpc=this.rpcFactory(rpcUrl);requireThat(Number(BigInt(await rpc.send('eth_chainId')))===chainId,'RPC 网络与选择不一致。');
  const minted=await this.minted(wallet.address,chainId),warnings=[];let page={nfts:[]};
  try{page=await this.api.request(`chain/${chainName(chainId)}/account/${wallet.address}/nfts?limit=50&include_auto_hidden=false${next?'&next='+encodeURIComponent(next):''}`);requireThat(Array.isArray(page.nfts),'持仓返回格式异常。');}catch(e){page={nfts:[]};warnings.push(safeError(e));}
  let listed=null;try{listed=await this.active(wallet.address,chainId);}catch(e){warnings.push(safeError(e));}
  const raws=new Map();for(const n of page.nfts)if(addr(n.contract)&&token(n.identifier))raws.set(n.contract.toLowerCase()+':'+BigInt(n.identifier).toString(),n);
  if(!next)for(const [k,v] of minted)if(!raws.has(k))raws.set(k,v);
  const items=[];for(const [key,v]of [...raws].slice(0,200)){
   const n={chainId,walletId:wallet.id,owner:wallet.address,contract:v.contract.toLowerCase(),tokenId:BigInt(v.identifier).toString(),standard:String(v.token_standard??'').toLowerCase(),slug:typeof v.collection==='string'&&/^[a-z0-9_-]{1,150}$/i.test(v.collection)?v.collection:null,name:String(v.name||'NFT #'+v.identifier).slice(0,140),minted:minted.has(key)};
   n.id=itemKey(n);n.url=`https://opensea.io/assets/${chainName(chainId)}/${n.contract}/${n.tokenId}`;
   n.listing=listed?.get(key)??null;n.listingChecked=listed!==null;n.local=await this.local(n);n.cost=await this.costs.get(n);
   n.owned=null;if(n.minted){try{await ownership(rpc,n);n.owned=true;}catch{n.owned=false;}}
   if(this.items.size>=5000)this.items.delete(this.items.keys().next().value);this.items.set(n.id,n);items.push(n);
  }return {items,next:typeof page.next==='string'?page.next:null,warnings,checkedAt:Date.now()};
 }
 selected(ids,wallets){requireThat(Array.isArray(ids)&&ids.length>0&&ids.length<=20&&new Set(ids).size===ids.length,'每批选择 1–20 个不同 NFT。');return ids.map(id=>{const n=this.items.get(id);requireThat(n&&wallets.some(w=>w.id===n.walletId&&eq(w.address,n.owner)),'NFT 或钱包已改变，请刷新持仓。');return n;});}
 async collection(n){const detail=await this.api.request(`chain/${chainName(n.chainId)}/contract/${n.contract}/nfts/${n.tokenId}`);const v=detail.nft;requireThat(v&&eq(v.contract,n.contract)&&String(v.identifier)===n.tokenId&&String(v.token_standard).toLowerCase()===n.standard&&/^[a-z0-9_-]{1,150}$/i.test(v.collection??''),'NFT 详情未匹配。');n={...n,slug:v.collection};return {n,collection:await this.api.request('collections/'+encodeURIComponent(n.slug))};}
 async currency(ids,wallets,rpcUrl){
  const items=this.selected(ids,wallets);requireThat(items.every(n=>n.walletId===items[0].walletId&&n.chainId===items[0].chainId),'每批选择同一钱包、同一条链的 NFT。');
  let currency;for(const item of items){const {n,collection}=await this.collection(item),c=listingCurrency(collection,n);requireThat(!currency||json(c)===json(currency),'所选 NFT 的上架币种不同，请按币种分批上架。');currency=c;}
  await verifyCurrency(this.rpcFactory(rpcUrl),currency);return {currency};
 }
 async preview(b,wallets,rpcUrl){
  const items=this.selected(b.itemIds,wallets),gasCap=amount(b.maxGasEth,'每次授权 gas 上限'),hours=Number(b.hours);
  const {currency}=await this.currency(b.itemIds,wallets,rpcUrl);
  // Old ETH-only clients must never silently reinterpret an ETH amount as USDG.
  requireThat(b.currency?json(b.currency)===json(currency):currency.native&&b.priceEth!==undefined,'上架币种已变化或尚未确认，请关闭窗口重新选择 NFT；不会自动换算售价。');
  const price=listingAmount(b.price??b.priceEth,currency),priceText=formatUnits(price,currency.decimals);
  requireThat(Number.isInteger(hours)&&hours>=1&&hours<=720,'上架期限为 1–720 小时。');requireThat(items.every(n=>n.walletId===items[0].walletId&&n.chainId===items[0].chainId),'每批选择同一钱包、同一条链的 NFT。');
  const rpc=this.rpcFactory(rpcUrl),domain=await verifyProtocol(rpc,items[0].chainId),listed=await this.active(items[0].owner,items[0].chainId),rows=[];
  for(const item of items){requireThat(!listed.has(nftKey(item)),'选择中已有上架 NFT，请取消勾选后重试。');const old=await this.local(item);requireThat(!old||Number(old.end)*1000<Date.now(),'此 NFT 有未过期的本地上架记录（可能已提交）；请先核实或等其到期。');
   await ownership(rpc,item);const {n,collection}=await this.collection(item);requireThat(json(listingCurrency(collection,n))===json(currency),'上架币种已变化，请重新选择 NFT。');const fees=feePlan(collection,n,price),req=await approval(rpc,n);let estimatedGas='0';
   if(req){const [estimate,gp,balance]=await Promise.all([rpc.send('eth_estimateGas',[req]),rpc.send('eth_gasPrice'),rpc.send('eth_getBalance',[n.owner,'pending'])]);estimatedGas=formatEther(gasPlan(BigInt(estimate),BigInt(gp),BigInt(balance),0n,b.maxGasEth).maxCost);}
   const cost=await this.costs.get(n),outcome=costOutcome(cost,formatUnits(fees.net,currency.decimals),currency,estimatedGas,b.ethRate,fees.fees.reduce((sum,f)=>sum+f.bps,0));
   rows.push({n,fees,approvalNeeded:!!req,estimatedGas,cost,outcome});
  }
  const maxBudget=gasCap*BigInt(rows.length),balance=BigInt(await rpc.send('eth_getBalance',[items[0].owner,'pending'])),reserved=this.coord.reserved(items[0],items[0].owner);
  requireThat(balance>=maxBudget+reserved,'余额不足以覆盖本批授权预算与其他运行任务。');
  const id=randomUUID(),review={id,rows,price:price.toString(),priceText,currency,...(currency.native?{priceEth:priceText}:{}),maxGasEth:b.maxGasEth,maxBudget:formatEther(maxBudget),hours,rpcUrl,domain,at:Date.now()};this.reviews.clear();this.reviews.set(id,review);
  return {reviewId:id,currency,rows:rows.map(r=>({id:r.n.id,name:r.n.name,tokenId:r.n.tokenId,owner:r.n.owner,standard:r.n.standard,cost:r.cost,outcome:r.outcome,price:priceText,net:formatUnits(r.fees.net,currency.decimals),...(currency.native?{priceEth:priceText,netEth:formatEther(r.fees.net)}:{}),fees:r.fees.fees.map(f=>({...f,amountText:formatUnits(f.amount,currency.decimals)})),approvalNeeded:r.approvalNeeded,estimatedGas:r.estimatedGas})),hours,maxBudget:review.maxBudget,reservedEth:formatEther(reserved)};
 }
}

export class ListingJob {
 constructor({id,review,wallet,market}){this.id=id;this.r=review;this.market=market;this.dir=market.records;this.p={id,chainId:review.rows[0].n.chainId,address:review.rows[0].n.contract,name:'批量上架 · '+review.rows.length+' 个 NFT',quantity:1,maxPriceEth:'0',maxGasEth:review.maxBudget,rpcUrl:review.rpcUrl};this.claimKey='listing:'+id;this.wallets=[{...wallet,status:'等待',note:'等待协调发送'}];this.controller=new AbortController();this.status='启动中';this.logs=[];this.createdAt=Date.now();this.results=[];}
 check(){if(this.controller.signal.aborted)throw new Stop('上架任务已停止；已广播授权和已提交订单不能撤回。');}
 stop(){this.controller.abort();this.status='正在停止';}
 log(message){this.logs.push({at:Date.now(),message});}
 view(){return {id:this.id,projectId:this.id,name:this.p.name,chainId:this.p.chainId,address:this.p.address,status:this.status,createdAt:this.createdAt,logs:this.logs,results:this.results,wallets:this.wallets.map(({address,status,note})=>({address,status,note}))};}
 async wait(){await new Promise(r=>setTimeout(r,1000));this.check();}
 async approve(rpc,n,w){
  const req=await approval(rpc,n);if(!req)return;
  const floor=await this.market.coord.historyBarrier(this.dir,this.p,w.address,rpc),[pending,latest,balance,estimate,gp]=await Promise.all([rpc.send('eth_getTransactionCount',[w.address,'pending']),rpc.send('eth_getTransactionCount',[w.address,'latest']),rpc.send('eth_getBalance',[w.address,'pending']),rpc.send('eth_estimateGas',[req]),rpc.send('eth_gasPrice')]);
  requireThat(BigInt(pending)===BigInt(latest)&&BigInt(pending)>=floor,'钱包前序交易未确认或节点序号落后，请稍后重新预检。');
  requireThat(BigInt(balance)>=this.market.coord.reserved(this.p,w.address),'余额不足以覆盖所有任务预留。');
  const plan=gasPlan(BigInt(estimate),BigInt(gp),BigInt(balance),0n,this.r.maxGasEth),tx={chainId:n.chainId,type:0,nonce:Number(BigInt(pending)),to:n.contract,value:0n,data:req.data,gasLimit:plan.gasLimit,gasPrice:plan.gasPrice};
  this.check();const raw=await w.signer.signTransaction(tx),decoded=Transaction.from(raw);requireThat(eq(decoded.from,w.address)&&eq(decoded.to,n.contract)&&decoded.data===req.data&&decoded.value===0n&&decoded.chainId===BigInt(n.chainId)&&decoded.nonce===tx.nonce&&decoded.gasLimit*decoded.gasPrice<=amount(this.r.maxGasEth,'gas'),'授权签名与预算不匹配。');
  const hash=keccak256(raw),record={kind:'approval',chainId:n.chainId,address:w.address,nft:n.contract,tokenId:n.tokenId,quantity:1,hash,nonce:tx.nonce,createdUtc:new Date().toISOString()};
  await mkdir(this.dir,{recursive:true});const file=path.join(this.dir,`${n.chainId}-approval-${randomUUID()}-${w.address.toLowerCase()}.json`),handle=await open(file,'wx',0o600);try{await handle.writeFile(json(record));await handle.sync();}finally{await handle.close();}
  this.check();w.note='授权已准备，等待链上回执';this.log('授权交易 '+hash);try{requireThat(eq(await rpc.send('eth_sendRawTransaction',[raw]),hash),'授权广播返回不匹配。');}catch{this.log('授权广播回应不确定，核实同一哈希，不重发。');}
  const end=Date.now()+180000;while(Date.now()<end){this.check();let receipt;try{receipt=await rpc.send('eth_getTransactionReceipt',[hash]);}catch{}if(receipt){requireThat(eq(receipt.transactionHash,hash)&&receipt.status==='0x1','授权交易未成功。');requireThat(!(await approval(rpc,n)),'授权状态未生效。');return;}await this.wait();}throw new Stop('授权结果不明，停止上架；保留哈希以防重复发送。');
 }
 async run(){const w=this.wallets[0],m=this.market,rpc=m.rpcFactory(this.r.rpcUrl);let lane;
  try{this.status='运行中';await m.coord.register(this,rpc);while(!(lane=m.coord.take(this,w))){w.note='其他任务发送中，等待钱包协调';await this.wait();}
   let remaining=this.r.rows.length;
   for(const row of this.r.rows){this.check();const n=row.n;w.note='检查 '+n.name+' #'+n.tokenId;
    const domain=await verifyProtocol(rpc,n.chainId);await ownership(rpc,n);const {collection}=await m.collection(n),currency=listingCurrency(collection,n);requireThat(json(currency)===json(this.r.currency),'上架币种已变化，请重新预检。');await verifyCurrency(rpc,currency);const fees=feePlan(collection,n,BigInt(this.r.price));requireThat(json(fees)===json(row.fees),'费用已变化，请重新预检。');
    requireThat(!(await m.active(n.owner,n.chainId)).has(nftKey(n)),'该 NFT 已有有效上架，停止本批以避免重复。');const old=await m.local(n);requireThat(!old||Number(old.end)*1000<Date.now(),'已有未过期上架记录，停止重复提交。');
    await this.approve(rpc,n,w);this.check();m.coord.setBudget(this,w,amount(this.r.maxGasEth,'gas')*BigInt(--remaining));
    await ownership(rpc,n);requireThat(!(await approval(rpc,n)),'NFT 授权状态改变。');
    const counter=(await rpc.call(PORT_ABI,SEAPORT,'getCounter',[n.owner]))[0],start=Math.floor(Date.now()/1000)-30,end=Math.floor(Date.now()/1000)+this.r.hours*3600,order=buildOrder(n,BigInt(this.r.price),fees,counter,start,end,undefined,currency);
    const hash=TypedDataEncoder.hashStruct('OrderComponents',ORDER_TYPES,order),chainHash=(await rpc.call(PORT_ABI,SEAPORT,'getOrderHash',[order]))[0];requireThat(eq(hash,chainHash),'链上订单哈希不匹配，不签名。');this.check();
    const latestCollection=(await m.collection(n)).collection;requireThat(json(listingCurrency(latestCollection,n))===json(currency),'上架币种已变化，停止签名。');await verifyCurrency(rpc,currency);const latestFees=feePlan(latestCollection,n,BigInt(this.r.price));requireThat(json(latestFees)===json(fees),'费用已变化，停止签名，请重新预检。');
    const signature=await w.signer.signTypedData(domain,ORDER_TYPES,order);requireThat(eq(verifyTypedData(domain,ORDER_TYPES,order,signature),n.owner),'上架签名钱包不匹配。');this.check();
    const record={chainId:n.chainId,owner:n.owner,contract:n.contract,tokenId:n.tokenId,hash,currency,price:this.r.priceText,net:formatUnits(fees.net,currency.decimals),...(currency.native?{priceEth:this.r.priceText,netEth:formatEther(fees.net)}:{}),end,status:'提交待核实',at:Date.now()};
    await mkdir(m.dir,{recursive:true});await writeFile(path.join(m.dir,itemKey(n)+'.json'),json(record),{mode:0o600});this.check();
    // Persist no signature. Ambiguous responses retain the order hash and expiry.
    try{const response=await m.api.request(`orders/${chainName(n.chainId)}/seaport/listings`,{parameters:{...order,totalOriginalConsiderationItems:order.consideration.length},protocol_address:SEAPORT,signature});requireThat(eq(response.order_hash,hash),'上架返回哈希未匹配，需核实。');record.status='已提交 OpenSea';await writeFile(path.join(m.dir,itemKey(n)+'.json'),json(record),{mode:0o600});this.results.push({...record,name:n.name,url:n.url});this.log(`${n.name} #${n.tokenId} · 已提交 · ${this.r.priceText} ${currency.symbol}`);}catch{this.results.push({...record,name:n.name,url:n.url});throw new Stop('上架提交结果待核实；已保留订单哈希，不自动重发。');}
   }w.status='已完成';w.note=`已提交 ${this.results.length} 个上架订单`;this.status='已完成';
  }catch(e){w.status='停止';w.note=safeError(e);this.log(w.note);this.status=this.controller.signal.aborted?'已停止':'已结束';}
  finally{w.signer=null;await lane?.release();await m.coord.unregister(this);this.finished=true;}
 }
}
