import {Worker} from 'node:worker_threads';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {MarketStream} from './monitor/market-stream.mjs';
import {Rpc,Stop,requireThat} from './lib.mjs';
export const DEFAULT_MONITOR={rpcUrl:'https://rpc.mainnet.chain.robinhood.com',wsUrl:'',intervalSeconds:300,profitMultiple:2,watchlist:[]};
export function monitorSettings(b){
 const c={rpcUrl:String(b.rpcUrl||DEFAULT_MONITOR.rpcUrl).trim(),wsUrl:String(b.wsUrl||'').trim(),intervalSeconds:Number(b.intervalSeconds??300),profitMultiple:Number(b.profitMultiple??2),watchlist:b.watchlist??[]};
 new Rpc(c.rpcUrl);
 requireThat(Number.isInteger(c.intervalSeconds)&&c.intervalSeconds>=60&&c.intervalSeconds<=86400,'扫描间隔须为 60–86400 秒。');
 requireThat(Number.isFinite(c.profitMultiple)&&c.profitMultiple>0&&c.profitMultiple<=1000,'利润倍数须大于 0 且不超过 1000。');
 requireThat(Array.isArray(c.watchlist)&&c.watchlist.length<=60&&c.watchlist.every(s=>/^[a-z0-9_-]{1,150}$/i.test(s)),'自选列表应为系列 slug，每行一个，最多 60 个。');
 if(c.wsUrl){let u;try{u=new URL(c.wsUrl);}catch{}requireThat(u&&['ws:','wss:'].includes(u.protocol),'WS 地址格式错误。');new Rpc(c.wsUrl.replace(/^ws/,'http'));}
 return c;
}
export function scanConfig(c){return {chains:['robinhood'],intervalSeconds:c.intervalSeconds,discoveryPages:3,maxCollections:80,freeOnly:false,maxGasEth:null,minFloorEth:0,minVolume24hEth:0,profitMetric:'profitToCost',profitMultiple:c.profitMultiple,minFloorToCost:3,minMarginEth:0.00005,floorHaircut:0.5,assumedMarketplaceFeeBps:250,assumedExitGasUnits:200000,watchlist:c.watchlist,apiKeyFile:'data/opensea-key.local.json',port:8792,requireSecondarySales:false,minSecondarySales:3,minUniqueBuyers:2,valuationMode:'sales-conservative-v1',realtime:{http:c.rpcUrl,ws:c.wsUrl,fallback:DEFAULT_MONITOR.rpcUrl}};}
export class MonitorService{
 constructor(root,{workerFactory=(url,opt)=>new Worker(url,opt),validatorFactory=file=>new MarketStream(file)}={}){this.root=root;this.dir=path.join(root,'monitor/data');this.file=path.join(this.dir,'settings.local.json');this.keyFile=path.join(this.dir,'opensea-key.local.json');this.config={...DEFAULT_MONITOR};this.configured=false;this.worker=null;this.latest=null;this.error=null;this.workerFactory=workerFactory;this.validatorFactory=validatorFactory;}
 async init(){await mkdir(this.dir,{recursive:true});try{this.config=monitorSettings(JSON.parse(await readFile(this.file,'utf8')));}catch(e){if(e.code!=='ENOENT')this.error='监控配置无法读取，已使用默认设置。';}try{const b=JSON.parse(await readFile(this.keyFile,'utf8'));this.configured=typeof b.apiKey==='string'&&!!b.apiKey.trim();}catch{}try{this.latest={scan:{report:JSON.parse(await readFile(path.join(this.dir,'latest.json'),'utf8')),running:false,progress:'历史结果；监控尚未启动'}};}catch{}}
 async save(b){
  const c=monitorSettings(b);requireThat(!this.worker,'先停止监控，再修改设置。自动 mint 任务不受影响。');
  if(typeof b.apiKey==='string'&&b.apiKey.trim()){
   const validator=this.validatorFactory(this.keyFile);validator.stopped=true;
   try{await validator.configure(b.apiKey.trim());}catch(e){throw new Stop(/^OpenSea 验证失败：HTTP \d+；尚未保存$|^请输入有效的 OpenSea API Key|^这里仅接受/.test(e.message)?e.message:'OpenSea Key 验证失败；请检查 Key 和网络。');}finally{validator.stop();}
   this.configured=true;
  }
  await writeFile(this.file,JSON.stringify(c,null,2),{mode:0o600});this.config=c;this.error=null;return this.snapshot();
 }
 async removeKey(){await this.stop();try{await unlink(this.keyFile);}catch(e){if(e.code!=='ENOENT')throw new Stop('未能删除本机 Key 文件。');}this.configured=false;return this.snapshot();}
 start(){requireThat(this.configured,'请先在监控设置中填写并验证自己的 OpenSea API Key。');requireThat(!this.worker,'监控已经运行。');this.error=null;
  const worker=this.workerFactory(new URL('./monitor/worker.mjs',import.meta.url),{workerData:{config:scanConfig(this.config),storageRoot:path.join(this.root,'monitor')},stdout:true,stderr:true});this.worker=worker;
  // Worker output is deliberately not logged: API/RPC credentials belong only
  // to local configuration and must not appear in console output or exports.
  worker.stdout?.resume();worker.stderr?.resume();
  worker.on('message',m=>{if(this.worker!==worker)return;if(m.type==='snapshot')this.latest=m.value;else if(m.type==='failure'){this.error=m.message;void this.stop();}});
  worker.on('error',()=>{if(this.worker===worker)this.error='监控进程异常；请检查设置后重新启动。';});
  worker.on('exit',()=>{if(this.worker===worker)this.worker=null;});return this.snapshot();
 }
 async stop(){const w=this.worker;this.worker=null;if(w){w.postMessage({type:'stop'});await w.terminate();}return this.snapshot();}
 scan(){requireThat(this.worker,'请先启动监控。');requireThat(!this.latest?.scan?.running,'本轮正在扫描。');this.worker.postMessage({type:'scan'});return {};}
 snapshot(){return {enabled:!!this.worker,configured:this.configured,config:this.config,error:this.error,latest:this.latest};}
 candidates(){return (this.latest?.scan?.report?.rows??[]).map(r=>({...r,source:'market'})).concat((this.latest?.chain?.rows??[]).map(r=>({...r,source:'chain',chain:'robinhood'})));}
 draft(b){const r=this.candidates().find(r=>r.address?.toLowerCase()===String(b.address).toLowerCase()&&r.source===b.source);requireThat(r&&r.chain==='robinhood','项目不在监控结果中，请重新扫描。');return {name:r.name,address:r.address,slug:r.slug,chainId:4663,rpcUrl:this.config.rpcUrl,quantity:1,maxPriceEth:String(r.onchain?.mintPriceEth??r.mintPriceEth??0),maxGasEth:'0.001'};}
}
