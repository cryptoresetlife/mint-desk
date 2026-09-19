import {Interface,ZeroAddress,formatEther,keccak256} from 'ethers';
import {SEA,CHAINS,sea,nft,requireThat} from './lib.mjs';
const events=new Interface(['event SeaDropMint(address indexed nftContract,address indexed minter,address indexed feeRecipient,address payer,uint256 quantityMinted,uint256 unitMintPrice,uint256 feeBps,uint256 dropStageIndex)']);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hashOK=h=>typeof h==='string'&&/^0x[0-9a-f]{64}$/i.test(h);
const chainName=id=>id===4663?'robinhood':'ethereum';
// Only a direct, successful, known SeaDrop public mint has unambiguous native payment attribution.
export function verifiedMintCost(n,tx,r){
 requireThat(n.standard==='erc721','目前自动核算支持 SeaDrop ERC-721 mint；其他类型请填写实际成本。');
 requireThat(hashOK(tx?.hash)&&same(tx.hash,r?.transactionHash)&&r.status==='0x1'&&same(tx.blockHash,r.blockHash)&&tx.blockNumber===r.blockNumber,'mint 交易或成功回执未匹配。');
 requireThat(Number(BigInt(tx.chainId))===n.chainId&&same(tx.to,SEA)&&same(r.to,SEA),'该交易不是支持的 SeaDrop mint，无法自动归属费用。');
 requireThat(same(tx.from,n.owner)&&same(r.from,n.owner),'mint 不是由当前钱包付款，不能作为本钱包成本。');
 let call;try{call=sea.parseTransaction({data:tx.input,value:tx.value});}catch{}
 requireThat(call?.name==='mintPublic'&&same(call.args[0],n.contract)&&(same(call.args[2],ZeroAddress)||same(call.args[2],n.owner)),'交易不是当前钱包、当前系列的公开 mint。');
 const q=call.args[3];requireThat(q>0n&&q<=10000n,'mint 数量无法可靠核验。');
 const minted=[],drops=[];
 for(const log of r.logs??[]){
  requireThat(!log.removed&&same(log.transactionHash,tx.hash)&&same(log.blockHash,r.blockHash),'回执日志不完整或已重组。');
  if(same(log.address,n.contract)){let e;try{e=nft.parseLog(log);}catch{}if(e?.name==='Transfer'){
   requireThat(same(e.args[0],ZeroAddress)&&same(e.args[1],n.owner),'该交易包含额外 NFT 转移，不能直接分摊 mint 成本。');minted.push(e.args[2].toString());
  }}
  if(same(log.address,SEA)){let e;try{e=events.parseLog(log);}catch{}if(e?.name==='SeaDropMint')drops.push(e.args);}
 }
 requireThat(BigInt(minted.length)===q&&new Set(minted).size===minted.length&&minted.includes(n.tokenId)&&drops.length===1,'mint 数量、Token ID 或铸造事件未匹配。');
 const d=drops[0],paid=BigInt(tx.value);
 requireThat(same(d.nftContract,n.contract)&&same(d.minter,n.owner)&&same(d.payer,n.owner)&&same(d.feeRecipient,call.args[1])&&d.quantityMinted===q&&d.unitMintPrice*q===paid&&d.dropStageIndex===0n,'实付金额与 SeaDrop 铸造事件未匹配。');
 requireThat(/^0x[0-9a-f]+$/i.test(r.gasUsed)&&/^0x[0-9a-f]+$/i.test(r.effectiveGasPrice),'回执缺少实际 gas 数据。');
 const gas=BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice);requireThat(gas>0n,'回执 gas 数据无效。');
 return {source:'chain-mint',symbol:'ETH',totalCostEth:formatEther((paid+q-1n)/q+(gas+q-1n)/q),paid:formatEther((paid+q-1n)/q),gasEth:formatEther((gas+q-1n)/q),hash:tx.hash,quantity:Number(q),totalPaidEth:formatEther(paid),totalGasEth:formatEther(gas),checkedAt:Date.now()};
}
export async function lookupMintCost(n,rpc,api,transactionHash=''){
 requireThat(CHAINS[n.chainId]&&Number(BigInt(await rpc.send('eth_chainId')))===n.chainId,'RPC 网络与 NFT 不一致。');
 requireThat(n.standard==='erc721','目前自动核算支持 SeaDrop ERC-721 mint；其他类型请手填成本。');
 requireThat(!transactionHash||hashOK(transactionHash),'交易哈希应为 0x 开头的 66 位字符。');
 const endpoint=`events/chain/${chainName(n.chainId)}/contract/${n.contract}/nfts/${n.tokenId}`;
 if(!transactionHash){
  const page=await api.request(endpoint+'?event_type=mint&limit=50');
  requireThat(Array.isArray(page.asset_events),'mint 历史返回格式异常。');
  const hashes=[...new Set(page.asset_events.filter(e=>(e.event_type==='mint'||e.transfer_type==='mint')&&e.chain===chainName(n.chainId)&&same(e.nft?.contract,n.contract)&&String(e.nft?.identifier)===n.tokenId&&same(e.to_address,n.owner)&&hashOK(e.transaction)).map(e=>e.transaction))];
  requireThat(!page.next&&hashes.length===1,hashes.length?'mint 历史不唯一或分页未完整，请提供交易哈希核验。':'尚未查到本钱包的 mint 记录；可能是买入、转入或索引未收录。可提供 mint 交易哈希核验。');transactionHash=hashes[0];
 }
 const [tx,r]=await Promise.all([rpc.send('eth_getTransactionByHash',[transactionHash]),rpc.send('eth_getTransactionReceipt',[transactionHash])]);
 requireThat(same(tx?.hash,transactionHash),'RPC 未返回对应的 mint 交易。');
 const cost=verifiedMintCost(n,tx,r);
 const [block,code,owner]=await Promise.all([rpc.send('eth_getBlockByNumber',[r.blockNumber,false]),rpc.send('eth_getCode',[SEA,'latest']),rpc.send('eth_call',[{to:n.contract,data:new Interface(['function ownerOf(uint256) view returns(address)']).encodeFunctionData('ownerOf',[n.tokenId])},'latest'])]);
 requireThat(same(block?.hash,r.blockHash)&&keccak256(code)===CHAINS[n.chainId].seaHash,'交易区块或当前 SeaDrop 合约版本未能核验。');
 requireThat(/^0x[0-9a-f]{64}$/i.test(owner)&&same('0x'+owner.slice(-40),n.owner),'当前钱包未持有该 NFT。');
 // Index hints cannot prove a complete ownership history. Flag known re-acquisitions and incomplete responses.
 cost.historyOnly=true;
 try{const p=await api.request(endpoint+'?event_type=transfer&limit=50');
  if(Array.isArray(p.asset_events)&&!p.next){cost.historyOnly=p.asset_events.some(e=>same(e.nft?.contract,n.contract)&&String(e.nft?.identifier)===n.tokenId&&same(e.from_address,n.owner)&&!same(e.to_address,n.owner)&&e.transfer_type!=='mint');}
 }catch{}
 cost.historyNote=cost.historyOnly?'历史 mint 支出已核验；转手记录不完整或有转出，请确认当前持仓成本后手动保存。':'历史 mint 支出已核验；OpenSea 索引未发现转出，未覆盖索引遗漏及链外费用。';
 return cost;
}
