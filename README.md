# Nexus Terminal v3

加密货币 **实时监测 + 因子关系终端**。纯前端单页应用，无后端、无构建步骤；同时配套一个 Cloudflare Worker 解决宏观数据的浏览器跨域（CORS）问题。整站托管在 **Cloudflare**（Pages 静态前端 + Worker 边缘代理），并绑定自定义域名。

> 部署形态：**Cloudflare Pages（静态前端）+ Cloudflare Worker（宏观数据代理）**，自定义域名走 `uichain.org`。
>
> - 前端（Cloudflare Pages / 自定义域名）：**https://nexus.uichain.org**
> - 宏观数据 Worker（自定义域名）：**https://nexus-api.uichain.org**
> - GitHub 仓库（源码 + 历史版）：`https://github.com/leo-bone/nexus-terminal`
> - 备用前端（GitHub Pages）：`https://leo-bone.github.io/nexus-terminal/`

---

## 核心能力

| 模块 | 说明 | 数据源 |
|---|---|---|
| 实时行情 | BTC/ETH/SOL/BNB/XRP/ADA 价格、24h 涨跌、成交量 | Binance |
| K 线 + 技术指标 | Canvas 自绘 K 线（15m/1H/4H/1D），RSI / MACD / 布林 / ATR / MA 趋势 | Binance |
| 因子模型（20 维） | 情绪 / 资金费率 / 多空比 / 持仓 / 占比 / 稳定币 / 算力 / 链上活跃 / 美元指数 / 美债 / 黄金 / 标普 / VIX / 技术面 / 动量 → 加权合成 **Nexus Score** | 多源 |
| **因子关系网络** | 力导向图 + Pearson 相关性矩阵，**实时计算各因子与 BTC 的相关关系**（绿=正相关，红=负相关，线宽=相关强度） | 多源 |
| 宏观仪表盘 | DXY / 美债10Y / 黄金 / 标普500 / VIX 实时卡片 | Cloudflare Worker → Yahoo |
| 链上数据 | 全网算力 / 日交易笔数 / 总市值 / BTC 占比 / 稳定币市值 | CryptoCompare / CoinGecko |
| 衍生品 | 资金费率 / 持仓量 / 多空比 | Binance FAPI |
| 量化回测 | 均线交叉 / RSI 反转 / 突破，输出收益、夏普、回撤、胜率、净值曲线 | 本地计算 |
| 模拟交易 | 按现价开仓，localStorage 本地保存，浮动盈亏 | 本地 |

---

## 本地运行

```bash
cd nexus-terminal      # 含 index.html / app.js
python3 -m http.server 8899
# 浏览器打开 http://localhost:8899
```

也可直接双击 `index.html`（file:// 协议，数据走远程 API）。

---

## 部署（Cloudflare Pages + Worker）

### 1) 部署前端到 Cloudflare Pages

```bash
# 装 wrangler（隔离环境）
cd ~/.workbuddy/binaries/node/workspace && npm i wrangler
# 直接用 wrangler 上传静态目录（无需 GitHub App）
wrangler pages project create nexus-terminal --production-branch production
wrangler pages deploy public --project-name nexus-terminal --branch production
```

> 也可把 `index.html` / `app.js` / `nexus*.html` 直接推到 GitHub，再在 Cloudflare Pages 控制台用 GitHub 连接（本项目用 `public/` 目录直接上传）。

### 2) 绑定自定义域名（已做）

- 前端：`nexus.uichain.org` → Cloudflare Pages 项目 `nexus-terminal`（控制台或 API 添加自定义域，CF 自动建 CNAME + 代理）。
- Worker：在 `worker/wrangler.toml` 配置 `routes = [{ pattern = "nexus-api.uichain.org", custom_domain = true }]`，然后 `wrangler deploy`，CF 自动把 Worker 绑到该域名。

### 3) 部署 Cloudflare Worker（宏观数据 + 完整关系网络）

> ✅ **已部署并接入**：Worker `nexus-proxy` 已上线于 **https://nexus-api.uichain.org**，`app.js` 的 `CONFIG.PROXY` 已填写该地址，宏观仪表盘与全量因子相关性已自动解锁。以下为重新部署步骤。

```bash
cd worker
wrangler deploy
```

`app.js` 顶部 `CONFIG.PROXY` 指向：

```js
const CONFIG = { PROXY: 'https://nexus-api.uichain.org', ... }
```

若换域名，只需同步修改这一行并重新部署 Pages。未配置时：宏观卡片显示「需 Worker」，因子关系网络仅在加密/链上/衍生品因子间计算相关性；配置后自动解锁宏观因子与全量相关性。

### 4) 源码同步到 GitHub（本机 git 因 xcrun 损坏，走 REST API）

```bash
# 项目内 push_to_github.py 用 GitHub REST API（git-database）推送，不依赖本地 git
python3 push_to_github.py
```

---

## 文件结构

```
nexus-terminal/
├── index.html        # 前端页面（结构 + 样式）
├── app.js            # 全部前端逻辑（数据/指标/图表/因子/网络/回测/模拟）
├── worker/
│   ├── worker.js     # Cloudflare Worker：宏观数据代理 + 边缘缓存
│   └── wrangler.toml # Worker 部署配置
├── nexus.html        # v1 历史版本（保留）
├── nexus_v2.html     # v2 历史版本（保留）
└── README.md
```

---

## 免责声明

本工具仅供研究与教育使用，**不构成任何投资建议**。加密资产波动剧烈、衍生品杠杆风险极高，请独立判断并自担风险。
