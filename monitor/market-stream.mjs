import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const TYPES=['item_listed','item_sold','item_received_bid','collection_offer','trait_offer','item_cancelled','order_invalidate','order_revalidate'];
export class MarketStream {
 constructor(keyFile,onEvent=()=>{}){this.keyFile=keyFile;this.onEvent=onEvent;this.status='未配置 OpenSea API Key；页面行情扫描仍正常';this.events=[];this.slugs=new Set();this.joined=new Set();this.pending=new Set();this.backoff=1000;this.ref=0;this.stopped=false;this.key=null;}
 async start(){try{const c=JSON.parse(await readFile(this.keyFile,'utf8'));if(typeof c.apiKey==='string'&&c.apiKey.trim()){this.key=c.apiKey.trim();this.connect();}}catch{}this.timer=setInterval(()=>this.heartbeat(),25000);}
 async configure(key){
  if(typeof key!=='string'||key.length<10||key.length>512||/\s/.test(key))throw new Error('请输入有效的 OpenSea API Key（不是 RPC URL 或钱包私钥）');
  if(/^https?:/i.test(key)||/^(0x)?[0-9a-f]{64}$/i.test(key))throw new Error('这里仅接受 OpenSea API Key');
  const r=await fetch('https://api.opensea.io/api/v2/collections/rare-friends-genesis',{headers:{'x-api-key':key},signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw new Error('OpenSea 验证失败：HTTP '+r.status+'；尚未保存');
  await mkdir(path.dirname(this.keyFile),{recursive:true});await writeFile(this.keyFile,JSON.stringify({apiKey:key})+'\n',{mode:0o600});
  this.key=key;this.ws?.close();clearTimeout(this.retry);this.connect();
 }
 connect(){if(this.stopped||!this.key)return;this.status='连接 OpenSea 实时流中';this.joined.clear();this.pending.clear();
  const ws=new WebSocket('wss://stream-api.opensea.io/socket/websocket?token='+encodeURIComponent(this.key)+'&vsn=2.0.0');this.ws=ws;
  ws.onopen=()=>{if(this.ws!==ws)return;this.lastReply=Date.now();this.status='实时流已连接，正在订阅';this.backoff=1000;this.subscribe();};
  ws.onmessage=e=>{if(this.ws!==ws)return;try{
   const msg=JSON.parse(e.data);if(!Array.isArray(msg))return;const [,ref,topic,type,payload]=msg;
   if(type==='phx_reply'){this.lastReply=Date.now();if(topic?.startsWith('collection:')){const slug=topic.slice(11);this.pending.delete(slug);if(!this.slugs.has(slug)){this.joined.delete(slug);return;}if(payload?.status==='ok'){this.joined.add(slug);this.status='实时行情已连接';}else this.status='部分订阅被拒绝，页面扫描继续';}return;}
   if(!TYPES.includes(type))return;const slug=topic?.slice(11);if(!this.slugs.has(slug))return;
   const row={id:String(ref??'')+'-'+Date.now(),slug,type,time:new Date().toISOString(),eventTime:payload?.payload?.event_timestamp??null};this.events.unshift(row);this.events=this.events.slice(0,40);this.onEvent(row);
  }catch{}};
  ws.onerror=()=>{this.status='实时流连接异常，等待重连；页面扫描继续';ws.close();};
  ws.onclose=()=>{if(this.ws!==ws||this.stopped)return;this.status='实时流断开，等待重连；断线活动由页面扫描补核，无法保证完整补齐';this.joined.clear();this.pending.clear();clearTimeout(this.retry);this.retry=setTimeout(()=>this.connect(),this.backoff);this.backoff=Math.min(60000,this.backoff*2);};
 }
 updateSlugs(slugs){
  const next=new Set(slugs.filter(s=>/^[a-z0-9_-]+$/i.test(s)).slice(0,50));
  for(const slug of new Set([...this.joined,...this.pending]))if(!next.has(slug)){
   if(this.ws?.readyState===1)this.ws.send(JSON.stringify([null,String(++this.ref),'collection:'+slug,'phx_leave',{}]));
   this.joined.delete(slug);this.pending.delete(slug);
  }
  this.slugs=next;this.subscribe();
 }
 subscribe(){if(this.ws?.readyState!==1)return;for(const s of this.slugs){if(this.joined.has(s)||this.pending.has(s))continue;this.pending.add(s);const ref=String(++this.ref);this.ws.send(JSON.stringify([ref,ref,'collection:'+s,'phx_join',{event_types:TYPES}]));}}
 heartbeat(){if(this.ws?.readyState!==1)return;if(Date.now()-this.lastReply>60000){this.ws.close();return;}this.ws.send(JSON.stringify([null,String(++this.ref),'phoenix','heartbeat',{}]));}
 async resolve(address){if(!this.key)return null;const r=await fetch('https://api.opensea.io/api/v2/chain/robinhood/contract/'+address,{headers:{'x-api-key':this.key},signal:AbortSignal.timeout(8000)});if(!r.ok)return null;const b=await r.json();const slug=typeof b.collection==='string'?b.collection:b.collection?.slug;return /^[a-z0-9_-]+$/i.test(slug??'')?slug:null;}
 snapshot(){return {status:this.status,configured:!!this.key,subscriptions:this.joined.size,events:this.events,scope:'仅已识别系列的市场活动；不把事件价格直接作为利润估值。OpenSea 推送不保证完整交付，断线后用页面扫描重新核验。'};}
 stop(){this.stopped=true;clearTimeout(this.retry);clearInterval(this.timer);this.ws?.close();}
}
