// Shared by the browser and tests. These are discovery heuristics, not profit estimates.
function earlyOpportunity(row,now=Date.now()){
 const a=row.activity,checked=Date.parse(row.checkedUtc),start=Number(row.startTime)*1000,end=Number(row.endTime)*1000;
 const fresh=Number.isFinite(checked)&&checked<=now+2000&&now-checked<=90000&&!row.error;
 const available=fresh&&Number(row.remaining)>0&&Number(row.walletLimit)>0;
 const soon=available&&row.status==='待开售'&&start>now&&start-now<=3600000&&end>start;
 const activityFresh=a&&Number.isFinite(Date.parse(a.sampledAtUtc))&&now-Date.parse(a.sampledAtUtc)<=15000&&Date.parse(a.sampledAtUtc)<=now+2000;
 const active=available&&row.status==='公售开放'&&start<=now&&end>now;
 const concentrated=!!a&&(a.topWalletShare>.5||a.topPayerShare>.5);
 const accelerating=!!a&&a.transactions1m>=Math.max(3,a.previousPerMinute*2);
 const hot=active&&activityFresh&&a.healthy===true&&a.complete===true&&a.wallets5m>=8&&a.wallets1m>=3&&accelerating&&!concentrated;
 return {soon,hot,concentrated,secondsToStart:soon?Math.ceil((start-now)/1000):null,secondsToEnd:active?Math.max(0,Math.ceil((end-now)/1000)):null,reason:hot?'近 5 分钟至少 8 个接收地址，近 1 分钟至少 3 个地址、3 笔交易；交易速度至少为前 4 分钟均速的 2 倍；单地址及单付款人占比均不超过 50%。':soon?'未来 1 小时内公售，价格、限购和剩余供应已读取；尚未验证盈利。':!a?'等待新版实时采样。':!a.healthy||!activityFresh?'监听或采样暂不完整，等待恢复。':!a.complete?'收集连续 5 分钟样本后判断升温。':concentrated?'少数接收地址或同一付款人集中 mint，保留在原始发现。':'参与数量或加速度尚未达到早期升温门槛。'};
}
if(typeof module!=='undefined')module.exports={earlyOpportunity};

