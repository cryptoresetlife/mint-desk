(()=>{
 let rows=[],picked=new Set(),next=null,listingReview=null,selection=[],walletSignature='',generation=0,loading=false;
 const wallet=$('nft-wallet'),chain=$('nft-chain'),rpc=$('nft-rpc');
 function invalidate(){listingReview=null;$('listing-review').replaceChildren();$('listing-authorization').hidden=true;$('listing-consent').checked=false;$('listing-start').disabled=true;}
 function reset(){generation++;rows=[];picked.clear();next=null;invalidate();if($('listing-dialog').open)$('listing-dialog').close();draw();$('nft-message').textContent='点击“刷新持仓与上架状态”读取当前钱包。';}
 function sync(){const sig=JSON.stringify(state.wallets.map(w=>[w.id,w.address]));if(sig===walletSignature)return;walletSignature=sig;const old=wallet.value;wallet.replaceChildren();for(const w of state.wallets){const opt=el('option',`${w.label} · ${w.address.slice(0,8)}…${w.address.slice(-6)}`);opt.value=w.id;wallet.append(opt);}if(state.wallets.some(w=>w.id===old))wallet.value=old;reset();}
 window.mintHoldings={sync,activate:sync};
 wallet.onchange=reset;chain.onchange=()=>{rpc.value='';reset();};rpc.oninput=reset;
 $('nft-minted').onchange=()=>{picked.clear();draw();};
 const canPick=n=>n.owned!==false&&n.listingChecked&&!n.listing&&(!n.local||n.local.end*1000<Date.now())&&['erc721','erc1155'].includes(n.standard);
 function draw(){const root=$('nft-list');root.replaceChildren();const shown=rows.filter(n=>!$('nft-minted').checked||n.minted);
  if(!shown.length)root.append(el('p',rows.length?'当前筛选没有 NFT。':'暂无持仓结果，请先导入钱包并刷新。','empty'));
  for(const n of shown){const card=el('article',undefined,'project-card'),choose=el('label',undefined,'check'),checkbox=el('input');checkbox.type='checkbox';checkbox.checked=picked.has(n.id);checkbox.disabled=!canPick(n);checkbox.onchange=()=>{if(checkbox.checked)picked.add(n.id);else picked.delete(n.id);$('nft-list-selected').textContent=`批量上架（${picked.size}）`;};choose.append(checkbox,el('span',n.minted?'本软件 mint':'钱包持仓'));card.append(choose);
   const h=el('h3');h.append(externalLink(n.name,n.url));card.append(h,el('p',`#${n.tokenId} · ${n.standard.toUpperCase()}`),el('div',n.contract,'address'));
   card.append(el('p',n.owned===false?'当前未确认持有，不能上架':n.owned===true?'链上已核验持有':'OpenSea 持仓索引；上架前核验'));
   card.append(el('strong',n.listing?`已上架 · ${n.listing.price}`:!n.listingChecked?'上架状态查询失败':n.local&&n.local.end*1000>Date.now()?`${n.local.status} · ${n.local.priceEth} ETH`:'未查到有效上架'));
   if(n.local?.hash)card.append(el('small',`本机订单 ${n.local.hash}`,'address'));
   const quote=el('div',undefined,'project-market'),b=button('查询地板 / 成交价','quiet',()=>busy(b,async()=>{const q=await api('/api/nfts/market',{itemId:n.id});quote.replaceChildren(el('div',`地板挂单：${priceText(q.floor)}`),el('div',`最近单件成交：${q.sales?.length?priceText(q.sales[0].price):'未取得样本'}`),el('small',`查询时间：${new Date(q.checkedUtc).toLocaleString()}`));for(const warning of q.warnings??[])quote.append(el('small',warning));}));
   const actions=el('div',undefined,'card-actions');actions.append(b,externalLink('OpenSea ↗',n.url));card.append(quote,actions);root.append(card);
  }$('nft-more').hidden=!next;$('nft-list-selected').textContent=`批量上架（${picked.size}）`;
 }
 async function load(more=false){if(loading)return;sync();if(!wallet.value)throw Error('请先在钱包管理中导入钱包。');loading=true;const version=++generation;try{const result=await api('/api/nfts/refresh',{walletId:wallet.value,chainId:Number(chain.value),rpcUrl:rpc.value,next:more?next:''});if(version!==generation)return;
   const map=new Map((more?rows:[]).map(n=>[n.id,n]));for(const n of result.items)map.set(n.id,n);rows=[...map.values()];picked.clear();next=result.next;draw();$('nft-message').textContent=`已读取 ${rows.length} 项${next?'，还有更多':''} · ${new Date(result.checkedAt).toLocaleString()}。${result.warnings.join(' ')}`;
  }finally{loading=false;}}
 $('nft-refresh').onclick=()=>busy($('nft-refresh'),()=>load());$('nft-more').onclick=()=>busy($('nft-more'),()=>load(true));
 $('nft-list-selected').onclick=()=>{if(!picked.size||picked.size>20){note('请选择 1–20 项 NFT，每项出售 1 个。',true);return;}selection=[...picked];invalidate();$('listing-selection').textContent=`已选择 ${selection.length} 项，统一售价，每项出售 1 个。可取消后分批设置不同价格。`;$('listing-price').value='';$('listing-dialog').showModal();};
 for(const id of ['listing-price','listing-hours','listing-gas'])$(id).oninput=invalidate;
 $('listing-dialog').onclose=invalidate;
 $('listing-preview').onclick=()=>busy($('listing-preview'),async()=>{invalidate();const inputs=JSON.stringify([selection,$('listing-price').value,$('listing-hours').value,$('listing-gas').value,rpc.value]);const result=await api('/api/listings/preview',{itemIds:selection,priceEth:$('listing-price').value.trim(),hours:Number($('listing-hours').value),maxGasEth:$('listing-gas').value.trim(),rpcUrl:rpc.value});
  if(!$('listing-dialog').open||inputs!==JSON.stringify([selection,$('listing-price').value,$('listing-hours').value,$('listing-gas').value,rpc.value]))throw Error('设置已更改，请重新预览。');listingReview=result.reviewId;const box=$('listing-review');box.append(el('p',`本批授权 gas 总预算：${result.maxBudget} ETH；其他任务预留：${result.reservedEth} ETH。有效期 ${result.hours} 小时。`));
  for(const r of result.rows){const item=el('div',undefined,'review-row');item.append(el('strong',`${r.name} #${r.tokenId}`),el('p',`售价 ${r.priceEth} ETH → 扣订单费用后预计到账 ${r.netEth} ETH（另扣实际授权 gas）`),el('p',r.approvalNeeded?`需要${r.standard==='erc721'?'单个 NFT 授权':'整个系列授权'}，预估 gas 上限 ${r.estimatedGas} ETH`:'已有授权，无需新增授权交易'));for(const f of r.fees)item.append(el('small',`费用 ${f.bps/100}% · ${f.amountEth} ETH → ${f.recipient}`,'address'));box.append(item);}$('listing-authorization').hidden=false;
 });
 $('listing-consent').onchange=()=>{$('listing-start').disabled=!listingReview||!$('listing-consent').checked;};
 $('listing-start').onclick=()=>busy($('listing-start'),async()=>{await api('/api/listings/start',{reviewId:listingReview,confirm:$('listing-consent').checked});$('listing-dialog').close();picked.clear();show('tasks');await refresh();note('上架任务已启动，查看运行任务中的逐项进度。完成后返回“我的 NFT”刷新。');});
})();
