import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {parsePage,discover,collection,applyStats,assess} from './market.mjs';
import {ChainDiscovery} from './realtime.mjs';
import {MarketStream} from './market-stream.mjs';
import {inspect,CHAINS} from './chain.mjs';
import {discoverPublic} from './discovery.mjs';
let chainLive=null,marketLive=null;
const marketDirty=new Set();
let ROOT=path.dirname(fileURLToPath(import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function validateConfig(c){
 if(!Array.isArray(c.chains)||!c.chains.length||c.chains.some(x=>!CHAINS[x]))throw new Error('chains 仅支持 ethereum / robinhood');
 if(c.valuationMode!==undefined&&!['floor','sales-conservative-v1'].includes(c.valuationMode))throw new Error('valuationMode 配置无效');
 if(typeof c.freeOnly!=='boolean')throw new Error('freeOnly 必须为 true 或 false');
 if(c.maxGasEth!==null&&(!Number.isFinite(c.maxGasEth)||c.maxGasEth<=0))throw new Error('maxGasEth 须为正数或 null（不限制）');
 if(c.profitMetric!==undefined&&(!['floorToCost','profitToCost','profitToFloor'].includes(c.profitMetric)||!Number.isFinite(c.profitMultiple)||c.profitMultiple<=0))throw new Error('profitMetric / profitMultiple 配置无效');
 for(const [k,min,max] of [['intervalSeconds',60,86400],['discoveryPages',1,5],['maxCollections',1,200],['port',1024,65535],['assumedExitGasUnits',21000,2000000]])if(!Number.isInteger(c[k])||c[k]<min||c[k]>max)throw new Error(`${k} 配置无效`);
 if(c.requireSecondarySales!==undefined&&typeof c.requireSecondarySales!=='boolean')throw new Error('requireSecondarySales 配置无效');
 for(const k of ['minSecondarySales','minUniqueBuyers'])if(c[k]!==undefined&&(!Number.isInteger(c[k])||c[k]<1||c[k]>100))throw new Error(`${k} 配置无效`);
 for(const [k,min,max] of [['minFloorEth',0,100],['minVolume24hEth',0,1000000],['minFloorToCost',1,1000000],['minMarginEth',0,100],['floorHaircut',0.01,1],['assumedMarketplaceFeeBps',0,10000]])if(!Number.isFinite(c[k])||c[k]<min||c[k]>max)throw new Error(`${k} 配置无效`);
 if(!Array.isArray(c.watchlist)||c.watchlist.length>60||c.watchlist.some(x=>typeof x!=='string'||!/^[a-z0-9_-]+$/i.test(x)))throw new Error('watchlist 须为 OpenSea 系列 slug 列表，最多 60 个');
 return c;
}
export function rateLimitUntil(headers,now=Date.now()){
 const retry=headers.get('retry-after');
 let until=now+15*60*1000;
 if(retry){const seconds=Number(retry);const parsed=Number.isFinite(seconds)?now+seconds*1000:Date.parse(retry);if(Number.isFinite(parsed))until=Math.max(now+60000,parsed);}
 const reset=Number(headers.get('x-ratelimit-reset'));if(reset>1e9)until=Math.max(until,reset*1000);
 return until;
}
class Reader{
 constructor(){this.deferUntil=0;this.last=0;}
 async get(url,headers={}){
  if(Date.now()<this.deferUntil)throw new Error('数据源限流，正在等待恢复');
  await delay(Math.max(0,600-(Date.now()-this.last)));this.last=Date.now();
  const r=await fetch(url,{headers:{'user-agent':'OpenSeaMintScanner/1.0 (read-only local research)',...headers},signal:AbortSignal.timeout(20000)});
  if(r.status===429){this.deferUntil=rateLimitUntil(r.headers);throw new Error('数据源 HTTP 429，已停止本轮抓取并退避');}
  if(r.status===403){this.deferUntil=Date.now()+15*60*1000;throw new Error('数据源拒绝访问，已停止本轮；未绕过访问限制');}
  if(!r.ok)throw new Error(`数据读取 HTTP ${r.status}`);
  return r;
 }
}
const reader=new Reader();
const state={running:false,progress:'尚未扫描',lastAttemptUtc:null,nextScanUtc:null,report:null,lastError:null};
// Embedded by Mint Desk in a disposable worker. No second HTTP server, shared
// personal API key, or wallet access is available to this worker.
export async function startEmbedded(c,storageRoot=ROOT){
 ROOT=storageRoot;
 validateConfig(c);
 if(!await optionalKey(c))throw new Error('请先填写自己的 OpenSea API Key');
 CHAINS.robinhood.rpc=c.realtime.http;
 try{const p=JSON.parse(await readFile(path.join(ROOT,'data/latest.json'),'utf8'));if(p.settings?.valuationMode===c.valuationMode&&p.settings?.profitMultiple===c.profitMultiple)state.report=p;}catch{}
 chainLive=new ChainDiscovery(ROOT,c.realtime);
 marketLive=new MarketStream(path.join(ROOT,'data/opensea-key.local.json'),e=>marketDirty.add(e.slug));
 await chainLive.start();chainLive.seed(state.report);await marketLive.start();refreshSubscriptions();
 let resolving=false;
 const resolver=setInterval(async()=>{if(resolving||!marketLive.key)return;resolving=true;try{for(const r of rankedChainRows().map(r=>chainLive.rows.get(r.address)).filter(r=>!r.slug&&Date.now()-(r.resolveAttempt??0)>3600000).slice(0,2)){r.resolveAttempt=Date.now();try{const slug=await marketLive.resolve(r.address);if(slug){r.slug=slug;marketDirty.add(slug);refreshSubscriptions();}}catch{}}}finally{refreshSubscriptions();resolving=false;}},15000);
 const timer=setInterval(()=>{if(!state.running&&state.nextScanUtc&&Date.now()>=Date.parse(state.nextScanUtc))void scan(c);},1000);
 void scan(c);
 return {snapshot:()=>({scan:state,chain:chainLive.snapshot(),market:marketLive.snapshot(),serverUtc:new Date().toISOString()}),scan:()=>scan(c),stop:()=>{clearInterval(timer);clearInterval(resolver);chainLive.stop();marketLive.stop();}};
}
function rankedChainRows(){const now=Date.now()/1000;return (chainLive?.snapshot().rows??[]).sort((a,b)=>{
 const score=r=>r.activity?.healthy&&r.activity.wallets5m>=8?3:r.status==='待开售'&&r.startTime>now&&r.startTime-now<=3600?2:r.status==='公售开放'?1:0;
 return score(b)-score(a)||(b.activity?.wallets1m??0)-(a.activity?.wallets1m??0)||Date.parse(b.firstSeenUtc)-Date.parse(a.firstSeenUtc);
});}
function refreshSubscriptions(){marketLive?.updateSlugs([...new Set([...rankedChainRows().filter(r=>(r.activity?.wallets5m??0)>=8||r.status==='待开售'&&r.startTime-Date.now()/1000<=3600).map(r=>r.slug).filter(Boolean),...(state.report?.rows??[]).filter(r=>r.chain==='robinhood').map(r=>r.slug),...rankedChainRows().map(r=>r.slug).filter(Boolean)])]);}
async function optionalKey(c){
 if(!c.apiKeyFile)return null;
 try{const v=JSON.parse(await readFile(path.resolve(ROOT,c.apiKeyFile),'utf8'));if(typeof v.apiKey!=='string'||!v.apiKey.trim())throw new Error();return v.apiKey.trim();}
 catch(e){if(e.code==='ENOENT')return null;throw new Error('可选 API Key 文件格式无效；应为含 apiKey 的 JSON 对象');}
}
async function saveReport(report){
 await mkdir(path.join(ROOT,'data'),{recursive:true});
 const dest=path.join(ROOT,'data','latest.json');await writeFile(dest+'.tmp',JSON.stringify(report,null,2));await rename(dest+'.tmp',dest);
}
export async function scan(c){
 if(state.running)return;
 if(Date.now()<reader.deferUntil){state.lastError='数据源限流，等待退避结束';state.nextScanUtc=new Date(reader.deferUntil).toISOString();return;}
 state.running=true;state.lastAttemptUtc=new Date().toISOString();state.lastError=null;
 const startedUtc=state.lastAttemptUtc,errors=[],rows=[];
 let checked=0,quote=null;
 try{
  const apiKey=await optionalKey(c);
  try{
   const q=await(await reader.get('https://api.coinbase.com/v2/prices/ETH-USD/spot')).json();
   if(q.data?.base!=='ETH'||q.data.currency!=='USD'||!Number.isFinite(Number(q.data.amount))||Number(q.data.amount)<=0)throw new Error('币种或汇率无效');
   quote={ethUsd:Number(q.data.amount),checkedUtc:new Date().toISOString(),source:'Coinbase ETH/USD spot'};
  }catch(e){errors.push(`美元折算不可用：${e.message}；非 ETH 报价无法参与比较`);}
  const discovery=await discoverPublic(c,reader,p=>state.progress=p);
  const discovered=discovery.found;errors.push(...discovery.errors);
  const cacheFile=path.join(ROOT,'data','discovered.json');let cache=[];
  try{cache=JSON.parse(await readFile(cacheFile,'utf8'));if(!Array.isArray(cache))cache=[];}catch{}
  const history=new Map(cache.filter(x=>c.chains.includes(x.chain)&&/^[a-z0-9_-]+$/i.test(x.slug??'')).map(x=>[x.slug,x]));
  for(const [slug,r] of discovered)history.set(slug,{...r,seenUtc:startedUtc});
  const retained=[...history.values()].sort((a,b)=>(b.seenUtc??'').localeCompare(a.seenUtc??'')).slice(0,300);
  await mkdir(path.dirname(cacheFile),{recursive:true});await writeFile(cacheFile+'.tmp',JSON.stringify(retained,null,2));await rename(cacheFile+'.tmp',cacheFile);
  for(const r of chainLive?.rows.values()??[])if(r.slug&&!discovered.has(r.slug))discovered.set(r.slug,{slug:r.slug,name:r.name,chain:'robinhood',address:r.address});
  const pool=new Map(c.watchlist.map(slug=>[slug,discovered.get(slug)??{slug}]));
  for(const [slug,r] of discovered)if(!pool.has(slug))pool.set(slug,r);
  for(const r of retained)if(!pool.has(r.slug))pool.set(r.slug,r);
  const previous=new Map((state.report?.rows??[]).map(r=>[r.slug,r]));
  const earlySlugs=new Set(rankedChainRows().filter(r=>(r.activity?.wallets5m??0)>=8||r.status==='待开售'&&r.startTime-Date.now()/1000<=3600).map(r=>r.slug).filter(Boolean));
  // Recheck active/upcoming candidates first, then new and least recently read
  // collections so the per-round cap cannot permanently starve old discoveries.
  const selected=[...pool.values()].sort((a,b)=>{
   const priority=x=>earlySlugs.has(x.slug)?-2:marketDirty.has(x.slug)?-1:['优先复核','待开售'].includes(previous.get(x.slug)?.status)?0:1;
   return priority(a)-priority(b)||(previous.get(a.slug)?.marketCheckedUtc??'').localeCompare(previous.get(b.slug)?.marketCheckedUtc??'');
  }).slice(0,c.maxCollections);
  for(const [i,item] of selected.entries()){
   if(Date.now()<reader.deferUntil){errors.push('因限流提前结束，部分项目尚未抓取');break;}
   state.progress=`核验 ${i+1}/${selected.length}：${item.slug}`;
   let row;
   try{
    row=collection(parsePage(await (await reader.get(`https://opensea.io/collection/${encodeURIComponent(item.slug)}/overview`)).text()),item.slug);
    if(!c.chains.includes(row.chain))continue;
    checked++;
    if(apiKey){
     try{applyStats(row,await (await reader.get(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(row.slug)}/stats`,{'x-api-key':apiKey})).json());}
     catch(e){errors.push(`${row.slug} 统计 API：${e.message}；本项目使用公开页面数据`);}
    }
    try{row.onchain=await inspect(row);}catch(e){row.onchain={error:e.message};}
   }catch(e){row={...item,name:item.name??item.slug,url:`https://opensea.io/collection/${encodeURIComponent(item.slug)}/overview`,creatorFeeBps:null,onchain:{error:`行情读取失败：${e.message}`}};errors.push(`${item.slug}：${e.message}`);}
   rows.push(assess(row,c,quote));marketDirty.delete(row.slug);chainLive?.seed({rows:[row]});
  }
  const order={'优先复核':0,'观察':1,'待开售':2,'待核验':3,'排除':4};
  rows.sort((a,b)=>order[a.status]-order[b.status]||(b.estimatedProfitEth??-Infinity)-(a.estimatedProfitEth??-Infinity));
  const report={version:2,startedUtc,finishedUtc:new Date().toISOString(),complete:errors.length===0,coverage:{source:'OpenSea Drop 日历＋Drops 首页＋Robinhood 系列榜单＋历史发现＋自选列表；仅公开页面，非全链全量。分页重复即停止，更多游标分页需官方 API。',pagesRequested:discovery.pagesRequested,pagesRead:discovery.pagesRead,duplicatePages:discovery.duplicatePages,sources:discovery.sources,discoveredSupported:discovered.size,tracked:pool.size,selected:selected.length,checked,omittedByLimit:Math.max(0,pool.size-c.maxCollections)},settings:{...c,apiKeyFile:undefined,apiKeyEnabled:Boolean(apiKey)},quote,errors,rows};
  await saveReport(report);state.report=report;chainLive?.seed(report);refreshSubscriptions();state.progress=`本轮完成：${rows.filter(r=>r.status==='优先复核').length} 个优先复核，${rows.length} 个结果`;
  if(errors.length)state.lastError='本轮有数据缺失，请查看覆盖范围和错误记录';
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${state.progress}${errors.length?`；${errors.length} 项读取问题`:''}`);
 }catch(e){state.lastError=e.message;state.progress='扫描失败，保留上次结果';console.error(e.message);}
 finally{state.running=false;state.nextScanUtc=new Date(Math.max(Date.now()+c.intervalSeconds*1000,reader.deferUntil)).toISOString();}
 return state.report;
}