let monitorState=null,monitorBusy=false,monitorSignature='',soundOn=false,soundContext=null;
let openMonitorDetails=new Set();
const knownAlerts=new Set();let alertsInitialized=false,lastBeep=0;
let previousPriority=new Set(),priorityInitialized=false;
let earlyKeys=new Set(),earlyAlertsInitialized=false;
$('monitor-early-alerts').onchange=()=>{earlyAlertsInitialized=false;monitorSignature='';drawMonitor();};
function qualifiedMonitorRow(r,s,now=Date.now()){
 const at=Date.parse(r.marketCheckedUtc),cost=r.totalCostEth,profit=r.estimatedProfitEth,multiple=Number(s.config.profitMultiple);
 const live=(s.latest?.chain?.rows??[]).find(c=>c.address?.toLowerCase()===r.address?.toLowerCase());
 return r.chain==='robinhood'&&r.status==='优先复核'&&r.valuationMode==='sales-conservative-v1'
  &&r.valuation?.supported===true&&r.valuation.independentTransactions>=3&&r.valuation.pricedBuyers>=2
  &&Number.isFinite(at)&&at<=now&&now-at<=15*60*1000
  &&Number.isFinite(cost)&&cost>0&&Number.isFinite(profit)&&profit>=cost*multiple
  &&r.onchain?.state==='active'&&r.onchain?.simulation==='passed'
  &&(!live||live.status==='公售开放'&&Number(live.remaining)>0);
}
const ethText=v=>v===null||v===undefined||!Number.isFinite(Number(v))?'未核验':`${Number(v).toLocaleString('en-US',{maximumFractionDigits:8})} ETH`;
const localTime=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';
function monitorNotice(message){$('monitor-status').textContent=message;}
async function monitorRefresh(){if(monitorBusy||stopped)return;monitorBusy=true;try{monitorState=await api('/api/monitor');projectMonitor=monitorState;drawMonitor();draw();}catch(e){monitorNotice(e.message);}finally{monitorBusy=false;}}
async function monitorAction(b,route,body={}){await busy(b,async()=>{await api(route,body);monitorSignature='';});await monitorRefresh();}
function monitorSettingsOpen(){const s=monitorState;if(!s)return;const c=s.config;$('monitor-key').value='';$('monitor-rpc').value=c.rpcUrl;$('monitor-ws').value=c.wsUrl;$('monitor-interval').value=c.intervalSeconds;$('monitor-multiple').value=c.profitMultiple;$('monitor-watchlist').value=c.watchlist.join('\n');$('key-current').textContent=s.configured?'已保存你在本机填写的 Key。留空沿用，更换时粘贴新 Key。':'未配置 Key。必须填写你自己的 OpenSea API Key 才能启动监控。';$('monitor-settings-result').textContent=s.enabled?'先停止监控，再修改设置；不会停止 mint 任务。':'';$('monitor-dialog').showModal();}
$('monitor-settings').onclick=monitorSettingsOpen;
$('monitor-form').onsubmit=e=>{e.preventDefault();busy(e.submitter,async()=>{let key=$('monitor-key').value.trim();$('monitor-key').value='';try{await api('/api/monitor/settings',{apiKey:key,rpcUrl:$('monitor-rpc').value.trim(),wsUrl:$('monitor-ws').value.trim(),intervalSeconds:Number($('monitor-interval').value),profitMultiple:Number($('monitor-multiple').value),watchlist:$('monitor-watchlist').value.split(/[\s,]+/).filter(Boolean)});$('monitor-dialog').close();note('监控设置已保存。点击“启动监控”开始使用你自己的接口。');await monitorRefresh();}catch(e){$('monitor-settings-result').textContent=e.message;throw e;}finally{key='';}});};
$('monitor-start').onclick=()=>monitorAction($('monitor-start'),'/api/monitor/start');
$('monitor-stop').onclick=()=>monitorAction($('monitor-stop'),'/api/monitor/stop');
$('monitor-scan').onclick=()=>monitorAction($('monitor-scan'),'/api/monitor/scan');
$('monitor-remove-key').onclick=()=>busy($('monitor-remove-key'),async()=>{if(await confirmAction('删除本软件保存的 OpenSea Key 并停止监控？不会撤销 OpenSea 账户上的 Key，也不会停止 mint 任务。')){await api('/api/monitor/remove-key',{});await monitorRefresh();$('monitor-dialog').close();note('本机 OpenSea Key 已删除。');}});
for(const card of document.querySelectorAll('[data-monitor-category]'))card.onclick=()=>{
 $('monitor-search').value='';$('monitor-filter').value=card.dataset.monitorCategory;monitorSignature='';drawMonitor();
 const heading=$('monitor-radar-heading');heading.focus({preventScroll:true});heading.parentElement.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
};
$('monitor-filter').onchange=()=>{monitorSignature='';drawMonitor();};$('monitor-search').oninput=()=>{monitorSignature='';drawMonitor();};
$('monitor-chain-filter').onchange=()=>{monitorSignature='';drawMonitor();};
$('monitor-sound').onclick=async()=>{if(!soundOn){soundContext??=new AudioContext();await soundContext.resume();soundOn=true;beep();}else soundOn=false;$('monitor-sound').textContent=soundOn?'声音提醒：开':'开启声音提醒';};
function beep(){if(!soundOn||!soundContext||Date.now()-lastBeep<4000)return;lastBeep=Date.now();const osc=soundContext.createOscillator(),gain=soundContext.createGain();osc.frequency.value=700;gain.gain.value=.08;osc.connect(gain);gain.connect(soundContext.destination);osc.start();osc.stop(soundContext.currentTime+.25);}
function addMonitorDraft(r){return async()=>{try{const draft=await api('/api/monitor/draft',{address:r.address,source:r.source});edit(draft);$('editor-title').textContent='从监控加入 mint 项目';$('editor-result').textContent='这是项目草稿，尚未保存或启动。请核对 mint 价格和 gas 上限，保存时将重新检查链上合约。';}catch(e){note(e.message,true);}};}
function monitorCollectionUrl(r){
 const known=r.slug||(monitorState?.latest?.scan?.report?.rows??[]).find(x=>x.chain==='robinhood'&&x.address?.toLowerCase()===r.address?.toLowerCase())?.slug;
 return typeof known==='string'&&/^[a-z0-9_-]{1,150}$/i.test(known)?'https://opensea.io/collection/'+encodeURIComponent(known)+'/overview':null;
}
function monitorName(r){
 const heading=el('h3'),url=monitorCollectionUrl(r),link=el(url?'a':'button',(r.name||r.slug||'未知系列')+' ↗','collection-name');
 link.title='在 OpenSea 查看该系列';
 if(url){link.href=url;link.target='_blank';link.rel='noopener noreferrer';}
 else{link.type='button';link.onclick=async()=>{
  const target=window.open('about:blank','_blank');if(target){target.opener=null;target.document.title='正在查找 OpenSea 系列';target.document.body.textContent='正在按合约查询 OpenSea 系列，请稍候…';}
  link.disabled=true;
  try{const result=await api('/api/monitor/link?address='+encodeURIComponent(r.address||''));
   if(!/^https:\/\/opensea\.io\/collection\/[a-z0-9_-]{1,150}\/overview$/i.test(result.url))throw Error('未取得有效的 OpenSea 系列链接。');
   if(target&&!target.closed)target.location.replace(result.url);else note('浏览器阻止了新窗口，请允许弹窗后再次点击项目名称。');
  }catch(e){if(target&&!target.closed)target.close();note(e.message==='请求格式不正确。'?'此功能需要重新打开更新后的软件。退出前请确保已保存自己的钱包私钥。':e.message,true);}
  finally{link.disabled=false;}
 };}
 heading.append(link);return heading;
}
function monitorCard(r){const card=el('article',undefined,'project-card');card.append(el('span',r.earlyLabel||(r.source==='chain'?`原始发现 · ${r.status||'待核验'}`:r.status||'待核验'),r.source==='chain'?'badge raw-badge':'badge'),monitorName(r),el('div',r.address||'合约尚未识别','address'));const meta=el('div',undefined,'meta');
 const fields=r.source==='market'?[['保守售价',ethText(r.referencePriceEth)],['全部估算成本',ethText(r.totalCostEth)],['估算净利润',ethText(r.estimatedProfitEth)],['净利润 / 成本',r.profitToCost===null||r.profitToCost===undefined?'未核验':`${Number(r.profitToCost).toFixed(2)} 倍`],['mint 单价',ethText(r.onchain?.mintPriceEth)],['剩余',r.onchain?.remaining??'未核验']]:[['mint 单价',ethText(r.mintPriceEth)],['剩余',r.remaining??'未核验'],['开售时间',localTime(r.startUtc)],['利润','收益未知'],['每钱包限购',r.walletLimit??'未核验'],['公售结束',localTime(r.endUtc)]];
 if(r.activity){const a=r.activity;fields.push(['公售 mint · 1 / 5 分钟',`${a.mints1m} / ${a.mints5m}`],['接收地址 · 1 / 5 分钟',`${a.wallets1m} / ${a.wallets5m}`],['交易数 · 1 / 5 分钟',`${a.transactions1m} / ${a.transactions5m}`],['最大接收 / 付款占比',a.topWalletShare===null?'暂无样本':`${(a.topWalletShare*100).toFixed(0)}% / ${(a.topPayerShare*100).toFixed(0)}%`]);}
 for(const [label,value]of fields){const d=el('div');d.append(el('small',label),el('span',String(value)));meta.append(d);}card.append(meta);
 if(r.source==='market'){const detail=el('details'),info=el('div',undefined,'monitor-detail');detail.dataset.address=r.address;detail.open=openMonitorDetails.has(r.address);detail.append(el('summary','依据与风险'));for(const [k,v] of [['地板挂单价',ethText(r.floorEth)],['最佳报价（未核验可成交性）',ethText(r.topOfferEth)],['成交中位价',ethText(r.sampledMedianSaleEth)],['成交样本',`${r.saleEvidence?.sampledSales24h??0} 条 / ${r.saleEvidence?.uniqueBuyers??0} 个买家`],['数据时间',localTime(r.marketCheckedUtc)],['开始',localTime(r.onchain?.startUtc)],['筛选依据',(r.reasons??[]).join('；')||'符合本轮条件'],['风险',(r.warnings??[]).join('；')]])info.append(el('p',`${k}：${v}`));detail.append(info);card.append(detail);}
 else card.append(el('small',`链上发现 · ${r.eventLabel||'公售配置'} · ${localTime(r.checkedUtc)}；不代表值得购买。`));
 if(r.source==='chain'){const evidence=el('p',earlyOpportunity(r).reason,'run-hint');card.append(evidence,el('small','地址数不等于真实人数；官方来源、资金关联、转售限制尚未核验。mint 单价不含 gas。'));}
 if(r.earlyLabel==='即将开售')card.append(el('p',`距开售约 ${Math.ceil(earlyOpportunity(r).secondsToStart/60)} 分钟 · 收益未知`,'run-hint'));
 const actions=el('div',undefined,'card-actions');if(!r.unsupported&&/^0x[a-f0-9]{40}$/i.test(r.address||''))actions.append(button(r.source==='chain'?'自行核实后添加':'加入 mint 项目',r.source==='chain'?'quiet':'primary',addMonitorDraft(r)));
 if(r.slug&&/^[a-z0-9_-]+$/i.test(r.slug)){const a=el('a','OpenSea','monitor-link');a.href=`https://opensea.io/collection/${r.slug}/overview`;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);}card.append(actions);return card;}
