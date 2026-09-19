import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assess,conservativeValuation} from '../monitor/market.mjs';
import {scanConfig,DEFAULT_MONITOR} from '../monitor-service.mjs';
const cfg=scanConfig(DEFAULT_MONITOR);
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const sale=(n,price=.01)=>({transactionHash:'0x'+n.toString(16).padStart(64,'0'),from:addr(100),to:addr(n),eventTime:new Date().toISOString(),price:{value:price,symbol:'ETH'}});
const row=()=>({floor:{value:.279,symbol:'ETH'},topOffer:{value:.008,symbol:'WETH'},creatorFeeBps:0,saleEvidence:{sales:[sale(1,.005),sale(2,.005),sale(3,.005)]},onchain:{state:'active',mintPriceEth:.0088,simulation:'passed',gasCapEth:.00001,gasPriceWei:'100000000'}});
test('live config uses conservative evidence valuation; inflated Lil floor cannot qualify',()=>{
 assert.equal(cfg.valuationMode,'sales-conservative-v1');
 const r=assess(row(),cfg);assert.equal(r.status,'观察');assert.equal(r.referencePriceEth,.004);assert(r.estimatedProfitEth<0);assert(r.profitToCost<0);assert(r.valuation.floorDivergence);
 assert(Math.abs(r.totalCostEth-(.0088+.00001+.00002+.004*.025))<1e-12);
});
test('no sales, stale sales, one buyer or one bulk transaction fail closed',()=>{
 for(const sales of [[],[sale(1)],Array.from({length:20},()=>sale(1)),[1,2,3].map(n=>({...sale(n),to:addr(1)})),[1,2,3].map(n=>({...sale(n),transactionHash:sale(1).transactionHash})),[1,2,3].map(n=>({...sale(n),eventTime:new Date(Date.now()-7*3600000).toISOString()}))]){
  const r=row();r.saleEvidence={sales};const a=assess(r,cfg);assert.equal(a.status,'待核验');assert.equal(a.referencePriceEth,null);assert.equal(a.profitToCost,null);
 }
});
test('offer never increases valuation and unknown offers do not fabricate demand',()=>{
 const r=row();r.topOffer.value=100;assert.equal(conservativeValuation(r).reference,.004);
 r.topOffer.value=.002;assert.equal(conservativeValuation(r).reference,.002);
 r.topOffer=null;assert.equal(conservativeValuation(r).reference,.004);
 r.floor.value=.001;assert.equal(conservativeValuation(r).reference,.001);
});
test('buyer weighting prevents a repeated high-price buyer lifting low price',()=>{
 const r=row();r.topOffer=null;r.saleEvidence.sales=[sale(1,.005),sale(2,.005),...Array.from({length:30},(_,i)=>({...sale(i+3,1),to:addr(3)}))];
 assert.equal(conservativeValuation(r).reference,.004);
});
test('conservative net profit boundary includes sales fees; paid and high gas remain allowed',()=>{
 const r=row();r.topOffer=null;r.floor.value=200;r.saleEvidence.sales=[sale(1,187.5),sale(2,187.5),sale(3,187.5)];
 r.onchain={...r.onchain,mintPriceEth:49,gasCapEth:.8,gasPriceWei:'1000000000000'};
 const c={...cfg,assumedMarketplaceFeeBps:0};
 const a=assess(r,c);assert.equal(a.referencePriceEth,150);assert.equal(a.totalCostEth,50);assert.equal(a.estimatedProfitEth,100);assert.equal(a.profitToCost,2);assert.equal(a.status,'优先复核');
 assert.equal(assess(r,{...c,assumedMarketplaceFeeBps:250}).status,'观察');
 r.onchain.state='waiting';assert.equal(assess(r,c).status,'待开售');assert.equal(assess(r,c).upcomingPromising,false);
});
