# Nexus Terminal v3.3

加密货币 **实时监测 + 因子关系终端**。纯前端单页应用，无后端、无构建步骤。整站托管在 **Cloudflare**（前端 Workers Assets + 数据代理 Worker），并绑定自定义域名。

> **数据源全部经 Cloudflare Worker 代理**：浏览器只与 `nexus-api.uichain.org` 通信，由 Worker 从边缘节点抓取真实 API 并加 CORS 头。这样解决两件事——① 中国大陆无法直连 Binance/CoinGecko 等（Binance 在中国被封禁）；② 浏览器跨域（CORS）。**已实测从 Cloudflare 边缘可稳定拉取** Bybit / CoinPaprika / DefiLlama / blockchain.info / alternative.me / mempool.space / NY Fed / U.S. Treasury / Stooq。

> 部署形态：**纯 Cloudflare 单一出口**——前端（Workers Assets）+ 数据代理 Worker，均经 `workers_routes` 自动绑定到 `uichain.org`，无需手动配置 DNS。GitHub 仅作为**源码仓库**，不再对外提供 Pages 站点。
>
> - 前端（Cloudflare Worker + Assets / 自定义域名）：**https://nexus.uichain.org**
> - 数据代理 Worker（自定义域名）：**https://nexus-api.uichain.org**
> - 唯一对外入口：以上两个 `uichain.org` 子域（GitHub Pages 备用站已关停）
> - 源码仓库（仅存代码，不对外服务）：`https://github.com/leo-bone/nexus-terminal`

---

## 核心能力

| 模块 | 说明 | 数据源（均经 Worker 代理） |
|---|---|---|
| 实时行情 | BTC/ETH/SOL/BNB/XRP/ADA 价格、24h 涨跌、成交量 | Bybit Spot |
| K 线 + 技术指标 | Canvas 自绘 K 线（15m/1H/4H/1D），RSI / MACD / 布林 / ATR / MA 趋势 | Bybit Kline |
| 因子模型（**21 维**） | 情绪 / 资金费率 / 多空比 / 持仓 / 占比 / 稳定币 / 算力 / 链上活跃 / 美元指数 / 美债 / 黄金 / 标普 / VIX / **美联储利率 / 通胀预期 / 期限利差 / 原油 / 农业 / 地缘风险(代理)** / 技术面 / 动量 → 加权合成 **Nexus Score** | 多源 |
| **因子关系网络** | 力导向图 + Pearson 相关性矩阵，基于**日收益率 + 日期对齐**实时计算各因子与 BTC 的相关关系（绿=正相关，红=负相关，线宽=相关强度） | 多源 |
| 宏观 · 政策 · 通胀 · 大宗 | DXY / 美债10Y / 黄金 / 标普500 / VIX / WTI原油 / 农业 / **联邦基金利率 / 通胀预期 / 10Y-2Y 利差** | Stooq·Yahoo + NY Fed + 美财政部 |
| 链上数据 | 全网算力 / **日交易笔数** / 总市值 / BTC占比 / **稳定币市值** | mempool.space · blockchain.info · CoinPaprika · DefiLlama |
| 衍生品 | 资金费率 / 持仓量 / 多空比 | Bybit Linear / Open-Interest / Account-Ratio |
| 量化回测 | 均线交叉 / RSI 反转 / 突破，输出收益、夏普、回撤、胜率、净值曲线 | 本地计算 |
| 模拟交易 | 按现价开仓，localStorage 本地保存，浮动盈亏 | 本地 |

---

## v3.3 变更（本次）

1. **新增 6 个因子**：美联储利率（NY Fed EFFR，日频真实政策利率）、通胀预期（10Y 名义−实际，市场隐含）、期限利差（10Y-2Y）、WTI 原油、农业 ETF、地缘风险（VIX+黄金+原油 代理合成）。
2. **宏观因子改用滚动 Z-Score**：取代原先人工设定的静态中枢（会随时间失真）。
3. **修复两个空转因子**：稳定币占比（DefiLlama 稳定币总市值 ÷ 全市场市值）、链上活跃（blockchain.info 日交易笔数）。
4. **相关性方法论升级**：从「价格水位 + 按序对齐」改为「**日收益率 + 日期对齐**」，消除跨频伪相关。
5. **数据源新增**：NY Fed（EFFR）、美国财政部（名义/实际收益率曲线）；OI / 多空比 / 算力改为**日频长历史**（200 / 200 / 365 点），使其能参与日收益相关性。

