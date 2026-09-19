const $=id=>document.getElementById(id), session=document.querySelector('meta[name="mint-session"]').content;
let state={projects:[],wallets:[],jobs:[],chains:{}},page='projects',runProject=null,reviewId=null,pickIds=new Set(),editorSlug=null;
let projectMonitor=null;
const projectQuotes=new Map();
const priceText=p=>p&&p.value!==null&&p.value!==undefined&&Number.isFinite(Number(p.value))?`${Number(p.value).toLocaleString('en-US',{maximumFractionDigits:10})} ${p.symbol}`:'未取得';
function quoteFor(p){
 const key=`${p.chainId}:${p.address.toLowerCase()}`;
 if(projectQuotes.has(key))return projectQuotes.get(key);
 const chain=p.chainId===4663?'robinhood':'ethereum';
 const rows=projectMonitor?.latest?.scan?.report?.rows??[];
 const r=rows.find(r=>r.chain===chain&&r.address?.toLowerCase()===p.address.toLowerCase());
 const discovered=p.chainId===4663?(projectMonitor?.latest?.chain?.rows??[]).find(r=>r.address?.toLowerCase()===p.address.toLowerCase()):null;
 const slug=r?.slug||discovered?.slug||p.slug;
 return {slug,floor:r?.floorEth!==null&&r?.floorEth!==undefined?{value:r.floorEth,symbol:'ETH（监控折算）'}:r?.floor,median:r?.sampledMedianSaleEth,checkedUtc:r?.marketCheckedUtc,fromMonitor:!!r,paused:!projectMonitor?.enabled,sales:null};
}
function externalLink(label,url){const a=el('a',label,'quiet project-link');a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function projectMarketPanel(p){
 const q=quoteFor(p),box=el('section',undefined,'project-market');box.append(el('strong','OpenSea 行情'));
 const meta=el('div',undefined,'meta');
 for(const [label,value]of [['地板挂单价',priceText(q.floor)],['最近一笔单件成交',q.sales?.length?priceText(q.sales[0].price):q.sales?'24h 样本未找到':'尚未查询']]){const d=el('div');d.append(el('small',label),el('span',value));meta.append(d);}box.append(meta);
 if(q.fromMonitor&&q.median!==null&&q.median!==undefined)box.append(el('small',`监控成交样本中位价：${q.median} ETH`));
 if(q.sales?.length){box.append(el('small',`最近成交时间：${new Date(q.sales[0].at).toLocaleString('zh-CN',{hour12:false})}`));const details=el('details');details.append(el('summary',`查看成交明细（${q.sales.length} 条样本）`));for(const s of q.sales.slice(0,10)){const row=el('p',`#${s.tokenId} · ${priceText(s.price)} · ${new Date(s.at).toLocaleString('zh-CN',{hour12:false})} `);row.append(txLink(s.hash,p.chainId));details.append(row);}box.append(details);}
 box.append(el('small',q.checkedUtc?`${q.paused?'监控已停止 · 历史数据 · ':''}查询时间：${new Date(q.checkedUtc).toLocaleString('zh-CN',{hour12:false})}`:'尚未取得行情，请点击“查询行情”。'));
 for(const w of q.warnings??[])box.append(el('small',w));
 box.append(el('small','地板价是挂单，不是成交价；币种以各项标注为准。'));
 const links=el('div',undefined,'card-actions');
 if(/^[a-z0-9_-]{1,150}$/i.test(q.slug??''))links.append(externalLink('查看 OpenSea ↗',`https://opensea.io/collection/${q.slug}/overview`));
 else box.append(el('small','尚未匹配系列链接，查询行情后自动识别。'));
 const b=button('查询行情','quiet',()=>busy(b,async()=>{
   try{const q=await api(`/api/projects/market?id=${encodeURIComponent(p.id)}`);projectQuotes.set(`${p.chainId}:${p.address.toLowerCase()}`,q);staticSignature='';draw();}
   catch(e){if(e.message==='请求格式不正确。')throw Error('程序后台仍是旧版本：请退出软件后重新打开，再查询行情。内存钱包需要重新导入。');throw e;}
 }));links.append(b);box.append(links);return box;
}
const money=x=>`${x} ETH`,time=s=>s?new Date(Number(s)*1000).toLocaleString('zh-CN',{hour12:false}):'未配置';
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,cls,fn){const b=el('button',text,cls);b.type='button';b.onclick=fn;return b;}
function note(text,error=false){$('notice').textContent=text;$('notice').className=error?'error':'';$('notice').hidden=false;}
async function api(url,body){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'x-mint-token':session,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');return data;}
async function busy(b,fn){if(b.disabled)return;b.disabled=true;const text=b.textContent;b.textContent='处理中…';try{await fn();}catch(e){note(e.message,true);if($('listing-dialog')?.open)$('listing-review').replaceChildren(el('p',e.message,'error'));if($('project-dialog').open)$('editor-result').textContent=e.message;if($('run-dialog').open){$('review').replaceChildren(el('p',e.message));}}finally{b.disabled=false;b.textContent=text;}}
function confirmAction(text){return new Promise(resolve=>{$('confirm-text').textContent=text;$('confirm-dialog').showModal();const done=v=>{$('confirm-dialog').close();resolve(v);};$('ok-confirm').onclick=()=>done(true);$('cancel-confirm').onclick=()=>done(false);$('confirm-dialog').oncancel=()=>done(false);});}
function show(name){page=name;for(const n of document.querySelectorAll('.page'))n.hidden=n.id!==`page-${name}`;for(const n of document.querySelectorAll('.nav'))n.classList.toggle('active',n.dataset.page===name);$('page-title').textContent={monitor:'机会监控',projects:'我的项目',wallets:'钱包管理',nfts:'我的 NFT',tasks:'运行任务',history:'交易记录'}[name];$('page-subtitle').textContent={monitor:'发现项目、复核成交证据，再选择是否加入 mint。',projects:'添加目标，设置预算，让准备工作提前完成。',wallets:'只在本机输入，每次启动重新导入。',nfts:'查看持仓、核对行情，自行定价后批量上架。',tasks:'等待、预演、提交与回执，进展一目了然。',history:'保留交易证据，避免不确定时重复发送。'}[name];if(name==='nfts')window.mintHoldings?.activate();if(name==='history')loadHistory().catch(e=>note(e.message,true));}
for(const n of document.querySelectorAll('.nav'))n.onclick=()=>show(n.dataset.page);
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
function invalidate(){reviewId=null;$('authorization').hidden=true;$('consent').checked=false;$('start').disabled=true;$('review').replaceChildren();$('selected-count').textContent=`已选 ${pickIds.size} 个`;}
let staticSignature='';
function draw(){
  const running=state.jobs.filter(j=>!['已完成','已停止','已结束','异常停止'].includes(j.status));
  $('wallet-count').textContent=state.wallets.length;$('task-count').textContent=running.length;$('project-count').textContent=state.projects.length;$('wallet-summary').textContent=state.wallets.length;$('running-summary').textContent=running.length;
  const signature=JSON.stringify([state.projects,state.wallets,state.projects.map(quoteFor)]);if(signature===staticSignature){drawJobs();window.mintHoldings?.sync();return;}staticSignature=signature;window.mintHoldings?.sync();
  const list=$('project-list');list.replaceChildren();
  if(!state.projects.length){const e=el('div',undefined,'empty');e.append(el('strong','从一个 NFT 项目开始'),el('p','粘贴 OpenSea 链接，或直接添加 NFT 合约地址。'),button('＋ 添加第一个项目','primary',()=>edit()));list.append(e);}
  for(const p of state.projects){
    const card=el('article',undefined,'project-card');card.append(el('span',`${state.chains[p.chainId]?.name??p.chainId} · Public`,'badge'),el('h3',p.name),el('div',p.address,'address'));
    const meta=el('div',undefined,'meta');for(const [k,v]of [['每钱包数量',`${p.quantity} 个`],['单个价格上限',money(p.maxPriceEth)],['每钱包 gas 上限',money(p.maxGasEth)],['RPC',new URL(p.rpcUrl).hostname]]){const d=el('div');d.append(el('small',k),el('span',v));meta.append(d);}card.append(meta);
    card.append(projectMarketPanel(p));
    const actions=el('div',undefined,'card-actions');actions.append(button('选择钱包 / 预检','primary',()=>openRun(p)),button('编辑','quiet',()=>edit(p)),button('移除','quiet',async()=>{if(await confirmAction(`移除“${p.name}”？交易历史会保留。`))try{await api('/api/projects/delete',{id:p.id});await refresh();}catch(e){note(e.message,true);}}));card.append(actions,el('small','选择钱包和预检不会发交易；确认预算并点击“开始自动 mint”后才启动。','run-hint'));list.append(card);
  }
  const wl=$('wallet-list');wl.replaceChildren();if(!state.wallets.length)wl.append(el('p','还没有导入钱包。'));
  for(const w of state.wallets){const r=el('div',undefined,'wallet-row');r.append(el('b',w.label),el('span',w.address,'address'));wl.append(r);}
  drawJobs();
}
function edit(p){$('project-form').reset();$('project-id').value=p?.id||'';$('editor-title').textContent=p?'编辑项目':'添加 NFT 项目';$('source').value=p?.slug?`https://opensea.io/collection/${p.slug}`:'';editorSlug=p?.slug||null;$('chain').value=p?.chainId||4663;$('address').value=p?.address||'';$('quantity').value=p?.quantity||1;$('rpc').value=p?.rpcUrl||state.chains[4663]?.rpc||'https://rpc.mainnet.chain.robinhood.com';$('price').value=p?.maxPriceEth||'0';$('gas').value=p?.maxGasEth||'0.001';$('editor-result').textContent='';$('project-dialog').showModal();}
$('add-project').onclick=()=>edit();$('chain').onchange=()=>{$('rpc').value=state.chains[$('chain').value]?.rpc||'';};
$('resolve').onclick=()=>busy($('resolve'),async()=>{const r=await api('/api/resolve',{source:$('source').value});$('address').value=r.address;$('chain').value=r.chainId;$('rpc').value=state.chains[r.chainId].rpc;editorSlug=r.slug;$('editor-result').textContent=`已识别 ${r.name}。请核对链与合约，再设置预算。`;});
$('project-form').onsubmit=e=>{e.preventDefault();const b=e.submitter;busy(b,async()=>{const r=await api('/api/projects',{id:$('project-id').value||undefined,chainId:Number($('chain').value),address:$('address').value.trim(),rpcUrl:$('rpc').value.trim(),quantity:Number($('quantity').value),maxPriceEth:$('price').value.trim(),maxGasEth:$('gas').value.trim(),slug:editorSlug});$('project-dialog').close();note(`已保存 ${r.project.name}：${r.sale.phase}，当前单价 ${r.sale.priceEth} ETH，剩余 ${r.sale.remaining} 个。`);await refresh();});};
$('import-wallets').onclick=()=>busy($('import-wallets'),async()=>{const keys=$('keys').value.trim().split(/\s+/).filter(Boolean);$('keys').value='';try{const r=await api('/api/wallets',{keys});note(`内存中共有 ${r.wallets.length} 个钱包。`);await refresh();}finally{keys.fill('');}});
$('keys').addEventListener('paste',e=>{const text=e.clipboardData?.getData('text/plain');if(text!==undefined){e.preventDefault();$('keys').value=text.replace(/\s+/g,' ').trim();}});
$('clear-wallets').onclick=()=>busy($('clear-wallets'),async()=>{if(await confirmAction('清除本次内存中的全部钱包？之后需要重新输入私钥。')){await api('/api/wallets/clear',{});await refresh();note('已清除钱包。');}});
function openRun(p){if(!state.wallets.length){show('wallets');note('先导入钱包，然后回到项目选择要使用的钱包。');return;}runProject=p;pickIds=new Set([state.wallets[0].id]);$('run-title').textContent=p.name;$('run-info').textContent=`${state.chains[p.chainId].name} · 每钱包 ${p.quantity} 个 · 单个价格上限 ${p.maxPriceEth} ETH · 每钱包 gas 上限 ${p.maxGasEth} ETH`;$('run-count').value=1;drawPicks();invalidate();$('run-dialog').showModal();}
function drawPicks(){const list=$('wallet-picks');list.replaceChildren();for(const w of state.wallets){const l=el('label',undefined,'pick'),c=el('input');c.type='checkbox';c.checked=pickIds.has(w.id);c.onchange=()=>{if(c.checked)pickIds.add(w.id);else pickIds.delete(w.id);invalidate();};l.append(c,el('span',`${w.label} · ${w.address}`));list.append(l);}}
$('select-count').onclick=()=>{const n=Number($('run-count').value);if(!Number.isInteger(n)||n<1||n>state.wallets.length){note(`可选择 1–${state.wallets.length} 个钱包。`,true);return;}pickIds=new Set(state.wallets.slice(0,n).map(w=>w.id));drawPicks();invalidate();};
$('preflight').onclick=()=>busy($('preflight'),async()=>{invalidate();const checkedProject=runProject.id,checkedWallets=[...pickIds];const r=await api('/api/check',{projectId:checkedProject,walletIds:checkedWallets});if(!($('run-dialog').open)||runProject.id!==checkedProject||JSON.stringify([...pickIds])!==JSON.stringify(checkedWallets))throw Error('选择已更改，请重新检查。');reviewId=r.reviewId;const review=$('review');review.replaceChildren();const box=el('div',undefined,'budget');box.append(el('strong',`整批最高授权：mint ${r.maxMintEth} ETH ＋ gas ${r.maxGasEth} ETH`),el('div',`当前：${r.sale.phase} · 单价 ${r.sale.priceEth} ETH · 剩余 ${r.sale.remaining}`),el('small',`开始：${time(r.sale.start)} ｜ 结束：${time(r.sale.end)}（本机时区）`));review.append(box);for(const w of r.wallets){const row=el('div',undefined,`review-row ${w.ok?'ok':'fail'}`);row.append(el('div',w.address,'address'),el('div',`${w.ok?'通过':'未通过'} · ${w.balanceEth?`余额 ${w.balanceEth} ETH · `:''}${w.gasEth?`签名 gas 上限 ${w.gasEth} ETH · `:''}${w.reservedEth?`其他任务预留 ${w.reservedEth} ETH · 合计需 ${w.requiredEth} ETH · `:''}${w.note}`));review.append(row);}if(r.wallets.every(w=>w.ok))$('authorization').hidden=false;});
$('consent').onchange=()=>{$('start').disabled=!$('consent').checked||!reviewId;};
$('start').onclick=()=>busy($('start'),async()=>{await api('/api/start',{reviewId,confirm:$('consent').checked});$('run-dialog').close();invalidate();show('tasks');await refresh();note('任务已启动，窗口可查看实时状态。请保持电脑开机且不休眠。');});
function txLink(hash,chain){const a=el('a',hash,'hash');a.href=`${state.chains[chain]?.explorer||'https://etherscan.io'}/tx/${hash}`;a.target='_blank';a.rel='noopener noreferrer';return a;}
function drawJobs(){const root=$('job-list'),opened=new Set([...root.querySelectorAll('details[open]')].map(n=>n.dataset.id));root.replaceChildren();if(!state.jobs.length){const empty=el('div',undefined,'empty');empty.append(el('strong','还没有运行任务'),el('p','从“我的项目”选择钱包并完成检查。'));root.append(empty);}for(const j of [...state.jobs].reverse()){const card=el('div',undefined,'job'),head=el('div',undefined,'job-head'),h=el('div');h.append(el('h3',j.name),el('span',j.status,'badge'));head.append(h);if(!['已完成','已停止','已结束','异常停止'].includes(j.status))head.append(button('停止任务','quiet',async()=>{try{await api('/api/stop',{id:j.id});await refresh();}catch(e){note(e.message,true);}}));card.append(head);if(j.sale)card.append(el('p',`${j.sale.phase} · 剩余 ${j.sale.remaining} 个 · 开始 ${time(j.sale.start)} · 最新链上时间 ${time(j.sale.timestamp)}`));for(const w of j.wallets){const row=el('div',undefined,'job-wallet'),left=el('div'),right=el('div');left.append(el('b',w.status),el('div',w.address,'address'));right.append(el('div',w.note));if(w.gasEth)right.append(el('small',`gas ${w.gasEth} ETH · `));if(w.tokenIds?.length)right.append(el('small',`Token ID ${w.tokenIds.join(', ')}`));if(w.hash)right.append(txLink(w.hash,j.chainId));row.append(left,right);card.append(row);}const detail=el('details');detail.dataset.id=j.id;detail.open=opened.has(j.id);detail.append(el('summary','运行日志'));const logs=el('div',undefined,'logs');for(const l of j.logs)logs.append(el('div',`${new Date(l.at).toLocaleTimeString()}  ${l.message}`));detail.append(logs);card.append(detail);root.append(card);}}
async function loadHistory(){const r=await api('/api/history'),root=$('history-list');root.replaceChildren();if(!r.items.length)root.append(el('p','尚无本软件的交易记录。'));for(const t of r.items){const row=el('div',undefined,'tx');row.append(el('div',`${state.chains[t.chainId]?.name||t.chainId} · ${new Date(t.createdUtc).toLocaleString()} · 数量 ${t.quantity}`),el('div',`钱包 ${t.address}`,'address'),el('div',`NFT ${t.nft}`,'address'),txLink(t.hash,t.chainId));root.append(row);}}
$('reload-history').onclick=()=>busy($('reload-history'),loadHistory);
$('exit').onclick=async()=>{if(await confirmAction('停止全部任务、清除内存私钥并退出软件？已广播的交易不能撤回。'))try{await api('/api/exit',{});document.body.replaceChildren(el('div','软件正在退出。你可以关闭此窗口；已广播的交易请在区块浏览器核实。','empty'));stopped=true;}catch(e){note(e.message,true);}};
let refreshing=false,stopped=false;
async function refresh(){if(refreshing||stopped)return;refreshing=true;try{state=await api('/api/state');$('connection').textContent='● 本机已连接';draw();}catch(e){$('connection').textContent='连接中断';note(`无法连接软件：${e.message}。请重新打开 Mint Desk。`,true);}finally{refreshing=false;}}
refresh();setInterval(refresh,1500);
