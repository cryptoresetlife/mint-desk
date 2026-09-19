import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scanConfig,DEFAULT_MONITOR,MonitorService} from '../monitor-service.mjs';
test('实际 worker 在离线传输下完成扫描、输出不含 Key，终止后保存结果可读取',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'monitor-worker-'));let worker;
 try{
  await mkdir(path.join(root,'data'));const key='OFFLINE-TEST-KEY-DO-NOT-USE';await writeFile(path.join(root,'data/opensea-key.local.json'),JSON.stringify({apiKey:key}));
  worker=new Worker(new URL('./monitor-worker-fixture.mjs',import.meta.url),{workerData:{config:scanConfig(DEFAULT_MONITOR),storageRoot:root},stdout:true,stderr:true});worker.stdout.resume();worker.stderr.resume();
  const output=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No completed scan')),10000);worker.on('error',reject);worker.on('message',m=>{if(m.type==='snapshot'&&m.value.scan.report){clearTimeout(timer);resolve(m.value);}});});
  assert.equal(output.scan.report.coverage.pagesRead,3);assert.equal(output.scan.report.rows.length,0);assert.equal(output.market.configured,true);assert.ok(!JSON.stringify(output).includes(key));
  await worker.terminate();worker=null;const saved=JSON.parse(await readFile(path.join(root,'data/latest.json'),'utf8'));assert.equal(saved.settings.apiKeyEnabled,true);
 }finally{if(worker)await worker.terminate();await rm(root,{recursive:true,force:true});}
});
test('监控转 mint 只生成预算草稿，不带钱包或自动执行指令',()=>{const s=new MonitorService('unused');const address='0x'+'1'.repeat(40);s.latest={scan:{report:{rows:[{address,chain:'robinhood',name:'Fixture',onchain:{mintPriceEth:.02}}]}}};const d=s.draft({address,source:'market'});assert.equal(d.maxPriceEth,'0.02');assert.equal(d.quantity,1);assert.equal(d.chainId,4663);assert.equal(d.wallets,undefined);assert.equal(d.confirm,undefined);assert.equal(d.id,undefined);assert.throws(()=>s.draft({address:'wrong',source:'market'}));});
