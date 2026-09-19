export function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const v of Object.values(value)) walk(v, visit);
}
// Read the JSON sent with OpenSea's public HTML. Never execute page scripts.
export function parsePage(html) {
  const objects=[];
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script=match[1];
    if(!script.includes('urql_transport'))continue;
    const at=script.indexOf('.push(');
    if(at<0)continue;
    try {objects.push(JSON.parse(script.slice(at+6).replace(/\);?\s*$/,'')));} catch {}
  }
  if(!objects.length)throw new Error('公开页面数据格式已改变或未加载，不能据此判断没有项目');
  return objects;
}
export function discover(objects) {
  const rows=new Map();
  walk(objects,x=>{
    if(!x.dropCalendar?.items)return;
    for(const item of x.dropCalendar.items){
      const c=item.collection;
      if(c?.slug && /^[a-z0-9_-]+$/i.test(c.slug))rows.set(c.slug,{slug:c.slug,name:c.name,chain:item.identifier?.chain?.identifier ?? c.chain?.identifier,address:item.identifier?.contractAddress,floor:money(c.floorPrice?.pricePerItem)});
    }
  });
  return [...rows.values()];
}
export function money(price) {
  const t=price?.token ?? price?.native;
  return t&&typeof t.unit==='number'&&Number.isFinite(t.unit)&&t.unit>=0 ? {value:t.unit,symbol:t.symbol,chain:t.chain?.identifier??null,usd:Number.isFinite(price?.usd)&&price.usd>=0?price.usd:null}:null;
}
export function eth(m,quote=null){
 if(!m||!Number.isFinite(m.value)||m.value<0)return null;
 if(['ETH','WETH'].includes(m.symbol))return m.value;
 // Use the page's USD valuation, never assume an arbitrary token is worth $1.
 if(Number.isFinite(m.usd)&&m.usd>=0&&Number.isFinite(quote?.ethUsd)&&quote.ethUsd>0&&Math.abs(Date.now()-Date.parse(quote.checkedUtc))<10*60*1000)return m.usd/quote.ethUsd;
  return null;
}
export function saleEvidence(objects,slug,now=Date.now()) {
 const sales=new Map();
 walk(objects,x=>{
  if(!Array.isArray(x.collectionActivity?.items))return;
  for(const e of x.collectionActivity.items){
   if(e.__typename!=='Sale'||e.type!=='SALE'||e.collection?.slug!==slug)continue;
   const time=Date.parse(e.eventTime),from=e.from?.address?.toLowerCase(),to=e.to?.address?.toLowerCase(),price=money(e.price);
   if(!Number.isFinite(time)||time>now||time<now-86400000||!/^0x[0-9a-f]{40}$/.test(from??'')||!/^0x[0-9a-f]{40}$/.test(to??''))continue;
   if(from===to||/^0x0+$/.test(from)||/^0x0+$/.test(to)||!price||price.value<=0||!/^0x[0-9a-f]{64}$/i.test(e.transactionHash??''))continue;
   const tokenId=e.item?.tokenId;if(tokenId===undefined)continue;
   const quantity=Number(e.quantity);if(!Number.isFinite(quantity)||quantity!==1)continue;
   const key=`${e.transactionHash.toLowerCase()}:${e.item?.contractAddress?.toLowerCase()}:${tokenId}`;
   sales.set(key,{transactionHash:e.transactionHash,tokenId,from,to,eventTime:e.eventTime,price});
  }
 });
 const rows=[...sales.values()];
 return {sampledSales24h:rows.length,uniqueBuyers:new Set(rows.map(x=>x.to)).size,sales:rows,source:'OpenSea 页面 Sale 活动样本；已排除 Mint、零地址及同地址买卖，未逐笔核验链上回执或排除关联钱包刷量'};
}
export function collection(objects,slug){
  const pieces=[];
  walk(objects,x=>{if(x.__typename==='Collection'&&x.slug===slug)pieces.push(x);});
  const c=pieces.find(x=>x.stats&&x.drop&&x.address) ?? pieces.find(x=>x.stats&&x.address);
  if(!c)throw new Error('未读到完整系列数据');
  const descriptions=[];
  walk(c.content,x=>{for(const k of ['answer','description'])if(typeof x[k]==='string')descriptions.push(x[k]);});
  return {
    slug,name:c.name,chain:c.chain?.identifier,address:c.address,
    url:`https://opensea.io/collection/${encodeURIComponent(slug)}/overview`,
    floor:money(c.floorPrice?.pricePerItem),topOffer:money(c.topOffer?.pricePerItem),
    volume24h:money(c.stats.oneDay?.volume),volume1h:money(c.stats.oneHour?.volume),
    owners:c.stats.ownerCount??null,listed:c.stats.listedItemCount??null,supply:c.stats.totalSupply??null,
    creatorFeeBps:Number.isFinite(c.fees?.totalCreatorFee?.feeBasisPoints)&&c.fees.totalCreatorFee.feeBasisPoints>=0&&c.fees.totalCreatorFee.feeBasisPoints<=10000?c.fees.totalCreatorFee.feeBasisPoints:null,
    creatorFeeRequired:c.fees?.totalCreatorFee?.isRequired??null,
    floorChange24h:c.stats.oneDay?.floorPriceChange??null,
    verified:c.isVerified===true,
    disabled:c.enforcement?.isDisabled===true||c.enforcement?.isCompromised===true||c.enforcement?.isOwnershipDisputed===true,
    dropType:c.drop?.type??null,dropDisabled:c.drop?.disabledReason??null,
    extraCostNotice:descriptions.some(s=>/pay gas,? plus|pass-through cost|additional fee|reveal fee/i.test(s)),
    secondarySales24h:null,saleEvidence:saleEvidence(objects,slug),marketSource:'OpenSea 公开页面',marketCheckedUtc:new Date().toISOString()
  };
}
export function applyStats(row,stats) {
  const day=stats.intervals?.find(i=>i.interval==='one_day');
  const t=stats.total;
  if(t&&Number.isFinite(t.floor_price)&&t.floor_price>=0&&typeof t.floor_price_symbol==='string')row.floor={value:t.floor_price,symbol:t.floor_price_symbol};
  if(day&&Number.isFinite(day.volume)&&day.volume>=0&&typeof day.volume_symbol==='string')row.volume24h={value:day.volume,symbol:day.volume_symbol};
  // Do not infer secondary-only sale counts from aggregate volume/mint metrics.
  row.marketSource='OpenSea 公开页面＋官方统计 API';
  return row;
}
// Public-page evidence is a price scenario, never a fillable order guarantee.
export function conservativeValuation(row,quote=null,now=Date.now()) {
 const samples=(row.saleEvidence?.sales??[]).filter(s=>{
  const time=Date.parse(s.eventTime),price=eth(s.price,quote);
  return time<=now&&time>=now-86400000&&price>0&&/^0x[0-9a-f]{64}$/i.test(s.transactionHash??'')&&/^0x[0-9a-f]{40}$/i.test(s.to??'')&&/^0x[0-9a-f]{40}$/i.test(s.from??'')&&s.to.toLowerCase()!==s.from.toLowerCase()&&!/^0x0+$/i.test(s.to)&&!/^0x0+$/i.test(s.from);
 });
 const buyers=new Map(),transactions=new Set();
 for(const s of samples){const key=s.to.toLowerCase();if(!buyers.has(key))buyers.set(key,[]);buyers.get(key).push(eth(s.price,quote));transactions.add(s.transactionHash.toLowerCase());}
 const median=a=>{a=[...a].sort((x,y)=>x-y);return (a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2;};
 // Each buyer contributes one median, so a bulk buyer cannot dominate the price.
 const prices=[...buyers.values()].map(median).sort((a,b)=>a-b);
 const lowerQuartile=prices.length?prices[Math.floor((prices.length-1)*.25)]:null;
 const fresh=samples.some(s=>Date.parse(s.eventTime)>=now-6*3600000);
 const supported=transactions.size>=3&&buyers.size>=2&&fresh;
 const floor=eth(row.floor,quote),offer=eth(row.topOffer,quote);
 const reference=supported&&floor>0?Math.min(floor,lowerQuartile*.8,...(offer>0?[offer]:[])):null;
 return {reference,topOfferEth:offer,lowerQuartileEth:lowerQuartile,independentTransactions:transactions.size,pricedBuyers:buyers.size,supported,
  reason:supported?null:'成交依据不足：需 24h 内至少 3 笔不同交易、2 个买家，且近 6h 有成交；不能仅凭挂单判定利润',
  floorDivergence:floor>0&&lowerQuartile>0&&floor>lowerQuartile*3};
}
export function assess(row,cfg,quote=null) {
  const reasons=[],warnings=['地板价是卖方挂单；最高报价未核验可成交性；未识别刷量'], floor=eth(row.floor,quote),volume=eth(row.volume24h,quote);
  const currencyConverted=(floor!==null&&!['ETH','WETH'].includes(row.floor?.symbol))||(volume!==null&&!['ETH','WETH'].includes(row.volume24h?.symbol));
  if(currencyConverted)warnings.push('按页面美元估值与 Coinbase ETH/USD 近似折算；未计兑换滑点或跨链成本');
  const chain=row.onchain;
  const salePrices=(row.saleEvidence?.sales??[]).map(s=>eth(s.price,quote)).filter(p=>p!==null&&p>0).sort((a,b)=>a-b);
  const median=salePrices.length?(salePrices[Math.floor((salePrices.length-1)/2)]+salePrices[Math.floor(salePrices.length/2)])/2:null;
  const conservative=cfg.valuationMode==='sales-conservative-v1';
  const valuation=conservativeValuation(row,quote);
  const requireSales=cfg.requireSecondarySales===true;
  const reference=conservative?valuation.reference:requireSales?(floor!==null&&median!==null?Math.min(floor,median):null):floor;
  const liquidityOK=!requireSales||((row.saleEvidence?.sampledSales24h??0)>=(cfg.minSecondarySales??3)&&(row.saleEvidence?.uniqueBuyers??0)>=(cfg.minUniqueBuyers??2)&&median!==null);
  let status='观察',margin=null,totalCost=null,ratio=null;
  let floorSaleFees=null,floorProfit=null,profitToCost=null,profitToFloor=null,feeRate=null;
  let estimatedProfit=null,estimatedSaleFees=null;
  if(Number.isFinite(row.creatorFeeBps)&&row.creatorFeeBps>=0&&row.creatorFeeBps+cfg.assumedMarketplaceFeeBps<10000)feeRate=(row.creatorFeeBps+cfg.assumedMarketplaceFeeBps)/10000;
  if(row.extraCostNotice)warnings.push('项目说明提到额外成本，未包含在 gas 估算中');
  if(row.creatorFeeBps===null)warnings.push('创作者费用未知');
  if(!row.verified)warnings.push('OpenSea 未认证');
  if(conservative)warnings.push('保守售价来自页面成交样本并折价，不是可成交承诺；最佳报价仅用于压低估值，未核验适用 NFT、余额或有效期');
  else if(!requireSales)warnings.push('成交样本只供参考，不作为筛选门槛；按地板价计算的利润不代表可实现收益');
  if(conservative&&valuation.floorDivergence)warnings.push('挂单价偏离成交：地板价超过买家等权成交低位价 3 倍');
  if(!chain||chain.error){status='待核验';reasons.push(chain?.error??'未完成链上核验');}
  else if(chain.state!=='active'){status=chain.state==='waiting'?'待开售':'排除';reasons.push(chain.message);}
  else if(row.disabled||row.dropDisabled){status='排除';reasons.push('平台标记异常或 Drop 被禁用');}
  else if(cfg.freeOnly&&chain.mintPriceEth!==0){status='排除';reasons.push('不是免费公售');}
  else if(chain.simulation!=='passed'||!Number.isFinite(chain.gasCapEth)||chain.gasCapEth<=0||!Number.isFinite(Number(chain.gasPriceWei))||Number(chain.gasPriceWei)<=0||!Number.isFinite(chain.mintPriceEth)||chain.mintPriceEth<0){status='待核验';reasons.push('mint 价格或 gas 模拟未通过、费用未知');}
  else {
    const gas=chain.gasCapEth;
    const exitCost=Number(chain.gasPriceWei)*cfg.assumedExitGasUnits/1e18;
    const acquisitionCost=chain.mintPriceEth+gas+exitCost;
    floorSaleFees=floor!==null&&feeRate!==null?floor*feeRate:null;
    totalCost=floorSaleFees!==null?acquisitionCost+floorSaleFees:null;
    if(totalCost!==null&&totalCost>0&&floor!==null&&floor>0){
      ratio=floor/totalCost;floorProfit=floor-totalCost;profitToCost=floorProfit/totalCost;profitToFloor=floorProfit/floor;
    }
    if(conservative){
      estimatedSaleFees=reference!==null&&feeRate!==null?reference*feeRate:null;
      totalCost=estimatedSaleFees!==null?acquisitionCost+estimatedSaleFees:null;
      estimatedProfit=totalCost!==null?reference-totalCost:null;
      profitToCost=totalCost>0?estimatedProfit/totalCost:null;
      ratio=totalCost>0?reference/totalCost:null;
      profitToFloor=floor>0&&estimatedProfit!==null?estimatedProfit/floor:null;
      if(!valuation.supported){status='待核验';reasons.push(valuation.reason);}
      if(feeRate===null||row.extraCostNotice)status='待核验';
    }
    if(reference!==null&&feeRate!==null)margin=reference*cfg.floorHaircut*(1-feeRate)-acquisitionCost;
    if(cfg.maxGasEth!==null&&gas>cfg.maxGasEth)reasons.push('mint gas 高于上限');
    if(floor===null||floor<=0)reasons.push('地板价缺失、为零或币种未换算');
    else if(floor<cfg.minFloorEth)reasons.push('地板价低于门槛');
    if(cfg.minVolume24hEth>0&&(volume===null||volume<cfg.minVolume24hEth))reasons.push('24 小时成交量不足或币种未核验');
    if(cfg.profitMetric){
      const metric={floorToCost:ratio,profitToCost,profitToFloor}[cfg.profitMetric];
      const label=conservative?'保守售价情景净利润／总成本':{floorToCost:'地板价／总成本',profitToCost:'地板价情景净利润／总成本',profitToFloor:'地板价情景净利润／地板价'}[cfg.profitMetric];
      if(metric===null||metric<cfg.profitMultiple)reasons.push(label+'未达到 '+cfg.profitMultiple+' 倍，或费用未知');
    }else{
      if(ratio===null||ratio<cfg.minFloorToCost)reasons.push('地板价／假设总成本倍数不足');
      if(margin===null||margin<cfg.minMarginEth)reasons.push('折价后的假设价差不足或费用未知');
    }
    if(row.extraCostNotice)reasons.push('存在未计入的额外费用，需人工核实');
    if(!liquidityOK)reasons.push('近期二级成交样本不足（至少 '+(cfg.minSecondarySales??3)+' 笔、'+(cfg.minUniqueBuyers??2)+' 个不同买家），不能只凭地板价推荐');
    if(!reasons.length)status='优先复核';
  }
  // Profit threshold requires a valid gas estimate; waiting drops are listed but
  // cannot trigger a qualifying-opportunity alert before simulation is possible.
  const upcomingPromising=!conservative&&!cfg.profitMetric&&status==='待开售'&&liquidityOK&&floor>=cfg.minFloorEth&&volume>=cfg.minVolume24hEth&&reference>0&&row.creatorFeeBps!==null&&!row.extraCostNotice&&!row.disabled&&!row.dropDisabled&&(!cfg.freeOnly||chain?.mintPriceEth===0);
  return {...row,status,reasons,warnings,upcomingPromising,valuationMode:cfg.valuationMode,valuation,estimatedProfitEth:conservative?estimatedProfit:floorProfit,estimatedSaleFeesEth:estimatedSaleFees,topOfferEth:valuation.topOfferEth,referencePriceEth:reference,sampledMedianSaleEth:median,currencyConverted,floorEth:floor,volume24hEth:volume,totalCostEth:totalCost,floorSaleFeesEth:floorSaleFees,floorProfitEth:floorProfit,profitToCost,profitToFloor,scenarioMarginEth:margin,floorToCost:ratio};
}
