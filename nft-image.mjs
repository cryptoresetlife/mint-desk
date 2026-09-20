// Media URLs are rendered only as images, never fetched with API credentials.
export function nftImageUrl(nft){
 for(let value of [nft?.display_image_url,nft?.image_url]){
  if(typeof value!=='string'||value.length>4096)continue;
  value=value.trim();
  if(value.startsWith('ipfs://'))value='https://ipfs.io/ipfs/'+value.slice(7).replace(/^ipfs\//,'');
  try{
   const u=new URL(value),h=u.hostname.toLowerCase();
   if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))continue;
   if(!h.includes('.')||h.endsWith('.local')||h.endsWith('.localhost')||h.endsWith('.internal')||h.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(h))continue;
   return u.href;
  }catch{}
 }
 return null;
}

// One small, shared metadata queue; artwork must never hold the transaction lock.
export class ArtworkService {
 constructor(request,{now=Date.now,spacing=250}={}){this.request=request;this.now=now;this.spacing=spacing;this.cache=new Map();this.pending=new Map();this.tail=Promise.resolve();}
 get({chainId,contract,tokenId}){
  if(![1,4663].includes(chainId)||!/^0x[0-9a-f]{40}$/i.test(contract??'')||(tokenId!==undefined&&!/^\d{1,78}$/.test(tokenId)))return Promise.reject(Error('图片目标无效。'));
  const key=`${chainId}:${contract.toLowerCase()}:${tokenId??'collection'}`,cached=this.cache.get(key);
  if(cached&&cached.until>this.now())return Promise.resolve(cached.value);
  if(this.pending.has(key))return this.pending.get(key);
  if(this.pending.size>=24)return Promise.resolve({imageUrl:null,message:'图片请求较多，请稍后刷新。'});
  const task=this.tail.then(async()=>{
   let value;try{value=await this.read({chainId,contract:contract.toLowerCase(),tokenId});}catch{value={imageUrl:null,message:'图片暂不可用；请检查 OpenSea Key 或稍后刷新。'};}
   if(this.cache.size>=1000)this.cache.delete(this.cache.keys().next().value);
   this.cache.set(key,{value,until:this.now()+(value.imageUrl?6*3600000:60000)});return value;
  });
  this.pending.set(key,task);this.tail=task.then(()=>new Promise(r=>setTimeout(r,this.spacing)));
  task.finally(()=>this.pending.delete(key));return task;
 }
 async read({chainId,contract,tokenId}){
  const chain=chainId===4663?'robinhood':'ethereum',eq=x=>typeof x==='string'&&x.toLowerCase()===contract;
  if(tokenId!==undefined){
   const {nft:n}=await this.request(`chain/${chain}/contract/${contract}/nfts/${tokenId}`);
   if(!n||!eq(n.contract)||String(n.identifier)!==tokenId)throw Error('NFT 图片详情未匹配。');
   return {imageUrl:nftImageUrl(n),url:`https://opensea.io/assets/${chain}/${contract}/${tokenId}`,kind:'nft'};
  }
  const detail=await this.request(`chain/${chain}/contract/${contract}`);
  if(!eq(detail.address)||detail.chain!==chain)throw Error('系列合约未匹配。');
  const slug=typeof detail.collection==='string'?detail.collection:detail.collection?.slug;
  if(!/^[a-z0-9_-]{1,150}$/i.test(slug??''))throw Error('系列尚未收录。');
  const collection=await this.request(`collections/${encodeURIComponent(slug)}`);
  if(collection.collection!==slug||!collection.contracts?.some(c=>c.chain===chain&&eq(c.address)))throw Error('系列图片未匹配。');
  return {imageUrl:nftImageUrl(collection),url:`https://opensea.io/collection/${slug}/overview`,kind:'collection'};
 }
}
