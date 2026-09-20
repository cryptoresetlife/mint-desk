import test from 'node:test';
import assert from 'node:assert/strict';
import {ABI,SEA,TOPICS,decodeEvent,applyEvent,dropPhase,readRpc,ChainDiscovery,displayDropTime} from '../monitor/realtime.mjs';
import {MarketStream} from '../monitor/market-stream.mjs';
const address='0x'+'1'.repeat(40),hash='0x'+'2'.repeat(64);
test('uint48 sale dates outside Date range do not crash snapshots or discard other projects',()=>{
 const c=new ChainDiscovery('.'),now=Math.floor(Date.now()/1000),max=2**48-1;
 c.rows.set(address,{address,startTime:now-10,endTime:max,checkedUtc:new Date().toISOString(),walletLimit:1,remaining:'2'});
 c.rows.set(SEA,{address:SEA,startTime:now+60,endTime:now+600});
 c.head={number:1,timestamp:now,checkedUtc:new Date().toISOString()};c.cursor=1;
 const snapshot=c.snapshot(),r=snapshot.rows.find(r=>r.address===address);
 assert.equal(snapshot.rows.length,2);assert.equal(r.status,'公售开放');assert.equal(r.endUtc,null);assert.match(r.timeDisplayWarning,/超出/);assert.equal(r.endTime,max);
 assert.equal(displayDropTime(max),null);assert.equal(displayDropTime(Infinity),null);assert.equal(displayDropTime(0),null);assert.equal(displayDropTime(now),new Date(now*1000).toISOString());
 c.rows.get(address).startTime=max;assert.doesNotThrow(()=>c.snapshot());c.stop();
});
function log(block=100){const encoded=ABI.encodeEventLog(ABI.getEvent('PublicDropUpdated'),[address,[0,1000,2000,2,0,false]]);return {...encoded,address:SEA,blockNumber:'0x'+block.toString(16),blockHash:hash,transactionHash:hash,logIndex:'0x1'};}
test('only configured SeaDrop event emitter is accepted; decoding retains contract and time-order metadata',()=>{
 const e=decodeEvent(log());assert.equal(e.address,address);assert.equal(e.kind,'PublicDropUpdated');assert.equal(e.block,100);
 assert.equal(decodeEvent({...log(),address}),null);assert.equal(decodeEvent({...log(),data:'0x'}),null);assert.equal(TOPICS.length,5);
});
test('delayed history cannot overwrite newer event and removed logs invalidate cached readiness',()=>{
 const rows=new Map();assert(applyEvent(rows,decodeEvent(log(101)),true));assert(!applyEvent(rows,decodeEvent(log(100)),false));assert.equal(rows.get(address).eventBlock,101);
 const removed=decodeEvent({...log(101),removed:true});applyEvent(rows,removed,true);assert.equal(rows.get(address).checkedUtc,null);assert(rows.get(address).error.includes('重组'));
});
test('sale opening, closing, zero supply and stale readings are not mislabeled',()=>{
 const r={checkedUtc:new Date().toISOString(),startTime:1000,endTime:2000,walletLimit:1,remaining:'10'};
 assert.equal(dropPhase(r,999),'待开售');assert.equal(dropPhase(r,1000),'公售开放');assert.equal(dropPhase(r,2000),'已结束');assert.equal(dropPhase({...r,remaining:'0'},1500),'已售罄');
 assert.equal(dropPhase({...r,walletLimit:0},1500),'未配置公售');assert.equal(dropPhase(r,1500,false),'待核验');assert.equal(dropPhase({...r,checkedUtc:'2020-01-01'},1500),'待核验');
});
test('write/sign RPC methods rejected before network access',async()=>{for(const m of ['eth_sendRawTransaction','eth_sign','personal_sign'])await assert.rejects(readRpc('http://invalid',m),/只读/);});
function fakeReader(fail=false){
 const now=Math.floor(Date.now()/1000);return async(method,params)=>{
  if(method==='eth_getBlockByNumber'){const height=params[0]==='latest'?103:Number(BigInt(params[0]));return {number:'0x'+height.toString(16),timestamp:'0x'+now.toString(16),hash};}
  if(method==='eth_getLogs'){if(fail)throw new Error('range failed');return [log(101)];}throw new Error('Unexpected method');
 };
}
test('failed log range does not advance durable cursor; retry catches and deduplicates',async()=>{
 const c=new ChainDiscovery('.');c.cursor=100;c.cursorHash=hash;c.verify=async()=>{};c.rpc=fakeReader(true);c.save=async()=>{};c.drain=()=>{};
 await c.tick();assert.equal(c.cursor,100);assert.equal(c.rows.size,0);assert(c.error);
 c.rpc=fakeReader(false);await c.tick();assert.equal(c.cursor,103);assert.equal(c.rows.size,1);assert.equal(c.error,null);
 c.ingest(log(101),true);assert.equal(c.rows.size,1);assert.equal(c.alerts.length,0);c.stop();
});
test('restart restores persisted cursor and records; dead websocket schedules reconnect',async()=>{
 const c=new ChainDiscovery('.');c.cursor=100;c.cursorHash=hash;c.verify=async()=>{};c.rpc=fakeReader(false);c.drain=()=>{};c.save=async()=>{};
 await c.tick();const snap=c.snapshot();assert.equal(snap.healthy,true);assert.equal(snap.cursor,103);assert.equal(snap.rows[0].status,'待核验');
 c.scheduleReconnect();assert(c.reconnect);c.stop();assert.equal(c.stopped,true);
});
test('event stream rejects wallet private keys and rpc urls as OpenSea keys',async()=>{
 const c=new MarketStream('unused');await assert.rejects(c.configure('0x'+'a'.repeat(64)),/仅接受/);await assert.rejects(c.configure('https://example.test/key'),/仅接受/);assert.equal(c.snapshot().configured,false);c.stop();
});
test('opening alert fires once from fresh chain clock even without a new configuration event',async()=>{
 const c=new ChainDiscovery('.');c.cursor=103;c.cursorHash=hash;c.verify=async()=>{};c.rpc=fakeReader(false);c.drain=()=>{};c.save=async()=>{};
 const now=Math.floor(Date.now()/1000);c.rows.set(address,{address,checkedUtc:new Date().toISOString(),startTime:now-1,endTime:now+600,remaining:'10',walletLimit:1,lastPhase:'待开售'});
 await c.tick();await c.tick();assert.equal(c.alerts.filter(a=>a.message.startsWith('公售已开放')).length,1);c.stop();
});
