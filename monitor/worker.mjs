import {parentPort,workerData} from 'node:worker_threads';
import {startEmbedded} from './scanner.mjs';
try {
 const service=await startEmbedded(workerData.config,workerData.storageRoot);
 const push=()=>parentPort.postMessage({type:'snapshot',value:service.snapshot()});
 push();const timer=setInterval(push,1500);
 parentPort.on('message',m=>{if(m.type==='scan')void service.scan();if(m.type==='stop'){clearInterval(timer);service.stop();parentPort.close();}});
}catch{parentPort.postMessage({type:'failure',message:'监控启动失败，请检查 Key、RPC 和本机配置。'});parentPort.close();}
