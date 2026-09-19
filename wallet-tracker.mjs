import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Interface,ZeroAddress,formatEther} from 'ethers';
import {Rpc,requireThat,safeError,nft} from './lib.mjs';
import {SEAPORT} from './nft-market.mjs';
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const address=v=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v)&&!eq(v,ZeroAddress);
const hex=n=>'0x'+n.toString(16),topic=a=>'0x'+a.slice(2).toLowerCase().padStart(64,'0');
export const TRANSFERS=new Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)','event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)','event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)']);
export const FILLS=new Interface(['event OrderFulfilled(bytes32 orderHash,address indexed offerer,address indexed zone,address recipient,tuple(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,tuple(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)']);
export const DEFAULT_TRACKER={wallets:[],windowSeconds:300,threshold:3,pollSeconds:4,confirmations:2,lookbackBlocks:300};
export function trackerSettings(b){
 requireThat(Array.isArray(b.wallets)&&b.wallets.length<=200,'最多监控 200 个公开钱包地址。');
 const seen=new Set(),wallets=[];
 for(const w of b.wallets){requireThat(address(w.address),'钱包必须是完整 0x 地址，不接受私钥或助记词。');const a=w.address.toLowerCase();if(seen.has(a))continue;seen.add(a);
  for(const k of ['label','group','cluster'])requireThat(w[k]===undefined||(typeof w[k]==='string'&&w[k].length<=60&&!/(?:0x)?[a-f0-9]{64}/i.test(w[k])),'标签最多 60 字，不应包含私钥。');
  wallets.push({address:a,label:w.label||a.slice(0,10),group:w.group||'未分组',cluster:w.cluster||'',focus:w.focus===true});
 }
 const c={...DEFAULT_TRACKER,...Object.fromEntries(['windowSeconds','threshold','pollSeconds','confirmations','lookbackBlocks'].map(k=>[k,Number(b[k]??DEFAULT_TRACKER[k])])),wallets};
 for(const [k,min,max]of [['windowSeconds',60,1800],['threshold',2,20],['pollSeconds',2,60],['confirmations',1,20],['lookbackBlocks',0,2000]])requireThat(Number.isInteger(c[k])&&c[k]>=min&&c[k]<=max,'监控参数超出允许范围。');return c;
}
export function decodeTransfers(log){
 try{if(log.removed)return [];const e=TRANSFERS.parseLog(log);if(!e)return [];const a=e.args;
  const ids=e.name==='TransferBatch'?[...a.ids]:[e.name==='Transfer'?a.tokenId:a.id],amounts=e.name==='TransferBatch'?[...a[4]]:[e.name==='Transfer'?1n:a.value];
  if(ids.length>1000||ids.length!==amounts.length)return [];
  return ids.map((id,i)=>({contract:log.address.toLowerCase(),tokenId:id.toString(),quantity:amounts[i].toString(),from:a.from.toLowerCase(),to:a.to.toLowerCase(),standard:e.name==='Transfer'?'erc721':'erc1155',logIndex:Number(BigInt(log.logIndex)),tx:log.transactionHash,block:Number(BigInt(log.blockNumber)),blockHash:log.blockHash}));
 }catch{return [];}
}
function saleFor(t,r){
 for(const l of r.logs??[]){if(l.removed||!eq(l.address,SEAPORT))continue;let e;try{e=FILLS.parseLog(l);}catch{}if(!e)continue;
  const a=e.args,match=i=>[2n,3n].includes(i.itemType)&&eq(i.token,t.contract)&&i.identifier.toString()===t.tokenId&&i.amount.toString()===t.quantity;
  const listing=a.offer.some(match)&&eq(a.offerer,t.from)&&eq(a.recipient,t.to);
  const bid=a.consideration.some(i=>match(i)&&eq(i.recipient,t.to))&&eq(a.offerer,t.to)&&eq(a.recipient,t.from);
  if(!listing&&!bid)continue;
  const items=[...a.offer,...a.consideration].filter(i=>[2n,3n].includes(i.itemType)),payments=(listing?a.consideration:a.offer).filter(i=>i.itemType===0n||i.itemType===1n);
  if(!payments.some(p=>p.amount>0n))continue;
  let payment=null;if(items.length===1&&payments.length&&payments.every(p=>p.itemType===payments[0].itemType&&eq(p.token,payments[0].token))){const value=payments.reduce((s,p)=>s+p.amount,0n);if(value>0n)payment={value:value.toString(),token:payments[0].token,native:payments[0].itemType===0n};}
  return {orderHash:a.orderHash,payment};
 }return null;
}
export function classifyTransfer(t,tx,r,w){
 if(r?.status!=='0x1'||!eq(r.transactionHash,t.tx)||!eq(tx?.hash,t.tx)||!eq(r.blockHash,t.blockHash)||!eq(tx.blockHash,t.blockHash)||Number(BigInt(tx.chainId??0))!==4663)return null;
 const incoming=eq(t.to,w.address),outgoing=eq(t.from,w.address);if(!incoming&&!outgoing)return null;
 const sale=saleFor(t,r);let kind='transfer',actionable=false;
 if(incoming&&eq(t.from,ZeroAddress)){kind=eq(tx.from,w.address)?'mint':'received';actionable=kind==='mint';}
 else if(sale&&!eq(t.from,t.to)){kind=incoming?'buy':'sell';actionable=true;}
 else kind=eq(t.from,t.to)?'self':incoming?'received':'sent';
 return {...t,id:`${t.blockHash}:${t.tx}:${t.logIndex}:${t.tokenId}:${w.address}`,wallet:w.address,label:w.label,group:w.group,cluster:w.cluster,focus:w.focus,kind,actionable,payment:sale?.payment??null,orderHash:sale?.orderHash??null,payer:tx.from.toLowerCase(),transactionValueEth:formatEther(tx.value??0),gasEth:r.effectiveGasPrice?formatEther(BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice)):null};
}
export function trackerAlerts(events,c,now){
 const current=events.filter(e=>!e.historical&&e.at<=now&&e.at>=now-c.windowSeconds*1000&&e.actionable),out=[],groups=new Map();
 for(const e of current){
  if(e.focus){const sameAction=current.filter(x=>x.wallet===e.wallet&&x.contract===e.contract&&x.kind===e.kind);const first=sameAction.reduce((a,b)=>a.at<=b.at?a:b);if(first.id===e.id)out.push({id:'focus:'+e.id,type:'focus',contract:e.contract,at:e.at,wallets:[e.wallet],kind:e.kind,message:`重点钱包 ${e.label} ${e.kind==='mint'?'主动 mint':e.kind==='buy'?'买入':'卖出'}（当前窗口）`});}
  const key=e.contract+':'+(e.kind==='sell'?'sell':'entry');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);
 }
 for(const list of groups.values()){const participants=new Set(list.map(e=>e.cluster?'cluster:'+e.cluster:'address:'+e.wallet));if(participants.size<c.threshold)continue;const last=list.reduce((a,b)=>a.at>b.at?a:b),wallets=[...new Set(list.map(e=>e.wallet))];out.push({id:`crowd:${last.contract}:${last.kind==='sell'?'sell':'entry'}`,type:'crowd',contract:last.contract,at:last.at,wallets,participants:participants.size,kind:last.kind==='sell'?'sell':'entry',message:`${Math.round(c.windowSeconds/60)} 分钟内 ${wallets.length} 个地址${last.kind==='sell'?'集中卖出':'共同参与'}；按已设置关联组计 ${participants.size} 组，真实独立性未核实`});}
 return out.sort((a,b)=>b.at-a.at).slice(0,100);
}
export class WalletTracker{
 constructor(root,{rpcFactory=url=>new Rpc(url)}={}){this.dir=path.join(root,'data/wallet-tracker');this.rpcFactory=rpcFactory;this.config={...DEFAULT_TRACKER};this.events=[];this.cursor=null;this.hash=null;this.running=false;this.busy=false;this.error=null;this.checkedAt=null;this.tip=null;this.epoch=0;this.standardCache=new Map();this.names=new Map();}
 async init(){await mkdir(this.dir,{recursive:true});try{this.config=trackerSettings(JSON.parse(await readFile(path.join(this.dir,'settings.local.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')this.error='钱包监控配置无法读取，请重新保存。';}try{const s=JSON.parse(await readFile(path.join(this.dir,'state.local.json'),'utf8'));if(Number.isSafeInteger(s.cursor)&&/^0x[0-9a-f]{64}$/i.test(s.hash)){this.cursor=s.cursor;this.hash=s.hash;this.events=(s.events??[]).slice(-2000).map(e=>({...e,historical:true}));}}catch{} }
 async persist(file,v){const dest=path.join(this.dir,file),temp=dest+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(v),{mode:0o600});await rename(temp,dest);}
 async save(b){requireThat(!this.running&&!this.busy,'请先停止钱包监控再修改清单。');const c=trackerSettings(b);await this.persist('settings.local.json',c);this.config=c;this.events=[];this.cursor=null;this.hash=null;await this.persist('state.local.json',{cursor:null,hash:null,events:[]});return this.view();}
 async start(rpcUrl,wsUrl=''){requireThat(!this.running&&!this.busy,'钱包监控已启动或正在停止。');requireThat(this.config.wallets.length,'请先导入公开钱包地址。');const rpc=this.rpcFactory(rpcUrl);requireThat(Number(BigInt(await rpc.send('eth_chainId')))===4663,'钱包监控目前只支持 Robinhood 4663。');this.rpc=rpc;this.running=true;this.epoch++;this.error=null;this.sessionStart=Date.now();this.timer=setInterval(()=>void this.tick(),this.config.pollSeconds*1000);this.timer.unref?.();
  this.wsState=wsUrl?'连接中':'HTTP 补查';if(wsUrl){try{new Rpc(wsUrl.replace(/^ws/,'http'));requireThat(/^wss?:\/\//.test(wsUrl),'WS 地址无效');const ws=new WebSocket(wsUrl);this.ws=ws;ws.onopen=()=>{if(this.ws!==ws)return;ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_subscribe',params:['newHeads']}));};ws.onmessage=e=>{if(this.ws!==ws)return;try{const v=JSON.parse(e.data);if(v.error){this.wsState='WS 不可用，HTTP 补查';ws.close();}else if(v.method==='eth_subscription'||v.result){this.wsState='WS 已连接 + HTTP 补查';void this.tick();}}catch{}};ws.onerror=()=>{if(this.ws===ws)this.wsState='WS 不可用，HTTP 补查';};ws.onclose=()=>{if(this.ws===ws)this.wsState='WS 已断开，HTTP 补查';};}catch{this.wsState='WS 不可用，HTTP 补查';}}
  void this.tick();return this.view();
 }
 stop(){this.running=false;this.epoch++;clearInterval(this.timer);const ws=this.ws;this.ws=null;try{ws?.close();}catch{}return this.view();}
 async supported(t){const key=t.contract+':'+t.standard;if(this.standardCache.has(key))return this.standardCache.get(key);let ok;const abi=new Interface(['function supportsInterface(bytes4) view returns(bool)']);try{ok=(await this.rpc.call(abi,t.contract,'supportsInterface',[t.standard==='erc721'?'0x80ac58cd':'0xd9b67a26']))[0]===true;}catch{requireThat(false,'NFT 标准查询未完成，本段将重试。');}if(this.standardCache.size>1000)this.standardCache.clear();this.standardCache.set(key,ok);return ok;}
 async tick(){if(!this.running||this.busy)return;this.busy=true;const epoch=this.epoch;try{
  const latest=await this.rpc.send('eth_getBlockByNumber',['latest',false]);requireThat(latest?.number&&latest.timestamp&&Math.abs(Number(BigInt(latest.timestamp))*1000-Date.now())<90000,'节点时间落后，等待 RPC 恢复。');const tip=Number(BigInt(latest.number))-this.config.confirmations;this.tip=tip;
  if(this.cursor===null){this.cursor=Math.max(0,tip-this.config.lookbackBlocks);this.hash=(await this.rpc.send('eth_getBlockByNumber',[hex(this.cursor),false]))?.hash;}
  else{const checkpoint=await this.rpc.send('eth_getBlockByNumber',[hex(this.cursor),false]);requireThat(checkpoint?.hash,'无法核对断点区块。');if(!eq(checkpoint.hash,this.hash)){this.cursor=Math.max(0,this.cursor-64);this.events=[];this.hash=(await this.rpc.send('eth_getBlockByNumber',[hex(this.cursor),false]))?.hash;this.error='检测到区块变化，已回退补查。';}}
  if(this.cursor>=tip){this.checkedAt=Date.now();this.error=null;return;}
  const from=this.cursor+1,to=Math.min(tip,from+63),anchor=await this.rpc.send('eth_getBlockByNumber',[hex(to),false]),topics=this.config.wallets.map(w=>topic(w.address)),logs=[];
  for(let i=0;i<topics.length;i+=50){const set=topics.slice(i,i+50);for(const [event,index]of [['Transfer',1],['TransferSingle',2],['TransferBatch',2]])for(const side of [index,index+1]){if(epoch!==this.epoch)return;const filter=[TRANSFERS.getEvent(event).topicHash];while(filter.length<=side)filter.push(null);filter[side]=set;const batch=await this.rpc.send('eth_getLogs',[{fromBlock:hex(from),toBlock:hex(to),topics:filter}]);requireThat(Array.isArray(batch)&&batch.length<10000,'日志过多或格式异常，本段未跳过，请缩小钱包清单。');logs.push(...batch);}}
  const unique=new Map(logs.flatMap(decodeTransfers).map(t=>[t.tx+':'+t.logIndex+':'+t.tokenId,t]));requireThat(unique.size<=1500,'本段 NFT 活动过多，请缩小监控范围。');
  const blocks=new Map(),transactions=new Map(),newEvents=[];const watched=new Map(this.config.wallets.map(w=>[w.address,w]));
  for(const t of unique.values()){
   if(epoch!==this.epoch)return;if(!await this.supported(t))continue;
   if(!transactions.has(t.tx))transactions.set(t.tx,await Promise.all([this.rpc.send('eth_getTransactionByHash',[t.tx]),this.rpc.send('eth_getTransactionReceipt',[t.tx])]));const [tx,r]=transactions.get(t.tx);
   requireThat(tx&&r&&eq(r.blockHash,t.blockHash),'回执尚未完整或发生重组，稍后重试。');
   if(!blocks.has(t.block))blocks.set(t.block,await this.rpc.send('eth_getBlockByNumber',[hex(t.block),false]));const block=blocks.get(t.block);requireThat(eq(block?.hash,t.blockHash),'区块已变化，重新扫描。');
   for(const a of new Set([t.from,t.to])){const w=watched.get(a);if(!w)continue;const e=classifyTransfer(t,tx,r,w);if(e){if(!this.names.has(t.contract)){let name='';try{name=String((await this.rpc.call(nft,t.contract,'name',[]))[0]).slice(0,100);}catch{}this.names.set(t.contract,name);}e.name=this.names.get(t.contract);e.at=Number(BigInt(block.timestamp))*1000;e.historical=e.at<this.sessionStart;e.detectedAt=Date.now();newEvents.push(e);}}
  }
  const end=await this.rpc.send('eth_getBlockByNumber',[hex(to),false]);requireThat(end?.hash&&eq(end.hash,anchor?.hash),'扫描期间区块变化，本段将重试。');if(epoch!==this.epoch)return;
  const all=new Map([...this.events,...newEvents].map(e=>[e.id,e]));this.events=[...all.values()].sort((a,b)=>a.block-b.block||a.logIndex-b.logIndex).slice(-2000);this.cursor=to;this.hash=end.hash;this.checkedAt=Date.now();this.error=null;await this.persist('state.local.json',{cursor:this.cursor,hash:this.hash,events:this.events});
 }catch(e){if(epoch===this.epoch)this.error=safeError(e);}finally{this.busy=false;}}
 view(){const now=Date.now(),healthy=this.running&&!this.error&&this.checkedAt&&now-this.checkedAt<Math.max(30000,this.config.pollSeconds*3000)&&this.cursor>=this.tip;return {running:this.running,busy:this.busy,config:this.config,error:this.error,checkedAt:this.checkedAt,cursor:this.cursor,tip:this.tip,wsState:this.wsState||'未启动',healthy:!!healthy,alerts:healthy?trackerAlerts(this.events,this.config,now):[],events:[...this.events].reverse().slice(0,500),retained:this.events.length};}
}
