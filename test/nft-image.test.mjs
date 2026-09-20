import test from 'node:test';
import assert from 'node:assert/strict';
import {nftImageUrl,ArtworkService} from '../nft-image.mjs';
import {NftMarket} from '../nft-market.mjs';
test('NFT images prefer display metadata; IPFS resolves through HTTPS',()=>{
 assert.equal(nftImageUrl({display_image_url:'https://i.seadn.io/a.png',image_url:'https://example.com/b.png'}),'https://i.seadn.io/a.png');
 assert.equal(nftImageUrl({image_url:'ipfs://ipfs/bafytest/7.png'}),'https://ipfs.io/ipfs/bafytest/7.png');
 for(const url of ['javascript:alert(1)','data:text/html,test','http://example.com/a','https://127.0.0.1/a','https://user:password@example.com/a','https://host.local/a','https://[::1]/a'])assert.equal(nftImageUrl({image_url:url}),null);
 assert.equal(nftImageUrl({}),null);
});
test('Artwork cache isolates chains and token IDs, coalesces duplicate calls and rejects mismatched collections',async()=>{
 const contract='0x'+'b'.repeat(40);let calls=0;
 const service=new ArtworkService(async endpoint=>{calls++;if(endpoint.endsWith('/nfts/7'))return {nft:{contract,identifier:'7',image_url:'https://i.seadn.io/7.png'}};if(endpoint.startsWith('collections/'))return {collection:'sample',contracts:[{address:contract,chain:'ethereum'}],image_url:'https://i.seadn.io/collection.png'};return {address:contract,chain:'robinhood',collection:'sample'};},{spacing:0});
 const t={chainId:4663,contract,tokenId:'7'};
 const results=await Promise.all([service.get(t),service.get(t)]);assert.equal(calls,1);assert.equal(results[0].imageUrl,results[1].imageUrl);
 assert.equal((await service.get({chainId:4663,contract})).imageUrl,null);assert.equal(calls,3);
 await service.get({chainId:4663,contract});assert.equal(calls,3);
 await assert.rejects(()=>service.get({...t,contract:'../../private'}));
});
test('A matching collection returns its cover; missing metadata is cached briefly',async()=>{
 const contract='0x'+'c'.repeat(40);let now=1,calls=0;
 const service=new ArtworkService(async endpoint=>{calls++;return endpoint.startsWith('collections/')?{collection:'sample',contracts:[{address:contract,chain:'robinhood'}],image_url:'https://i.seadn.io/cover.png'}:{address:contract,chain:'robinhood',collection:'sample'};},{now:()=>now,spacing:0});
 const result=await service.get({chainId:4663,contract});assert.equal(result.kind,'collection');assert.match(result.url,/collection\/sample/);assert.equal(result.imageUrl,'https://i.seadn.io/cover.png');
 const missing=new ArtworkService(async()=>{calls++;return {nft:{contract,identifier:'8'}};},{now:()=>now,spacing:0});
 const t={chainId:4663,contract,tokenId:'8'};await missing.get(t);await missing.get(t);assert.equal(calls,3);now+=60001;await missing.get(t);assert.equal(calls,4);
});
test('Image detail must match the NFT and cached data avoids repeat API calls',async()=>{
 const n={chainId:4663,contract:'0x'+'a'.repeat(40),tokenId:'7'};let calls=0;
 const market={api:{request:async()=>{calls++;return {nft:{contract:n.contract,identifier:'7',image_url:'https://i.seadn.io/7.png'}};}}};
 assert.equal((await NftMarket.prototype.image.call(market,n)).imageUrl,'https://i.seadn.io/7.png');
 await NftMarket.prototype.image.call(market,n);assert.equal(calls,1);
 await assert.rejects(()=>NftMarket.prototype.image.call(market,{...n,tokenId:'8',imageUrl:null,imageCheckedAt:0}),/未匹配/);
});
