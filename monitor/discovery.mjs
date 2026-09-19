import {parsePage,walk,discover} from './market.mjs';

export function discoverCollections(objects) {
 const found=new Map(discover(objects).map(r=>[r.slug,r]));
 walk(objects,c=>{
  if(c.__typename==='Collection' && /^[a-z0-9_-]+$/i.test(c.slug??'') && c.chain?.identifier) {
   const prior=found.get(c.slug)??{};
   found.set(c.slug,{...prior,slug:c.slug,name:c.name??prior.name,chain:c.chain.identifier,address:c.address??prior.address});
  }
 });
 return [...found.values()];
}

// Only follow a next-page URL actually present in the public HTML. Some SSR
// routes ignore pagination: stop as soon as the collection set repeats.
export function nextPublicPage(html,current) {
 const u=new URL(current),page=Number(u.searchParams.get('page')??1);
 for(const m of html.matchAll(/href="([^"]+)"/g)) {
  let n;try{n=new URL(m[1].replaceAll('&amp;','&'),u);}catch{continue;}
  if(n.origin===u.origin&&n.pathname===u.pathname&&Number(n.searchParams.get('page'))===page+1)return n.href;
 }
 return null;
}

export async function discoverPublic(c,reader,progress=()=>{}) {
 const roots=['https://opensea.io/drops/upcoming','https://opensea.io/drops',...c.chains.map(chain=>`https://opensea.io/collections/chain/${chain}`)];
 const found=new Map(),sources=[],errors=[];
 let pagesRead=0,duplicatePages=0;
 for(const root of roots){
  let url=root;const seen=new Set();const source={url:root,pages:0,uniqueCollections:0,stopped:'page_limit'};
  for(let p=0;url&&p<c.discoveryPages;p++){
   progress(`发现项目：${new URL(root).pathname} 第 ${p+1} 页`);
   try{
    const html=await(await reader.get(url)).text();pagesRead++;source.pages++;
    const items=discoverCollections(parsePage(html));
    const fingerprint=items.map(x=>x.slug).sort().join('|');
    if(seen.has(fingerprint)){duplicatePages++;source.stopped='duplicate_page';break;}
    seen.add(fingerprint);
    for(const item of items)if(c.chains.includes(item.chain)){found.set(item.slug,item);source.uniqueCollections++;}
    if(!items.length){source.stopped='empty_page';break;}
    url=nextPublicPage(html,url);if(!url)source.stopped='no_public_next_link';
   }catch(e){errors.push(`${root}：${e.message}`);source.stopped='error';break;}
  }
  sources.push(source);
  if(Date.now()<reader.deferUntil)break;
 }
 return {found,sources,errors,pagesRead,duplicatePages,pagesRequested:roots.length*c.discoveryPages};
}
