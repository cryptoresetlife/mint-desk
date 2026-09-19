// Shared by the browser and tests. These are discovery heuristics, not profit estimates.
function earlyOpportunity(row,now=Date.now()){
 const a=row.activity,checked=Date.parse(row.checkedUtc),start=Number(row.startTime)*1000,end=Number(row.endTime)*1000;
 const fresh=Number.isFinite(checked)&&checked<=now+2000&&now-checked<=90000&&!row.error;
 const available=fresh&&Number(row.remaining)>0&&Number(row.walletLimit)>0;
 const soon=available&&row.status==='待开售'&&start>now&&start-now<=3600000&&end>start;
 const activityFresh=a&&Number.isFinite(Date.parse(a.sampledAtUtc))&&now-Date.parse(a.sampledAtUtc)<=15000&&Date.parse(a.sampledAtUtc)<=now+2000;
 const active=available&&row.status==='公售开放'&&start<=now&&end>now;
 const concentrated=!!a&&(a.topWalletShare>.5||a.topPayerShare>.5);
 const accelerating=!!a&&a.transactions1m>=Math.max(3,a.previousPerMinute*2);
 const hot=active&&activityFresh&&a.healthy===true&&a.complete===true&&a.wallets5m>=8&&a.wallets1m>=3&&accelerating&&!concentrated;
 return {soon,hot,concentrated,secondsToStart:soon?Math.ceil((start-now)/1000):null,secondsToEnd:active?Math.max(0,Math.ceil((end-now)/1000)):null,reason:hot?'近 5 分钟至少 8 个接收地址，近 1 分钟至少 3 个地址、3 笔交易；交易速度至少为前 4 分钟均速的 2 倍；单地址及单付款人占比均不超过 50%。':soon?'未来 1 小时内公售，价格、限购和剩余供应已读取；尚未验证盈利。':!a?'等待新版实时采样。':!a.healthy||!activityFresh?'监听或采样暂不完整，等待恢复。':!a.complete?'收集连续 5 分钟样本后判断升温。':concentrated?'少数接收地址或同一付款人集中 mint，保留在原始发现。':'参与数量或加速度尚未达到早期升温门槛。'};
}
if(typeof module!=='undefined')module.exports={earlyOpportunity};
