(()=>{
 let snapshot=null,loading=false,sound=false,audio=null,seen=new Set(),signature='',selectedContract='';
 const kinds={mint:'主动 mint',buy:'已确认买入',sell:'已确认卖出',received:'转入 / 代付 mint',sent:'普通转出',self:'自转'};
 const stamp=x=>x?new Date(x).toLocaleString('zh-CN',{hour12:false}):'尚未检查';
 const short=x=>x.slice(0,8)+'…'+x.slice(-6);
 const msg=s=>$('tracker-message').textContent=s;
 const go=async(button,fn)=>{button.disabled=true;try{await fn();}catch(e){msg(e.message==='请求格式不正确。'?'后台需要更新：请退出软件后重新打开，内存钱包需要重新导入。':e.message);}finally{button.disabled=false;if(snapshot)render();}};
 function config(){const c=snapshot.config;$('tracker-addresses').value=c.wallets.map(w=>[w.address,w.label,w.group,w.cluster,w.focus?'重点':'观察'].join(' | ')).join('\n');for(const k of ['windowSeconds','threshold','pollSeconds','confirmations','lookbackBlocks'])$('tracker-'+k).value=c[k];}
 function render(){if(!snapshot)return;const s=snapshot;
  $('tracker-start').disabled=s.running||s.busy;$('tracker-stop').disabled=!s.running;$('tracker-save').disabled=s.running||s.busy;
  $('tracker-summary').textContent=`Robinhood · ${s.config.wallets.length} 个公开地址 · ${s.config.wallets.filter(w=>w.focus).length} 个重点 · ${s.running?(s.healthy?'实时跟踪中':'正在追赶 / 核验'):'已停止'} · 已保留 ${s.retained} 条活动`;
  $('tracker-progress').textContent=`检查时间：${stamp(s.checkedAt)} · 已扫描区块 ${s.cursor??'—'} / 目标 ${s.tip??'—'} · ${s.wsState}。${s.error||''}`;
  const sig=JSON.stringify([s.events,s.alerts,$('tracker-filter').value,$('tracker-search').value,selectedContract]);if(signature===sig)return;signature=sig;
  const alerts=$('tracker-alerts');alerts.replaceChildren();if(!s.alerts.length)alerts.append(el('p',s.running?'当前没有达到条件的实时信号。历史补查不会响铃。':'启动后显示重点钱包与多人参与信号。'));
  for(const a of s.alerts){const row=el('div',undefined,'panel');row.append(nftArtwork.heading([el('strong',a.message),el('p',`${short(a.contract)} · ${stamp(a.at)} · 收益未知`)],{chainId:4663,contract:a.contract,name:a.message}));row.append(button('查看相关活动','quiet',()=>{selectedContract=a.contract;$('tracker-filter').value='all';signature='';render();$('tracker-events').scrollIntoView({behavior:'smooth'});}));alerts.append(row);if(sound&&!seen.has(a.id)){const osc=audio.createOscillator(),gain=audio.createGain();gain.gain.value=0.06;osc.connect(gain).connect(audio.destination);osc.frequency.value=a.kind==='sell'?440:740;osc.start();osc.stop(audio.currentTime+0.15);}seen.add(a.id);}
  if(seen.size>2000)seen=new Set(s.alerts.map(a=>a.id));
  const query=$('tracker-search').value.toLowerCase().trim(),filter=$('tracker-filter').value;
  const list=s.events.filter(e=>(!selectedContract||e.contract===selectedContract)&&(filter==='all'||filter==='actions'&&e.actionable||filter===e.kind)&&(!query||[e.wallet,e.label,e.group,e.name,e.contract,e.tokenId].join(' ').toLowerCase().includes(query)));
  $('tracker-result-count').textContent=`显示 ${list.length} 条（最近最多 500 条）${selectedContract?' · 已筛选合约 '+short(selectedContract):''}`;
  const out=$('tracker-events');out.replaceChildren();if(!list.length)out.append(el('p','暂无匹配活动。清单中的地址可能暂时没有 NFT 交易；可切换“全部活动”查看转账与历史记录。','panel'));
  for(const e of list){const card=el('article',undefined,'project-card');card.append(nftArtwork.heading([el('span',kinds[e.kind]||e.kind,'badge'),externalLink(`${e.name||short(e.contract)} #${e.tokenId}`,`https://opensea.io/assets/robinhood/${e.contract}/${e.tokenId}`)],{chainId:4663,contract:e.contract,tokenId:e.tokenId,name:e.name}),el('p',`${e.label} · ${e.group}${e.focus?' · 重点':''}`),externalLink(short(e.wallet),`https://robinhoodchain.blockscout.com/address/${e.wallet}`),el('p',`${stamp(e.at)} · 数量 ${e.quantity}${e.historical?' · 历史补查':''}`));
   const detail=el('details');detail.append(el('summary','交易证据 / 金额'));detail.append(el('p',`整笔交易原生币 value：${e.transactionValueEth} ETH；整笔 gas：${e.gasEth??'未知'} ETH。不是该 NFT 的单件成本。`));
   if(e.payment)detail.append(el('p',e.payment.native?`匹配订单支付：${Number(BigInt(e.payment.value))/1e18} ETH`:`匹配订单代币：${e.payment.token}；原始数量 ${e.payment.value}（未换算精度）`));else detail.append(el('p','未得到可分配到该 NFT 的订单金额。'));
   detail.append(txLink(e.tx,4663));card.append(detail);const actions=el('div',undefined,'card-actions');actions.append(button('查询地板 / 成交','quiet',function(){go(this,async()=>{const q=await api('/api/tracker/market',{address:e.contract});const target=el('div',undefined,'project-market');target.append(externalLink('OpenSea 系列 ↗',q.url),el('p',`地板挂单：${priceText(q.floor)}`),el('p',`最近单件成交：${q.sales?.length?priceText(q.sales[0].price):'暂无样本'}`),el('small',`查询时间 ${stamp(q.checkedUtc)}；挂单不代表可卖出。`));for(const w of q.warnings??[])target.append(el('p',w));market.replaceChildren(target);});}),button('添加 mint 项目','quiet',()=>{edit();$('address').value=e.contract;$('editor-result').textContent='来自钱包活动，尚未验证是否能 mint。请核对价格和合约后保存；不会自动启动。';}));const market=el('div');card.append(actions,market);out.append(card);}
 }
 async function refresh(){if(loading)return;loading=true;try{snapshot=await api('/api/tracker');render();}catch(e){if(page==='tracker')msg('钱包监控尚未连接。若刚更新软件，请退出后重新打开。');}finally{loading=false;}}
 $('tracker-config').onclick=async()=>{await refresh();if(snapshot){config();$('tracker-settings').open=!$('tracker-settings').open;}};
 $('tracker-form').onsubmit=e=>{e.preventDefault();go($('tracker-save'),async()=>{const wallets=$('tracker-addresses').value.split(/\r?\n/).filter(x=>x.trim()).map((line,i)=>{const [address,label='',group='',cluster='',focus='观察']=line.split('|').map(s=>s.trim());if(!/^0x[0-9a-f]{40}$/i.test(address)||!['观察','重点'].includes(focus))throw Error(`第 ${i+1} 行格式不正确：只填公开地址，末项填重点或观察。`);return {address,label,group,cluster,focus:focus==='重点'};});const c={wallets};for(const k of ['windowSeconds','threshold','pollSeconds','confirmations','lookbackBlocks'])c[k]=Number($('tracker-'+k).value);snapshot=await api('/api/tracker/settings',c);signature='';render();msg('清单已保存，旧活动缓存已清空。点击启动钱包监控开始读取。');$('tracker-settings').open=false;});};
 $('tracker-start').onclick=()=>go($('tracker-start'),async()=>{snapshot=await api('/api/tracker/start',{});msg('已启动，只读取公开链上数据。');render();});
 $('tracker-stop').onclick=()=>go($('tracker-stop'),async()=>{snapshot=await api('/api/tracker/stop',{});msg('钱包监控已停止。');render();});
 $('tracker-sound').onclick=async()=>{sound=!sound;if(sound){audio??=new AudioContext();await audio.resume();seen=new Set((snapshot?.alerts??[]).map(a=>a.id));}$('tracker-sound').textContent=sound?'关闭声音提醒':'开启声音提醒';};
 $('tracker-filter').onchange=render;$('tracker-search').oninput=render;$('tracker-clear').onclick=()=>{selectedContract='';$('tracker-search').value='';render();};
 window.mintTracker={activate:refresh};setInterval(()=>{if(page==='tracker'||sound)void refresh();},4000);
})();
