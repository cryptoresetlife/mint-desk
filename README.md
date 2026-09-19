# Mint Desk V1.0

Windows 本地 NFT 监控、自动 mint、持仓查看与 OpenSea 批量上架工具。源码采用 MIT 许可证。

[下载 Windows 完整包](https://github.com/cryptoresetlife/mint-desk/releases/download/v1.0-desktop/Mint-Desk-Windows-V1.0-Desktop-Share.zip) · [发布记录](https://github.com/cryptoresetlife/mint-desk/releases) · [详细操作说明](docs/USER-GUIDE.md)

## 功能

- **机会监控**：Robinhood 的利润筛选、即将开售、早期升温与原始发现。免费、付费均包含；没有成交依据时不编造收益。
- **自动 mint**：Robinhood / Ethereum 上支持的 SeaDrop Public 阶段，免费或原生 ETH 付款。
- **多钱包、多项目**：最多 100 个钱包；多项目同时等待、提前准备，同钱包协调发送，不同钱包可并行。
- **我的 NFT**：查看导入钱包持仓，补充本软件成功 mint 的本地记录，查询地板与成交价，点击名称前往 OpenSea。
- **批量上架**：同一钱包每批 1–20 项，每项出售 1 个，按系列报价币种自填售价和期限；预览费用并确认后才提交。
- **本机运行**：用户填写自己的 RPC 和 OpenSea API Key，不使用 AI 额度；私钥仅保存在运行内存。

## 快速使用

桌面窗口、任务栏和托盘统一使用 M_ 图标。Windows 完整包包含独立窗口组件，需要已安装 Microsoft Edge WebView2 Runtime。关闭窗口会保留后台任务；彻底退出请使用软件内的“停止任务并退出软件”。项目的 OpenSea 链接在默认浏览器打开。

1. 下载完整 ZIP，完整解压后双击 **Mint Desk.exe**，无需另装 Node.js。
2. 在 **机会监控 → 监控设置 / API Key** 填写自己的 [OpenSea API Key](https://opensea.io/settings/developer) 和 RPC。
3. 在 **钱包管理** 导入自己的钱包私钥。
4. **自动 mint**：我的项目 → 添加 NFT → 设置数量、价格和 gas 上限 → 选择钱包 → 检查费用 → 核对并授权启动。
5. **上架 NFT**：我的 NFT → 刷新持仓 → 勾选 NFT → 批量上架 → 自填售价与期限 → 预览费用 → 核对并确认上架。
6. 在 **运行任务** 查看进度；退出请点击 **停止任务并退出软件**。关闭网页不会停止后台任务。

更新前先处理运行任务并退出旧软件，再打开新版、重新导入钱包。新解压包默认没有项目、钱包、RPC Key 或 OpenSea API Key；请保留旧文件夹的本机记录。不要分享使用过的文件夹。

## 多币种上架更新

此前 USDG 系列被 ETH-only 检查拦截的问题已修复。上架前先显示币种和代币地址，再让你填写售价，不沿用旧输入或自动换算。例如填写 20 USDG 就是 20 USDG；不能把 ETH 数字照搬。USDG 最多 6 位小数，费用与到账均按 USDG 计算，gas 单独用 ETH。已有 ETH 上架记录仍可识别。

## 支持范围

- mint 仅支持已适配的 SeaDrop 公开阶段；白名单、自定义合约和 ERC-20 支付暂不支持。
- 上架支持标准 ERC-721 / ERC-1155 的固定售价，自动识别系列指定的原生 ETH 或标准 ERC-20 报价币种（如 USDG、USDC、WETH），核验代币地址、符号和精度。售价与到账按该币种计算，授权 gas 另付 ETH。不同币种请分批上架，特殊交易区域仍需到 OpenSea 操作。
- ERC-721 优先授权单个 NFT；ERC-1155 必要时授权 OpenSea 指定通道操作该系列全部 NFT。授权不随挂单到期自动撤销，提交前会明确说明。
- 上架后需有人购买才有收入。地板挂单不是成交价；监控筛选及提前准备均不保证盈利或抢到。
- 已有有效挂单或未过期本地记录会阻止重复提交。不自动改价、撤单或重试不明订单；请到 OpenSea 核实和撤单。
- 停止任务不能撤回已广播交易或已提交订单。私钥不写入文件；RPC、API Key、公开交易记录保存在本机，内存不提供硬件级安全擦除保证。

## 从源码运行

安装 Node.js 22 或更新版本（完整包使用 Node.js 24）：

```sh
git clone https://github.com/cryptoresetlife/mint-desk.git
cd mint-desk
npm ci
npm start
```

打开本机地址 `http://127.0.0.1:8792/`。源码启动不依赖 Windows 启动器；不要与另一份软件占用同一端口。

```sh
npm test
```

本版 71 项测试通过，覆盖预算、签名目标、并发、停止、重复提交、上架费用及本机访问隔离。上架流程使用模拟测试；没有使用真实钱包进行测试授权或测试售卖。Robinhood 接口与持仓查询另做了真实只读检查。

## Windows 构建

启动器源码在 `launcher/MintDeskLauncher.cs`。在 Windows PowerShell 7 中运行：

```powershell
./scripts/build-launcher.ps1
# npm ci 后，传入从 Node.js 官方获取的 Windows 运行时目录
./scripts/package-windows.ps1 -RuntimeDirectory 'C:\node-runtime'
```

运行时目录需包含 `node.exe` 和官方 `LICENSE`（或 `NODE-LICENSE.txt`）。白名单打包排除所有本机 data 文件夹，输出至 dist。

## 源码结构

| 路径 | 用途 |
| --- | --- |
| server.mjs | 本机服务与接口 |
| engine.mjs / coordinator.mjs | 自动 mint 与同钱包发送协调 |
| nft-market.mjs | 持仓、授权预检、Seaport 上架订单 |
| monitor/ | 链上发现与行情扫描 |
| app/ | 网页界面 |
| test/ | 离线测试 |
| launcher/ / scripts/ | Windows 启动器、构建及打包 |

仓库不提交 data、monitor/data、用户配置、日志、依赖及运行时。测试钱包在测试时随机生成，不含用户私钥。

## 许可证

本项目源码使用 [MIT License](LICENSE)，版权归 cryptoresetlife。第三方依赖和 Node.js 保留各自许可证，见 [第三方说明](THIRD-PARTY-NOTICES.md)。
