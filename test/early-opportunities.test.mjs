import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {MintActivity} from '../monitor/activity.mjs';
import {ABI,SEA,decodeEvent,ChainDiscovery} from '../monitor/realtime.mjs';
const code=await readFile(new URL('../app/early.js',import.meta.url),'utf8');
const early=vm.runInNewContext(code+'\nearlyOpportunity;');
const ui=await readFile(new URL('../app/monitor-ui.js',import.meta.url),'utf8');
const address='0x'+'1'.repeat(40),who=n=>'0x'+n.toString(16).padStart(40,'0');
const event=(n,change={})=>({address,hash:'block'+n,index:0,tx:'tx'+n,minter:who(n+2),payer:who(n+2),quantity:'1',...change});
test('browser uses the tested early-discovery rules',()=>assert.ok(ui.startsWith(code)));
test('block timestamps, deduplication, batch quantities, boundaries and reorg removal',()=>{
 let now=1000000;const a=new MintActivity(()=>now);a.startedAt=now-300000;
 a.add(event(1),now-310000);a.add(event(2),now+3000);assert.equal(a.events.size,0);
 a.add(event(3,{quantity:'24'}),now-30000);a.add(event(3,{quantity:'24'}),now-30000);
 a.add(event(4),now-60000);let s=a.snapshot().get(address);assert.equal(s.mints1m,24);assert.equal(s.mints5m,25);assert.equal(s.wallets5m,2);assert.equal(s.transactions5m,2);
 a.add(event(3,{removed:true}),now-30000);assert.equal(a.snapshot().get(address).mints5m,1);
 now+=300001;assert.equal(a.snapshot().size,0);
});
test('hot requires multiple recipients and acceleration; shared payer, stale or incomplete data is not hot',()=>{
 const now=2000000,a=new MintActivity(()=>now);a.startedAt=now-300000;
 for(let i=0;i<8;i++)a.add(event(i),now-(i<4?10000:100000));
 const activity={...a.snapshot().get(address),healthy:true};
 const row={address,status:'公售开放',checkedUtc:new Date(now).toISOString(),startTime:(now-100000)/1000,endTime:(now+100000)/1000,remaining:10,walletLimit:1,activity};
 assert.equal(early(row,now).hot,true);assert.equal(early({...row,name:'Test'},now).hot,true);
 for(const change of [{complete:false},{healthy:false},{wallets5m:7},{wallets1m:2},{transactions1m:2},{previousPerMinute:3},{topWalletShare:.6},{topPayerShare:.9},{sampledAtUtc:new Date(now-16000).toISOString()}])assert.equal(early({...row,activity:{...activity,...change}},now).hot,false,JSON.stringify(change));
 assert.equal(early({...row,remaining:0},now).hot,false);assert.equal(early({...row,checkedUtc:new Date(now-91000).toISOString()},now).hot,false);
 a.gap();assert.equal(a.events.size,0);assert.equal(a.empty().complete,false);
});
test('soon means fresh, available public sale within one hour; no price or profit requirement',()=>{
 const now=Date.now(),row={status:'待开售',checkedUtc:new Date(now).toISOString(),remaining:50,walletLimit:1,startTime:(now+600000)/1000,endTime:(now+7200000)/1000};
 assert.equal(early(row,now).soon,true);assert.equal(early({...row,startTime:(now+3601000)/1000},now).soon,false);assert.equal(early({...row,error:'stale'},now).soon,false);assert.equal(early({...row,walletLimit:0},now).soon,false);
});
test('mint event retains payer and quantity, and history uses block time rather than arrival time',async()=>{
 const encoded=ABI.encodeEventLog(ABI.getEvent('SeaDropMint'),[address,who(2),who(3),who(4),24,0,0,0]);
 const log={...encoded,address:SEA,blockNumber:'0x64',blockHash:'0x'+'2'.repeat(64),transactionHash:'0x'+'3'.repeat(64),logIndex:'0x0'};
 const e=decodeEvent(log);assert.equal(e.quantity,'24');assert.equal(e.payer,who(4));
 const c=new ChainDiscovery('.');c.head={number:100};c.rpc=async()=>({hash:log.blockHash,timestamp:'0x1'});c.ingest(log,true);
 await new Promise(r=>setTimeout(r,10));assert.equal(c.activity.events.size,0,'old logs must not create a new burst');c.stop();
});
