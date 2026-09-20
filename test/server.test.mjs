import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Wallet } from 'ethers';
test('本机接口：隔离跨站访问、导入校验、无默认真实运行、清除钱包',async()=>{
  const port=18792,origin=`http://127.0.0.1:${port}`,proc=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,MINT_DESK_PORT:String(port)},stdio:'pipe',windowsHide:true});
  try {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('start timeout')),8000);proc.stdout.once('data',()=>{clearTimeout(timer);resolve();});proc.once('exit',()=>{clearTimeout(timer);reject(Error('early exit'));});});
    const html=await(await fetch(origin)).text(),token=html.match(/name="mint-session" content="([a-f0-9]+)"/)[1];
    const call=async(route,b,extra={})=>fetch(origin+route,{method:b===undefined?'GET':'POST',headers:{'x-mint-token':token,'content-type':'application/json',...extra},body:b===undefined?undefined:JSON.stringify(b)});
    assert.equal((await fetch(origin+'/api/state')).status,400);
    assert.equal((await fetch(origin+'/api/artwork?chainId=4663&contract=0x'+'a'.repeat(40))).status,400);
    assert.equal((await call('/api/artwork?chainId=4663&contract=0x'+'a'.repeat(40))).status,400);
    assert.equal((await fetch(origin+'/artwork.js')).status,200);
    assert.equal((await call('/api/state',undefined,{origin:'https://evil.invalid'})).status,400);
    assert.equal((await call('/api/state',undefined,{'sec-fetch-site':'cross-site'})).status,400);
    let state=await(await call('/api/state')).json();assert.equal(state.wallets.length,0);assert.equal(state.jobs.length,0);
    const monitor=await(await call('/api/monitor')).json();assert.equal(monitor.configured,false);assert.equal(monitor.enabled,false);
    assert.equal((await call('/api/monitor/start',{})).status,400);
    assert.equal((await call('/api/monitor/draft',{address:'0x'+'1'.repeat(40),source:'chain'})).status,400);
    assert.equal((await call('/api/monitor/settings',{apiKey:'not-a-key'},{origin:'https://evil.invalid'})).status,400);
    assert.equal((await fetch(origin+'/api/tracker')).status,400);
    const tracker=await(await call('/api/tracker')).json();assert.equal(tracker.running,false);
    assert.equal((await call('/api/tracker/settings',{wallets:[]})).status,200);
    assert.equal((await call('/api/tracker/start',{})).status,400);
    assert.equal((await call('/api/tracker/settings',{wallets:[{address:'0x'+'f'.repeat(64)}]})).status,400);
    assert.equal((await call('/api/tracker/stop',{})).status,200);
    assert.equal((await fetch(origin+'/wallet-tracker-ui.js')).status,200);
    const signer=Wallet.createRandom();const bad=await call('/api/wallets',{keys:[signer.privateKey,'invalid']});assert.equal(bad.status,400);state=await(await call('/api/state')).json();assert.equal(state.wallets.length,0);
    const good=await call('/api/wallets',{keys:[signer.privateKey]});assert.equal(good.status,200);const text=await good.text();assert.ok(!text.includes(signer.privateKey));assert.ok(text.includes(signer.address));
    assert.equal((await call('/api/wallets',{keys:[signer.privateKey]})).status,400);
    assert.equal((await call('/api/start',{confirm:false})).status,400);
    assert.equal((await call('/api/start',{confirm:true,reviewId:'invented'})).status,400);
    assert.equal((await call('/api/wallets/clear',{})).status,200);state=await(await call('/api/state')).json();assert.equal(state.wallets.length,0);assert.equal(state.jobs.length,0);
  }finally{proc.kill();}
});
