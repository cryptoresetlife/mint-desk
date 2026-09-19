import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Wallet } from 'ethers';
import { settings, CHAINS, Rpc, Stop, requireThat, safeError, json, identity, snapshot, publicSale, recordPath } from './lib.mjs';
import { MintJob, preflight } from './engine.mjs';
import {coordinator} from './coordinator.mjs';
import {NftMarket,ListingJob} from './nft-market.mjs';
import {MonitorService} from './monitor-service.mjs';
import {ProjectMarket} from './project-market.mjs';
import { parsePage, collection } from './opensea-page.mjs';
const base=path.dirname(fileURLToPath(import.meta.url)),data=path.join(base,'data'),records=path.join(data,'attempts');
const port=Number(process.env.MINT_DESK_PORT||8792),origin=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex');
const instanceId=createHash('sha256').update(path.resolve(base).toLowerCase()).digest('hex');
await mkdir(records,{recursive:true});
const monitor=new MonitorService(base);await monitor.init();
const projectMarket=new ProjectMarket(monitor.keyFile);
const nftMarket=new NftMarket({keyFile:monitor.keyFile,records,dir:path.join(data,'listings')});
let projects=[];
try{projects=JSON.parse(await readFile(path.join(data,'projects.local.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('项目文件无法读取，请保留文件并修复。');}
const wallets=new Map(),jobs=new Map(),reviews=new Map();let mutation=false;
const persist=()=>writeFile(path.join(data,'projects.local.json'),json(projects),{mode:0o600});
const active=()=>[...jobs.values()].filter(j=>!j.finished);
const walletView=()=>[...wallets.values()].map(w=>({id:w.id,address:w.address,label:w.label}));
const project=id=>{const p=projects.find(p=>p.id===id);requireThat(p,'项目不存在。');return p;};
function selected(ids){requireThat(Array.isArray(ids)&&ids.length>=1&&ids.length<=100,'选择 1–100 个钱包。');requireThat(new Set(ids).size===ids.length,'钱包选择重复。');return ids.map(id=>{const w=wallets.get(id);requireThat(w,'钱包已清除，请重新输入。');return w;});}
function slugOf(input){
  let value=String(input||'').trim();
  if(value.startsWith('https://')){let u;try{u=new URL(value);}catch{}requireThat(u?.hostname==='opensea.io','请使用 opensea.io 系列链接。');value=u.pathname.match(/\/(?:collection)\/([a-z0-9_-]+)/i)?.[1]??'';}
  requireThat(/^[a-z0-9_-]{1,150}$/i.test(value),'填写 OpenSea 系列链接、slug，或在合约栏直接填写地址。');return value;
}
async function resolve(input){
  const slug=slugOf(input);
  const cached=monitor.candidates().find(r=>r.slug===slug&&r.address);
  if(cached)return {slug,address:cached.address,name:cached.name,chainId:cached.chain==='ethereum'?1:4663};
  // A user-provided OpenSea link is resolved only through OpenSea or the
  // existing local scanner's public report, never as executable web content.
  try {
    const report=JSON.parse(await readFile(path.resolve(base,'../opensea-mint-scanner/data/latest.json'),'utf8'));
    const row=report.rows.find(r=>r.slug===slug);
    if(row?.address&&['robinhood','ethereum'].includes(row.chain))return {slug,address:row.address,name:row.name,chainId:row.chain==='robinhood'?4663:1};
  }catch{}
  try {
    const r=await fetch(`https://opensea.io/collection/${encodeURIComponent(slug)}/overview`,{signal:AbortSignal.timeout(12000)});requireThat(r.ok,'OpenSea 页面暂不可用。');
    const row=collection(parsePage(await r.text()),slug);requireThat(['robinhood','ethereum'].includes(row.chain),'该系列的链暂不支持。');
    return {slug,address:row.address,name:row.name,chainId:row.chain==='robinhood'?4663:1};
  }catch{throw new Stop('暂时无法解析链接。请从 OpenSea 详情复制 NFT 合约地址，选择正确链后直接添加。');}
}
async function history(){
  const all=[];for(const f of (await readdir(records)).filter(f=>f.endsWith('.json')).slice(-300))try{all.push(JSON.parse(await readFile(path.join(records,f),'utf8')));}catch{}
  return all.sort((a,b)=>b.createdUtc.localeCompare(a.createdUtc));
}
async function action(route,b){
  if(route==='/api/nfts/refresh'){
    const w=selected([b.walletId])[0],chainId=Number(b.chainId);requireThat(CHAINS[chainId],'网络不受支持。');
    const rpcUrl=b.rpcUrl?.trim()||(chainId===4663?monitor.config.rpcUrl:CHAINS[chainId].rpc);new Rpc(rpcUrl);
    return nftMarket.inventory(w,chainId,rpcUrl,b.next??'');
  }
  if(route==='/api/nfts/cost-chain'){
    const n=nftMarket.selected([b.itemId],[...wallets.values()])[0];
    const rpcUrl=b.rpcUrl?.trim()||(n.chainId===4663?monitor.config.rpcUrl:CHAINS[n.chainId].rpc);new Rpc(rpcUrl);
    return nftMarket.chainCost(n,rpcUrl,b.transactionHash?.trim()||'');
  }
  if(route==='/api/nfts/cost'){
    const n=nftMarket.selected([b.itemId],[...wallets.values()])[0];
    const cost=await nftMarket.costs.save(n,b);n.cost=cost;nftMarket.reviews.clear();return {cost};
  }
  if(route==='/api/nfts/market'){
    const n=nftMarket.selected([b.itemId],[...wallets.values()])[0];return projectMarket.get({chainId:n.chainId,address:n.contract});
  }
  if(route==='/api/listings/preview'||route==='/api/listings/currency'){
    const ns=nftMarket.selected(b.itemIds,[...wallets.values()]),chainId=ns[0].chainId;
    const rpcUrl=b.rpcUrl?.trim()||(chainId===4663?monitor.config.rpcUrl:CHAINS[chainId].rpc);new Rpc(rpcUrl);
    return route==='/api/listings/currency'?nftMarket.currency(b.itemIds,[...wallets.values()],rpcUrl):nftMarket.preview(b,[...wallets.values()],rpcUrl);
  }
  if(route==='/api/listings/start'){
    requireThat(b.confirm===true,'请核对上架售价、费用、期限并授权。');
    const review=nftMarket.reviews.get(b.reviewId);requireThat(review&&Date.now()-review.at<300000,'上架预检已过期，请重新检查。');
    const w=selected([review.rows[0].n.walletId])[0];requireThat(review.rows.every(r=>r.n.owner===w.address),'上架钱包不匹配。');
    const id=randomUUID(),job=new ListingJob({id,review,wallet:w,market:nftMarket});await coordinator.register(job,new Rpc(review.rpcUrl));
    nftMarket.reviews.delete(b.reviewId);jobs.set(id,job);job.run().catch(()=>{job.status='异常停止';job.finished=true;});return {id};
  }
  if(route==='/api/monitor/settings')return monitor.save(b);
  if(route==='/api/monitor/start')return monitor.start();
  if(route==='/api/monitor/stop')return monitor.stop();
  if(route==='/api/monitor/scan')return monitor.scan();
  if(route==='/api/monitor/remove-key')return monitor.removeKey();
  if(route==='/api/monitor/draft'){
    // Draft only. A monitored candidate never authorizes spending or imports a
    // wallet. The existing project review and transaction consent still apply.
    return monitor.draft(b);
  }
  if(route==='/api/resolve')return resolve(b.source);
  if(route==='/api/projects') {
    requireThat(!active().some(j=>j.p.id===b.id),'此项目正在运行，先停止后再修改。');
    const p={...settings(b),id:b.id||randomUUID()};
    const rpc=new Rpc(p.rpcUrl),ident=await identity(rpc,p),s=await snapshot(rpc,p);
    p.name=ident.name;p.codeHash=ident.codeHash;p.savedAt=Date.now();
    if(b.id){const at=projects.findIndex(x=>x.id===b.id);requireThat(at>=0,'项目不存在。');projects[at]=p;}else projects.push(p);
    reviews.clear();await persist();return {project:p,sale:publicSale(s)};
  }
  if(route==='/api/projects/delete'){requireThat(!active().some(j=>j.p.id===b.id),'项目仍在运行。');projects=projects.filter(p=>p.id!==b.id);reviews.clear();await persist();return {};}
  if(route==='/api/wallets') {
    requireThat(Array.isArray(b.keys)&&b.keys.length>=1&&b.keys.length<=100,'输入 1–100 个私钥。');
    requireThat(wallets.size+b.keys.length<=100,'内存钱包数量最多 100。');
    const staged=[];
    for(let i=0;i<b.keys.length;i++){
      const k=typeof b.keys[i]==='string'?b.keys[i].trim():'';let signer;
      try{requireThat(/^(0x)?[0-9a-fA-F]{64}$/.test(k),'invalid');signer=new Wallet(k.startsWith('0x')?k:`0x${k}`);}catch{throw new Stop(`第 ${i+1} 个私钥格式无效，整批未导入。`);}
      requireThat(![...wallets.values(),...staged].some(w=>w.address===signer.address),`第 ${i+1} 个钱包重复，整批未导入。`);
      staged.push({id:randomUUID(),label:`钱包 ${wallets.size+i+1}`,address:signer.address,signer});b.keys[i]='';
    }
    for(const w of staged)wallets.set(w.id,w);reviews.clear();return {wallets:walletView()};
  }
  if(route==='/api/wallets/clear'){requireThat(!active().length,'先停止运行中的任务，再清除钱包。');wallets.clear();reviews.clear();return {};}
  if(route==='/api/check') {
    const p=project(b.projectId),ws=selected(b.walletIds);
    requireThat(!active().some(j=>j.p.chainId===p.chainId&&j.p.address.toLowerCase()===p.address.toLowerCase()&&j.wallets.some(w=>ws.some(v=>v.address===w.address))),'同一钱包对此系列已有任务，不能重复启动。');
    const result=await preflight(p,ws,records);const reviewId=randomUUID();
    reviews.set(reviewId,{...result,projectJSON:json(p),walletIds:[...b.walletIds],createdAt:Date.now()});return {...result,reviewId};
  }
  if(route==='/api/start') {
    requireThat(b.confirm===true,'请在界面核对预算并确认真实交易。');const review=reviews.get(b.reviewId);
    requireThat(review&&Date.now()-review.createdAt<300000,'检查结果已过期，请重新检查。');
    const p=project(review.projectId);requireThat(json(p)===review.projectJSON,'项目已更改，请重新检查。');
    requireThat(review.wallets.every(w=>w.ok),'有钱包检查未通过，请调整选择后重新检查。');
    const ws=selected(review.walletIds);
    requireThat(!active().some(j=>j.p.chainId===p.chainId&&j.p.address.toLowerCase()===p.address.toLowerCase()&&j.wallets.some(w=>ws.some(v=>v.address===w.address))),'同一钱包对此系列已有任务，不能重复启动。');
    const id=randomUUID(),job=new MintJob({id,project:p,wallets:ws,dir:records,review});await coordinator.register(job,new Rpc(p.rpcUrl));jobs.set(id,job);reviews.delete(b.reviewId);job.run().catch(()=>{job.status='异常停止';job.finished=true;});return {id};
  }
  if(route==='/api/stop'){const j=jobs.get(b.id);requireThat(j,'任务不存在。');if(!j.finished)j.stop();return {};}
  if(route==='/api/history/check') {
    const p=project(b.projectId),items=(await history()).filter(x=>x.chainId===p.chainId&&x.nft.toLowerCase()===p.address.toLowerCase()),rpc=new Rpc(p.rpcUrl);
    await identity(rpc,p);
    const out=[];for(const a of items){const r=await rpc.send('eth_getTransactionReceipt',[a.hash]);out.push({...a,status:r?BigInt(r.status)===1n?'交易已入块成功（请核对 NFT）':'交易已入块失败':'未查到回执',block:r?.blockNumber??null});}return {items:out};
  }
  if(route==='/api/exit'){await monitor.stop();for(const j of active())j.stop();wallets.clear();setTimeout(()=>process.exit(0),8000).unref();return {message:'正在停止任务并退出；已广播交易仍会在链上处理。'};}
  throw new Stop('未知操作。');
}
const server=http.createServer(async(req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
  const send=(status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{...headers,'Content-Type':type});res.end(type.startsWith('application/json')?json(body):body);};
  try {
    requireThat(req.headers.host===`127.0.0.1:${port}`,'只允许本机固定地址访问。');
    requireThat(!req.headers.origin||req.headers.origin===origin,'禁止其他网页调用。');
    requireThat(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']),'禁止跨站访问。');
    const route=new URL(req.url,origin).pathname;
    if(req.method==='GET'&&route==='/health')return send(200,{app:'mint-desk',version:'1.0.0',instanceId});
    if(req.method==='GET'&&route==='/')return send(200,(await readFile(path.join(base,'app/index.html'),'utf8')).replace('__TOKEN__',token),'text/html; charset=utf-8');
    if(req.method==='GET'&&['/app.js','/early.js','/monitor-ui.js','/holdings.js','/style.css','/icon.svg'].includes(route))return send(200,await readFile(path.join(base,'app',route.slice(1)),'utf8'),route.endsWith('.svg')?'image/svg+xml':route.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
    requireThat(req.headers['x-mint-token']===token,'会话失效，请刷新软件页面。');
    if(req.method==='GET'&&route==='/api/state')return send(200,{projects,wallets:walletView(),jobs:[...jobs.values()].map(j=>j.view()),chains:CHAINS});
    if(req.method==='GET'&&route==='/api/history')return send(200,{items:await history()});
    if(req.method==='GET'&&route==='/api/monitor')return send(200,monitor.snapshot());
    if(req.method==='GET'&&route==='/api/monitor/link'){
      const address=new URL(req.url,origin).searchParams.get('address');
      const candidate=monitor.candidates().find(r=>r.chain==='robinhood'&&r.address?.toLowerCase()===address?.toLowerCase());
      requireThat(candidate&&/^0x[0-9a-f]{40}$/i.test(address),'项目不在监控结果中，请刷新后再试。');
      return send(200,await projectMarket.link({chainId:4663,address}));
    }
    if(req.method==='GET'&&route==='/api/projects/market')return send(200,await projectMarket.get(project(new URL(req.url,origin).searchParams.get('id'))));
    requireThat(req.method==='POST'&&req.headers['content-type']?.startsWith('application/json'),'请求格式不正确。');
    requireThat(!mutation,'上一项操作仍在进行，请稍候。');mutation=true;
    try {
      let body='',size=0;for await(const chunk of req){size+=chunk.length;requireThat(size<=32000,'输入内容过多。');body+=chunk.toString('utf8');}
      let b;try{b=JSON.parse(body);}catch{throw new Stop('输入数据格式错误。');}body='';
      const result=await action(route,b);send(200,result);
    }finally{mutation=false;}
  }catch(e){if(!res.headersSent)send(400,{error:safeError(e)});else res.end();}
});
server.on('error',()=>{console.error('启动失败：8792 端口可能已占用。');process.exit(1);});
server.listen(port,'127.0.0.1',()=>console.log(`Mint Desk 已启动：${origin}。只在点击开始后发送真实交易。`));
process.on('SIGINT',()=>{void monitor.stop();for(const j of active())j.stop();wallets.clear();server.close();setTimeout(()=>process.exit(0),8000).unref();});
