import {Interface,formatEther} from 'ethers';
import {randomBytes} from 'node:crypto';
const SEA='0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',FEE='0x0000a26b00c1F0DF003000390027140000fAa719';
const abi=new Interface([
 'function getPublicDrop(address) view returns(tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))',
 'function getFeeRecipientIsAllowed(address,address) view returns(bool)',
 'function mintPublic(address,address,address,uint256) payable',
 'function getMintStats(address) view returns(uint256,uint256,uint256)'
]);
export const CHAINS={ethereum:{id:1,rpc:'https://ethereum-rpc.publicnode.com'},robinhood:{id:4663,rpc:'https://rpc.mainnet.chain.robinhood.com'}};
const ALLOWED=new Set(['eth_chainId','eth_getBlockByNumber','eth_call','eth_gasPrice','eth_estimateGas']);
export async function rpc(url,method,params=[]){
 if(!ALLOWED.has(method))throw new Error('扫描器禁止签名和发送交易');
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw new Error(`链上读取 HTTP ${r.status}`);
 const b=await r.json();if(b.error||b.result===undefined)throw new Error(`${method} 未成功（不代表 gas 为零）`);return b.result;
}
export async function inspect(row,readRpc=rpc){
 const network=CHAINS[row.chain];if(!network)throw new Error('暂未支持的链');
 if(row.dropType!=='SEADROP_V1_ERC721')throw new Error('非标准 SeaDrop ERC721，需独立检查');
 if(!/^0x[0-9a-f]{40}$/i.test(row.address))throw new Error('缺少有效合约地址');
 const send=(m,p)=>readRpc(network.rpc,m,p);
 if(Number(BigInt(await send('eth_chainId')))!==network.id)throw new Error('RPC 链错误');
 const block=await send('eth_getBlockByNumber',['latest',false]);
 const timestamp=Number(BigInt(block.timestamp));
 if(Math.abs(Date.now()/1000-timestamp)>90)throw new Error('RPC 区块过旧');
 const call=async(to,name,args)=>abi.decodeFunctionResult(name,await send('eth_call',[{to,data:abi.encodeFunctionData(name,args)},block.number]));
 const synthetic='0x'+randomBytes(20).toString('hex');
 const [drop,stats,fee]=await Promise.all([call(SEA,'getPublicDrop',[row.address]),call(row.address,'getMintStats',[synthetic]),call(SEA,'getFeeRecipientIsAllowed',[row.address,FEE])]);
 const d=drop[0],start=Number(d.startTime),end=Number(d.endTime);
 let state='active',message=d.mintPrice===0n?'免费公售已开放':'付费公售已开放';
 if(stats[1]>=stats[2]){state='sold_out';message='已售罄';}
 else if(start<=0||end<=start||d.maxTotalMintableByWallet<1){state='unconfigured';message='公售未配置';}
 else if(timestamp<start){state='waiting';message='公售未开放，其他阶段可能消耗库存';}
 else if(timestamp>=end){state='ended';message='公售已结束';}
 else if(d.restrictFeeRecipients&&!fee[0]){state='fee';message='预设费用接收人不获准';}
 const result={state,message,startUtc:new Date(start*1000).toISOString(),endUtc:new Date(end*1000).toISOString(),block:String(BigInt(block.number)),chainUtc:new Date(timestamp*1000).toISOString(),mintPriceEth:Number(formatEther(d.mintPrice)),minted:String(stats[1]),maxSupply:String(stats[2]),remaining:String(stats[2]-stats[1]),walletLimit:Number(d.maxTotalMintableByWallet),simulation:'not_run',gasCapEth:null,gasPriceWei:null};
 if(state!=='active')return result;
 const tx={from:synthetic,to:SEA,data:abi.encodeFunctionData('mintPublic',[row.address,FEE,'0x'+'0'.repeat(40),1]),value:'0x'+d.mintPrice.toString(16)};
 try{
  const [estimate,price]=await Promise.all([send('eth_estimateGas',[tx,'latest',{[synthetic]:{balance:'0x'+(d.mintPrice+10n**18n).toString(16)}}]),send('eth_gasPrice')]);
  const gasLimit=(BigInt(estimate)*125n+99n)/100n,gasPrice=(BigInt(price)*120n+99n)/100n;
  if(gasLimit<=0n||gasPrice<=0n)throw new Error('gas 估计无效');
  result.simulation='passed';result.gasCapEth=Number(formatEther(gasLimit*gasPrice));result.gasPriceWei=String(gasPrice);result.gasLimit=String(gasLimit);
  result.simulationNote='随机地址＋虚拟余额的只读估算；未核验你的钱包资格和余额；未审计合约';
 }catch(e){result.simulation='failed';result.simulationNote=e.message;}
 return result;
}
