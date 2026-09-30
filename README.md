# Nexus Terminal v3

加密货币 **实时监测 + 因子关系终端**。纯前端单页应用，无后端、无构建步骤；同时配套一个 Cloudflare Worker 解决宏观数据的浏览器跨域（CORS）问题，并作为 GitHub Pages 的边缘加速层。

> 部署形态：**GitHub（托管静态前端）+ Cloudflare（Worker 代理宏观数据 / 可选自定义域名 CDN）**。

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

## 部署到 GitHub Pages + Cloudflare

### 1) 推送到 GitHub（本机 git 已损坏时，用仓库里的脚本走 GitHub REST API）

```bash
# 在本地有 gh 且已登录的情况下：
gh repo clone leo-bone/nexus-terminal
# 把 index.html / app.js / worker/ 复制进去后：
git add -A && git commit -m "Nexus Terminal v3" && git push
```

> 若 `git` 因 `xcrun` 损坏不可用，项目使用纯 REST API 推送（见历史方案 `push_to_github.py`），不依赖本地 git。

### 2) 开启 GitHub Pages

- 仓库 **Settings → Pages → Source** 选 `main` 分支、`/ (root)`，保存。
- 稍候即可访问：`https://leo-bone.github.io/nexus-terminal/`

（也可通过 API 开启：`gh api -X POST repos/leo-bone/nexus-terminal/pages -f source.branch=main -f source.path=/`）

### 3) 部署 Cloudflare Worker（解锁宏观数据 + 完整关系网络）

```bash
cd worker
npm i -g wrangler        # 或 npx wrangler
wrangler login
wrangler deploy
# 记下分配的 *.workers.dev 地址
```

部署后在 **`app.js` 顶部**把：

```js
const CONFIG = { PROXY: '', ... }
```

改成你的 Worker 地址：

```js
const CONFIG = { PROXY: 'https://nexus-proxy.<你的子域>.workers.dev', ... }
```

未配置时：宏观卡片显示「需 Worker」，因子关系网络仅在加密/链上/衍生品因子间计算相关性；配置后自动解锁宏观因子与全量相关性。

### 4) （可选）自定义域名经 Cloudflare 加速

1. 在 Cloudflare 添加你的域名，把 DNS 指向 GitHub Pages（`leo-bone.github.io`，用 CNAME 记录）。
2. 给该域名开启 **Orange-cloud（代理）**，即获得 Cloudflare CDN / SSL / 缓存。
3. 如需把 Worker 绑定到同一域名，在 `worker/wrangler.toml` 取消注释 `routes` 并填写自定义域名。

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
