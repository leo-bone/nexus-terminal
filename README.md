# Nexus Terminal v3

加密货币 **实时监测 + 因子关系终端**。纯前端单页应用，无后端、无构建步骤。整站托管在 **Cloudflare**（前端 Workers Assets + 数据代理 Worker），并绑定自定义域名。

> **数据源全部经 Cloudflare Worker 代理**：浏览器只与 `nexus-api.uichain.org` 通信，由 Worker 从边缘节点抓取真实 API 并加 CORS 头。这样解决两件事——① 中国大陆无法直连 Binance/CoinGecko 等（Binance 在中国被封禁）；② 浏览器跨域（CORS）。**已实测从 Cloudflare 边缘可稳定拉取** Bybit / CoinPaprika / alternative.me / mempool.space / Stooq。

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
| 因子模型（20 维） | 情绪 / 资金费率 / 多空比 / 持仓 / 占比 / 稳定币 / 算力 / 链上活跃 / 美元指数 / 美债 / 黄金 / 标普 / VIX / 技术面 / 动量 → 加权合成 **Nexus Score** | 多源 |
| **因子关系网络** | 力导向图 + Pearson 相关性矩阵，**实时计算各因子与 BTC 的相关关系**（绿=正相关，红=负相关，线宽=相关强度） | 多源 |
| 宏观仪表盘 | DXY / 美债10Y / 黄金 / 标普500 / VIX 实时卡片 | Worker → Stooq（Yahoo 兜底） |
| 链上数据 | 全网算力（日交易数/流通量降级为中性） | mempool.space（算力）/ CoinPaprika（总市值、BTC 占比） |
| 衍生品 | 资金费率 / 持仓量 / 多空比 | Bybit Linear / Open-Interest / Account-Ratio |
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

### 2) 部署宏观数据 Worker

```bash
cd worker
wrangler deploy          # nexus-api.uichain.org 自动绑定
```

### 3) 数据代理 Worker（行情/ K线/ 衍生品/ 全球市值/ F&G/ 算力 + 宏观）

`worker/worker.js` 暴露：

- `/api/snapshot` —— 宏观序列（DXY/US10Y/黄金/标普/VIX），Stooq 主源 + Yahoo 兜底
- `/api/fetch?url=<encoded>` —— 通用代理（白名单：Bybit / CoinPaprika / alternative.me / mempool.space），带 CORS 头；CoinGecko 等限流源做 10 分钟边缘缓存

```bash
cd worker
wrangler deploy          # nexus-api.uichain.org 自动绑定
```

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
│   ├── worker.js     # /api/snapshot + /api/fetch（带 CORS 的通用代理）
│   └── wrangler.toml # 绑定 nexus-api.uichain.org 自定义域
├── nexus.html        # v1 历史版本（保留）
├── nexus_v2.html     # v2 历史版本（保留）
└── README.md
```

---

## 免责声明

本工具仅供研究与教育使用，**不构成任何投资建议**。加密资产波动剧烈、衍生品杠杆风险极高，请独立判断并自担风险。
