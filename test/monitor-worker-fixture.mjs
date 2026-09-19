// Offline-only transport for worker integration tests; no real API credentials.
globalThis.fetch=async(url,options={})=>{
 const u=String(url);
 if(u.startsWith('https://api.coinbase.com/'))return {ok:true,json:async()=>({data:{base:'ETH',currency:'USD',amount:'2000'}})};
 if(u.startsWith('https://opensea.io/'))return {ok:true,text:async()=>'<script>urql_transport.push({});</script>'};
 if(options.method==='POST'){
  const {method,params}=JSON.parse(options.body);const n=Math.floor(Date.now()/1000),height=params?.[0]==='latest'?100:Number(BigInt(params?.[0]||0));
  const result={eth_chainId:'0x1237',eth_getCode:'0x12345678901234',eth_getLogs:[],eth_getBlockByNumber:{number:'0x'+height.toString(16),timestamp:'0x'+(n-(100-height)*2).toString(16),hash:'0x'+'1'.repeat(64)}}[method];
  if(result===undefined)throw Error('Unexpected RPC method '+method);return {ok:true,json:async()=>({result})};
 }
 throw Error('Unexpected destination');
};
globalThis.WebSocket=class {constructor(){this.readyState=0;}close(){}send(){}};
await import('../monitor/worker.mjs');
