import {readFile} from 'node:fs/promises';
import {formatUnits} from 'ethers';
import {Stop,requireThat} from './lib.mjs';
const addressOK=v=>/^0x[0-9a-f]{40}$/i.test(v??'')&&!/^0x0+$/i.test(v);
const slugOK=v=>typeof v==='string'&&/^[a-z0-9_-]{1,150}$/i.test(v);
export function marketSales(events,p,now=Date.now()){
 const chain=p.chainId===4663?'robinhood':'ethereum',seen=new Set(),out=[];
 for(const e of events??[]){
  if(e.event_type!=='sale'||e.chain!==chain||e.nft?.contract?.toLowerCase()!==p.address.toLowerCase()||Number(e.quantity)!==1)continue;
  if(!addressOK(e.buyer)||!addressOK(e.seller)||e.buyer.toLowerCase()===e.seller.toLowerCase()||!/^0x[0-9a-f]{64}$/i.test(e.transaction??''))continue;
  const at=Number(e.event_timestamp)*1000,pay=e.payment;
  if(!Number.isFinite(at)||at>now||at<now-86400000||!pay||!Number.isInteger(pay.decimals)||pay.decimals<0||pay.decimals>36||!/^\d{1,100}$/.test(pay.quantity??'')||!/^.{1,32}$/.test(pay.symbol??''))continue;
  const value=formatUnits(BigInt(pay.quantity),pay.decimals);if(!(Number(value)>0))continue;
  const key=e.transaction.toLowerCase()+':'+e.nft.identifier;if(seen.has(key))continue;seen.add(key);
  out.push({price:{value,symbol:pay.symbol},at:new Date(at).toISOString(),hash:e.transaction,tokenId:String(e.nft.identifier),buyer:e.buyer});
 }
 return out.sort((a,b)=>b.at.localeCompare(a.at));
}
export class ProjectMarket{
 constructor(keyFile,{fetcher=fetch,now=Date.now}={}){this.keyFile=keyFile;this.fetcher=fetcher;this.now=now;this.cache=new Map();this.pending=new Map();this.cooldown=0;}
 async get(p){
  const id=`${p.chainId}:${p.address.toLowerCase()}`,old=this.cache.get(id);
  if(old&&this.now()-old.time<60000)return old.data;
  if(this.pending.has(id))return this.pending.get(id);
  const task=this.load(p).then(data=>{this.cache.set(id,{time:this.now(),data});return data;}).finally(()=>this.pending.delete(id));this.pending.set(id,task);return task;
 }
 async link(p){
  const id=`link:${p.chainId}:${String(p.address).toLowerCase()}`,old=this.cache.get(id);
  if(old&&this.now()-old.time<3600000)return old.data;
  if(this.pending.has(id))return this.pending.get(id);
  const task=this.load(p,true).then(data=>{this.cache.set(id,{time:this.now(),data});return data;}).finally(()=>this.pending.delete(id));
  this.pending.set(id,task);return task;
 }
 async load(p,linkOnly=false){
  requireThat(this.now()>=this.cooldown,'OpenSea 请求较多，请稍后再查询。');
  let key;try{key=JSON.parse(await readFile(this.keyFile,'utf8')).apiKey;}catch{}
  requireThat(typeof key==='string'&&key.trim(),'请先在监控设置中填写自己的 OpenSea API Key。');
  const chain=p.chainId===4663?'robinhood':p.chainId===1?'ethereum':null;requireThat(chain&&addressOK(p.address),'不支持该链或合约。');
  const get=async endpoint=>{
   let r;try{r=await this.fetcher('https://api.opensea.io/api/v2/'+endpoint,{headers:{'x-api-key':key},redirect:'error',signal:AbortSignal.timeout(12000)});}catch{throw new Stop('OpenSea 暂时连接失败，请稍后重试。');}
   if(r.status===429){this.cooldown=this.now()+60000;throw new Stop('OpenSea 限流，60 秒后再试。');}
   requireThat(r.ok,`OpenSea 查询失败（HTTP ${r.status}），请检查 Key 或稍后重试。`);
   try{return await r.json();}catch{throw new Stop('OpenSea 返回格式异常。');}
  };
  // Resolve by chain + contract, never trust a manually entered collection name
  // or borrow prices from a different contract with the same slug.
  const contract=await get(`chain/${chain}/contract/${p.address}`);
  requireThat(contract.address?.toLowerCase()===p.address.toLowerCase()&&contract.chain===chain,'OpenSea 返回的链或合约不匹配。');
  const slug=typeof contract.collection==='string'?contract.collection:contract.collection?.slug;
  requireThat(slugOK(slug),'OpenSea 尚未返回该合约的系列链接。');
  if(linkOnly)return {slug,url:`https://opensea.io/collection/${slug}/overview`};
  const [stats,events]=await Promise.allSettled([get(`collections/${encodeURIComponent(slug)}/stats`),get(`events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=50&after=${Math.floor(this.now()/1000)-86400}`)]);
  const warnings=[];for(const [label,r]of [['地板价',stats],['成交记录',events]])if(r.status==='rejected')warnings.push(`${label}：${r.reason.message}`);
  const t=stats.status==='fulfilled'?stats.value.total:null;
  const floor=typeof t?.floor_price==='number'&&Number.isFinite(t.floor_price)&&t.floor_price>0&&typeof t.floor_price_symbol==='string'?{value:String(t.floor_price),symbol:t.floor_price_symbol}:null;
  const sales=events.status==='fulfilled'?marketSales(events.value.asset_events,p,this.now()):[];
  return {slug,url:`https://opensea.io/collection/${slug}/overview`,floor,sales,checkedUtc:new Date(this.now()).toISOString(),warnings,source:'OpenSea 官方 API；最近 24 小时内最多 50 条事件中的单件二级成交样本；未逐笔核验回执或排除关联钱包。'};
 }
}
