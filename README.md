# Nexus Terminal

加密货币实时监控与量化分析仪表盘（单文件 HTML，无需后端）。

## 功能特性

- **实时行情** — BTC/ETH/SOL/BNB 等主流币种价格（CryptoCompare API）
- **K线图表** — Canvas 自绘，支持 1H / 4H / 1D 周期切换，数据源：CryptoCompare → Binance → 本地合成兜底
- **技术指标面板（TA）**
  - MA Cross（EMA 快慢线交叉）
  - RSI（14日相对强弱）
  - Bollinger Bands（布林带）
  - MACD（指数平滑异同移动平均线）
  - TSMOM（时间序列动量）
  - Mean Reversion（均值回归 Z-Score）
  - Vol Breakout（ATR 波动率突破）
  - Seasonal Calendar（季节性效应）
- **量化回测（QT）** — 任意策略历史回测，含夏普比率、最大回撤、胜率、盈亏比、月度收益热力图
- **模拟交易（PT）** — 实时 Paper Trading，支持开仓/平仓/止损，信号自动推送
- **12维市场因子模型** — 政治/经济/战争/利率/技术/情绪/热点/链上/机构/巨鲸/天气/节日
- **情绪指数** — Fear & Greed 实时数据

## 运行方式

### 本地（推荐）

```bash
cd /path/to/nexus-terminal
python3 -m http.server 8899
# 浏览器打开 http://localhost:8899
```

### 直接打开

双击 `nexus.html` 即可在浏览器中运行（使用 file:// 协议，K线数据走 API 远程获取）。

## 技术架构

- **纯前端** — 单 HTML 文件，无框架依赖
- **Canvas 绘图** — 自研 K 线渲染引擎，零外部依赖
- **API 数据源** — CryptoCompare（主）→ Binance（备）→ 合成数据（兜底）
- **本地存储** — localStorage 保存模拟交易状态

## 文件结构

```
nexus-terminal/
├── README.md        # 本文件
└── nexus.html       # 完整应用代码（单文件）
```

## 免责声明

本工具仅供教育与个人研究使用，不构成任何投资建议。加密货币市场波动剧烈，请自行承担风险。