function drawMonitor(){for(const card of document.querySelectorAll('[data-monitor-category]'))card.setAttribute('aria-pressed',String(card.dataset.monitorCategory===$('monitor-filter').value));const s=monitorState;if(!s)return;
 $('monitor-start').disabled=s.enabled||!s.configured;$('monitor-stop').disabled=!s.enabled;$('monitor-scan').disabled=!s.enabled||s.latest?.scan?.running;
 $('monitor-key-state').textContent=s.configured?'你的 Key 已配置':'需填写自己的 API Key';$('monitor-enabled').textContent=s.enabled?'监控运行中':'监控已停止';
 const report=s.latest?.scan?.report,chain=s.latest?.chain,market=s.latest?.market;
 const changed=report&&report.settings?.profitMultiple!==s.config.profitMultiple;
 monitorNotice(s.error||(!s.configured?'首次使用：打开“监控设置”，填写你自己的 OpenSea API Key。':!s.enabled?'点击“启动监控”开始；历史结果不能当成实时状态。':s.latest?.scan?.progress||'正在启动监控…'));
 $('monitor-rule').textContent=`Robinhood · 免费 / 付费均含 · gas 不设筛选上限 · 保守净利润 ≥ 总成本 × ${s.config.profitMultiple}。全部成本包括 mint、双向 gas 和估算出售费用；成交不足或费用未知不列为优先。`;
 $('monitor-source').textContent=`行情更新：${localTime(report?.finishedUtc)}${changed?'（历史结果使用旧筛选条件，需重新扫描）':''}。下一轮：${s.enabled?localTime(s.latest?.scan?.nextScanUtc):'已停止'}。${report?.coverage?.source||'尚未完成一轮扫描。'}`;
 $('monitor-live-state').textContent=`链上：${s.enabled?(chain?.status||'连接中'):'已停止'} · ${chain?.wsStatus||'可选 WS 未连接'} · OpenSea：${s.enabled?(market?.status||'等待连接'):'已停止'} · 已订阅 ${market?.subscriptions??0} 个系列（最多 50，其他系列靠定时扫描）。`;
 const sig=JSON.stringify([s.enabled,s.config.profitMultiple,report?.finishedUtc,chain?.rows,chain?.alerts,market?.events,$('monitor-filter').value,$('monitor-search').value,$('monitor-chain-filter').value,$('monitor-early-alerts').checked,Math.floor(Date.now()/30000)]);if(sig===monitorSignature)return;monitorSignature=sig;
 const rows=(report?.rows??[]).map(r=>({...r,source:'market'})),search=$('monitor-search').value.toLowerCase().trim(),filter=$('monitor-filter').value;
 const match=r=>!search||`${r.name} ${r.slug} ${r.address}`.toLowerCase().includes(search);
 const priority=rows.filter(r=>qualifiedMonitorRow(r,s)),priorityAddresses=new Set(priority.map(r=>r.address.toLowerCase()));
 const discovered=(chain?.rows??[]).map(r=>({...r,chain:'robinhood',source:'chain'})),soon=discovered.filter(r=>s.enabled&&earlyOpportunity(r).soon).sort((a,b)=>a.startTime-b.startTime),hot=discovered.filter(r=>s.enabled&&earlyOpportunity(r).hot).sort((a,b)=>b.activity.wallets1m-a.activity.wallets1m);
 $('monitor-soon').textContent=soon.length;$('monitor-hot').textContent=hot.length;
 const marketResult=rows.filter(r=>match(r)&&(filter==='all'||filter==='priority'&&priorityAddresses.has(r.address?.toLowerCase())||filter==='waiting'&&r.status==='待开售'||filter==='active'&&r.onchain?.state==='active'));
 const result=filter==='soon'?soon.filter(match).map(r=>({...r,earlyLabel:'即将开售'})):filter==='early'?hot.filter(match).map(r=>({...r,earlyLabel:'早期升温 · 收益未知'})):filter==='raw'?discovered.filter(match).slice(0,80):marketResult;
 $('monitor-stage-help').textContent=filter==='soon'?'未来 1 小时内开售，提前核对来源、规则和预算；不要求已有地板价，也不代表有利润。':filter==='early'?'默认门槛：5 分钟至少 8 个接收地址，1 分钟至少 3 个地址、3 笔交易，交易速度 ≥ 前 4 分钟均速的 2 倍；最大接收地址及付款人占比 ≤ 50%。需连续完整采样 5 分钟，收益未知。':filter==='raw'?'原始链上活动，最多显示 80 个；可能包含测试和批量项目，不作为推荐。':filter==='priority'?'利润达标需要成交证据和新鲜行情；早期机会可切换“即将开售”或“早期升温”查看。':'行情结果用于复核，不代表可以盈利。';
 $('monitor-qualified').textContent=priority.length;$('monitor-total').textContent=rows.length;$('monitor-chain-count').textContent=chain?.rows?.length??0;
 const list=$('monitor-results');openMonitorDetails=new Set([...list.querySelectorAll('details[open]')].map(x=>x.dataset.address));list.replaceChildren();if(!result.length)list.append(el('div',filter==='early'?'尚无升温项目。启动监控后需连续采样 5 分钟；断线后重新积累，未达门槛的项目留在原始发现。':filter==='soon'?'当前没有已核验且将在 1 小时内开售的项目。':rows.length?'当前筛选没有结果。可切换“全部结果”查看被排除的原因。':'尚无行情扫描结果。首次扫描可能需要几分钟。','empty'));for(const r of result)list.append(monitorCard(r.status==='优先复核'&&!priorityAddresses.has(r.address?.toLowerCase())?{...r,status:'待重核',reasons:[...(r.reasons??[]),'当前行情时效、库存或利润条件需重新核实']}:r));
 const chainList=$('monitor-chain-results');chainList.replaceChildren();const raw=(chain?.rows??[]).filter(r=>['公售开放','待开售','待核验'].includes(r.status)),showRaw=$('monitor-chain-filter').value==='raw';
 const chainRows=(showRaw?raw.map(r=>({...r,source:'chain'})):priority).filter(match).slice(0,80);
 $('monitor-noise-summary').textContent=showRaw?`原始列表：${raw.length} 个，最多显示 80 个；包含未评估和测试合约，不作为推荐，也不触发声音。`:`默认只展示满足成交依据、15 分钟内行情及净利润 ≥ 成本 × ${s.config.profitMultiple} 的项目：${priority.length} 个。原始链上发现 ${raw.length} 个，未通过筛选的不展示；无结果就等待，不用未经评估的项目填充。`;
 if(!chainRows.length)chainList.append(el('p',showRaw?'当前搜索没有原始记录。':'当前没有通过筛选的项目。链上活动多不代表有值得 mint 的机会。'));for(const r of chainRows)chainList.append(monitorCard(r));
 const custom=$('monitor-custom-results');custom.replaceChildren();const unsupported=rows.filter(r=>r.chain==='robinhood'&&r.dropType&&r.dropType!=='SEADROP_V1_ERC721').filter(match);for(const r of unsupported.slice(0,40))custom.append(monitorCard({...r,unsupported:true,earlyLabel:'非标准合约 · 不支持自动 mint'}));if(!unsupported.length)custom.append(el('p','本轮尚无已识别的非标准合约记录；不代表全链没有。'));
 const errors=$('monitor-errors');errors.replaceChildren();for(const message of (report?.errors??[]).slice(0,30))errors.append(el('p',message));
 const alerts=(chain?.alerts??[]).filter(a=>priorityAddresses.has(a.address?.toLowerCase())&&/公售已开放|公售将在/.test(a.message??'')&&Date.now()-Date.parse(a.time)<=10*60*1000);
 for(const a of alerts){if(!knownAlerts.has(a.id)){knownAlerts.add(a.id);if(alertsInitialized&&s.enabled)beep();}}if(s.enabled&&chain)alertsInitialized=true;
 if(s.enabled&&report){if(priorityInitialized&&priority.some(r=>!previousPriority.has(r.address.toLowerCase())))beep();previousPriority=priorityAddresses;priorityInitialized=true;}
 const feed=$('monitor-events');feed.replaceChildren();for(const a of [...alerts].slice(-6).reverse()){const r=priority.find(r=>r.address.toLowerCase()===a.address?.toLowerCase());feed.append(el('p',`${localTime(a.time)} · ${r?.name||a.address} · ${a.message}`));}
 for(const r of priority.slice(0,6))feed.append(el('p',`${r.name||r.slug} · 估算净利润 / 成本 ${Number(r.profitToCost).toFixed(2)} 倍 · 行情 ${localTime(r.marketCheckedUtc)} · 仍需核实可成交性`));
 const earlyCurrent=new Map();for(const r of hot)earlyCurrent.set('hot:'+r.address,{r,message:'早期升温 · 收益未知'});for(const r of soon)if(earlyOpportunity(r).secondsToStart<=300)earlyCurrent.set('soon:'+r.address+':'+r.startTime,{r,message:'5 分钟内开售 · 收益未知'});
 if($('monitor-early-alerts').checked&&s.enabled){if(earlyAlertsInitialized&&[...earlyCurrent.keys()].some(k=>!earlyKeys.has(k)))beep();for(const {r,message}of [...earlyCurrent.values()].slice(0,6)){const line=el('p');line.append(el('span',message+' · '),monitorName(r));feed.append(line);}earlyAlertsInitialized=true;}else earlyAlertsInitialized=false;earlyKeys=new Set(earlyCurrent.keys());
 if(!priority.length)feed.append(el('p','暂无利润达标提醒。早期提醒须单独勾选，仅表示参与升温或临近开售；普通原始活动和取消挂单不响铃。'));
}
monitorRefresh();setInterval(monitorRefresh,2500);
