import {Interface,formatEther,ZeroAddress} from 'ethers';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {MintActivity} from './activity.mjs';

export const SEA='0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
export const ABI=new Interface([
 'event PublicDropUpdated(address indexed nftContract,tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients) publicDrop)',
 'event SeaDropMint(address indexed nftContract,address indexed minter,address indexed feeRecipient,address payer,uint256 quantityMinted,uint256 unitMintPrice,uint256 feeBps,uint256 dropStageIndex)',
 'event AllowListUpdated(address indexed nftContract,bytes32 indexed previousMerkleRoot,bytes32 indexed newMerkleRoot,string[] publicKeyURI,string allowListURI)',
 'event TokenGatedDropStageUpdated(address indexed nftContract,address indexed allowedNftToken,tuple(uint80 mintPrice,uint16 maxTotalMintableByWallet,uint48 startTime,uint48 endTime,uint8 dropStageIndex,uint32 maxTokenSupplyForStage,uint16 feeBps,bool restrictFeeRecipients) dropStage)',
 'event DropURIUpdated(address indexed nftContract,string newDropURI)',
 'function getPublicDrop(address) view returns(tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
 'function getMintStats(address) view returns(uint256,uint256,uint256)',
 'function name() view returns(string)'
]);
export const TOPICS=['PublicDropUpdated','SeaDropMint','AllowListUpdated','TokenGatedDropStageUpdated','DropURIUpdated'].map(n=>ABI.getEvent(n).topicHash);
const hex=n=>'0x'+n.toString(16),validAddress=s=>/^0x[0-9a-f]{40}$/i.test(s??'');
const eventLabels={PublicDropUpdated:'公售配置变更',SeaDropMint:'链上 mint 活动',AllowListUpdated:'白名单更新',TokenGatedDropStageUpdated:'持币阶段更新',DropURIUpdated:'项目资料更新'};
const allowed=new Set(['eth_chainId','eth_getCode','eth_getBlockByNumber','eth_getLogs','eth_call']);
export async function readRpc(url,method,params=[]){
 if(!allowed.has(method))throw new Error('仅允许只读 RPC');
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(6000)});
 if(!r.ok)throw new Error('RPC HTTP '+r.status);
 const b=await r.json();if(b.error||b.result===undefined)throw new Error('RPC 返回错误'+(b.error?.code?' '+b.error.code:''));return b.result;
}
export function decodeEvent(log){
 if(log.address?.toLowerCase()!==SEA.toLowerCase())return null;
 try{const p=ABI.parseLog(log);if(!p||!eventLabels[p.name])return null;
 return {address:p.args.nftContract.toLowerCase(),kind:p.name,block:Number(BigInt(log.blockNumber)),hash:log.blockHash,tx:log.transactionHash,index:Number(BigInt(log.logIndex??'0x0')),removed:log.removed===true,...(p.name==='SeaDropMint'?{minter:p.args.minter.toLowerCase(),payer:p.args.payer.toLowerCase(),quantity:p.args.quantityMinted.toString(),stage:Number(p.args.dropStageIndex)}: {})};}catch{return null;}
}
export function dropPhase(row,nowSeconds,healthy=true){
 if(!healthy||!row.checkedUtc||Date.now()-Date.parse(row.checkedUtc)>90000||row.error)return '待核验';
 if(row.remaining==='0')return '已售罄';
 if(!row.startTime||row.endTime<=row.startTime||!row.walletLimit)return '未配置公售';
 if(nowSeconds>=row.endTime)return '已结束';
 if(nowSeconds<row.startTime)return '待开售';
 return '公售开放';
}
export function applyEvent(rows,event,live=false,now=new Date().toISOString()){
 if(!event||!validAddress(event.address))return false;
 const old=rows.get(event.address);
 if(old?.eventBlock>event.block&&!event.removed)return false;
 const isNew=!old;
 rows.set(event.address,{...old,address:event.address,name:old?.name||event.address,firstSeenUtc:old?.firstSeenUtc??now,discoveredLive:old?.discoveredLive||live,eventBlock:event.block,eventKind:event.kind,eventLabel:eventLabels[event.kind],eventTx:event.tx,eventUtc:now,unconfirmed:true,...(event.removed?{error:'事件发生重组，正在重新核验',checkedUtc:null}:{})});
 return isNew;
}
export class ChainDiscovery {
 constructor(root,cfg={}){
  this.root=root;this.cfg={http:'https://rpc.mainnet.chain.robinhood.com',ws:'',fallback:'https://rpc.mainnet.chain.robinhood.com',...cfg};
  this.activity=new MintActivity();this.activityQueue=new Map();this.activityPending=0;this.activityGeneration=0;this.activityTimes=new Map();this.rows=new Map();this.queue=new Set();this.inflight=new Set();this.seen=new Set();this.alerts=[];this.cursor=null;this.cursorHash=null;this.head=null;this.status='正在连接';this.wsStatus='正在连接';this.error=null;this.busy=false;this.stopped=false;this.backoff=1000;this.source='所选 RPC';this.url=this.cfg.http;this.verified=new Set();this.lastSave=0;this.chunk=5000;this.lastRefresh=0;this.lastProbe=0;this.nextId=0;
 }
 async rpc(m,p=[]){
  try{return await readRpc(this.url,m,p);}catch(e){throw new Error(e.message);}
 }
 async verify(url){if(this.verified.has(url))return;if(Number(BigInt(await readRpc(url,'eth_chainId')))!==4663)throw new Error('链 ID 不符');if((await readRpc(url,'eth_getCode',[SEA,'latest'])).length<10)throw new Error('未找到 SeaDrop 合约');this.verified.add(url);}
 async start(){
  try{const saved=JSON.parse(await readFile(path.join(this.root,'data/chain-discovery.json'),'utf8'));if(saved.version===1){this.cursor=saved.cursor;this.cursorHash=saved.cursorHash;for(const r of saved.rows??[])if(validAddress(r.address))this.rows.set(r.address,r);this.alerts=(saved.alerts??[]).slice(-80);this.coverageStart=saved.coverageStart;}}catch{}
  for(const a of this.rows.keys())this.queue.add(a);
  this.connect();void this.tick();this.timer=setInterval(()=>void this.tick(),3000);this.worker=setInterval(()=>this.drain(),200);this.watchdog=setInterval(()=>{if(this.ws&&Date.now()-(this.lastWs??0)>20000)this.ws.close();},5000);
 }
 connect(){
  if(this.stopped)return;
  if(!this.cfg.ws){this.wsStatus='未配置 WS，使用 HTTP 轮询';return;}
  this.wsStatus='正在重连';this.lastWs=Date.now();
  let ws;try{ws=new WebSocket(this.cfg.ws);}catch{this.scheduleReconnect();return;}this.ws=ws;
  ws.onopen=()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}));
  ws.onmessage=e=>{try{this.lastWs=Date.now();const b=JSON.parse(e.data);
   if(b.id===1){if(b.error||Number(BigInt(b.result))!==4663){this.wsStatus='WS 链 ID 不符';ws.close();return;}
    ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['newHeads']}));
    ws.send(JSON.stringify({jsonrpc:'2.0',id:3,method:'eth_subscribe',params:['logs',{address:SEA,topics:[TOPICS]}]}));return;}
   if(b.id===2||b.id===3){if(b.error){ws.close();return;}if(b.id===3){this.wsStatus='实时推送已连接';this.backoff=1000;}return;}
   const log=b.params?.result;if(log?.topics){this.ingest(log,true);this.drain();}
  }catch{}};
  ws.onerror=()=>{this.wsStatus='推送断开，HTTP 补查中';ws.close();};
  ws.onclose=()=>{if(this.ws===ws)this.ws=null;this.wsStatus='推送断开，HTTP 补查中';this.scheduleReconnect();};
 }
 scheduleReconnect(){if(this.stopped)return;clearTimeout(this.reconnect);this.reconnect=setTimeout(()=>this.connect(),this.backoff);this.backoff=Math.min(this.backoff*2,30000);}
 ingest(log,live=false){
  const event=decodeEvent(log);if(!event)return;
  if(event.removed){this.activityGeneration++;this.activity.gap();this.activityQueue.clear();this.activityTimes.clear();}
  else if(event.kind==='SeaDropMint'&&event.stage===0&&this.head&&event.block>=this.head.number-5000)this.queueActivity(event);
  const key=log.blockHash+':'+log.logIndex;if(!event.removed&&this.seen.has(key))return;
  this.seen.add(key);if(this.seen.size>20000)this.seen.delete(this.seen.values().next().value);
  const fresh=applyEvent(this.rows,event,live);this.queue.add(event.address);
  if(live&&(fresh||event.kind==='PublicDropUpdated'||event.removed))this.alert(event.address,event.removed?'链上事件重组，需重核':fresh?'发现新项目活动':'公售设置变更');
  // Retain pending updates across restarts; cursor is checkpointed with rows.
 }
 queueActivity(event){
  const key=event.hash+':'+event.index;
  if(this.activityQueue.size>=2000){this.activityGeneration++;this.activity.gap();this.activityQueue.clear();return;}
  this.activityQueue.set(key,event);this.drainActivity();
 }
 drainActivity(){
  if(this.stopped)return;
  while(this.activityPending<4&&this.activityQueue.size){
   const [key,event]=this.activityQueue.entries().next().value;this.activityQueue.delete(key);this.activityPending++;const generation=this.activityGeneration;
   let task=this.activityTimes.get(event.hash);
   if(!task){task=this.rpc('eth_getBlockByNumber',[hex(event.block),false]).then(b=>{if(!b||b.hash!==event.hash)throw Error('区块变化');return Number(BigInt(b.timestamp))*1000;});this.activityTimes.set(event.hash,task);if(this.activityTimes.size>2000)this.activityTimes.delete(this.activityTimes.keys().next().value);}
   void task.then(time=>{if(!this.stopped&&generation===this.activityGeneration)this.activity.add(event,time);}).catch(()=>{if(generation===this.activityGeneration){this.activityGeneration++;this.activity.gap();this.activityQueue.clear();this.activityTimes.clear();}}).finally(()=>{this.activityPending--;this.drainActivity();});
  }
 }
 alert(address,message){this.alerts.push({id:Date.now()+'-'+(++this.nextId),address,message,time:new Date().toISOString()});this.alerts=this.alerts.slice(-80);}
 async findStart(head){
  const cutoff=Number(BigInt(head.timestamp))-86400;let low=0,high=Number(BigInt(head.number));
  while(low<high){const mid=Math.floor((low+high)/2),b=await this.rpc('eth_getBlockByNumber',[hex(mid),false]);if(!b)throw new Error('历史区块不可用');if(Number(BigInt(b.timestamp))<cutoff)low=mid+1;else high=mid;}
  this.coverageStart={block:low,sinceUtc:new Date(cutoff*1000).toISOString()};return Math.max(0,low-1);
 }
 async tick(){
  if(this.busy||this.stopped)return;this.busy=true;
  try{
   if(this.url!==this.cfg.http&&Date.now()-this.lastProbe>60000){this.lastProbe=Date.now();try{await this.verify(this.cfg.http);const b=await readRpc(this.cfg.http,'eth_getBlockByNumber',['latest',false]);if(Math.abs(Date.now()/1000-Number(BigInt(b.timestamp)))<30){this.url=this.cfg.http;this.source='所选 RPC';}}catch{}}
   let head;
   try{await this.verify(this.url);head=await this.rpc('eth_getBlockByNumber',['latest',false]);if(!head||Math.abs(Date.now()/1000-Number(BigInt(head.timestamp)))>30)throw new Error('节点区块过旧');}
   catch(e){if(this.url===this.cfg.fallback)throw e;await this.verify(this.cfg.fallback);this.url=this.cfg.fallback;this.source='官方公共 RPC（所选接口故障备用）';head=await this.rpc('eth_getBlockByNumber',['latest',false]);if(!head||Math.abs(Date.now()/1000-Number(BigInt(head.timestamp)))>30)throw new Error('备用节点区块过旧');}
   this.head={number:Number(BigInt(head.number)),timestamp:Number(BigInt(head.timestamp)),checkedUtc:new Date().toISOString()};
   if(this.cursor===null){this.status='初始化：回查最近 24 小时';this.cursor=await this.findStart(head);}
   if(this.cursorHash){const prior=await this.rpc('eth_getBlockByNumber',[hex(this.cursor),false]);if(!prior||prior.hash!==this.cursorHash){this.cursor=Math.max(0,this.cursor-256);this.cursorHash=null;this.seen.clear();this.activityGeneration++;this.activity.gap();this.activityQueue.clear();this.activityTimes.clear();for(const r of this.rows.values()){r.checkedUtc=null;r.error='区块变更，重新核验';this.queue.add(r.address);}}}
   // Commit only fully read chunks; failed ranges are retried, never skipped.
   for(let count=0;count<8&&this.cursor<this.head.number;count++){
    const end=Math.min(this.cursor+this.chunk,this.head.number),logs=await this.rpc('eth_getLogs',[{address:SEA,topics:[TOPICS],fromBlock:hex(this.cursor+1),toBlock:hex(end)}]);
    if(!Array.isArray(logs))throw new Error('日志响应无效');
    for(const l of logs)this.ingest(l,false);
    const endBlock=await this.rpc('eth_getBlockByNumber',[hex(end),false]);if(!endBlock)throw new Error('区块不可用');
    // A reorg during the range read must not be committed as complete.
    if(logs.some(l=>Number(BigInt(l.blockNumber))===end&&l.blockHash!==endBlock.hash))throw new Error('日志区块变化，重试');
    this.cursor=end;this.cursorHash=endBlock.hash;
   }
   if(this.cursor===this.head.number&&this.status!=='实时监听中'){this.activityGeneration++;this.activity.gap();this.activityQueue.clear();}
   this.error=null;this.status=this.cursor<this.head.number?'历史日志补查中':'实时监听中';
   for(const r of this.rows.values()){
    const phase=dropPhase(r,this.head.timestamp,true);
    if(r.lastPhase&&r.lastPhase!=='公售开放'&&phase==='公售开放'){this.alert(r.address,'公售已开放（需核验资格）');this.queue.add(r.address);}
    if(phase==='待开售'&&r.startTime-this.head.timestamp<=300&&r.nearAlertStart!==r.startTime){r.nearAlertStart=r.startTime;this.alert(r.address,'公售将在 5 分钟内开始');}
    if(phase!=='待核验')r.lastPhase=phase;
   }
   if(Date.now()-this.lastRefresh>15000){this.lastRefresh=Date.now();for(const r of this.rows.values()){const phase=dropPhase(r,this.head.timestamp,true);if(!r.checkedUtc||Date.now()-Date.parse(r.checkedUtc)>60000||phase==='公售开放'||phase==='待开售'&&r.startTime-this.head.timestamp<600)this.queue.add(r.address);}}
   this.drain();if(Date.now()-this.lastSave>10000){await this.save();this.lastSave=Date.now();}
  }catch(e){this.activityGeneration++;this.activity.gap();this.activityQueue.clear();this.activityTimes.clear();this.error=e.message;this.status='读取异常，将自动重试';if(this.chunk>250)this.chunk=Math.max(250,Math.floor(this.chunk/2));}finally{this.busy=false;}
 }
 async save(){await mkdir(path.join(this.root,'data'),{recursive:true});const f=path.join(this.root,'data/chain-discovery.json');await writeFile(f+'.tmp',JSON.stringify({version:1,cursor:this.cursor,cursorHash:this.cursorHash,coverageStart:this.coverageStart,rows:[...this.rows.values()],alerts:this.alerts}));await rename(f+'.tmp',f);}
 seed(report){for(const r of report?.rows??[]){if(r.chain!=='robinhood'||r.dropType!=='SEADROP_V1_ERC721'||!validAddress(r.address))continue;const address=r.address.toLowerCase(),old=this.rows.get(address);this.rows.set(address,{...old,address,name:r.name,slug:r.slug,firstSeenUtc:old?.firstSeenUtc??new Date().toISOString(),source:old?.source??'OpenSea 页面发现'});if(!old)this.queue.add(address);}}
 drain(){if(this.stopped||!this.head||Date.now()-Date.parse(this.head.checkedUtc)>30000)return;for(const a of this.queue){if(this.inflight.size>=4)break;if(this.inflight.has(a))continue;this.queue.delete(a);this.inflight.add(a);void this.refresh(a).finally(()=>this.inflight.delete(a));}}
 async refresh(address){
  const old=this.rows.get(address);if(!old)return;
  const tag='latest',call=async(to,name,args)=>ABI.decodeFunctionResult(name,await this.rpc('eth_call',[{to,data:ABI.encodeFunctionData(name,args)},tag]));
  try{
   const [drop,stats,name]=await Promise.all([call(SEA,'getPublicDrop',[address]),call(address,'getMintStats',[ZeroAddress]),old.name!==address?old.name:call(address,'name',[]).then(x=>String(x[0]).slice(0,150)).catch(()=>address)]);
   const d=drop[0],now=new Date().toISOString();
   const r={...this.rows.get(address),name,mintPriceEth:Number(formatEther(d.mintPrice)),startTime:Number(d.startTime),endTime:Number(d.endTime),walletLimit:Number(d.maxTotalMintableByWallet),minted:stats[1].toString(),maxSupply:stats[2].toString(),remaining:(stats[2]>stats[1]?stats[2]-stats[1]:0n).toString(),checkedUtc:now,error:null};
   const phase=dropPhase(r,this.head.timestamp,true),before=old.lastPhase;
   if(before&&before!=='公售开放'&&phase==='公售开放')this.alert(address,'公售已开放（需核验资格）');
   if(phase==='待开售'&&r.startTime-this.head.timestamp<=300&&r.nearAlertStart!==r.startTime){r.nearAlertStart=r.startTime;this.alert(address,'公售将在 5 分钟内开始');}
   r.lastPhase=phase;this.rows.set(address,r);
  }catch{const r=this.rows.get(address);if(r){r.error='公售或库存读取失败，未核验';r.checkedUtc=new Date().toISOString();}}
 }
 snapshot(){
  const healthy=!!this.head&&Date.now()-Date.parse(this.head.checkedUtc)<30000&&!this.error;
  const now=healthy?this.head.timestamp:Math.floor(Date.now()/1000);
  const activity=this.activity.snapshot();
  const rows=[...this.rows.values()].map(r=>({...r,activity:{...(activity.get(r.address)||this.activity.empty()),healthy:healthy&&this.cursor===this.head.number&&this.activityQueue.size===0&&this.activityPending===0},status:dropPhase(r,now,healthy),profitStatus:'收益未知 / 未评估',startUtc:r.startTime?new Date(r.startTime*1000).toISOString():null,endUtc:r.endTime?new Date(r.endTime*1000).toISOString():null}));
  const order={'公售开放':0,'待开售':1,'待核验':2,'未配置公售':3,'已售罄':4,'已结束':5};rows.sort((a,b)=>order[a.status]-order[b.status]||(a.status==='待开售'?a.startTime-b.startTime:Date.parse(b.firstSeenUtc)-Date.parse(a.firstSeenUtc)));
  return {status:this.status,wsStatus:this.wsStatus,source:this.source,healthy,error:this.error,head:this.head,cursor:this.cursor,blocksToBackfill:this.head?Math.max(0,this.head.number-(this.cursor??0)):null,coverageStart:this.coverageStart,queued:this.queue.size,rows,alerts:this.alerts,scope:'Robinhood 指定 SeaDrop V1 合约的公售/白名单/持币阶段更新及 mint 事件；不覆盖所有自定义 mint，不代表官方认证，实时事件尚未最终确认。首次回查 24h，之后按持久化区块断点补查。'};
 }
 stop(){this.stopped=true;clearInterval(this.timer);clearInterval(this.worker);clearInterval(this.watchdog);clearTimeout(this.reconnect);this.ws?.close();}
}
