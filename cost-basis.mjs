import {readFile,writeFile,mkdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseUnits,formatUnits} from 'ethers';
import {requireThat} from './lib.mjs';
const SCALE=10n**18n;
export function costAmount(v){requireThat(typeof v==='string'&&/^\d{1,30}(\.\d{1,18})?$/.test(v),'成本或汇率必须是非负数字，最多 18 位小数。');return parseUnits(v,18);}
export function manualCost(b){requireThat(['ETH','WETH','USDG','USDC'].includes(b.symbol),'请选择成本币种。');return {source:'manual',symbol:b.symbol,paid:formatUnits(costAmount(b.paid),18),gasEth:b.gasEth===''?null:formatUnits(costAmount(b.gasEth),18),updatedAt:Date.now()};}
export function recordedCost(a,r,n){
 try{
  const same=(x,y)=>typeof x==='string'&&x.toLowerCase()===y.toLowerCase();
  if(!r.success||!same(a.hash,r.hash)||!same(r.hash,r.receipt.transactionHash)||r.receipt.status!=='0x1'||a.chainId!==n.chainId||!same(a.address,n.owner)||!same(a.nft,n.contract))return null;
  const ids=r.tokenIds.map(String),q=BigInt(a.quantity);
  if(q<=0n||q!==BigInt(ids.length)||new Set(ids).size!==ids.length||!ids.includes(n.tokenId)||!/^\d+$/.test(String(a.value)))return null;
  const paid=BigInt(a.value),gas=BigInt(r.receipt.gasUsed)*BigInt(r.receipt.effectiveGasPrice);
  if(paid<0n||gas<0n)return null;
  return {source:'mint-record',symbol:'ETH',paid:formatUnits((paid+q-1n)/q,18),gasEth:formatUnits((gas+q-1n)/q,18),hash:r.hash,quantity:Number(q)};
 }catch{return null;}
}
export class CostStore{
 constructor(dir,records){this.dir=dir;this.records=records;}
 file(n){return path.join(this.dir,createHash('sha256').update(`${n.chainId}:${n.owner.toLowerCase()}:${n.contract.toLowerCase()}:${n.tokenId}`).digest('hex')+'.json');}
 async get(n){
  try{const b=JSON.parse(await readFile(this.file(n),'utf8'));return {...manualCost({...b,gasEth:b.gasEth??''}),updatedAt:b.updatedAt};}catch(e){if(e.code!=='ENOENT')return {source:'invalid'};}
  const base=path.join(this.records,`${n.chainId}-${n.contract.toLowerCase()}-${n.owner.toLowerCase()}.json`);
  try{return recordedCost(JSON.parse(await readFile(base,'utf8')),JSON.parse(await readFile(base+'.receipt','utf8')),n);}catch{return null;}
 }
 async save(n,b){
  if(b.clear){try{await unlink(this.file(n));}catch(e){if(e.code!=='ENOENT')throw e;}return this.get(n);}
  const value=manualCost(b);await mkdir(this.dir,{recursive:true});const dest=this.file(n),temp=dest+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,dest);return value;
 }
}
// Costs are advisory only. They never alter the seller's order or its price.
export function costOutcome(cost,net,currency,approvalGasEth,ethRate,feeBps=0){
 if(!cost||cost.source==='invalid')return {status:'missing',note:'成本未填写，无法计算盈亏。'};
 if(cost.gasEth===null)return {status:'incomplete',note:'买入时 gas 未填写，成本不完整，暂不计算盈亏。'};
 let rate=null;if(ethRate!==undefined&&ethRate!==''){rate=costAmount(ethRate);requireThat(rate>0n,'ETH 换算价必须大于 0。');}
 const quoteEth=currency.native===true&&currency.symbol==='ETH';
 const gas=costAmount(cost.gasEth)+costAmount(approvalGasEth),paid=costAmount(cost.paid);
 if(cost.symbol!==currency.symbol&&cost.symbol!=='ETH')return {status:'currency',note:'成本与售价币种不同，暂不跨币种计算盈亏。'};
 if(!quoteEth&&!rate&&(gas>0n||(cost.symbol==='ETH'&&paid>0n)))return {status:'rate',note:`需要填写 1 ETH 的 ${currency.symbol} 换算价，才能计入 ETH 成本和 gas。`};
 const convert=v=>quoteEth?v:(v*(rate??0n)+SCALE-1n)/SCALE;
 const total=(cost.symbol===currency.symbol?paid:convert(paid))+convert(gas);
 const [whole,fraction='']=net.split('.'),netFixed=BigInt(whole)*SCALE+BigInt(fraction.padEnd(18,'0').slice(0,18));
 const profit=netFixed-total,precision=10n**BigInt(currency.decimals),costUnits=(total*precision+SCALE-1n)/SCALE;
 const remaining=10000n-BigInt(feeBps);requireThat(remaining>0n&&remaining<=10000n,'费用比例无效。');
 const breakEven=formatUnits((costUnits*10000n+remaining-1n)/remaining,currency.decimals);
 return {status:'ok',total:formatUnits(total,18),profit:formatUnits(profit,18),breakEven,symbol:currency.symbol,rate:quoteEth?null:ethRate||null,source:cost.source};
}
