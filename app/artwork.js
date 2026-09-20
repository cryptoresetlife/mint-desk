(()=>{
 const cache=new Map(),pending=new Map(),watched=new Set(),queue=[];let active=0;
 const key=t=>`${t.chainId}:${t.contract.toLowerCase()}:${t.tokenId??'collection'}`;
 const observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){observer.unobserve(e.target);watched.delete(e.target);queue.push(e.target);drain();}},{rootMargin:'100px'});
 function prune(){for(const box of watched)if(!box.isConnected){observer.unobserve(box);watched.delete(box);}}
 function drain(){while(active<3&&queue.length){const box=queue.shift();if(!box.isConnected)continue;active++;box.loadImage().finally(()=>{active--;drain();});}}
 async function metadata(t){
  const id=key(t),cached=cache.get(id);if(cached&&cached.until>Date.now())return cached.value;
  if(pending.has(id))return pending.get(id);
  const params=new URLSearchParams({chainId:String(t.chainId),contract:t.contract});if(t.tokenId!==undefined)params.set('tokenId',String(t.tokenId));
  const request=api('/api/artwork?'+params).catch(()=>({imageUrl:null,message:'图片暂不可用'})).then(value=>{if(cache.size>=1000)cache.delete(cache.keys().next().value);cache.set(id,{value,until:Date.now()+(value.imageUrl?6*3600000:60000)});return value;}).finally(()=>pending.delete(id));
  pending.set(id,request);return request;
 }
 function create(t){
  prune();const box=document.createElement('a'),label=document.createElement('span');box.className='nft-thumbnail';label.textContent=t.tokenId===undefined?'系列封面':'加载图片…';box.append(label);box.target='_blank';box.rel='noopener noreferrer';box.setAttribute('aria-label',`${t.tokenId===undefined?'系列封面':'NFT 图片'}：${t.name||'NFT'}，在 OpenSea 查看`);
  const valid=[1,4663].includes(t.chainId)&&/^0x[0-9a-f]{40}$/i.test(t.contract??'');
  if(!valid){label.textContent='暂无图片';box.removeAttribute('target');return box;}
  if(t.tokenId!==undefined)box.href=`https://opensea.io/assets/${t.chainId===4663?'robinhood':'ethereum'}/${t.contract}/${t.tokenId}`;
  box.loadImage=async()=>{
   const result=t.imageUrl?{imageUrl:t.imageUrl}:await metadata(t);if(!box.isConnected)return;
   if(result.url){try{const u=new URL(result.url);if(u.protocol==='https:'&&u.hostname==='opensea.io')box.href=u.href;}catch{}}
   if(!result.imageUrl){label.textContent='暂无图片';box.title=result.message||'OpenSea 尚未提供图片';return;}
   let u;try{u=new URL(result.imageUrl);if(u.protocol!=='https:')throw Error();}catch{label.textContent='暂无图片';return;}
   const img=document.createElement('img');img.alt=t.name||'NFT';img.referrerPolicy='no-referrer';img.decoding='async';img.loading='lazy';
   img.onload=()=>{label.hidden=true;};img.onerror=()=>{img.remove();label.hidden=false;label.textContent='图片加载失败';};img.src=u.href;box.append(img);
  };observer.observe(box);watched.add(box);return box;
 }
 function heading(content,target){const root=document.createElement('div'),info=document.createElement('div');root.className='nft-card-heading';info.className='nft-card-identity';info.append(...content);root.append(info,create(target));return root;}
 window.nftArtwork={create,heading,prune};
})();