> 关于 CPI / PCE：官方月频数据源（BLS / FRED）**从 Cloudflare 边缘被 WAF 拦截**（BLS 403 / FRED 520，实测），故通胀维度改用「10Y 名义收益率 − 10Y 实际收益率」= **市场隐含通胀预期**（日频、前瞻），对交易更实用。

---

## 本地运行

```bash
cd nexus-terminal      # 含 index.html / app.js
python3 -m http.server 8899
# 浏览器打开 http://localhost:8899
```

也可直接双击 `index.html`（file:// 协议，数据走远程 API）。

---

## 部署（Cloudflare Workers 整站）

整站由两个 Cloudflare Worker 组成，均通过 `routes.custom_domain` 绑定到 `uichain.org`（无需手动 DNS）。

### 1) 部署前端（Workers Assets 托管静态文件）

```bash
cd frontend
wrangler deploy          # 自动上传 public/ 并把 nexus.uichain.org 绑为自定义域
```

`frontend/wrangler.toml`：

```toml
name = "nexus-frontend"
main = "worker.js"
assets = { directory = "./public" }
routes = [{ pattern = "nexus.uichain.org", custom_domain = true }]
```

### 2) 部署数据 Worker（快照 + 代理）

```bash
cd worker
wrangler deploy          # nexus-api.uichain.org 自动绑定
```

`worker/worker.js` 暴露：

- `/api/snapshot` —— 宏观/政策/通胀/大宗序列（DXY·US10Y·GOLD·SPX·VIX·OIL·AGRI·EFFR·UST2Y·T10Y2Y·REAL10Y·BEI10，含日期），Stooq/Yahoo 主源 + NY Fed + 美财政部
- `/api/fetch?url=<encoded>` —— 通用代理（白名单：Bybit / CoinPaprika / CoinGecko / alternative.me / mempool.space / DefiLlama / blockchain.info），带 CORS 头；限流源做 10 分钟边缘缓存
- `/api/probe` —— 数据源可达性诊断（临时调试）

`app.js` 顶部 `CONFIG.PROXY` 指向：

```js
const CONFIG = { PROXY: 'https://nexus-api.uichain.org', ... }
```

若换域名，只需同步修改这一行并重新部署前端 Worker。

### 4) 源码同步到 GitHub（本机 git 因 xcrun 损坏，走 REST API）

项目根目录的 `push_to_github.py` 用 **GitHub REST API（git-database）** 整体推送，不依赖本地 git：

```bash
python3 push_to_github.py      # 全量刷新 main 分支（force 覆盖整棵树，GitHub 仅作源码镜像）
```

脚本会自动跳过 `.workbuddy / .git / node_modules / .wrangler` 与根目录 `public/`（旧 GitHub Pages 构建产物，已废弃；真正的静态资源在 `frontend/public/`）。Cloudflare 凭据走本机 `~/.wrangler/config/default.toml` 的 OAuth token。

---

## 文件结构

```
nexus-terminal/
├── index.html        # 前端页面（结构 + 样式）
├── app.js            # 全部前端逻辑（数据/指标/图表/因子/网络/回测/模拟）
├── frontend/         # 前端 Cloudflare Worker（Workers Assets 托管静态文件）
│   ├── worker.js     # 静态资源 Worker（passthrough 到 ASSETS）
│   ├── wrangler.toml # 绑定 nexus.uichain.org 自定义域
│   └── public/       # 静态资源（index.html / app.js / nexus*.html）
├── worker/           # 数据代理 Cloudflare Worker（白名单代理 + 宏观 Stooq/Yahoo + 边缘缓存）
│   ├── worker.js     # /api/snapshot + /api/fetch + /api/probe（CORS 代理）
│   └── wrangler.toml # 绑定 nexus-api.uichain.org 自定义域
├── nexus.html        # v1 历史版本（保留）
├── nexus_v2.html     # v2 历史版本（保留）
└── README.md
```

---

## 免责声明

本工具仅供研究与教育使用，**不构成任何投资建议**。加密资产波动剧烈、衍生品杠杆风险极高，请独立判断并自担风险。
