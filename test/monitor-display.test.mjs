import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../app/monitor-ui.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function qualifiedMonitorRow('),source.indexOf('const ethText='));
const accepts=vm.runInNewContext(fn+'\nqualifiedMonitorRow;');
test('默认机会视图排除原始发现、虚高地板和成交证据不足，保留已评估的付费机会',()=>{
 const now=Date.now(),s={config:{profitMultiple:2},latest:{chain:{rows:[]}}};
 const r={address:'0x123',chain:'robinhood',status:'优先复核',valuationMode:'sales-conservative-v1',valuation:{supported:true,independentTransactions:3,pricedBuyers:2},marketCheckedUtc:new Date(now).toISOString(),totalCostEth:.1,estimatedProfitEth:.2,onchain:{state:'active',simulation:'passed',mintPriceEth:.09}};
 assert.equal(accepts(r,s,now),true);
 for(const change of [{status:'公售开放'},{chain:'ethereum'},{valuation:undefined},{valuation:{supported:false}},{valuation:{supported:true,independentTransactions:3,pricedBuyers:1}},{estimatedProfitEth:.1999},{totalCostEth:0},{marketCheckedUtc:new Date(now-16*60000).toISOString()},{marketCheckedUtc:new Date(now+1).toISOString()},{onchain:{state:'waiting',simulation:'passed'}},{onchain:{state:'active',simulation:'failed'}}])assert.equal(accepts({...r,...change},s,now),false,JSON.stringify(change));
 assert.equal(accepts(r,{config:{profitMultiple:3}},now),false);
 assert.equal(accepts(r,{...s,latest:{chain:{rows:[{address:'0x123',status:'已售罄',remaining:'0'}]}}},now),false);
 assert.equal(accepts({...r,name:'Test'},s,now),true,'名称不是认定质量或诈骗的依据');
});
