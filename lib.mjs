import { Interface, ZeroAddress, getAddress, keccak256, parseEther, formatEther, toQuantity, Transaction } from 'ethers';
import { open, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
export const SEA = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
export const FEE = '0x0000a26b00c1F0DF003000390027140000fAa719';
export const CHAINS = {
  4663: {name:'Robinhood', symbol:'ETH', rpc:'https://rpc.mainnet.chain.robinhood.com', explorer:'https://robinhoodchain.blockscout.com', seaHash:'0x53e4b9339cf624803c9a7d0195576cca5b917920813508d86b3eb93dcbabeb5c'},
  1: {name:'Ethereum', symbol:'ETH', rpc:'https://ethereum-rpc.publicnode.com', explorer:'https://etherscan.io', seaHash:'0x7200e8ad8178b88c4f40b7562834b163c961cac853dac50d209c82e27775f981'}
};
export const sea = new Interface([
  'function getPublicDrop(address) view returns(tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
  'function getFeeRecipientIsAllowed(address,address) view returns(bool)',
  'function mintPublic(address,address,address,uint256) payable',
  'error NotActive(uint256,uint256,uint256)'
]);
export const nft = new Interface(['function name() view returns(string)','function getMintStats(address) view returns(uint256,uint256,uint256)','event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
export class Stop extends Error {}
export const requireThat = (v, m) => { if(!v) throw new Stop(m); };
export const json = v => JSON.stringify(v, (_,x)=>typeof x==='bigint'?x.toString():x,2);
export const safeError = e => e instanceof Stop ? e.message : '请求未完成，请检查 RPC、网络或合约兼容性。';
export function amount(v, label, zero=false) {
  requireThat(typeof v==='string' && /^\d{1,12}(\.\d{1,18})?$/.test(v),`${label}请填写十进制 ETH 金额（最多 18 位小数）。`);
  const n=parseEther(v); requireThat(zero?n>=0n:n>0n,`${label}必须${zero?'不小于':'大于'} 0。`); return n;
}
export function settings(input) {
  const chainId=Number(input.chainId), quantity=Number(input.quantity);
  requireThat(CHAINS[chainId],'仅支持 Robinhood 4663 与 Ethereum 1。');
  requireThat(Number.isSafeInteger(quantity)&&quantity>=1&&quantity<=100,'每钱包数量须为 1–100。');
  let address;try{address=getAddress(input.address);}catch{throw new Stop('NFT 合约地址无效。');}
  amount(input.maxPriceEth,'单个 mint 价格上限',true);amount(input.maxGasEth,'每钱包 gas 上限');
  new Rpc(input.rpcUrl);
  return {chainId,address,quantity,maxPriceEth:input.maxPriceEth,maxGasEth:input.maxGasEth,rpcUrl:input.rpcUrl.trim(),name:String(input.name||'未命名项目').slice(0,100),slug: /^[a-z0-9_-]{1,150}$/i.test(input.slug||'')?input.slug:null};
}
export class Rpc {
  constructor(url, fetchImpl=fetch) {
    let u;try{u=new URL(url);}catch{throw new Stop('请填写完整 RPC 地址。');}
    const h=u.hostname;
    const local=h==='localhost'||h==='127.0.0.1'||/^192\.168\./.test(h)||/^10\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h);
    requireThat(!u.username&&!u.password&&(u.protocol==='https:'||(u.protocol==='http:'&&local)),'RPC 需为 HTTPS，或局域网 HTTP 地址。');
    this.url=url.trim();this.fetch=fetchImpl;this.id=0;
  }
  async send(method,params=[]) {
    let b;try {
      const r=await this.fetch(this.url,{method:'POST',headers:{'content-type':'application/json'},body:json({jsonrpc:'2.0',id:++this.id,method,params}),signal:AbortSignal.timeout(6000)});
      if(!r.ok)throw Error();b=await r.json();
    }catch{throw new Stop(`${method} 请求超时或网络不可用。`);}
    if(b.error){const e=new Stop(`${method} 被 RPC 拒绝；未展示可能包含凭据的原始错误。`);try{e.revert=sea.parseError(b.error.data)?.name;}catch{}throw e;}
    requireThat(Object.hasOwn(b,'result'), 'RPC 返回数据缺失。');return b.result;
  }
  async call(abi,to,name,args,tag='latest') {return abi.decodeFunctionResult(name,await this.send('eth_call',[{to,data:abi.encodeFunctionData(name,args)},tag]));}
}
export async function identity(rpc,p) {
  const [id,code,sc,name]=await Promise.all([rpc.send('eth_chainId'),rpc.send('eth_getCode',[p.address,'latest']),rpc.send('eth_getCode',[SEA,'latest']),rpc.call(nft,p.address,'name',[])]);
  requireThat(Number(BigInt(id))===p.chainId,'RPC 链 ID 与所选链不符。');
  requireThat(code!=='0x'&&keccak256(sc)===CHAINS[p.chainId].seaHash,'合约不存在或 SeaDrop 版本不受支持；不会发送交易。');
  return {name:String(name[0]).slice(0,100),codeHash:keccak256(code)};
}
export async function snapshot(rpc,p,address=ZeroAddress) {
  const b=await rpc.send('eth_getBlockByNumber',['latest',false]);
  requireThat(b?.number&&b?.timestamp,'区块数据缺失。');
  const [[d],s,[allowed]]=await Promise.all([rpc.call(sea,SEA,'getPublicDrop',[p.address],b.number),rpc.call(nft,p.address,'getMintStats',[address],b.number),rpc.call(sea,SEA,'getFeeRecipientIsAllowed',[p.address,FEE],b.number)]);
  const time=Number(BigInt(b.timestamp));
  requireThat(Math.abs(Date.now()/1000-time)<90,'节点区块时间落后或电脑时钟不准，暂不发送。');
  return {block:b.number,timestamp:time,price:d.mintPrice,start:Number(d.startTime),end:Number(d.endTime),limit:d.maxTotalMintableByWallet,feeBps:d.feeBps,restricted:d.restrictFeeRecipients,allowed,minted:s[0],total:s[1],supply:s[2]};
}
export function phase(s) {return s.start===0||s.end<=s.start?'未配置':s.total>=s.supply?'已售罄':s.timestamp>=s.end?'已结束':s.timestamp<s.start?'等待开售':'已开放';}
export function validateSale(p,s) {
  requireThat(s.start>0&&s.end>s.start,'没有可用的 SeaDrop 公开阶段。');
  requireThat(s.price<=amount(p.maxPriceEth,'价格上限',true),'当前 mint 单价超过设置的上限。');
  requireThat(s.timestamp<s.end,'公售已结束。');
  requireThat(s.total+BigInt(p.quantity)<=s.supply,'剩余供应不足。');
  requireThat(s.minted+BigInt(p.quantity)<=s.limit,'本钱包已铸造数量加本次数量超过公售钱包上限。');
  requireThat(!s.restricted||s.allowed,'OpenSea 费用接收地址未获该系列许可。');
}
export const fingerprint=s=>[s.price,s.start,s.end,s.limit,s.feeBps,s.restricted,s.allowed,s.supply].join('/');
export const mintRequest=(p,address,s)=>({from:address,to:SEA,value:toQuantity(s.price*BigInt(p.quantity)),data:sea.encodeFunctionData('mintPublic',[p.address,FEE,ZeroAddress,p.quantity])});
export function gasPlan(estimate,gasPrice,balance,value,cap) {
  requireThat(estimate>0n&&gasPrice>0n,'gas 估算无效。');
  const limit=(estimate*125n+99n)/100n,price=(gasPrice*120n+99n)/100n,cost=limit*price;
  requireThat(cost<=amount(cap,'gas 上限'),'估算后的 gas 费用上限超过预算。');
  requireThat(balance>=value+cost,'余额不足以覆盖 mint 金额与签名 gas 上限。');
  return {gasLimit:limit,gasPrice:price,maxCost:cost};
}
export function mintedIds(receipt,p,address) {
  const ids=[];for(const l of receipt.logs??[]) {if(l.address?.toLowerCase()!==p.address.toLowerCase())continue;
    try{const e=nft.parseLog(l);if(e?.name==='Transfer'&&e.args.from===ZeroAddress&&e.args.to.toLowerCase()===address.toLowerCase())ids.push(e.args.tokenId.toString());}catch{}}
  return ids;
}
export async function prepare(rpc,p,w,s,ahead=false) {
  validateSale(p,s);const req=mintRequest(p,w.address,s);
  let estimate;
  if(ahead) {
    const time=Math.max(s.start,s.timestamp+1);requireThat(time<s.end,'公售窗口不足。');
    const overrides={time:toQuantity(time)};
    const [e,sim]=await Promise.all([rpc.send('eth_estimateGas',[req,s.block,{},overrides]),rpc.send('eth_simulateV1',[{blockStateCalls:[{blockOverrides:overrides,calls:[req]}],validation:false},s.block])]);
    const result=sim?.[0]?.calls?.[0];
    requireThat(sim?.length===1&&sim[0].calls?.length===1&&Number(BigInt(sim[0].timestamp))===time&&result?.status==='0x1'&&mintedIds(result,p,w.address).length===p.quantity,'提前预演未证实预期 NFT 铸造，等待开售后标准预检。');
    estimate=BigInt(e);requireThat(estimate>=BigInt(result.gasUsed),'预演 gas 估算不完整。');
  } else {
    requireThat(s.timestamp>=s.start,'公售尚未开始。');
    const [e,r]=await Promise.all([rpc.send('eth_estimateGas',[req,'pending']),rpc.send('eth_call',[req,'pending'])]);
    requireThat(r==='0x','mint 模拟返回异常。');estimate=BigInt(e);
  }
  const [g,b,pending,latest]=await Promise.all([rpc.send('eth_gasPrice'),rpc.send('eth_getBalance',[w.address,'pending']),rpc.send('eth_getTransactionCount',[w.address,'pending']),rpc.send('eth_getTransactionCount',[w.address,'latest'])]);
  requireThat(BigInt(pending)===BigInt(latest),'钱包存在未确认交易，停止以防 nonce 冲突。');
  const value=BigInt(req.value),plan=gasPlan(estimate,BigInt(g),BigInt(b),value,p.maxGasEth);
  const tx={chainId:p.chainId,type:0,to:SEA,data:req.data,value,nonce:Number(BigInt(pending)),gasLimit:plan.gasLimit,gasPrice:plan.gasPrice};
  const raw=await w.signer.signTransaction(tx);validateSigned(raw,p,w.address,tx);
  return {tx,raw,maxCost:plan.maxCost,fingerprint:fingerprint(s),at:Date.now(),request:req};
}
export function validateSigned(raw,p,address,tx) {
  const signed=Transaction.from(raw),d=sea.parseTransaction({data:signed.data,value:signed.value});
  requireThat(signed.from.toLowerCase()===address.toLowerCase()&&signed.chainId===BigInt(p.chainId)&&signed.to===getAddress(SEA)&&signed.type===0&&signed.nonce===tx.nonce&&signed.data===tx.data&&signed.value===tx.value&&signed.gasLimit===tx.gasLimit&&signed.gasPrice===tx.gasPrice,'签名内容与已检查的交易不一致。');
  requireThat(d?.name==='mintPublic'&&d.args[0].toLowerCase()===p.address.toLowerCase()&&d.args[1]===getAddress(FEE)&&d.args[2]===ZeroAddress&&d.args[3]===BigInt(p.quantity),'交易必须只铸造指定系列到付款钱包。');
  requireThat(signed.value<=amount(p.maxPriceEth,'价格',true)*BigInt(p.quantity)&&signed.gasLimit*signed.gasPrice<=amount(p.maxGasEth,'gas'),'签名交易超过授权预算。');
}
export const recordPath=(dir,p,address)=>path.join(dir,`${p.chainId}-${p.address.toLowerCase()}-${address.toLowerCase()}.json`);
export async function prior(dir,p,address) {
  try{return JSON.parse(await readFile(recordPath(dir,p,address),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw new Stop('已有记录无法读取，禁止自动重发。');}
}
export async function sendOnce({rpc,p,w,prepared,dir,check=()=>{}}) {
  check();validateSigned(prepared.raw,p,w.address,prepared.tx);
  const hash=keccak256(prepared.raw),tx=prepared.tx;
  await mkdir(dir,{recursive:true});
  let f;try{f=await open(recordPath(dir,p,w.address),'wx',0o600);}catch{throw new Stop('已有交易尝试记录或无法保存记录，未新增广播。');}
  try{await f.writeFile(json({hash,address:w.address,nft:p.address,chainId:p.chainId,nonce:tx.nonce,quantity:p.quantity,value:tx.value,maxGasWei:tx.gasLimit*tx.gasPrice,createdUtc:new Date().toISOString()}));await f.sync();}finally{await f.close();}
  try {check();const got=await rpc.send('eth_sendRawTransaction',[prepared.raw]);requireThat(got?.toLowerCase()===hash.toLowerCase(),'广播哈希不符。');return {hash,uncertain:false};}
  catch{return {hash,uncertain:true};}
}
export function publicSale(s) {return {...s,priceEth:formatEther(s.price),remaining:(s.supply-s.total).toString(),phase:phase(s)};}
