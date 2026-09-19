import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MonitorService,DEFAULT_MONITOR,monitorSettings,scanConfig} from '../monitor-service.mjs';
import {MarketStream} from '../monitor/market-stream.mjs';
class FakeWorker extends EventEmitter {postMessage(v){this.message=v;}async terminate(){this.terminated=true;this.emit('exit',0);}}
test('默认只扫描 Robinhood，包含付费，不限 gas，用保守净利润两倍规则；无共享 Key 或私有 RPC',()=>{const c=scanConfig(DEFAULT_MONITOR);assert.deepEqual(c.chains,['robinhood']);assert.equal(c.freeOnly,false);assert.equal(c.maxGasEth,null);assert.equal(c.profitMultiple,2);assert.equal(c.valuationMode,'sales-conservative-v1');assert.equal(c.apiKeyFile,'data/opensea-key.local.json');assert.ok(!JSON.stringify(c).includes('192.168'));assert.ok(!JSON.stringify(c).includes('work/'));});
test('监控间隔、WS 协议和自选输入受约束',()=>{for(const value of [{intervalSeconds:0},{wsUrl:'https://example.com'},{profitMultiple:-2},{watchlist:['../../key']},{rpcUrl:'file:///x'}])assert.throws(()=>monitorSettings({...DEFAULT_MONITOR,...value}));});
test('无 Key 不能启动；仅保存用户 Key；状态不泄露 Key；停止会终止扫描 worker；新进程不自动运行',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'monitor-service-'));let spawned=0,fake,config;
 const validatorFactory=file=>({configure:async key=>writeFile(file,JSON.stringify({apiKey:key})),stop(){}});
 const workerFactory=(_url,opt)=>{spawned++;config=opt.workerData;return fake=new FakeWorker();};
 try {const service=new MonitorService(root,{workerFactory,validatorFactory});await service.init();assert.equal(service.configured,false);assert.throws(()=>service.start(),/自己的/);assert.equal(spawned,0);
  const key='synthetic-test-opensea-key';await service.save({...DEFAULT_MONITOR,apiKey:key});assert.equal(JSON.parse(await readFile(service.keyFile,'utf8')).apiKey,key);assert.ok(!JSON.stringify(service.snapshot()).includes(key));
  const next=new MonitorService(root,{workerFactory,validatorFactory});await next.init();assert.equal(next.configured,true);assert.equal(next.snapshot().enabled,false);
  service.start();assert.equal(spawned,1);assert.ok(!JSON.stringify(config).includes(key));
  fake.emit('message',{type:'snapshot',value:{chain:{rows:[{address:'0x'+'1'.repeat(40),name:'Fixture'}]},scan:{report:{rows:[]}}}});assert.equal(service.candidates().length,1);
  await assert.rejects(service.save(DEFAULT_MONITOR),/停止监控/);
  await service.stop();assert.equal(fake.terminated,true);assert.equal(service.snapshot().enabled,false);
  await service.removeKey();assert.equal(service.configured,false);await assert.rejects(readFile(service.keyFile));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Key 验证失败不替换已保存的 Key，异常原文不泄漏',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'monitor-service-'));try{const s=new MonitorService(root,{validatorFactory:()=>({configure:async()=>{throw Error('secret=EXAMPLE-KEY');},stop(){}})});await s.init();await assert.rejects(s.save({...DEFAULT_MONITOR,apiKey:'EXAMPLE-KEY'}),e=>!e.message.includes('EXAMPLE-KEY'));assert.equal(s.configured,false);}finally{await rm(root,{recursive:true,force:true});}});
test('行情流最多保留 50 个目标订阅，删除旧订阅后再加入新目标',()=>{const s=new MarketStream('unused'),frames=[];s.ws={readyState:1,send:x=>frames.push(JSON.parse(x))};s.updateSlugs(Array.from({length:80},(_,i)=>'series-'+i));assert.equal(s.slugs.size,50);assert.equal(frames.length,50);s.updateSlugs(['new-series']);assert.equal(s.slugs.size,1);assert.equal(frames.filter(x=>x[3]==='phx_leave').length,50);assert.equal(s.pending.size,1);});
test('不会把钱包私钥当 API Key 发送到 OpenSea',async()=>{const s=new MarketStream('unused');await assert.rejects(s.configure('1'.repeat(64)),/仅接受/);await assert.rejects(s.configure('0x'+'1'.repeat(64)),/仅接受/);});
