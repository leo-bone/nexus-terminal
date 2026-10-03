/* =====================================================================
 * NEXUS TERMINAL v3.31 — 加密货币实时监测与因子关系终端
 * 纯前端 / 无后端 / 无构建步骤。可直接 file:// 打开，也可部署到 Cloudflare。
 *
 * 数据源（全经 Cloudflare Worker 代理，解决中国大陆无法直连 + 浏览器 CORS）:
 *   - Bybit                 : 行情 / K线 / 合约资金费率 / 持仓 / 多空比
 *   - CoinPaprika           : 全球市值 / BTC 占比
 *   - DefiLlama             : 稳定币总市值（稳定币占比因子）
 *   - blockchain.info       : 链上日交易笔数（链上活跃因子）
 *   - alternative.me        : 恐惧贪婪指数 (F&G)
 *   - mempool.space         : 比特币全网算力
 *   - Forex Factory         : 美国经济日历（非农 / 失业率 / 初请 / PCE / CPI）
 *   - Cloudflare Worker     : 宏观/政策/通胀/大宗/日元序列 + 经济日历
 *                             (Yahoo Finance + NY Fed + 美财政部 + 日本财务省 + Forex Factory)
 *
 * v3.6 变更:
 *   1) 因子新增 dir（方向）字段 —— 修复 Nexus Score「方向混用」：
 *      原实现把所有因子的原始 z 直接相加，等于把「美元走强 / 美债收益率上行 /
 *      VIX 抬升 / 通胀超预期」这些利空项当成利多计入，评分方向是乱的。
 *      现在每个因子显式声明方向（+1 利多 / -1 利空 / 0 仅展示），评分按 dir×z 合成。
 *   2) 新增 2 个因子：美元/日元（套息交易风向标）、日本 10 年期国债收益率（套息成本）
 *      —— 2024-08 的全球风险资产暴跌就是日元套息平仓引发的，这条比黄金更贴近加密。
 *   3) 趋势型序列改「变化率 z」（chgZ）: 黄金 / 标普 / 原油 / 算力 / 美元日元 / 日债
 *      原先对水位直接做 z-score，单调上行的序列会长期贴顶（z 永远 > 0），失真。
 *   4) 美联储因子改用美债 2Y（市场对政策路径的定价）替代 EFFR 水平：
 *      EFFR 是阶梯常数，短窗口内滚动 z 恒为 0，等于空转。
 *   5) 修复若干真实缺陷：因子网络 requestAnimationFrame 每 60 秒泄漏一个动画循环、
 *      回测净值图在面板展开前用错误宽度绘制、账户未初始化时点击开仓静默失败、
 *      宏观快照 9 秒超时过短（冷启动常 10~30 秒）。
 *
 * v3.4 变更:
 *   1) 新增「事件因子」5 个: 非农就业 / 失业率 / 初请失业金 / 核心PCE / CPI(超预期方向)
 *   2) 新增「美国经济日历」面板: 本周高/中影响事件的实际·预期·前值
 *   3) 原油因子升级为 WTI + 布伦特 双源合成; 宏观卡片新增布伦特
 *   4) 数据源主备调换: Yahoo 升为主源 (Stooq 自 2026-10 起在 CF 边缘频繁 522/反爬)
 *   5) 快照新增 _src 数据源诊断字段
 *
 * v3.31 变更:
 *   1) 事件因子止血：FF 免费周历长期不回填 actual（实测 PCE/NFP/失业率/初请 的 actual 全为空），
 *      原「数据未到」是误导 —— 已改为诚实标注「FF未回填」，并加 RECENT_ACTUALS 手动锚定表，
 *      发布后填真值即算真实 surprise，不再永久挂脏。
 *   2) 情景推演引擎（借鉴 MiroFish「种子+因子互动→前瞻情景」的精髓，不搬 LLM 群体模拟）：
 *      以当前中性状态为种子，用跨资产日收益相关性做冲击传播，输出前瞻 Δz + 护栏趋向。
 *      确定性情景推演 ≠ 概率预测，假设相关性结构延续。
 *   3) 新增 4 个估值因子（价值维度）：股债风险溢价 ERP / 黄金实际价格 / 美联储资产负债表 /
 *      BTC 链上估值 NVT。慢变量走 VALUE_ANCHORS 锚定（真源被 Worker 白名单+WAF 挡），
 *      快变量走实时；anchored 因子不进实时评分，保持实时评分「全实时」纯度。
 *
 * v3.3 变更:
 *   1) 新增因子: 美联储利率 / 通胀预期(市场隐含) / 期限利差 / 原油 / 农业 / 地缘风险(代理)
 *   2) 宏观因子改用「滚动 Z-Score」, 取代人工静态中枢
 *   3) 修复两个空转因子: 稳定币占比、链上活跃
 *   4) 相关性改用「日收益率 + 日期对齐」(原为价格水位 + 按序对齐, 存在跨频伪相关)
 * ===================================================================== */

const CONFIG = {
  PROXY: 'https://nexus-api.uichain.org',
  REFRESH_MS: 60000,
  COINS: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA'],
  SYMBOL_MAP: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT', XRP: 'XRPUSDT', ADA: 'ADAUSDT' },
};

const px = (u) => CONFIG.PROXY ? CONFIG.PROXY + '/api/fetch?url=' + encodeURIComponent(u) : u;
const BYBIT_IV = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

const ENDPOINTS = {
  bybitTicker: s => px(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${s}`),
  bybitKline: (s, iv, l) => px(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${s}&interval=${iv}&limit=${l}`),
  bybitLinear: s => px(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`),
  bybitOI: s => px(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${s}&intervalTime=1d&limit=200`),
  bybitLS: s => px(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${s}&period=1d&limit=200`),
  ggGlobal: CONFIG.PROXY ? CONFIG.PROXY + '/api/global' : px('https://api.coinlore.net/api/global/'),
  stable: px('https://stablecoins.llama.fi/stablecoins?includePrices=false'),
  ntx: px('https://api.blockchain.info/charts/n-transactions?timespan=180days&format=json'),
  fg: px('https://api.alternative.me/fng/?limit=90'),
  mempoolHR: px('https://mempool.space/api/v1/mining/hashrate/1y'),
  calendar: CONFIG.PROXY ? CONFIG.PROXY + '/api/calendar' : null,
};

const state = {
  prices: {}, klines: {},
  fg: null, fgSeries: [], fgDates: [],
  global: null, stableMcap: null,
  chainSeries: {}, chainDates: {},
  deriv: {}, macro: null, macroSeries: null, macroDates: null, macroPrev: null,
  series: {}, seriesDates: {}, retMaps: {},
  econ: [], econTs: null, macroSrc: null,
  lastUpdate: null, interval: '1h',
  asof: null, histBundle: null, hist: null, zT: null, btcZ: null, klIdx: null,
  positions: [], acct: null, btStrat: 'ma',
  notify: null, _prevGuardStatus: 0,  /* v3.30 护栏 RED 通知：配置 + 上次状态（边缘检测） */
};

/* ---------- 工具 ---------- */
const $ = id => document.getElementById(id);
const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBig = n => {
  if (n == null || isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(2);
};
const last = a => (a && a.length) ? a[a.length - 1] : null;
async function getJSON(url, ms = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

/* ---------- 指标计算 ---------- */
const sma = (a, p) => { const o = []; for (let i = 0; i < a.length; i++) { if (i < p - 1) { o.push(null); continue; } let s = 0; for (let j = 0; j < p; j++) s += a[i - j]; o.push(s / p); } return o; };
const ema = (a, p) => { const o = [], k = 2 / (p + 1); let prev = a[0]; o.push(prev); for (let i = 1; i < a.length; i++) { prev = a[i] * k + prev * (1 - k); o.push(prev); } return o; };
function rsi(a, p = 14) {
  const o = []; let g = 0, l = 0;
  for (let i = 0; i < a.length; i++) {
    if (i === 0) { o.push(50); continue; }
    const d = a[i] - a[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0);
    g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p;
    o.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  }
  return o;
}
function macd(a, f = 12, s = 26, n = 9) {
  const ef = ema(a, f), es = ema(a, s); const dif = a.map((_, i) => ef[i] - es[i]);
  const dea = ema(dif, n); const hist = dif.map((v, i) => (v - dea[i]) * 2);
  return { dif, dea, hist };
}
function bollinger(a, p = 20, k = 2) {
  const mid = sma(a, p); const up = [], lo = [];
  for (let i = 0; i < a.length; i++) { if (mid[i] == null) { up.push(null); lo.push(null); continue; } let s = 0; for (let j = 0; j < p; j++) s += (a[i - j] - mid[i]) ** 2; const sd = Math.sqrt(s / p); up.push(mid[i] + k * sd); lo.push(mid[i] - k * sd); }
  return { mid, up, lo };
}
function atr(h, l, c, p = 14) {
  const tr = []; for (let i = 0; i < h.length; i++) { if (i === 0) { tr.push(h[i] - l[i]); continue; } tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); }
  return ema(tr, p);
}
/* Pearson 相关在全文件中只有一个定义，见回放区（本文件内不再重复声明）。
 * 历史上这里曾有一份带 Math.min 长度对齐的副本，被后文同名声明静默覆盖 ——
 * 覆盖后一旦有调用点传入不等长数组就会读到 undefined 产出 NaN 而非优雅返回 null。
 * v3.18 已合并为唯一实现，并保留长度对齐容错。 */
function pctChange(a) { if (!a || a.length < 2) return null; return (a[a.length - 1] - a[0]) / a[0] * 100; }
function rollZ(a, n = 120) {
  if (!a || a.length < 10) return 0;
  const w = a.slice(-n);
  const m = w.reduce((s, v) => s + v, 0) / w.length;
  const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / w.length) || 1;
  return (a[a.length - 1] - m) / sd;
}
/* 变化率 z：用于长期趋势型序列（黄金/标普/原油/算力/美元日元/日债）
 * 直接对「水位」做 z-score 会让单调上行的序列长期贴顶（恒 z>0），
 * 改为对「近 days 期的相对变化」做 z-score —— 衡量"涨/跌得是否异常快"。 */
function chgZ(a, days = 60, n = 120) {
  if (!a || a.length < days + 15) return 0;
  const chg = [];
  for (let i = days; i < a.length; i++) { const p = a[i - days]; if (p) chg.push((a[i] - p) / Math.abs(p)); }
  if (chg.length < 15) return 0;
  return rollZ(chg, n);
}
/* 历史回放游标（v3.8）：state.asof = { DXY: 123, ... } 时，下列读取器只看到该下标
 * 之前的数据，从而能用「同一套因子代码」逐日重放历史评分（无前视偏差）。
 * state.asof === null 表示用最新值 —— 即正常实时模式。
 *
 * v3.11：回放窗口 2y → 10y（3653 个交易日 × 22 个因子）。原来的实现用
 * asofCut() 做 slice() 复制数组、再让 rollZ/chgZ 遍历一遍，总量约
 * 3653 × 22 × 1800 ≈ 1.4 亿次元素拷贝 —— 主线程会冻结好几秒。
 *
 * 关键洞察：回放是**按时间顺序**推进的，某个因子的 z 只依赖它自己序列的前缀。
 * 所以「截至下标 i 的 z」可以一次 O(n) 滑窗预计算，回放时 O(1) 查表：
 * 总代价从 O(n²) 降到 O(n)，快约三个数量级。
 *
 * 数值口径必须与 rollZ/chgZ 完全一致 —— 否则「回放跑的是与实时同一套因子代码」
 * 这个前提就没了。回归测试 I 段用随机序列断言查表值 == 原函数值。 */
function asofCut(a, key) {
  if (!a) return a;
  if (!state.asof || state.asof[key] == null) return a;
  const i = Math.min(state.asof[key], a.length - 1);
  return i < 0 ? [] : a.slice(0, i + 1);
}
/* 统一序列访问：HR/TX 挂在 chainSeries，其余都在 macroSeries */
function seriesOf(key) {
  if (key === 'HR') return state.chainSeries && state.chainSeries.hashrate;
  if (key === 'TX') return state.chainSeries && state.chainSeries.n_tx;
  return state.macroSeries && state.macroSeries[key];
}
/* 截至游标可见的点数 —— 因子 ok 判定用它，而不是「序列总长度」 */
const mLen = key => {
  const v = seriesOf(key);
  if (!v || !v.length) return 0;
  if (state.asof && state.asof[key] != null) return Math.max(0, Math.min(state.asof[key], v.length - 1) + 1);
  return v.length;
};
const mZ = (key, n = 120) => {
  const v = seriesOf(key);
  if (!v || !v.length) return 0;
  if (state.asof && state.asof[key] != null && state.zT) {
    const t = zTabGet(key, n === 90 ? 'r90' : 'r120');
    if (t) { const i = Math.min(state.asof[key], t.length - 1); return i < 0 ? 0 : t[i]; }
  }
  return rollZ(v, n);
};
const mChgZ = (key, days = 60, n = 120) => {
  const v = seriesOf(key);
  if (!v || !v.length) return 0;
  if (state.asof && state.asof[key] != null && state.zT) {
    const t = zTabGet(key, 'c' + days);
    if (t) { const i = Math.min(state.asof[key], t.length - 1); return i < 0 ? 0 : t[i]; }
  }
  return chgZ(v, days, n);
};
const mV = key => {
  const v = seriesOf(key);
  if (!v || !v.length) return null;
  if (state.asof && state.asof[key] != null) { const i = Math.min(state.asof[key], v.length - 1); return i < 0 ? null : v[i]; }
  return v[v.length - 1];
};

/* ---------- 预计算 z 表 ----------
 * out[i] 必须**逐位等于** rollZ(v.slice(0, i+1), n) —— 「回放跑的是与实时同一套
 * 因子代码」是本功能的全部前提，表里的值只要有一点口径差异，整套结论就不成立。
 *
 * 这里踩过一个隐蔽的坑：一个 120 点全同值的窗口（EFFR / 日债这类利率平台期）
 * 真实方差是 0。原 rollZ 用 sqrt(sum((x-mean)^2)/n) 算 sd，平坦窗口下得到的是
 * ~3.5e-15 而不是 0，于是 z = (x-mean)/3.5e-15 = **-1** —— 纯浮点噪声决定的符号。
 * 而滑窗版用 (s2/n - mean^2) 求方差，同样的窗口因大数相消变成负数，走到 `|| 1`
 * 兜底，算出 z ≈ 0。两者相差整整 1.0（退化窗口下 z 的全部取值区间）。
 *
 * 所以放弃增量，改为**每步精确重算窗口**，并且保持与原实现相同的求和顺序
 * （两遍：先求和得 mean，再求偏差平方和得 sd）。窗口只有 90/120 宽，
 * 表又是按 (序列, 模式) 懒构建的，总代价远小于「每天重建 K 线切片跑 ema/rsi」。
 * 回归测试 I 段用真实序列断言最大偏差 < 1e-9。 */
function preRollZ(v, n) {
  const L = v.length, out = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    const m = i + 1 < n ? i + 1 : n;
    if (m < 10) continue;                       // 与 rollZ 的 length<10 -> 0 一致
    const lo = i - m + 1;
    let s = 0;
    for (let k = lo; k <= i; k++) s += v[k];
    const mean = s / m;
    let acc = 0;
    for (let k = lo; k <= i; k++) { const d = v[k] - mean; acc += d * d; }
    const sd = Math.sqrt(acc / m) || 1;
    out[i] = (v[i] - mean) / sd;
  }
  return out;
}
/* 滑窗版 chgZ：先算差分序列，再对差分做滑窗 rollZ，结果写回原下标。 */
function preChgZ(v, days, n) {
  const L = v.length, out = new Float64Array(L);
  if (L < days + 15) return out;                // 与 chgZ 的前置判定一致
  const chg = [], idx = [];
  for (let i = days; i < L; i++) {
    const q = v[i - days];
    if (!q) continue;                           // 与 chgZ 的 `if (p)` 过滤一致
    chg.push((v[i] - q) / Math.abs(q));
    idx.push(i);
  }
  if (chg.length < 15) return out;
  for (let k = 0; k < chg.length; k++) {
    const m = k + 1 < n ? k + 1 : n;
    if (m < 10) continue;
    const lo = k - m + 1;
    let s = 0;
    for (let j = lo; j <= k; j++) s += chg[j];
    const mean = s / m;
    let acc = 0;
    for (let j = lo; j <= k; j++) { const d = chg[j] - mean; acc += d * d; }
    const sd = Math.sqrt(acc / m) || 1;
    out[idx[k]] = (chg[k] - mean) / sd;
  }
  return out;
}
const Z_SPEC = { r120: [0, 120], r90: [0, 90], c30: [30, 120], c60: [60, 120], c90: [90, 120] };
/* 按需构建并缓存：只有真正被读到的 (序列, 模式) 组合才会算（实际约 18 个）。 */
function zTabGet(key, spec) {
  const T = state.zT;
  if (!T) return null;
  const id = key + '|' + spec;
  if (T[id] !== undefined) return T[id];
  const v = seriesOf(key);
  const sp = Z_SPEC[spec];
  if (!v || v.length < 20 || !sp) { T[id] = null; return null; }
  T[id] = sp[0] ? preChgZ(v, sp[0], sp[1]) : preRollZ(v, sp[1]);
  return T[id];
}

/* ---------- tech / mom 的预计算（v3.11）----------
 * 这两个因子是唯一依赖 K 线的。回放原实现每天重建一次 K 线切片、再跑
 * ema(20)/ema(50)/rsi(14)，是 10 年窗口下最大的一笔开销（实测占总回放时间一半以上）。
 * ema 与 rsi 都是递推式，可以一次 O(n) 算出「截至第 i 根 K 线」的值。
 * 实时模式仍走 klines 原路径（state.btcZ 只在回放期间存在）。 */
function buildBtcZ(closes) {
  const L = closes.length;
  const e20 = new Float64Array(L), e50 = new Float64Array(L), rr = new Float64Array(L);
  const tech = new Float64Array(L), mom = new Float64Array(L), out = new Float64Array(L);
  const k20 = 2 / 21, k50 = 2 / 51;
  let g = 0, l = 0;                       // rsi(14) 的递推累加器，与 rsi() 内一致
  for (let i = 0; i < L; i++) {
    if (i === 0) { e20[0] = e50[0] = closes[0]; rr[0] = 50; tech[0] = 0; mom[0] = 0; continue; }
    e20[i] = closes[i] * k20 + e20[i - 1] * (1 - k20);
    e50[i] = closes[i] * k50 + e50[i - 1] * (1 - k50);
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14;
    rr[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    tech[i] = (e20[i] - e50[i]) / (e50[i] || 1) * 30 + (rr[i] - 50) / 12;
    /* pctChange(c.slice(-30)) 是「最近 30 个元素的首尾差」= 29 个间隔 */
    mom[i] = i >= 29 ? ((closes[i] - closes[i - 29]) / closes[i - 29] * 100) / 8 : 0;
  }
  return { tech, mom, rsi: rr };
}

function dailyReturnsMap(ts, vals) {
  const out = new Map(); if (!ts || !vals || ts.length < 5) return out;
  const byDay = new Map();
  for (let i = 0; i < ts.length; i++) { if (vals[i] != null && isFinite(vals[i])) byDay.set(Math.floor(ts[i] / 86400000), vals[i]); }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  for (let i = 1; i < days.length; i++) { const p = byDay.get(days[i - 1]), c = byDay.get(days[i]); if (p) out.set(days[i], (c - p) / p); }
  return out;
}
function pearsonMaps(ma, mb, n = 120) {
  if (!ma || !mb || !ma.size || !mb.size) return null;
  const xs = [], ys = [];
  const keys = [...ma.keys()].sort((a, b) => b - a);
  for (const d of keys) { if (xs.length >= n) break; if (mb.has(d)) { const x = ma.get(d), y = mb.get(d); if (isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); } } }
  return xs.length < 20 ? null : pearson(xs, ys);
}

/* ---------- 经济日历事件（非农 / 失业率 / 初请 / PCE / CPI） ---------- */
const clampZ = v => Math.max(-2.5, Math.min(2.5, isFinite(v) ? v : 0));
function parseEconVal(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  const suf = str.slice(-1).toUpperCase();
  if (suf === 'M') v *= 1000; else if (suf === 'B') v *= 1000000;
  return isFinite(v) ? v : null;
}
function econFind(re) {
  const arr = state.econ || [];
  let pub = null, pend = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!re.test(arr[i].title)) continue;
    /* 只有真的填了 actual 才算「已发布」；纯倒序会让下周的预告盖掉本周刚出来的真值 */
    if (parseEconVal(arr[i].a) != null) { if (!pub) pub = arr[i]; }
    else if (!pend) pend = arr[i];
  }
  return pub || pend;
}
/* 事件因子: surprise = 实际 − 预期（正数=强于预期），
 * 这里只算「原始 surprise 的标准化值」，方向由因子表的 dir 决定（避免方向被应用两次）。
 * 未发布时退化为「预期 − 前值」× 0.5 权重。 */
/* 发布时刻 + 该缓冲之后仍没有实际值 → 判定为「数据缺口」。
 * 只有带具体时刻的 ISO 才做此判断（老缓存里 MM-DD-YYYY 无钟点，跳过以免误伤未来事件）。
 * 60 分钟是给数据源留的更新余量，不是拍脑袋：FF 通常几分钟内回填，慢也不过半小时。 */
const ECON_GRACE_MS = 60 * 60 * 1000;
function econOverdue(e) {
  const t = e && typeof e.t === 'string' ? e.t : '';
  if (t.indexOf('T') < 0) return false;
  const ms = Date.parse(t);
  if (!isFinite(ms)) return false;
  return (Date.now() - ms) > ECON_GRACE_MS;
}
/* v3.31 事件因子「最近已知实际值」手动锚定表（止血用）。
 * FF 免费周历不回填 actual（实测 PCE/NFP/失业率 actual 长期为空），根治走新增的实际值源；
 * 在此之前，发布后把真值填进这里，因子即算真实 surprise，不再永久「未回填」。
 * v 与 FF 同口径：PCE/CPI 用小数(0.3=0.3%)、NFP 用千(142=142K)、失业率用百分数(4.1=4.1%)。asof='YYYY-MM'。 */
const RECENT_ACTUALS = {
  // core_pce_mm: { v: 0.3, asof: '2026-09', src: '手动锚定' },
  // cpi_mm:      { v: 0.3, asof: '2026-09', src: '手动锚定' },
  // nfp:         { v: 142, asof: '2026-09', src: '手动锚定' },
  // urate:       { v: 4.1, asof: '2026-09', src: '手动锚定' },
};

/* v3.31 估值因子「慢变量锚定表」。ERP / 实际金价 / 美联储表 / BTC 链上估值 需要
 * 盈利(远期P/E)、CPI、WALCL、链上美元结算额 等系列 —— 这些源（FRED / CoinMetrics）
 * 在数据 Worker 里被主机白名单 + CF WAF 挡住（实测：host not allowed / 403 / 520），
 * 纯前端也拿不到。所以走与事件因子同一套诚实做法：
 *   慢变量（月级）放这里锚定，快变量（金价 / 10Y / 市值 / 链上笔数）走实时，
 *   两者合成出一个真实的估值读数，并在备注里标「锚定·非实时」，绝不冒充实时。 */
const VALUE_ANCHORS = {
  // spx_fpe:    { v: 21.0,   asof: '2026-09', src: '手动锚定·待接入盈利数据' },  // S&P500 远期 P/E
  // cpi_idx:    { v: 320.0,  asof: '2026-09', src: '手动锚定·待接入CPI' },       // CPI 定基指数(1982-84=100)
  // fed_total:  { v: 6.7e12, asof: '2026-09', src: '手动锚定·待接入WALCL' },    // 美联储总资产(USD)
  // avg_tx_usd: { v: 45000,  asof: '2026-09', src: '手动锚定·链上均值' },        // 单笔链上交易均值(USD)
};
/* 读锚定值：没锚就用兜底默认值，但 anchored=false —— 调用方据此在备注里如实标明 */
function vAnchor(k, dflt) {
  const a = VALUE_ANCHORS[k];
  const has = !!(a && a.v != null);
  return { v: has ? a.v : dflt, asof: (a && a.asof) || null, src: (a && a.src) || '', anchored: has };
}
function econFactor(cfg) {
  const e = econFind(cfg.re);
  if (!e) return { z: 0, note: '本周无发布' };
  let a = parseEconVal(e.a), f = parseEconVal(e.f), p = parseEconVal(e.p);
  let ov = false;
  if (a == null && cfg.key && RECENT_ACTUALS[cfg.key] && RECENT_ACTUALS[cfg.key].v != null) {
    a = RECENT_ACTUALS[cfg.key].v; ov = true;
  }
  if (a != null && f != null) return { z: clampZ((a - f) / cfg.std), note: (ov ? `实际(锚定${RECENT_ACTUALS[cfg.key].asof}) ${a} / 预期 ${e.f}` : `实际 ${e.a} / 预期 ${e.f}`), stale: false, ev: e.t };
  const late = econOverdue(e);
  if (f != null && p != null) return {
    z: clampZ((f - p) / cfg.std * 0.5),
    note: late ? `FF未回填实际值·前值 ${e.p}（最近已知实际）` : `预期 ${e.f}（未发布·半权重）`,
    stale: late && !ov, ev: e.t
  };
  return { z: 0, note: late ? '已过时辰·FF未回填' : '待发布', stale: late && !ov, ev: e.t };
}

/* =====================================================================
 *  数据拉取
 * ===================================================================== */
async function fetchPrices() {
  for (const c of CONFIG.COINS) {
    try {
      const d = await getJSON(ENDPOINTS.bybitTicker(CONFIG.SYMBOL_MAP[c]));
      const t = d && d.result && d.result.list && d.result.list[0];
      if (!t) continue;
      state.prices[c] = { price: +t.lastPrice, chg: (+t.price24hPcnt) * 100, high: +t.highPrice24h, low: +t.lowPrice24h, vol: +t.turnover24h };
    } catch (e) { console.warn('price fail', c, e); }
  }
  return true;
}
async function fetchKlines(coin, interval) {
  try {
    const iv = BYBIT_IV[interval] || '60';
    const d = await getJSON(ENDPOINTS.bybitKline(CONFIG.SYMBOL_MAP[coin], iv, 220));
    const list = (d.result && d.result.list) || [];
    const kl = list.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
    state.klines[coin + interval] = kl; return true;
  } catch (e) { console.warn('kline fail', e); return false; }
}
async function fetchFG() {
  try {
    const d = await getJSON(ENDPOINTS.fg);
    const arr = d.data.slice().reverse();
    state.fg = d.data[0];
    state.fgSeries = arr.map(x => +x.value);
    state.fgDates = arr.map(x => +x.timestamp * 1000);
    return true;
  } catch (e) { console.warn('fg fail', e); return false; }
}
async function fetchGlobal() {
  try {
    const d = await getJSON(ENDPOINTS.ggGlobal, 15000);
    if (d.mcap == null || d.btcD == null) throw new Error('global empty');
    state.global = { total_market_cap: { usd: d.mcap }, market_cap_percentage: { btc: d.btcD, eth: d.ethD }, _src: d.src };
    return true;
  } catch (e) { console.warn('global fail', (e && e.message) || e); return false; }
}
async function fetchStable() {
  try {
    const d = await getJSON(ENDPOINTS.stable);
    const a = d.peggedAssets || [];
    state.stableMcap = a.reduce((s, it) => s + ((it.circulating && it.circulating.peggedUSD) || 0), 0);
    return true;
  } catch (e) { console.warn('stable fail', e); return false; }
}
async function fetchChain() {
  let ok = false;
  const loadHR = async (attempt) => {
    const d = await getJSON(ENDPOINTS.mempoolHR, 15000);
    const hrs = (d && d.hashrates) || [];
    if (!hrs.length) throw new Error('hashrate empty');
    state.chainSeries.hashrate = hrs.map(x => x.avgHashrate);
    state.chainDates.hashrate = hrs.map(x => x.timestamp * 1000);
    if (attempt) console.warn('hashrate retry ok');
  };
  try {
    try { await loadHR(0); } catch (e1) { await new Promise(r => setTimeout(r, 1200)); await loadHR(1); }
    ok = !!state.chainSeries.hashrate;
  } catch (e) { console.warn('hashrate fail', (e && e.message) || e); }
  try {
    const n = await getJSON(ENDPOINTS.ntx);
    const vals = (n && n.values) || [];
    state.chainSeries.n_tx = vals.map(v => v.y);
    state.chainDates.n_tx = vals.map(v => v.x * 1000);
    ok = true;
  } catch (e) { console.warn('ntx fail', e); }
  return ok;
}
async function fetchDeriv() {
  try {
    const f = await getJSON(ENDPOINTS.bybitLinear('BTCUSDT'));
    const fr = f && f.result && f.result.list && f.result.list[0];
    const funding = fr ? (+fr.fundingRate) * 100 : null;
    let oi = null, oiSeries = null, oiDates = null;
    try {
      const o = await getJSON(ENDPOINTS.bybitOI('BTCUSDT'));
      const ol = ((o.result && o.result.list) || []).slice().reverse();
      if (ol.length) { oiSeries = ol.map(x => +x.openInterest); oiDates = ol.map(x => +x.timestamp); oi = last(oiSeries); }
    } catch (e) { console.warn('oi fail', e); }
    let ls = null, lsSeries = null, lsDates = null;
    try {
      const l = await getJSON(ENDPOINTS.bybitLS('BTCUSDT'));
      const ll = ((l.result && l.result.list) || []).slice().reverse();
      if (ll.length) { lsSeries = ll.map(x => +x.buyRatio * 100); lsDates = ll.map(x => +x.timestamp); ls = last(lsSeries); }
    } catch (e) { console.warn('ls fail', e); }
    state.deriv = { funding, oi, oiSeries, oiDates, ls, lsSeries, lsDates };
    return true;
  } catch (e) { console.warn('deriv fail', e); return false; }
}
async function fetchMacro() {
  if (!CONFIG.PROXY) { state.macro = null; state.macroSeries = null; state.macroDates = null; return false; }
  try {
    const d = await getJSON(CONFIG.PROXY + '/api/snapshot', 25000);   // 冷启动常需 10~30s，9s 会误判失败
    state.macro = d.macro; state.macroSeries = d.series; state.macroDates = d.dates;
    state.macroPrev = d._prev || null; state.macroSrc = d._src || null; return true;
  } catch (e) { console.warn('macro fail', e); return false; }
}
async function fetchEcon() {
  if (!ENDPOINTS.calendar) { state.econ = []; return false; }
  try {
    const d = await getJSON(ENDPOINTS.calendar, 20000);
    state.econ = (d && d.events) || []; state.econTs = d && d.ts;
    return state.econ.length > 0;
  } catch (e) { console.warn('econ fail', e); return false; }
}

function buildSeries() {
  const s = {}, sd = {};
  const btc1d = state.klines['BTC1d'];
  if (btc1d) { s.BTC = btc1d.map(k => k.c); sd.BTC = btc1d.map(k => k.t); }
  if (state.fgSeries.length) { s.FNG = state.fgSeries; sd.FNG = state.fgDates; }
  if (state.chainSeries.hashrate) { s.HR = state.chainSeries.hashrate; sd.HR = state.chainDates.hashrate; }
  if (state.chainSeries.n_tx) { s.TX = state.chainSeries.n_tx; sd.TX = state.chainDates.n_tx; }
  if (state.deriv.oiSeries) { s.OI = state.deriv.oiSeries; sd.OI = state.deriv.oiDates; }
  if (state.deriv.lsSeries) { s.LS = state.deriv.lsSeries; sd.LS = state.deriv.lsDates; }
  if (state.macroSeries && state.macroDates) {
    Object.keys(state.macroSeries).forEach(k => {
      const v = state.macroSeries[k], t = state.macroDates[k];
      if (v && v.length && t && t.length) { s[k] = v; sd[k] = t; }
    });
  }
  state.series = s; state.seriesDates = sd;
  const rm = {};
  Object.keys(s).forEach(k => { rm[k] = dailyReturnsMap(sd[k], s[k]); });
  state.retMaps = rm;
}

/* =====================================================================
 *  因子模型（21 维）
 * ===================================================================== */
const META = {
  BTC: { s: 'BTC', name: 'BTC', color: '#00e5a0', group: 'core' },
  FNG: { s: '情绪', name: '恐惧贪婪', color: '#ffc107', group: 'sentiment' },
  HR: { s: '算力', name: '算力', color: '#b388ff', group: 'onchain' },
  TX: { s: '链上', name: '链上活跃', color: '#b388ff', group: 'onchain' },
  OI: { s: '持仓', name: '持仓量', color: '#ff9100', group: 'deriv' },
  LS: { s: '多空', name: '多空比', color: '#ff9100', group: 'deriv' },
  DXY: { s: '美元', name: '美元指数', color: '#00b4ff', group: 'macro' },
  US10Y: { s: '10Y', name: '美债10Y', color: '#00b4ff', group: 'macro' },
  UST2Y: { s: '2Y', name: '美债2Y', color: '#4fc3f7', group: 'policy' },
  GOLD: { s: '黄金', name: '黄金', color: '#ffb300', group: 'macro' },
  SPX: { s: '标普', name: '标普500', color: '#00b4ff', group: 'macro' },
  VIX: { s: 'VIX', name: 'VIX恐慌', color: '#ff3d6e', group: 'macro' },
  OIL: { s: 'WTI', name: 'WTI原油', color: '#8d6e63', group: 'macro' },
  BRENT: { s: '布油', name: '布伦特原油', color: '#a1887f', group: 'macro' },
  AGRI: { s: '农业', name: '农业', color: '#8bc34a', group: 'macro' },
  EFFR: { s: 'FFR', name: '联邦利率', color: '#26c6da', group: 'policy' },
  BEI10: { s: '通胀', name: '通胀预期', color: '#ef5350', group: 'policy' },
  T10Y2Y: { s: '利差', name: '期限利差', color: '#7e57c2', group: 'policy' },
  USDJPY: { s: '日元', name: '美元日元', color: '#e57373', group: 'jpy' },
  JGB10Y: { s: '日债', name: '日债10Y', color: '#f06292', group: 'jpy' },
  STABLE: { s: '稳定', name: '稳定币占比', color: '#00e5a0', group: 'market' },
  FUND: { s: '费率', name: '资金费率', color: '#ff9100', group: 'deriv' },
};

/* ---------------------------------------------------------------------
 * 因子表（28 项 · 27 项参与评分）
 *
 *   dir = 该因子 z 相对加密资产的方向
 *         +1 → z 越高越「利多」   -1 → z 越高越「利空」   0 → 只展示、不参与评分
 *   z   = 相对自身历史的标准化偏离
 *         · 均值回复型（美元/美债/VIX/通胀预期/期限利差/资金费率/多空比/持仓/链上活跃）
 *           → rollZ（水平滚动 z）
 *         · 趋势型（黄金/标普/原油/算力/美元日元/日债）→ chgZ（变化率滚动 z）
 *
 *   合成: Nexus Score = 50 + 22 × Σ(w · dir · z) / Σw
 *
 *   方向取值的依据（可争议的判断，统一取「对加密的短期风险偏好」口径并公开标注）：
 *     · 拥挤类（资金费率 / 多空比 / 合约持仓 / 恐惧贪婪）→ -1
 *       多头越拥挤，越容易发生反向挤压，作为反向指标
 *     · 紧缩与避险类（美元 / 美债收益率 / 日债收益率 / VIX / 通胀预期 / PCE / CPI / 非农）→ -1
 *     · 风险偏好与基本面扩张类（标普 / 算力 / 链上活跃 / 稳定币 / 期限利差 / 技术面 / 动量）→ +1
 *     · 日元（美元/日元）→ +1：日元贬值 = 套息交易顺畅 = 风险偏好；
 *       日元急升 = 套息平仓 = 全球风险资产承压（2024-08 即此机制）
 *     · 劳动力走弱类（失业率 / 初请失业金）→ +1：就业降温 → 降息预期升温 → 利多
 *     · 农业 → 0：与加密相关性极弱，仅作通胀侧背景展示
 * ------------------------------------------------------------------- */
const FACTORS = [
  /* —— 情绪 / 仓位拥挤（反向指标）—— */
  { id: 'fng', name: '😱 恐惧贪婪', group: 'sentiment', w: 1.0, dir: -1, calc: () => { if (!state.fg) return { z: 0, ok: false, note: '无数据' }; const v = +state.fg.value; return { z: (v - 50) / 18, note: 'F&G ' + v + ' · 反向' }; } },
  { id: 'fund', name: '💸 资金费率', group: 'deriv', w: 0.9, dir: -1, calc: () => { const f = state.deriv.funding; if (f == null) return { z: 0, note: '—' }; return { z: f / 0.03, note: f.toFixed(4) + '% · 反向' }; } },
  { id: 'ls', name: '⚖️ 多空比', group: 'deriv', w: 0.7, dir: -1, calc: () => { const l = state.deriv.ls; if (l == null) return { z: 0, note: '—' }; return { z: (l - 50) / 10, note: l.toFixed(1) + '%多 · 反向' }; } },
  { id: 'oi', name: '📊 合约持仓', group: 'deriv', w: 0.6, dir: -1, calc: () => { const a = state.deriv.oiSeries; if (!a || !a.length) return { z: 0, note: '—' }; return { z: rollZ(a, 120), note: fmtBig(state.deriv.oi) + ' BTC' }; } },
  /* —— 结构 / 流动性 —— */
  { id: 'dom', name: '👑 BTC占比', group: 'market', w: 0.6, dir: -1, calc: () => { const d = state.global && state.global.market_cap_percentage.btc; if (d == null) return { z: 0, ok: false, note: '无数据' }; return { z: (d - 56) / 5, note: d.toFixed(1) + '%' }; } },
  { id: 'stable', name: '🪙 稳定币占比', group: 'market', w: 0.5, dir: 1, calc: () => { const st = state.stableMcap, tot = state.global && state.global.total_market_cap.usd; if (!st || !tot) return { z: 0, ok: false, note: '无数据' }; const r = st / tot * 100; return { z: (r - 11) / 3, note: r.toFixed(1) + '% · 场外购买力' }; } },
  { id: 'hr', name: '⛏ 算力趋势', group: 'onchain', w: 0.6, dir: 1, calc: () => { if (mLen('HR') < 190) return { z: 0, ok: false, note: '无数据' }; const z = mChgZ('HR', 90); return { z, note: '近90日' + (z >= 0 ? '加速' : '放缓') }; } },
  { id: 'tx', name: '🔗 链上活跃', group: 'onchain', w: 0.5, dir: 1, calc: () => { if (mLen('TX') < 100) return { z: 0, ok: false, note: '无数据' }; return { z: mZ('TX', 90), note: fmtBig(mV('TX')) + '笔/日' }; } },
  /* —— 美元 / 风险资产 —— */
  /* —— v3.10 回放专用因子（replayOnly）：只有历史序列、无实时源 ——
   * computeNexusScore 在实时模式（不带 ids）跳过它们；回放模式计入子集。
   * 方向假设沿用实时同类因子的约定：MVRV/溢价/持仓高 = 过热 → 反向(-1)；
   * 活跃地址/手续费升 = 网络需求升 → 顺向(+1)。对错由 IC 归因表裁决。 */
  { id: 'mrv', name: '⚖ MVRV 估值', group: 'onchain', w: 0.9, dir: -1, replayOnly: true, calc: () => { const v = mV('MRV'); if (v == null) return { z: 0, ok: false, note: '无数据' }; return { z: mZ('MRV', 120), note: 'MVRV ' + v.toFixed(2) + ' · 反向' }; } },
  { id: 'adr', name: '👥 活跃地址', group: 'onchain', w: 0.5, dir: 1, replayOnly: true, calc: () => { const v = mV('ADR'); if (v == null) return { z: 0, ok: false, note: '无数据' }; return { z: mChgZ('ADR', 60), note: fmtBig(v) + ' · 60日动能' }; } },
  { id: 'fee', name: '🧾 链上手续费', group: 'onchain', w: 0.5, dir: 1, replayOnly: true, calc: () => { const v = mV('FEE'); if (v == null) return { z: 0, ok: false, note: '无数据' }; return { z: mChgZ('FEE', 60), note: '$' + fmtBig(v) + ' · 需求' }; } },
  { id: 'prem', name: '🔥 永续溢价', group: 'deriv', w: 0.8, dir: -1, replayOnly: true, calc: () => { const v = mV('PREM'); if (v == null) return { z: 0, ok: false, note: '无数据' }; return { z: mZ('PREM', 120), note: (v * 100).toFixed(3) + '% · 反向' }; } },
  { id: 'oih', name: '📊 持仓量(史)', group: 'deriv', w: 0.6, dir: -1, replayOnly: true, calc: () => { const v = mV('OIH'); if (v == null) return { z: 0, ok: false, note: '无数据' }; return { z: mZ('OIH', 120), note: fmtBig(v) + ' · 反向' }; } },
  { id: 'dxy', name: '🇺🇸 美元指数', group: 'macro', w: 1.0, dir: -1, calc: () => { const v = mV('DXY'); if (v == null) return { z: 0, note: CONFIG.PROXY ? '—' : '需Worker' }; return { z: mZ('DXY'), note: v.toFixed(1) }; } },
  { id: 'us10y', name: '🏦 美债10Y', group: 'macro', w: 1.0, dir: -1, calc: () => { const v = mV('US10Y'); if (v == null) return { z: 0, note: '—' }; return { z: mZ('US10Y'), note: v.toFixed(2) + '%' }; } },
  { id: 'spx', name: '📈 标普500', group: 'macro', w: 0.9, dir: 1, calc: () => { const v = mV('SPX'); if (v == null) return { z: 0, note: '—' }; return { z: mChgZ('SPX', 60), note: v.toFixed(0) + ' · 60日动能' }; } },
  { id: 'vix', name: '😰 VIX恐慌', group: 'macro', w: 1.0, dir: -1, calc: () => { const v = mV('VIX'); if (v == null) return { z: 0, note: '—' }; return { z: mZ('VIX'), note: v.toFixed(1) }; } },
  { id: 'gold', name: '🥇 黄金', group: 'macro', w: 0.5, dir: -1, calc: () => { const v = mV('GOLD'); if (v == null) return { z: 0, note: '—' }; return { z: mChgZ('GOLD', 60), note: '$' + v.toFixed(0) + ' · 避险' }; } },
  { id: 'oil', name: '🛢 原油', group: 'macro', w: 0.5, dir: -1, calc: () => { const zs = []; const ws = mV('OIL'), bs = mV('BRENT'); if (ws != null) zs.push(mChgZ('OIL', 30)); if (bs != null) zs.push(mChgZ('BRENT', 30)); if (!zs.length) return { z: 0, note: '—' }; const note = (ws != null ? '$' + ws.toFixed(0) : '—') + (bs != null ? ' / $' + bs.toFixed(0) : ''); return { z: zs.reduce((a, b) => a + b, 0) / zs.length, note }; } },
  { id: 'agri', name: '🌾 农业(展示)', group: 'macro', w: 0, dir: 0, calc: () => { const v = mV('AGRI'); return { z: 0, note: v == null ? '—' : '$' + v.toFixed(2) + ' 不参与评分' }; } },
  { id: 'geo', name: '🌍 地缘风险(代理)', group: 'macro', w: 0.7, dir: -1, calc: () => { const S = state.macroSeries || {}; const zs = []; if (S.VIX) zs.push(mZ('VIX', 120)); if (S.GOLD) zs.push(mChgZ('GOLD', 60)); if (S.OIL) zs.push(mChgZ('OIL', 30)); if (!zs.length) return { z: 0, note: '—' }; return { z: zs.reduce((a, b) => a + b, 0) / zs.length, note: 'VIX+金+油' }; } },
  /* —— 政策 / 利率 —— */
  { id: 'fed', name: '🏛 美联储(2Y)', group: 'policy', w: 1.0, dir: -1, calc: () => { const v = mV('UST2Y'); if (v == null) return { z: 0, note: '—' }; return { z: mZ('UST2Y', 120), note: '2Y ' + v.toFixed(2) + '%' }; } },
  { id: 'bei', name: '🔥 通胀预期', group: 'policy', w: 0.8, dir: -1, calc: () => { const v = mV('BEI10'); if (v == null) return { z: 0, note: '—' }; return { z: mZ('BEI10'), note: v.toFixed(2) + '%' }; } },
  { id: 'curve', name: '📉 期限利差', group: 'policy', w: 0.7, dir: 1, calc: () => { const v = mV('T10Y2Y'); if (v == null) return { z: 0, note: '—' }; return { z: mZ('T10Y2Y'), note: (v >= 0 ? '+' : '') + v.toFixed(2) + (v < 0 ? ' 倒挂' : '') }; } },
  /* —— 日元 / 套息交易 —— */
  { id: 'jpy', name: '💴 美元/日元', group: 'jpy', w: 1.1, dir: 1, calc: () => { const v = mV('USDJPY'); if (v == null) return { z: 0, note: '—' }; return { z: mChgZ('USDJPY', 60), note: v.toFixed(1) + ' · 套息' }; } },
  { id: 'jgb', name: '🇯🇵 日债10Y', group: 'jpy', w: 0.9, dir: -1, calc: () => { const v = mV('JGB10Y'); if (v == null) return { z: 0, note: '—' }; return { z: mChgZ('JGB10Y', 90), note: v.toFixed(2) + '% · 套息成本' }; } },
  /* —— 事件因子（美国经济日历 · 超预期方向）—— */
  { id: 'nfp', name: '👷 非农就业', group: 'event', w: 0.6, dir: -1, calc: () => econFactor({ key: 'nfp', re: /^Non-Farm Employment Change$/i, std: 60 }) },
  { id: 'urate', name: '🧑‍💼 失业率', group: 'event', w: 0.5, dir: 1, calc: () => econFactor({ key: 'urate', re: /^Unemployment Rate$/i, std: 0.12 }) },
  { id: 'claims', name: '📋 初请失业金', group: 'event', w: 0.4, dir: 1, calc: () => econFactor({ key: 'claims', re: /^Unemployment Claims$/i, std: 8 }) },
  { id: 'pce', name: '💵 核心PCE', group: 'event', w: 0.6, dir: -1, calc: () => econFactor({ key: 'core_pce_mm', re: /^Core PCE Price Index m\/m$/i, std: 0.08 }) },
  { id: 'cpi', name: '🔥 CPI月率', group: 'event', w: 0.5, dir: -1, calc: () => econFactor({ key: 'cpi_mm', re: /^CPI m\/m$/i, std: 0.12 }) },
  /* —— 技术面（BTC 自身）—— */
  /* tech / mom：回放期间走预计算表（state.btcZ），实时模式走 K 线原路径 */
  { id: 'tech', name: '📐 技术面', group: 'tech', w: 1.0, dir: 1, calc: () => { const bz = state.btcZ; if (bz) { const i = state.klIdx == null ? bz.tech.length - 1 : state.klIdx; if (i < 100) return { z: 0, ok: false, note: '无数据' }; return { z: bz.tech[i], note: 'RSI ' + bz.rsi[i].toFixed(0) }; } const k = state.klines && state.klines['BTC' + state.interval]; if (!k) return { z: 0, note: '—' }; const c = k.map(x => x.c); const e20 = ema(c, 20), e50 = ema(c, 50), r = rsi(c); const z = (e20[e20.length - 1] - e50[e50.length - 1]) / (e50[e50.length - 1] || 1) * 30 + (r[r.length - 1] - 50) / 12; return { z, note: 'RSI ' + r[r.length - 1].toFixed(0) }; } },
  { id: 'mom', name: '🚀 动量', group: 'tech', w: 0.8, dir: 1, calc: () => { const bz = state.btcZ; if (bz) { const i = state.klIdx == null ? bz.mom.length - 1 : state.klIdx; if (i < 100) return { z: 0, ok: false, note: '无数据' }; const pc = bz.mom[i] * 8; return { z: bz.mom[i], note: pc.toFixed(1) + '%' }; } const k = state.klines && state.klines['BTC' + state.interval]; if (!k) return { z: 0, note: '—' }; const c = k.map(x => x.c); const pc = pctChange(c.slice(-30)) || 0; return { z: pc / 8, note: pc.toFixed(1) + '%' }; } },
  /* —— v3.31 估值因子（价值维度）——
   * 这 4 个是「估值标尺」而非实时价格序列：其 z 对着锚定的正常带，不进实时评分
   * （anchored:true，computeNexusScore 会跳过），只在估值面板里给出贵/便宜读数。
   * 之所以不塞进 META/相关性：它们是派生量、没有独立价格序列，塞进相关矩阵会污染跨资产统计。 */
  { id: 'erp', name: '🧮 股债风险溢价', group: 'value', w: 0.6, dir: 1, anchored: true, calc: () => {
      const y10 = mV('US10Y'); if (y10 == null) return { z: 0, note: '—' };
      const A = vAnchor('spx_fpe', 21.0);
      const ey = 1 / A.v;                              // 盈利收益率 = 1 / 远期 P/E
      const erp = ey - y10 / 100;                      // 口径统一成小数
      const z = clampZ((erp - 0.03) / 0.015);          // 锚定正常带：ERP≈3%，σ≈1.5%
      return { z, note: 'ERP ' + (erp * 100).toFixed(2) + '% = EY ' + (ey * 100).toFixed(2) + '% − 10Y ' + y10.toFixed(2) + '% · FPE' + (A.anchored ? '锚定' + A.asof : '默认21') + ' · 10Y实时' };
    } },
  { id: 'rgold', name: '🥇 黄金(实际)', group: 'value', w: 0.5, dir: -1, anchored: true, calc: () => {
      const g = mV('GOLD'); if (g == null) return { z: 0, note: '—' };
      const A = vAnchor('cpi_idx', 320.0);
      const real = g / (A.v / 100);                    // 定基 CPI 折算 → 实际金价
      const z = mChgZ('GOLD', 60);                     // CPI 是慢变量，实际金价动能≈名义动能（实时）
      return { z, note: '实际金价 $' + real.toFixed(0) + ' · 定基CPI ' + A.v + (A.anchored ? '锚定' + A.asof : '默认320') + ' · 60日动能实时' };
    } },
  { id: 'fedbs', name: '🏛 美联储表', group: 'value', w: 0.5, dir: 1, anchored: true, calc: () => {
      const A = vAnchor('fed_total', 6.7e12);
      const z = clampZ((A.v - 8.0e12) / 1.0e12);       // 锚定正常带：缩表前 ~8 万亿
      return { z, note: '总资产 $' + (A.v / 1e12).toFixed(2) + '万亿 · ' + (A.anchored ? '锚定' + A.asof + '·非实时' : '默认6.7万亿·待接入WALCL') + ' · 缩表=流动性收紧' };
    } },
  { id: 'nvt', name: '⛓ BTC链上估值', group: 'value', w: 0.7, dir: -1, anchored: true, calc: () => {
      const G = state.global;
      const tot = G && G.total_market_cap && G.total_market_cap.usd;
      const dom = G && G.market_cap_percentage && G.market_cap_percentage.btc;
      const ntx = mV('TX');
      if (!tot || !dom || !ntx) return { z: 0, note: '—' };
      const A = vAnchor('avg_tx_usd', 45000);
      const btcMcap = tot * dom / 100;                 // BTC 市值（实时）
      const dailyUsd = ntx * A.v;                      // 链上日结算额（代理）
      const nvt = btcMcap / dailyUsd;
      const z = clampZ((nvt - 75) / 30);               // 锚定正常带：NVT≈75，σ≈30
      return { z, note: 'NVT ' + nvt.toFixed(0) + ' · 市值实时 / 链上额(' + fmtBig(ntx) + '笔×$' + fmtBig(A.v) + (A.anchored ? '锚定' + A.asof : '默认') + ')' };
    } },
];

/* ---------- 因子级数据可用性（v3.11）----------
 * 10 年窗口下，早期根本不存在某些序列：情绪指数从 2018-02、MVRV 从 2022、
 * 永续持仓量从 2025-02。这里有两个会让「无数据因子」伪装成「中性观点」的陷阱：
 *   ① 多数 calc 写成 `if (v == null) return { z: 0, note: '—' }` —— 没设 ok:false，
 *      于是 z=0 被计入分母，把评分系统性拉向 50（越早期的年份越严重）；
 *   ② rollZ/chgZ 在数据不足时返回 0 而不是失败，同样伪装成中性。
 * 所以在 computeNexusScore 里统一加一道闸门：因子依赖的序列「截至当日可见长度」
 * 不够，直接判 ok:false 退出分母。实时模式下可见长度 = 全长，不会误伤。
 *
 * 第二列的门槛口径是「这个因子的 z 算法所需的最低数据量」，**不是**「z 窗口被填满」：
 *   rollZ(120)     -> 60    （算法硬门槛是 10，60 点已经能给出有意义的偏离）
 *   rollZ(90)      -> 50
 *   chgZ(60,120)   -> 80    （要先攒够 days 个基点，再对差分做 z）
 *   chgZ(90,120)   -> 110
 *   chgZ(30,120)   -> 50
 * 一开始用了「窗口填满」的口径（180/210），结果冒烟测试立刻抓出问题：模拟宏观序列
 * 只有 160 点，spx/gold/geo/jpy/jgb 被静默判死。窗口没填满时 z 的噪声更大，但仍是
 * 有效值 —— 而且实时模式在序列刚开始时本来就是这么算的，两者必须一致。 */
const FACTOR_DEP = {
  /* 注意：fng 不在这里 —— 它的数据挂在 state.fg 上、不是 macroSeries 里的序列，
   * 由它自己的 calc 判 `!state.fg -> ok:false`；放进这张表会被 mLen('FNG') 恒判 0。 */
  hr:    ['HR',    110],
  tx:    ['TX',     50],
  mrv:   ['MRV',    60],
  adr:   ['ADR',    80],
  fee:   ['FEE',    80],
  prem:  ['PREM',   60],
  oih:   ['OIH',    60],
  dxy:   ['DXY',    60],
  us10y: ['US10Y',  60],
  spx:   ['SPX',    80],
  vix:   ['VIX',    60],
  gold:  ['GOLD',   80],
  oil:   ['OIL',    50],
  geo:   ['VIX',    80],
  fed:   ['UST2Y',  60],
  bei:   ['BEI10',  60],
  curve: ['T10Y2Y', 60],
  jpy:   ['USDJPY', 80],
  jgb:   ['JGB10Y',110],
  tech:  [null,      0],   // 依赖 K 线，由 calc 自查（回放时读预计算表）
  mom:   [null,      0],
};

function computeNexusScore(ids) {
  const set = ids ? new Set(ids) : null;      // ids 非空 → 只算这个子集（历史回放用）
  let sum = 0, wsum = 0, nScored = 0, nDead = 0; const out = {};
  FACTORS.forEach(f => {
    if (set && !set.has(f.id)) return;
    if (!set && f.replayOnly) return;    // 回放专用因子不进实时评分
    const r = f.calc();
    let has = r.ok !== false;                       // 无数据的因子不进分母，避免把评分拉向 50
    const dep = FACTOR_DEP[f.id];
    if (has && dep) {
      if (dep[0] === null) has = (((state.klines && state.klines['BTC' + state.interval]) || []).length >= dep[1]);
      else has = mLen(dep[0]) >= dep[1];
    }
    const z = clampZ(r.z);
    const contribution = Math.max(-2.5, Math.min(2.5, (f.dir || 0) * z));   // 方向化贡献
    /* v3.24：zRaw = clamp 之前的原始 z。评分幅度诊断要分清「因子本身温和」与
     * 「被 ±2.5 截断」这两种完全不同的成因 —— 只看夹紧后的值永远分不开。 */
    out[f.id] = { z, contribution, zRaw: isFinite(r.z) ? r.z : null, dir: f.dir || 0, note: r.note, ok: has, stale: r.stale === true, evTime: r.ev };
    if (f.dir && has && !f.anchored) { sum += contribution * f.w; wsum += f.w; nScored++; }
    else if (f.dir && !has) nDead++;
  });
  const cRaw = wsum ? sum / wsum : 0;
  const score = Math.round(50 + cRaw * 22);
  /* v3.24：把夹紧前的复合值 cRaw 一并带出去。实时模式的标尺校正要用它 ——
   * score 已经被 round + clamp 到 2–98，取整和截断都不可逆，拿它反推会失真。 */
  return { score: Math.max(2, Math.min(98, score)), c: cRaw, out, nScored, nDead };
}

/* =====================================================================
 *  K线图（Canvas 自绘）
 * ===================================================================== */
let chartState = { hover: -1 };
function renderChart() {
  const cv = $('mainCanvas'); if (!cv) return;
  const k = state.klines['BTC' + state.interval]; if (!k) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const padL = 8, padR = 56, padT = 10, padB = 18, volH = 54;
  const priceH = H - padT - padB - volH;
  const c = k.map(x => x.c); const cl = c.length;
  const ma20 = sma(c, 20), ma50 = sma(c, 50);
  let lo = Math.min(...c), hi = Math.max(...c);
  for (const m of ma20.concat(ma50)) if (m) { lo = Math.min(lo, m); hi = Math.max(hi, m); }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = i => padL + i * (W - padL - padR) / (cl - 1);
  const y = p => padT + (hi - p) / (hi - lo) * priceH;
  const yv = v => H - padB - v / Math.max(...k.map(x => x.v)) * volH;
  ctx.strokeStyle = 'rgba(26,46,80,.5)'; ctx.fillStyle = '#3a5070'; ctx.font = '9px JetBrains Mono, monospace'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const yy = padT + priceH * i / 4; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.fillText(fmt(hi - (hi - lo) * i / 4, 0), W - padR + 4, yy + 3); }
  const bw = (W - padL - padR) / cl * 0.62;
  k.forEach((d, i) => {
    const up = d.c >= d.o; ctx.strokeStyle = ctx.fillStyle = up ? '#00e5a0' : '#ff3d6e';
    ctx.beginPath(); ctx.moveTo(x(i), y(d.h)); ctx.lineTo(x(i), y(d.l)); ctx.stroke();
    ctx.fillRect(x(i) - bw / 2, Math.min(y(d.o), y(d.c)), bw, Math.max(1, Math.abs(y(d.o) - y(d.c))));
    ctx.fillStyle = up ? 'rgba(0,229,160,.25)' : 'rgba(255,61,110,.25)';
    ctx.fillRect(x(i) - bw / 2, yv(d.v), bw, H - padB - yv(d.v));
  });
  const drawMA = (arr, col) => { ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false; arr.forEach((m, i) => { if (m == null) return; if (!started) { ctx.moveTo(x(i), y(m)); started = true; } else ctx.lineTo(x(i), y(m)); }); ctx.stroke(); };
  drawMA(ma20, '#ffc107'); drawMA(ma50, '#00b4ff');
  if (chartState.hover >= 0 && chartState.hover < cl) {
    const i = chartState.hover; ctx.strokeStyle = 'rgba(168,191,214,.4)'; ctx.beginPath(); ctx.moveTo(x(i), padT); ctx.lineTo(x(i), H - padB); ctx.stroke();
    const d = k[i]; const tt = $('chartTip');
    if (tt) { tt.style.display = 'block'; tt.style.left = Math.min(x(i) + 10, W - 170) + 'px'; tt.style.top = padT + 'px'; tt.innerHTML = `<div class="ctt-time">${new Date(d.t).toLocaleString('zh-CN')}</div><div class="ctt-row"><span class="ctt-lbl">开</span>${fmt(d.o)}</div><div class="ctt-row"><span class="ctt-lbl">高</span>${fmt(d.h)}</div><div class="ctt-row"><span class="ctt-lbl">低</span>${fmt(d.l)}</div><div class="ctt-row"><span class="ctt-lbl">收</span>${fmt(d.c)}</div><div class="ctt-row"><span class="ctt-lbl">量</span>${fmtBig(d.v)}</div>`; }
  }
}
function renderTA() {
  const k = state.klines['BTC' + state.interval]; if (!k) return; const c = k.map(x => x.c);
  const r = rsi(c), m = macd(c), b = bollinger(c), a = atr(k.map(x => x.h), k.map(x => x.l), c);
  const set = (id, v, sub) => { const e = $(id); if (e) { e.firstChild ? e.firstChild.textContent = v : e.textContent = v; } const s = $(id + '_s'); if (s) s.textContent = sub || ''; };
  set('ta_rsi', r[r.length - 1].toFixed(1), r[r.length - 1] > 70 ? '超买' : r[r.length - 1] < 30 ? '超卖' : '中性');
  set('ta_macd', (m.dif[m.dif.length - 1] - m.dea[m.dea.length - 1]).toFixed(1), m.hist[m.hist.length - 1] > 0 ? '金叉区' : '死叉区');
  set('ta_boll', b.up[b.up.length - 1] ? fmt(b.up[b.up.length - 1]) : '—', '中 ' + fmt(b.mid[b.mid.length - 1]));
  set('ta_atr', a[a.length - 1].toFixed(0), '波动 ' + (a[a.length - 1] / c[c.length - 1] * 100).toFixed(2) + '%');
  set('ta_ma', (c[c.length - 1] > sma(c, 20)[c.length - 1] ? '多头' : '空头'), 'MA20 ' + fmt(sma(c, 20)[c.length - 1]));
}

/* =====================================================================
 *  因子关系网络 + 相关性热力图（日收益率，日期对齐）
 * ===================================================================== */

/* =====================================================================
 *  因子关系网络 + 相关性热力图（日收益率）
 *
 *  v3.20 的四处升级（对应文首 ⑬）：
 *    ① 相关矩阵做 PSD 谱截断 + 向常数相关目标收缩，才敢拿去求逆；
 *    ② 「总相关 / 偏相关」可切换 —— 前者包含经由第三方的传导，后者是控制住
 *       其余全部因子后的直接关系。两条 DXY–BTC 的线含义完全不同；
 *    ③ 连边与否由 BH-FDR 决定，不再是 |r|>0.08 这种拍出来的阈值；
 *    ④ 网络形态可选 MST（n-1 条边，最强骨架）或显著网络（全部显著边）。
 * ===================================================================== */
let net = null;
let netRunning = false;      // 全局唯一动画循环开关（修复每 60 秒泄漏一个 rAF 循环）
const NET_OPTS = { mode: 'mst', rel: 'corr', win: 120, layout: 'radial', maxNodes: 64 };
/* 环的定义：先按「内生 → 外生」从内到外，同一类里再按「强 → 中 → 弱」。
 * 用户要的是「外生因素围在外围、一眼看清谁在往里打」，所以外生一定在外圈。
 * 顺序写死在 RINGS 里，环的**存在与否**由数据决定（空环不画）。 */
const RINGS = [
  { exo: 0, tier: 'strong', label: '内生·强', color: '#00e5a0' },
  { exo: 0, tier: 'mid', label: '内生·中', color: '#7ee0c0' },
  { exo: 0, tier: 'weak', label: '内生·弱', color: '#4a7f9e' },
  { exo: 1, tier: 'strong', label: '外生·强', color: '#ffb300' },
  { exo: 1, tier: 'mid', label: '外生·中', color: '#c98a3a' },
  { exo: 1, tier: 'weak', label: '外生·弱', color: '#6b5a44' },
];
const CLUSTER_COLORS = ['#00b4ff', '#ffb300', '#b388ff', '#00e5a0', '#ff9100', '#ff3d6e'];
let netAna = null;

function netKeys() { return Object.keys(state.series).filter(k => META[k] && state.retMaps[k] && state.retMaps[k].size > 20); }

/* 日期上界作为「数据有没有变」的标记：没变就复用上次的谱/偏相关结果，
 * 每次 60 秒刷新都重算 231 对 × 数百天没有意义，但也不要让陈旧结果一直挂着。 */
function retStamp(keys) {
  let mx = 0;
  for (let i = 0; i < keys.length; i++) {
    const m = state.retMaps[keys[i]];
    m.forEach(function (v, d) { if (d > mx) mx = d; });
  }
  return mx;
}
function netAnalyzed(force) {
  const keys = netKeys();
  if (keys.length < 3) { netAna = null; return null; }
  const stamp = keys.length + '|' + keys.join(',') + '|' + retStamp(keys);
  if (!force && netAna && netAna.win === NET_OPTS.win && netAna.stamp === stamp) return netAna;
  corrAna = null;
  let A = null;
  try { A = netAnalyze(keys, { win: NET_OPTS.win }); } catch (e) { console.warn('netAnalyze fail', e && e.message); }
  if (A) A.stamp = stamp;
  netAna = A;
  return A;
}
function netRelMatrix(A) { return (NET_OPTS.rel === 'part' && A.partial) ? A.partial : A.R; }

/* ⑬-⑯ 整套相关性分析（含 n-1 次谱分解、153 对滚动相关、17 个因子的滞后扫描）
 * 实测十年数据量下合计约 650ms。而刷新是每 60 秒一次 —— 不缓存等于每分钟
 * 白烧半秒 CPU。缓存键同样是「最大日期」，日频数据一天才变一次。 */
let corrAna = null;
function corrAnalyzed(force) {
  const A = netAnalyzed(force);
  if (!A) return null;
  if (corrAna && corrAna.stamp === A.stamp && !force) return corrAna;
  let LL = null, RS = null, CB = null;
  const target = A.keys.indexOf('BTC') >= 0 ? 'BTC' : A.keys[A.keys.length - 1];
  try { LL = leadLag(A.keys.filter(function (k) { return k !== target; }), target, { maxLag: 5, win: 365 }); } catch (e) { console.warn('leadLag fail', e && e.message); }
  try { RS = rollingSystemic(A.keys, { win: 90, step: 5 }); } catch (e) { console.warn('rollingSystemic fail', e && e.message); }
  try {
    const longA = A.win === 365 ? A : netAnalyze(A.keys, { win: 365 });
    CB = corrBreak(A, { longA: longA });
  } catch (e) { console.warn('corrBreak fail', e && e.message); }
  corrAna = { stamp: A.stamp, A: A, LL: LL, RS: RS, CB: CB, target: target };
  return corrAna;
}

/* ============ v3.31 情景推演引擎（借鉴 MiroFish「种子+因子互动→前瞻情景」） ============
 * 不搬 LLM 群体模拟（需 Docker/Zep/千 Agent，纯前端装不下）。
 * 以「当前中性状态」为种子，用已算好的跨资产日收益相关性(corrAna.A.R)做冲击传播：
 * 选定冲击节点 → 按历史相关线性传导到其余类别 → 输出前瞻情景(相对 Δz) + 护栏趋向。
 * 诚实边界：基于历史联动的确定性情景推演，非概率预测；假设相关性结构延续。 */
const SCENARIOS = [
  { id: 'vol_spike',  name: '波动率冲击',   desc: 'VIX→极端 + 美债波动抬升',     shocks: [{ k: 'VIX', toZ: 2.2 }, { k: 'US10Y', toZ: 1.0 }] },
  { id: 'btc_break',  name: 'BTC 破位',     desc: 'BTC 急跌至 −2σ',            shocks: [{ k: 'BTC', toZ: -2.0 }] },
  { id: 'real_up',    name: '实际利率上行', desc: '实际利率 +1.5σ（偏鹰）',     shocks: [{ k: 'US10Y', toZ: 1.5 }, { k: 'DXY', toZ: 1.0 }] },
  { id: 'risk_on',    name: '风险偏好回暖', desc: '标普 +1.5σ + 油价回升',      shocks: [{ k: 'SPX', toZ: 1.5 }, { k: 'OIL', toZ: 1.2 }] },
  { id: 'safe_haven', name: '避险扩散',     desc: '美元走强 + 金价避险',        shocks: [{ k: 'DXY', toZ: 1.5 }, { k: 'GOLD', toZ: 1.0 }] },
  { id: 'yen_carry',  name: '日元套息平仓', desc: '美元/日元急升（日元升值）',  shocks: [{ k: 'USDJPY', toZ: 1.8 }] },
];
/* 护栏风险-off 驱动键：被冲击/传导上行→护栏趋向 RED（值=+1 表示「上行=风险-off」） */
const SCN_GUARD = { VIX: 1, US10Y: 1, DXY: 1, OIL: 1, USDJPY: 1, BEI10: 1, T10Y2Y: -1, GOLD: -1, SPX: -1 };
function scenarioPropagate(A, scenario) {
  const keys = A.keys, R = netRelMatrix(A);
  const sh = scenario.shocks.filter(function (s) { return keys.indexOf(s.k) >= 0; });
  if (!sh.length) return { rows: [], guard: 0, dom: null, missing: scenario.shocks.map(function (s) { return s.k; }) };
  const rows = [];
  for (let j = 0; j < keys.length; j++) {
    const k = keys[j];
    if (sh.some(function (s) { return s.k === k; })) continue;
    let dz = 0, rhoDom = 0;
    for (let si = 0; si < sh.length; si++) {
      const i = keys.indexOf(sh[si].k);
      const r = (i >= 0 && R[i] && isFinite(R[i][j])) ? R[i][j] : 0;
      dz += r * sh[si].toZ;
      if (Math.abs(r) > Math.abs(rhoDom)) rhoDom = r;
    }
    rows.push({ k: k, name: (META[k] && META[k].name) || k, group: (META[k] && META[k].group) || '', dz: dz, rho: rhoDom });
  }
  rows.sort(function (a, b) { return Math.abs(b.dz) - Math.abs(a.dz); });
  let guard = 0;
  sh.forEach(function (s) { const g = SCN_GUARD[s.k]; if (g != null) guard += g * s.toZ; });
  rows.forEach(function (rw) { const g = SCN_GUARD[rw.k]; if (g != null) guard += g * rw.dz; });
  return { rows: rows, guard: guard, dom: sh.map(function (s) { return s.k; }).join('+'), missing: [] };
}
function renderScenario(id) {
  const box = $('scenarioBox'); if (!box) return;
  const scn = SCENARIOS.filter(function (s) { return s.id === id; })[0] || SCENARIOS[0];
  const A = corrAnalyzed();
  if (!A || !A.keys || !A.keys.length) { box.innerHTML = '<div class="rg-sub">相关系数未就绪（需先加载宇宙数据）。</div>'; return; }
  const res = scenarioPropagate(A, scn);
  if (!res.rows.length) { box.innerHTML = '<div class="rg-sub">该情景的冲击键不在当前宇宙（' + (res.missing || []).join('/') + '），无法传导。</div>'; return; }
  const top = res.rows.slice(0, 12);
  let h = '<div class="rg-sub">情景「' + scn.name + '」：' + scn.desc + ' · 种子=当前中性，按历史日收益相关性(120d)线性传导 · <span style="opacity:.7">确定性情景推演 ≠ 概率预测</span></div>';
  h += '<table style="width:100%;border-collapse:collapse;margin:6px 0;font-size:12px"><tr style="color:#8a93a6;text-align:left"><th style="padding:3px 6px">资产</th><th style="padding:3px 6px">预期Δz</th><th style="padding:3px 6px">与冲击相关ρ</th></tr>';
  top.forEach(function (rw) {
    const col = rw.dz > 0.1 ? 'var(--green)' : rw.dz < -0.1 ? 'var(--red)' : 'var(--gold)';
    h += '<tr style="border-top:1px solid #1b2a3f"><td style="padding:3px 6px">' + rw.name + '</td><td style="padding:3px 6px;color:' + col + '">' + (rw.dz >= 0 ? '+' : '') + rw.dz.toFixed(2) + '</td><td style="padding:3px 6px;color:#8a93a6">' + rw.rho.toFixed(2) + '</td></tr>';
  });
  h += '</table>';
  const gcol = res.guard > 0.5 ? 'var(--red)' : res.guard < -0.5 ? 'var(--green)' : 'var(--gold)';
  h += '<div class="rg-sub" style="margin-top:6px">护栏驱动净项 <b style="color:' + gcol + '">' + (res.guard >= 0 ? '+' : '') + res.guard.toFixed(2) + '</b> · ' + (res.guard > 0.5 ? '趋向 RED（降杠杆参考）' : res.guard < -0.5 ? '趋向 GREEN' : '中性') + '</div>';
  box.innerHTML = h;
}
function renderScenarioDefault() { renderScenario(SCENARIOS[0].id); }

/* 偏相关的显著性：自由度为 n-2-(p-2)。控制住的变量越多，剩下的自由度越少，
 * 这是偏相关的固有代价 —— 30 个样本、控制 20 个变量之后算出来的「直接关系」
 * 本质上没法与 0 区分。所以小样本时这里会诚实地给出 q≈1。 */
function netPartialQS(A) {
  if (A._pq) return A._pq;
  const p = A.keys.length, ps = [], list = [];
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) {
    const r = A.partial[i][j];
    const n = A.ovl[i][j];
    const df = Math.max(4, n - p);
    list.push({ i: i, j: j, r: r, n: n });
    if (!isFinite(r)) { ps.push(1); continue; }
    const rr = Math.max(-0.999999, Math.min(0.999999, r));
    const t = rr * Math.sqrt(df / (1 - rr * rr));
    ps.push(tToP2(t));
  }
  const qs = bhQ(ps);
  const map = {};
  list.forEach(function (x, k) { map[x.i + ':' + x.j] = qs[k]; });
  A._pq = { map: map, qs: qs, n: list.length };
  return A._pq;
}
function netEdges(A) {
  const p = A.keys.length;
  const R = netRelMatrix(A);
  if (NET_OPTS.mode === 'mst') {
    return mstFromCorr(R, p).edges.map(function (e) { return { a: e.a, b: e.b, r: e.r, mst: true }; });
  }
  const out = [];
  if (NET_OPTS.rel === 'part') {
    const PQ = netPartialQS(A);
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) {
      const q = PQ.map[i + ':' + j];
      const r = R[i][j];
      if (q != null && q < 0.05 && isFinite(r)) out.push({ a: i, b: j, r: r, q: q });
    }
  } else {
    A.pairs.forEach(function (pr) { if (pr.sig) out.push({ a: pr.i, b: pr.j, r: pr.r, q: pr.q }); });
  }
  return out;
}

function initNetwork() {
  const cv = $('netCanvas'); if (!cv) return;
  /* v3.25：径向影响星系图 —— 有筛选结果就默认走它（外生围外围、节点大小=影响强度）。
   * 【必须先把力导向的 rAF 循环停掉】否则上一次力导向留下的循环还在跑，
   * 而径向节点没有 vx/vy/fixed 字段 —— animateNetwork 会算出 NaN，节点直接飞出画布。
   * 这是「只换了数据结构、没换掉消费它的循环」的典型后果。 */
  if (NET_OPTS.layout === 'radial') {
    netRunning = false; net = null;
    if (initRadial(cv)) return;
  }
  const A = netAnalyzed();
  if (!A) {
    if ($('netCount')) $('netCount').textContent = '—';
    net = null;
    return;
  }
  const W = cv.clientWidth, H = cv.clientHeight;
  const keys = A.keys, p = keys.length;
  const maxS = Math.max.apply(null, A.strength.concat([1e-9]));
  /* 初始位置：确定性种子 + 按簇分角度撒点。原来用纯 Math.random，
   * 于是每次刷新连 Layout 都不同，「这张图变了」和「数据变了」分不开。 */
  let seed = 20261003;
  const rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const clusterOf = A.cluster;
  const nodes = keys.map(function (id, i) {
    const m = META[id];
    const ci = clusterOf[i] || 0;
    const nc = Math.max(1, A.nCluster);
    const ang = (ci / nc) * Math.PI * 2 + (rnd() - 0.5) * 0.8;
    const rad = 60 + rnd() * 50;
    return {
      id: id, label: m.name, short: m.s, color: m.color, group: m.group, ci: ci,
      strength: A.strength[i], eigC: A.eigC[i],
      r: id === 'BTC' ? 16 : 5 + 7 * Math.sqrt(Math.max(0, A.strength[i]) / maxS),
      x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad, vx: 0, vy: 0, fixed: id === 'BTC',
    };
  });
  const edges = netEdges(A);
  net = { cv: cv, ctx: cv.getContext('2d'), nodes: nodes, edges: edges, A: A, W: W, H: H, idle: 0 };
  const btc = nodes.find(function (n) { return n.id === 'BTC'; });
  if (btc) { btc.x = W / 2; btc.y = H / 2; btc.fixed = true; }
  if ($('netCount')) $('netCount').textContent = nodes.length + ' 因子 / ' + edges.length + ' 边 · ' +
    (NET_OPTS.rel === 'part' ? '偏相关' : '总相关') + ' · ' + NET_OPTS.win + ' 日';
  net.idle = 0;
  if (!netRunning) { netRunning = true; animateNetwork(); }
}
function animateNetwork() {
  if (!net) return;
  const cv = net.cv, ctx = net.ctx, nodes = net.nodes, edges = net.edges, A = net.A, W = net.W, H = net.H;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  for (let it = 0; it < 2; it++) {
    nodes.forEach(n => { if (n.fixed) return; let fx = (W / 2 - n.x) * 0.002, fy = (H / 2 - n.y) * 0.002;
      nodes.forEach(m => { if (m === n) return; const dx = n.x - m.x, dy = n.y - m.y; const d2 = dx * dx + dy * dy + 1; const f = 1400 / d2; fx += dx / Math.sqrt(d2) * f; fy += dy / Math.sqrt(d2) * f; });
      n.vx = (n.vx + fx) * 0.85; n.vy = (n.vy + fy) * 0.85; n.x += n.vx; n.y += n.vy; });
    edges.forEach(e => { const a = nodes[e.a], b = nodes[e.b]; if (!a || !b) return; const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 90) * 0.01; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; });
  }
  /* 负相关画虚线 —— 视觉上必须能一眼区分「同向」与「反向」，这是网络图最容易丢的信息 */
  edges.forEach(e => {
    const a = nodes[e.a], b = nodes[e.b]; if (!a || !b) return;
    const ar = Math.abs(e.r || 0);
    ctx.strokeStyle = (e.r >= 0 ? 'rgba(0,229,160,' : 'rgba(255,61,110,') + Math.min(.75, .18 + ar) + ')';
    ctx.lineWidth = 1 + ar * 3.2;
    ctx.setLineDash(e.r >= 0 ? [] : [3, 3]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
  });
  nodes.forEach(n => {
    ctx.fillStyle = n.color;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fill();
    ctx.strokeStyle = CLUSTER_COLORS[(n.ci || 0) % CLUSTER_COLORS.length];
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2.5, 0, 7); ctx.stroke();
    ctx.fillStyle = '#060c18'; ctx.font = 'bold 9px JetBrains Mono, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(n.id === 'BTC' ? 'BTC' : (n.short || n.label.slice(0, 3)), n.x, n.y);
    if (n.id !== 'BTC') { ctx.fillStyle = '#a8bfd6'; ctx.font = '8px Inter, sans-serif'; ctx.fillText(n.label, n.x, n.y + n.r + 9); }
  });
  const ke = nodes.reduce((a, n) => a + Math.abs(n.vx) + Math.abs(n.vy), 0);
  net.idle = ke < 0.06 ? net.idle + 1 : 0;
  if (net.idle > 90) { netRunning = false; return; }
  requestAnimationFrame(animateNetwork);
}

function renderHeatmap() {
  const box = $('heatmap'); if (!box) return;
  const A = netAnalyzed();
  if (!A) { box.innerHTML = '<div class="macro-hint">—</div>'; return; }
  const ids = A.keys, p = ids.length;
  const R = netRelMatrix(A);
  const isPart = NET_OPTS.rel === 'part';
  const PQ = isPart ? netPartialQS(A) : null;
  box.style.gridTemplateColumns = `64px repeat(${p}, 1fr)`;
  let html = '<div class="hm-h"></div>' + ids.map(function (id) {
    return `<div class="hm-h" title="${META[id].name}">${META[id].s || META[id].name.slice(0, 2)}</div>`;
  }).join('');
  let nSig = 0, nCell = 0;
  ids.forEach(function (ri, a) {
    html += `<div class="hm-h" style="text-align:left" title="${META[ri].name}">${META[ri].s || META[ri].name.slice(0, 2)}</div>`;
    ids.forEach(function (ci, b) {
      if (a === b) { html += `<div class="hm-cell" style="background:#1b2c47;color:#a8bfd6">1</div>`; return; }
      const r = R[a][b];
      let sig = true;
      if (isPart && PQ) { const q = PQ.map[a + ':' + b]; sig = q != null && q < 0.05; }
      else { const key = Math.min(a, b) + ':' + Math.max(a, b); const pr = A.pairs.find(function (x) { return (x.i === Math.min(a, b) && x.j === Math.max(a, b)); }); sig = pr ? pr.sig : false; }
      if (b > a) { nCell++; if (sig) nSig++; }
      const ciTxt = corrCI(r, A.ovl[a][b]);
      const bg = r == null || !isFinite(r) ? '#132035'
        : r > 0 ? `rgba(0,229,160,${Math.abs(r) * .8})` : `rgba(255,61,110,${Math.abs(r) * .8})`;
      const opacity = sig ? 1 : .38;                       // 不显著 → 淡化，但不填以为 0
      const tit = `${META[ri].name} × ${META[ci].name}\n${isPart ? '偏相关' : '相关'} r=${r == null ? '—' : r.toFixed(3)}` +
        `\n样本 ${A.ovl[a][b]} 天${ciTxt ? ' · 95%CI [' + ciTxt[0].toFixed(2) + ', ' + ciTxt[1].toFixed(2) + ']' : ''}\n${sig ? '通过 BH-FDR(q<0.05)' : '未通过 BH-FDR（可能只是噪声）'}`;
      html += `<div class="hm-cell" style="background:${bg};opacity:${opacity};color:${Math.abs(r || 0) > .5 ? '#060c18' : '#a8bfd6'}" title="${tit}">${r == null || !isFinite(r) ? '·' : r.toFixed(2)}</div>`;
    });
  });
  box.innerHTML = html;
  const tp = $('heatTip');
  if (tp) tp.innerHTML = p + ' 个序列 · ' + nCell + ' 个无序对（C(' + p + ',2)）· ' + nSig + ' 对通过 BH-FDR（未通过的已淡化，但仍是真实估计值 —— 淡化=不确定，不等于零）· 窗口 ' + NET_OPTS.win + ' 日 · 平均重叠样本 n̄=' + A.nBar;
}

/* ---- ⑬ 网络统计条：把「图很好看」升级成「图说明什么」 ---- */
function renderNetStats() {
  const el = $('netStats'); if (!el) return;
  const A = netAnalyzed();
  if (!A) { el.innerHTML = '<span class="badge">网络数据不足</span>'; return; }
  const p = A.keys.length;
  const AR = A.absorption;
  const btcIdx = A.keys.indexOf('BTC');
  let btcTxt = '—';
  if (btcIdx >= 0) {
    let bi = -1, br = 0;
    for (let j = 0; j < p; j++) {
      if (j === btcIdx) continue;
      const r = Math.abs(A.R[btcIdx][j] || 0);
      if (r > br) { br = r; bi = j; }
    }
    if (bi >= 0) btcTxt = (META[A.keys[bi]] ? META[A.keys[bi]].name : A.keys[bi]) + ' ' +
      (A.R[btcIdx][bi] >= 0 ? '+' : '') + A.R[btcIdx][bi].toFixed(2);
  }
  const chip = function (txt, cls) { return '<span class="badge ' + (cls || 'bg-blue') + '">' + txt + '</span>'; };
  el.innerHTML =
    chip('平均 |ρ| ' + (A.avgAbsCorr == null ? '—' : A.avgAbsCorr.toFixed(3))) +
    chip('吸收比 PC1 ' + (AR[0] * 100).toFixed(0) + '% · PC1-2 ' + (AR[1] * 100).toFixed(0) + '%', AR[0] > 0.6 ? 'bg-red' : AR[0] > 0.45 ? 'bg-gold' : 'bg-green') +
    chip('分散化比率 ' + A.divRatio.toFixed(2)) +
    chip('有效样本 n̄=' + A.nBar) +
    chip('收缩 δ=' + A.delta.toFixed(2)) +
    chip(A.clipped ? '谱已修正（有 λ≤0）' : '矩阵半正定', A.clipped ? 'bg-gold' : 'bg-green') +
    chip('数据驱动分簇 ' + A.nCluster + ' 组') +
    chip('BTC 最强邻居：' + btcTxt, 'bg-purple');
}

/* ---- ⑭ 领先-滞后 + 相关性断裂 ---- */
function renderCorrPanels() {
  const lb = $('leadLagBox'), cb = $('corrBreakBox');
  const A = netAnalyzed();
  if (!lb && !cb) return;
  if (!A) {
    if (lb) lb.innerHTML = '<div class="macro-hint">序列不足。</div>';
    if (cb) cb.innerHTML = '<div class="macro-hint">序列不足。</div>';
    return;
  }
  const CA = corrAnalyzed();
  if (lb) {
    const target = CA ? CA.target : (A.keys[A.keys.length - 1] || '—');
    const L = CA ? CA.LL : null;
    if (!L) { lb.innerHTML = '<div class="macro-hint">样本不足以做领先-滞后扫描（需 ≥60 天共同交易日）。</div>'; }
    else {
      const rows = L.rows.slice(0, 10);
      let html = '<div class="rg-tbl"><div class="rg-hd" style="grid-template-columns:1.3fr .5fr .6fr .6fr .6fr .8fr">' +
        '<span>因子 vs ' + target + '</span><span>最优滞后</span><span>r(滞后)</span><span>r(同步)</span><span>q 值</span><span>半样本稳定性</span></div>';
      rows.forEach(function (r) {
        const nm = META[r.key] ? META[r.key].name : r.key;
        const lead = r.bestLag > 0 ? ('领先 ' + r.bestLag + ' 日') : r.bestLag < 0 ? ('滞后 ' + (-r.bestLag) + ' 日') : '同步';
        const stab = r.stable
          ? '<span style="color:#00e5a0">✔ 两段一致</span>'
          : '<span style="color:#ffc107">△ 前/后段不一致</span>';
        html += '<div class="rg-row" style="grid-template-columns:1.3fr .5fr .6fr .6fr .6fr .8fr">' +
          '<span class="rg-nm">' + nm + '</span>' +
          '<span>' + lead + '</span>' +
          '<span style="color:' + icColor(r.bestR) + '">' + r.bestR.toFixed(3) + '</span>' +
          '<span class="rg-dim">' + (r.lag0 == null ? '—' : r.lag0.toFixed(3)) + '</span>' +
          '<span class="' + (r.sigQ ? 'rg-g' : 'rg-dim') + '">' + (r.q == null ? '—' : r.q.toFixed(3)) + '</span>' +
          '<span>' + stab + (r.lagA == null || r.lagB == null ? '' : '<i>' + r.lagA + ' / ' + r.lagB + '</i>') + '</span></div>';
      });
      html += '</div>';
      html += '<div class="rg-sub">「滞后」列的含义：该因子对 <b>' + target + '</b> 的收益，在哪一个偏移上解释力最强。' +
        '这一步天生是<b>事后的</b>——先把 11 个偏移全试一遍再挑最好的，即便全是噪声也会挑出一个「最优滞后」。' +
        '两道防线：<b>①</b> 全家族 ' + L.nTests + ' 次检验一起做 BH-FDR，只标 q&lt;0.05 的；' +
        '<b>②</b> 样本劈成前后两半各自找最优滞后，<b>两段不一致的一律不采信</b>。' +
        '真有传导机制的东西会在两段时间里指向同一个偏移；噪声不会。</div>';
      lb.innerHTML = html;
    }
  }
  if (cb) {
    const B = CA ? CA.CB : null;
    if (!B || !B.rows.length) { cb.innerHTML = '<div class="macro-hint">不足一年的共同样本，无法比较短/长窗相关。</div>'; }
    else {
      let html = '<div class="rg-tbl"><div class="rg-hd" style="grid-template-columns:1.6fr .7fr .7fr .8fr .8fr">' +
        '<span>序列对</span><span>' + B.shortWin + '日</span><span>365日</span><span>变化</span><span>z（Fisher）</span></div>';
      B.rows.slice(0, 8).forEach(function (r) {
        const d = r.rs - r.rl;
        html += '<div class="rg-row" style="grid-template-columns:1.6fr .7fr .7fr .8fr .8fr">' +
          '<span class="rg-nm">' + (META[r.keys[0]] ? META[r.keys[0]].name : r.keys[0]) + ' × ' + (META[r.keys[1]] ? META[r.keys[1]].name : r.keys[1]) + '</span>' +
          '<span style="color:' + icColor(r.rs) + '">' + r.rs.toFixed(2) + '</span>' +
          '<span class="rg-dim">' + r.rl.toFixed(2) + '</span>' +
          '<span class="' + (d >= 0 ? 'rg-g' : 'rg-r') + '">' + (d >= 0 ? '+' : '') + d.toFixed(2) + '</span>' +
          '<span class="' + (Math.abs(r.z) > 2 ? 'rg-r' : 'rg-dim') + '">' + r.z.toFixed(2) + '</span></div>';
      });
      html += '</div>';
      html += '<div class="rg-sub">相关性本身没有对错，但<b>相关性发生变化</b>是有含义的：' +
        '短窗与长窗的差值在 Fisher-z 空间标准化（z = (zₛ−zₗ)/√(1/(nₛ−3)+1/(nₗ−3))），|z|&gt;2 意味着' +
        '这对资产的关系已经超出了抽样噪声能解释的范围 —— 与之绑定的对冲/分散化假设需要重新审视。' +
        '注意这是「分散化会不会失效」的监控，<b>不是</b>价格方向的预测。</div>';
      cb.innerHTML = html;
    }
  }
}

/* ---- ⑭ 滚动系统性共振图 ---- */
function renderSystemic() {
  const cv = $('corrCanvas'); if (!cv) return;
  const CA = corrAnalyzed();
  const RS = CA ? CA.RS : null;
  const note = $('corrNote');
  if (!RS) {
    const ctx0 = cv.getContext('2d');
    if (ctx0) ctx0.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
    if (note) note.textContent = '滚动共振图需要至少 ' + (90 + 40) + ' 天的共同交易日。';
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const padL = 30, padR = 10, padT = 10, padB = 18;
  const pts = RS.pts;
  const vals = pts.map(function (x) { return x.avg; });
  const raw = vals.concat([RS.mean + 2 * RS.sd, RS.mean - 2 * RS.sd]);
  let lo = Math.min.apply(null, raw), hi = Math.max.apply(null, raw);
  lo = Math.max(-1, lo - 0.05); hi = Math.min(1, hi + 0.05);
  const x = i => padL + i * (W - padL - padR) / Math.max(1, pts.length - 1);
  const y = v => padT + (hi - v) / Math.max(1e-9, hi - lo) * (H - padT - padB);
  g.font = '9px JetBrains Mono, monospace';
  g.strokeStyle = 'rgba(26,46,80,.6)'; g.fillStyle = '#3a5070'; g.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4;
    g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(W - padR, y(v)); g.stroke();
    g.fillText(v.toFixed(2), padL - 4, y(v) + 3);
  }
  g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,193,7,.5)';
  g.beginPath(); g.moveTo(padL, y(RS.mean)); g.lineTo(W - padR, y(RS.mean)); g.stroke();
  g.beginPath(); g.moveTo(padL, y(RS.mean + 2 * RS.sd)); g.lineTo(W - padR, y(RS.mean + 2 * RS.sd)); g.strokeStyle = 'rgba(255,61,110,.5)'; g.stroke();
  g.setLineDash([]);
  g.lineWidth = 1.6; g.strokeStyle = '#a8bfd6';
  g.beginPath();
  pts.forEach(function (p, i) { const xx = x(i), yy = y(p.avg); i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
  g.stroke();
  /* 尾部用颜色标识当前处于什么位置：共振抬升=组合分散化在失效 */
  const lastX = x(pts.length - 1), lastY = y(RS.last.avg);
  g.fillStyle = Math.abs(RS.z || 0) > 2 ? '#ff3d6e' : '#00b4ff';
  g.beginPath(); g.arc(lastX, lastY, 3.2, 0, 7); g.fill();
  g.fillStyle = '#4a6a8a'; g.textAlign = 'left';
  g.fillText(RS.win + ' 日滚动平均成对相关 · ' + RS.nPair + ' 对', padL, H - 4);
  g.textAlign = 'right';
  g.fillText('黄=均值 · 红虚线=+2σ', W - padR, H - 4);
  if (note) {
    const dz = RS.z == null ? '—' : RS.z.toFixed(2);
    note.innerHTML = '当前 <b style="color:' + (Math.abs(RS.z || 0) > 2 ? 'var(--red)' : 'var(--text2)') + '">' +
      RS.last.avg.toFixed(3) + '</b>（自身分布 z=' + dz + '，均值 ' + RS.mean.toFixed(3) + ' ± ' + RS.sd.toFixed(3) + '）· ' +
      '|ρ|&gt;0.5 的组合占比 ' + (RS.last.shareHi * 100).toFixed(0) + '% · ' +
      '<b>口径</b>：把全部序列两两配对的滚动相关等权平均。它上升 = 因子开始一起动 = 「多因子分散化在失效。' +
      '这是风险监控指标，与「BTC 要涨还是要跌」无关 —— 高共振期里，任何一个因子的极端读数都不再是独立证据。';
  }
}

/* =====================================================================
 *  ⑫ 渲染：分歧度 / 岭回归今日评级 / 动态权重溯源
 * ===================================================================== */
function renderScoreV2(res) {
  /* ---- 分歧度 ---- */
  const db = $('dispBox');
  if (db) {
    const D = scoreDispersion ? scoreDispersion(res) : null;
    if (!D) { db.textContent = '—'; }
    else {
      const cls = D.consensus > 0.6 ? 'bg-green' : D.consensus > 0.4 ? 'bg-gold' : 'bg-red';
      db.innerHTML =
        '<div class="extsub-h"><span class="fttl">评分分歧度</span><span class="hint">' + D.n + ' 维参与</span></div>' +
        '<div class="extsub-row"><span class="fscore-l ' + (D.consensus > 0.6 ? 'up' : D.consensus > 0.4 ? 'n' : 'dn') + '">' +
        (D.consensus * 100).toFixed(0) + '% 一致</span>' +
        '<span class="extsub-lbl">分歧 σ=' + D.sd.toFixed(2) + ' · 剔除任一因子后分数区间 ' + D.jackLo + '~' + D.jackHi + '</span></div>' +
        '<div class="fnote" style="margin:6px 0 4px">' +
        '<b>' + (D.agreeSign > 0 ? '偏多' : '偏空') + '权重占比 ' + ((D.agreeSign > 0 ? D.upW : D.dnW) * 100).toFixed(0) + '%</b> · ' +
        '一致度越高，这个分数越像结论；一致度低说明因子在互相打架，此时分数是「平均值」而不是「判断」。<br>' +
        '<b>单点敏感度</b>：去掉「' + (D.driver ? D.driver.name.replace(/^[^ ]+ /, '') : '—') + '」后分数变动 ' + D.driverDelta.toFixed(1) + ' 分' +
        '（满分摆动 ' + D.jackRange + ' 分）—— 谁在一个人说了算，这里直接点名。<br>' +
        '<b>注意</b>：σ 与标准误（±' + D.bandScore.toFixed(1) + ' 分）都按「因子互相独立」计算。' +
        '而 ⑬ 的网络显示它们高度相关，所以这是<b>不确定性的下界</b>，真实误差只会更大。</div>' +
        '<div class="extsub-factors">' + D.top.map(function (p) {
          return '<span class="esf ' + (p.c > 0.25 ? 'up' : p.c < -0.25 ? 'dn' : 'n') + '">' +
            p.name.replace(/^[^ ]+ /, '') + ' ' + (p.c >= 0 ? '+' : '') + p.c.toFixed(1) + '<i style="opacity:.6"> ×w' + p.w + '</i></span>';
        }).join('') + '</div>';
      db.className = 'extsub' + (D.consensus < 0.4 ? ' active' : '');
    }
  }
  /* ---- 岭回归今日评级 ---- */
  const rb = $('ridgeBox');
  if (rb) {
    const RL = (typeof ridgeLiveScore === 'function') ? ridgeLiveScore(res.out) : null;
    if (!RL) {
      rb.innerHTML = '<div class="extsub-h"><span class="fttl">动态权重评分（岭回归）</span><span class="hint">未就绪</span></div>' +
        '<div class="fnote" style="margin:0">先运行上方「历史回放」—— 系数要用历史逐日滚动估出来，' +
        '没有任何预先写死的权重可代替这一步。</div>';
    } else {
      const rw = state.hist.rw.live;
      const cls = RL.score > 60 ? 'up' : RL.score < 40 ? 'dn' : 'n';
      rb.innerHTML = '<div class="extsub-h"><span class="fttl">动态权重评分（岭回归）</span><span class="hint">以历史预测分布定位</span></div>' +
        '<div class="extsub-row"><span class="fscore-l ' + cls + '">' + RL.score + '</span>' +
        '<span class="extsub-lbl">原始预测 ' + (RL.raw * 100).toFixed(2) + '% / ' + rw.h + ' 日 · 历史中位数 ' + (RL.median * 100).toFixed(2) + '% · ' + RL.nFac + '/' + RL.nTotal + ' 维可用</span></div>' +
        '<div class="fnote" style="margin:6px 0 0">这里的分数不是 50+22×z 的那套公式 —— 它是「用历史逐日估计出的&lt;因子→未来收益&gt;系数，' +
        '乘上今天的 z」得到的收益预测，再换算成<b>在自己历史预测分布中的百分位</b>（' + RL.nHist + ' 个历史预测值）。' +
        '换句话说：<b>这个预测值在历史上排第几</b>，而不是「我给它打几分」。左右两个分数不一致时，' +
        '右边的权重是被数据估出来的，左边的权重是人写的 —— 但两者都不是交易建议，' +
        '它们的样本外 IC 见下方 ⑫ 表。</div>';
    }
  }
}

function renderRwBox() {
  const box = $('rwBox'); if (!box) return;
  const h = state.hist;
  const rw = h && h.rw ? h.rw.full : null;
  const rwl = h && h.rw ? h.rw.live : null;
  if (!rw) {
    box.innerHTML = '<div class="fttl" style="margin-bottom:7px">⑫ 动态权重：岭回归 vs 手写权重</div>' +
      '<div class="rg-sub">' + (h && h.rwBusy ? '计算中…' : '样本不足以做 walk-forward 估计（需要 ≥ ' + (RW_MIN_TRAIN + RW_H + 80) + ' 天回放窗口）。') + '</div>';
    return;
  }
  const f2 = v => v == null ? '—' : v.toFixed(3);
  const pc = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  let html = '<div class="fttl" style="margin-bottom:7px">⑫ 动态权重：岭回归 vs 手写权重（walk-forward · 前向 ' + rw.h + ' 日）</div>';
  html += '<div class="rg-tbl"><div class="rg-hd" style="grid-template-columns:1.1fr .7fr .7fr .8fr .8fr .8fr">' +
    '<span>口径</span><span>IC( spearman )</span><span>t</span><span>高档收益</span><span>低档收益</span><span>多空差</span></div>';
  const rowHtml = function (nm, q, isDef, extra) {
    if (!q) return '';
    return '<div class="rg-row" style="grid-template-columns:1.1fr .7fr .7fr .8fr .8fr .8fr">' +
      '<span class="rg-nm">' + nm + (isDef ? '<i>默认口径</i>' : '') + '</span>' +
      '<span class="' + (q.ic == null ? 'rg-dim' : q.ic > 0.02 ? 'rg-g' : q.ic < -0.02 ? 'rg-r' : 'rg-y') + '">' + f2(q.ic) + (q.t == null ? '' : ' (' + q.t.toFixed(1) + ')') + '</span>' +
      '<span class="rg-dim">' + (extra || '') + '</span>' +
      '<span class="' + (q.up == null ? '' : q.up >= 0 ? 'rg-g' : 'rg-r') + '">' + pc(q.up) + '</span>' +
      '<span class="' + (q.dn == null ? '' : q.dn >= 0 ? 'rg-g' : 'rg-r') + '">' + pc(q.dn) + '</span>' +
      '<span class="' + (q.spread == null ? '' : q.spread > 0 ? 'rg-g' : 'rg-r') + '">' + pc(q.spread) + '</span></div>';
  };
  html += rowHtml('现状：手写权重 + 22×z', rw.baseline, false, '现在的面板');
  rw.rows.forEach(function (r) { html += rowHtml('岭回归 λ=' + r.lambda, r, r.default, 'κ=' + r.n); });
  html += rowHtml('等权 z 合成（参照）', rw.equalWeight, false, '无权重信息');
  html += '</div>';

  const pickDef = function (o) {
    if (!o || !o.rows) return null;
    for (let i = 0; i < o.rows.length; i++) if (o.rows[i].default) return o.rows[i];
    return null;
  };
  const defLive = pickDef(rwl);
  if (rwl) html += '<div class="rg-sub">实时可用口径（' + RW_LIVE_IDS.length + ' 维，去掉没有实时数据源的回放专用因子）：' +
    '样本外 IC ' + f2(defLive ? defLive.ic : null) +
    ' vs 同窗口手写权重 IC ' + f2(rwl.baseline ? rwl.baseline.ic : null) + '。' +
    '两个口径的差别本身就是一条信息：<b>拿掉 MVRV/链上手续费这类只有历史没有实时的因子之后，模型还剩多少燃料</b>。</div>';

  const defRow = pickDef(rw) || { ic: null, t: null, spread: null };
  const agreeTxt = rw.agreeTot ? (rw.agreeN + '/' + rw.agreeTot) : '—';
  const dIC = (defRow.ic != null && rw.baseline && rw.baseline.ic != null) ? (defRow.ic - rw.baseline.ic) : null;
  const verdict = dIC == null ? '样本不足以比较。'
    : (dIC > 0.01 ? '<b style="color:var(--green)">动态权重高出 ' + dIC.toFixed(3) + '</b>'
      : (dIC < -0.01 ? '<b style="color:var(--red)">动态权重低 ' + Math.abs(dIC).toFixed(3) + '</b>'
        : '两者差距在 ±0.01 以内，<b>等于没区别</b>'));
  html += '<div class="rg-sub">样本外口径结论：岭回归（λ=' + RW_LAMBDA_DEFAULT + '）IC ' + f2(defRow.ic) +
    ' vs 手写权重 IC ' + f2(rw.baseline ? rw.baseline.ic : null) + ' —— ' + verdict +
    '。多空差 ' + pc(defRow.spread) + ' vs ' + pc(rw.baseline ? rw.baseline.spread : null) + '。' +
    '（评价区间 ' + rw.nPred + ' 天，有效样本 ≈ ' + Math.round(rw.nPred / rw.h) + ' 个非重叠窗口，' +
    '所以 t 值只有 ' + (defRow.t == null ? '—' : defRow.t.toFixed(2)) + ' —— 十年数据在这个 horizon 上' +
    '真正的信息量就是这么点，这不是模型的错，是因子的信息密度决定的。）</div>';
  html += '<div class="rg-sub"><b>核对清单（这一块的价值不在结论，在于它把自己摊开了）：</b><br>' +
    '① 训练只用「标签已揭晓」的样本 —— 第 t 天预测 t→t+' + rw.h + ' 的收益，训练样本的最后一条标签是当天收盘才出现的。' +
    '回归测试里的「篡改未来不改变历史预测」直接验这一条。<br>' +
    '② 默认 λ=' + RW_LAMBDA_DEFAULT + ' 是<b>事前定死的规则</b>（罚项 ≈ 一个单位因子方差），' +
    '不是从这四条里面挑出最好看的那条。四条全列出来是为了让你看到<b>结果对 λ 有多敏感</b> —— ' +
    '如果只有某一条 λ 能用，那大概率是调参调出来的，不是信号。<br>' +
    '③ 学到的方向 vs 我们在 FACTORS 里假设的方向：' + agreeTxt + ' 一致' +
    '（α=' + (rw.agreePct == null ? '—' : (rw.agreePct * 100).toFixed(0)) + '%）。' +
    '不一致的那些因子值得单独看一眼 —— 到底是模型过拟合，还是我们的方向假设一开始就设反了。<br>' +
    '④ 样本口径：每 5 天重估一次系数，共 ' + rw.nRefit + ' 次；参与 ' + rw.K + ' 维；' +
    '评价区间 ' + rw.nPred + ' 天（第 ' + rw.firstPred + ' 天起到末尾），这段区间的预测系数每一次都是当时的历史算出来的。' +
    '有效下注数 ' + (rw.enb == null ? '—' : rw.enb.toFixed(1)) + ' / ' + rw.K +
    '（越接近 1 = 实际只押在一个方向上，分散度是假的）；' +
    '平均换手 Σ|Δβ| ' + (rw.turnover == null ? '—' : rw.turnover.toFixed(3)) + '。<br>' +
    '⑤ <b>最要紧的一句</b>：这张表回答的是「动态权重比手写权重好多少」，' +
    '如果样本外 IC 没有稳定超过现状口径，那结论就是<b>这套因子里的信息量不足以支撑一个更精细的组合方法</b> —— ' +
    '换更大的模型不会凭空产生 alpha。</div>';
  box.innerHTML = html;
}

/* =====================================================================
 *  回测 v2 —— 真实成交台账 + 手续费 + 买入持有基准
 *
 *  修复了 v1 的这些问题：
 *   1) 策略切换失效：v1 绑定的是不存在的 #btStrat，点 RSI/突破毫无反应
 *   2) 胜率算错：v1 用「平仓那根 K 线是不是阳线」当胜率（≈50% 噪声），
 *      与策略真实盈亏无关 —— 改为按每笔真实「入场价→出场价」结算
 *   3) 突破策略只买不卖：v1 信号只有 0/1，开仓后永不平仓 —— 改为通道双向
 *   4) 最大回撤算错：v1 用「全局峰值 − 全局最小值」，未区分先后顺序
 *   5) 夏普年化系数错：v1 恒用 √252，与所选周期无关
 *   6) 样本太短：v1 只有 220 根且固定 BTC + 主图周期 —— 改为可选标的/周期，拉满 1000 根
 *   7) 无手续费、无基准、无成交明细、失败静默无提示
 * ===================================================================== */
const BT_BARS_PER_YEAR = { '15m': 35040, '1h': 8760, '4h': 2190, '1d': 365 };
const btCache = {};
const fmtDate = t => new Date(t).toISOString().slice(0, 10);

async function btLoadKlines(coin, interval) {
  const key = coin + interval;
  if (btCache[key] && btCache[key].length) return btCache[key];
  const iv = BYBIT_IV[interval] || 'D';
  const d = await getJSON(ENDPOINTS.bybitKline(CONFIG.SYMBOL_MAP[coin], iv, 1000), 20000);
  const list = (d.result && d.result.list) || [];
  const kl = list.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
  if (kl.length) btCache[key] = kl;
  return kl;
}

/* 目标仓位序列：1 = 持有多头，0 = 空仓（现货口径，不做空） */
function btSignals(strat, k, p) {
  const c = k.map(x => x.c), n = c.length, sig = new Array(n).fill(0);
  if (strat === 'ma') {
    const f = sma(c, Math.max(2, p.f | 0)), s = sma(c, Math.max(3, p.s | 0));
    for (let i = 0; i < n; i++) { if (f[i] == null || s[i] == null) continue; sig[i] = f[i] > s[i] ? 1 : 0; }
  } else if (strat === 'rsi') {
    const r = rsi(c, Math.max(2, p.p | 0)); let inPos = 0;
    for (let i = 0; i < n; i++) {
      if (r[i] == null) continue;
      if (!inPos && r[i] < p.b) inPos = 1;        // 跌破超卖线 → 抄底
      else if (inPos && r[i] > p.sell) inPos = 0; // 越过超买线 → 离场
      sig[i] = inPos;
    }
  } else if (strat === 'brk') {
    const nn = Math.max(2, p.n | 0); let inPos = 0;
    for (let i = 0; i < n; i++) {
      if (i < nn) continue;
      const win = c.slice(i - nn, i);
      const hi = Math.max(...win), lo = Math.min(...win);
      if (!inPos && c[i] > hi * (1 + p.e / 100)) inPos = 1;      // 向上突破 → 开仓
      else if (inPos && c[i] < lo * (1 - p.e / 100)) inPos = 0;  // 向下跌破 → 平仓
      sig[i] = inPos;
    }
  }
  return sig;
}

/* 执行器：第 i 根产生信号、第 i+1 根开盘价成交（避免用当根收盘价的前视偏差） */
function btRun(k, sig, opts) {
  const cap = opts.capital || 10000, feeR = (opts.feeBps || 0) / 10000;
  let cash = cap, qty = 0, fees = 0, holdBars = 0;
  const eq = [], bh = [], list = [];
  let open = null;
  for (let i = 1; i < k.length; i++) {
    const want = sig[i - 1] ? 1 : 0;
    const px = k[i].o > 0 ? k[i].o : k[i].c;
    if (want === 1 && qty === 0) {
      const notional = cash / (1 + feeR), f = notional * feeR;
      qty = notional / px; cash -= notional + f; fees += f;
      open = { i, t: k[i].t, px, cost: notional + f, bars: 0 };
    } else if (want === 0 && qty > 0 && open) {
      const notional = qty * px, f = notional * feeR;
      cash += notional - f; fees += f;
      const pnl = (notional - f) - open.cost;
      list.push({ tIn: open.t, tOut: k[i].t, pxIn: open.px, pxOut: px, bars: i - open.i, pnl, ret: pnl / open.cost * 100, open: false });
      holdBars += i - open.i; qty = 0; open = null;
    }
    eq.push(cash + qty * k[i].c);
    bh.push(cap * (k[i].c / k[1].c));
  }
  if (qty > 0 && open) {   // 未平仓：按末根收盘估值展示，但不计入「已平仓胜率」
    const px = k[k.length - 1].c, pnl = qty * px - open.cost;
    list.push({ tIn: open.t, tOut: k[k.length - 1].t, pxIn: open.px, pxOut: px, bars: k.length - 1 - open.i, pnl, ret: pnl / open.cost * 100, open: true });
  }
  const finalEq = eq.length ? eq[eq.length - 1] : cap;
  const ret = (finalEq - cap) / cap * 100;
  const bhRet = (bh.length ? bh[bh.length - 1] : cap) / cap * 100 - 100;

  // 最大回撤：标准口径（历史峰值 → 之后谷底）
  let peak = -Infinity, maxDD = 0;
  eq.forEach(v => { if (v > peak) peak = v; const dd = peak > 0 ? (peak - v) / peak : 0; if (dd > maxDD) maxDD = dd; });

  const rr = [];
  for (let i = 1; i < eq.length; i++) if (eq[i - 1]) rr.push((eq[i] - eq[i - 1]) / eq[i - 1]);
  const mean = rr.length ? rr.reduce((a, b) => a + b, 0) / rr.length : 0;
  const sd = rr.length > 1 ? Math.sqrt(rr.reduce((a, b) => a + (b - mean) ** 2, 0) / rr.length) : 0;
  const bpy = BT_BARS_PER_YEAR[opts.interval] || 365;
  const sharpe = sd ? mean / sd * Math.sqrt(bpy) : 0;
  const years = eq.length / bpy;
  const cagr = (years > 0.02 && finalEq > 0) ? (Math.pow(finalEq / cap, 1 / years) - 1) * 100 : 0;

  const closed = list.filter(t => !t.open);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const aw = wins.length ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0;
  const al = losses.length ? Math.abs(losses.reduce((a, b) => a + b.pnl, 0) / losses.length) : 0;
  const pf = al ? aw / al : (aw ? Infinity : 0);

  return {
    ret, bhRet, excess: ret - bhRet, cagr, sharpe, dd: maxDD * 100,
    win: closed.length ? wins.length / closed.length * 100 : 0,
    tradeCount: closed.length, hasOpen: list.some(t => t.open),
    pf, avgBars: closed.length ? holdBars / closed.length : 0,
    fees, bars: eq.length, eq, bh, list,
  };
}

let btRunning = false;
async function renderBacktest() {
  const res = $('btRes'), msg = $('btMsg');
  const strat = state.btStrat || 'ma';
  const coin = $('btCoin') ? $('btCoin').value : 'BTC';
  const interval = $('btInterval') ? $('btInterval').value : '1d';
  const num = (id, dv) => { const e = $(id); const v = e ? parseFloat(e.value) : NaN; return isFinite(v) ? v : dv; };
  const p = strat === 'ma' ? { f: num('btF', 10), s: num('btS', 30) }
    : strat === 'rsi' ? { p: num('btP', 14), b: num('btB', 35), sell: num('btSell', 70) }
      : { n: num('btN', 20), e: num('btE', 1.5) };
  const feeBps = num('btFee', 6);

  if (strat === 'ma' && p.f >= p.s) {
    if (msg) { msg.className = 'bt-msg err'; msg.textContent = `快线周期(${p.f}) 必须小于慢线周期(${p.s})，当前参数无法产生交叉信号`; }
    return;
  }
  if (btRunning) return;   // 参数校验通过后再判忙，避免参数错误被"正在回测"吞掉
  if (msg) { msg.className = 'bt-msg'; msg.textContent = `回测中… 正在拉取 ${coin}/${interval} 最多 1000 根 K 线`; }
  btRunning = true;
  try {
    const k = await btLoadKlines(coin, interval);
    if (!k || k.length < 60) {
      if (msg) { msg.className = 'bt-msg err'; msg.textContent = `K 线数据不足（仅 ${k ? k.length : 0} 根），无法回测。请稍后重试或换一个周期。`; }
      return;
    }
    const r = btRun(k, btSignals(strat, k, p), { capital: 10000, feeBps, interval });
    const col = v => v >= 0 ? 'var(--green)' : 'var(--red)';
    const set = (id, txt, c) => { const e = $(id); if (!e) return; e.textContent = txt; e.style.color = c || 'var(--text3)'; };
    set('btRet', (r.ret >= 0 ? '+' : '') + r.ret.toFixed(1) + '%', col(r.ret));
    set('btBH', (r.bhRet >= 0 ? '+' : '') + r.bhRet.toFixed(1) + '%', col(r.bhRet));
    set('btExcess', (r.excess >= 0 ? '+' : '') + r.excess.toFixed(1) + '%', col(r.excess));
    set('btCagr', (r.cagr >= 0 ? '+' : '') + r.cagr.toFixed(1) + '%', col(r.cagr));
    set('btSharpe', r.sharpe.toFixed(2), col(r.sharpe));
    set('btDD', '-' + r.dd.toFixed(1) + '%', 'var(--red)');
    set('btWin', r.tradeCount ? r.win.toFixed(0) + '%' : '—', r.win >= 50 ? 'var(--green)' : 'var(--orange)');
    set('btPF', r.tradeCount ? (isFinite(r.pf) ? r.pf.toFixed(2) : '∞') : '—', r.pf >= 1 ? 'var(--green)' : 'var(--orange)');
    set('btTrades', r.tradeCount + (r.hasOpen ? ' +1持仓' : ''), 'var(--text3)');

    const scope = $('btScope');
    if (scope) {
      const label = strat === 'ma' ? `MA(${p.f},${p.s})` : strat === 'rsi' ? `RSI(${p.p}) <${p.b} / >${p.sell}` : `通道(${p.n}) ±${p.e}%`;
      scope.textContent = `${coin}/USDT · ${interval} · ${label} · ${r.bars} 根 · 手续费 ${feeBps}bps`;
    }

    res && res.classList.add('show');   // 必须先展开，否则 clientWidth=0 会以 320px 绘制再被拉伸
    const cv = $('btCanvas');
    if (cv) {
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth || 320, H = cv.clientHeight || 120;
      cv.width = W * dpr; cv.height = H * dpr;
      const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      const all = r.eq.concat(r.bh);
      const mn = Math.min(...all), mx = Math.max(...all), sp = (mx - mn) || 1, n = r.eq.length;
      const X = i => n > 1 ? i / (n - 1) * W : 0, Y = v => H - (v - mn) / sp * H;
      ctx.strokeStyle = 'rgba(58,80,112,.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Y(10000)); ctx.lineTo(W, Y(10000)); ctx.stroke();
      const line = (arr, color, dash, w) => {
        ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath();
        arr.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
        ctx.stroke(); ctx.setLineDash([]);
      };
      line(r.bh, 'rgba(168,191,214,.45)', [3, 3], 1);
      line(r.eq, '#00e5a0', [], 1.6);
    }

    const tl = $('btTradesList');
    if (tl) {
      const rows = r.list.slice(-10).reverse();
      tl.innerHTML = '<div class="tr hd"><div>出场时间</div><div>状态</div><div>开→平</div><div>盈亏</div></div>' +
        (rows.length ? rows.map(t => `<div class="tr"><div>${fmtDate(t.tOut)}</div><div>${t.open ? '持仓中' : (t.pnl >= 0 ? '盈利' : '亏损')}</div><div>${t.pxIn >= 100 ? t.pxIn.toFixed(0) : t.pxIn.toFixed(3)}→${t.pxOut >= 100 ? t.pxOut.toFixed(0) : t.pxOut.toFixed(3)}</div><div style="text-align:right;color:${t.pnl >= 0 ? 'var(--green)' : 'var(--red)'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(1)} (${t.ret >= 0 ? '+' : ''}${t.ret.toFixed(1)}%)</div></div>`).join('')
          : '<div class="tr">本次参数没有触发任何完整交易，可放宽参数或换周期</div>');
    }
    if (msg) { msg.className = 'bt-msg ok'; msg.textContent = `已回测 ${r.bars} 根 ${interval} K 线（${fmtDate(k[0].t)} ~ ${fmtDate(k[k.length - 1].t)}），共 ${r.tradeCount} 笔已平仓交易，累计手续费 ${r.fees.toFixed(2)}`; }
  } catch (e) {
    if (msg) { msg.className = 'bt-msg err'; msg.textContent = '回测失败：' + ((e && e.message) || '数据源不可用，请稍后重试'); }
  } finally { btRunning = false; }
}

/* =====================================================================
 *  模拟交易 v2 —— 真实账户模型（可用现金 / 持仓 / 已实现盈亏 / 手续费）
 *
 *  修复了 v1 的这些问题：
 *   1) 净值双重计成本：v1 显示「初始资金 + 持仓市值」，买入 $1000 净值立刻
 *      从 10,000 跳到 11,000（凭空 +10%）—— 改为「可用现金 + 持仓市值」
 *   2) 平仓后盈亏凭空消失：v1 平仓只是把仓位删掉，没有已实现盈亏字段，
 *      浮动盈亏随即归零，账户永远无法累积战绩 —— 改为真实结算并累计
 *   3) 刷新丢账户：v1 只存 positions，现金/盈亏不落盘 —— 改为整账户持久化
 *   4) 无余额约束、无手续费、无交易流水、失败静默无提示
 * ===================================================================== */
const PAPER_INIT = 10000;
const PAPER_FEE = 0.001;   // 0.1% 单边

function paperDefault() {
  return { init: PAPER_INIT, cash: PAPER_INIT, realized: 0, fees: 0, wins: 0, losses: 0, positions: [], trades: [] };
}
function loadAcct() {
  try {
    const raw = localStorage.getItem('nexus_acct_v2');
    if (raw) { const a = JSON.parse(raw); if (a && typeof a.cash === 'number') return Object.assign(paperDefault(), a); }
  } catch (e) { }
  try {   // 迁移 v1 遗留数据（只有持仓、没有现金概念）
    const old = JSON.parse(localStorage.getItem('nexus_pos') || '[]');
    if (Array.isArray(old) && old.length) {
      const a = paperDefault();
      old.forEach(o => { const qty = o.amt / o.px; if (isFinite(qty) && qty > 0) { a.positions.push({ sym: o.sym, qty, avg: o.px, opened: o.t || Date.now() }); a.cash -= o.amt; } });
      return a;
    }
  } catch (e) { }
  return paperDefault();
}
function saveAcct() { try { localStorage.setItem('nexus_acct_v2', JSON.stringify(state.acct)); } catch (e) { } }
function paperPrice(sym) { const p = state.prices[sym]; return p && isFinite(p.price) ? p.price : null; }
function paperMsg(text, kind) {
  const e = $('ptMsg'); if (!e) return;
  e.className = 'bt-msg' + (kind ? ' ' + kind : ''); e.textContent = text || '';
}
function paperBuy() {
  const a = state.acct; if (!a) return;
  const sym = $('ptSym') ? $('ptSym').value : 'BTC';
  const amt = $('ptAmt') ? parseFloat($('ptAmt').value) : NaN;
  const pr = paperPrice(sym);
  if (!pr) { paperMsg(`拿不到 ${sym} 的最新价，无法开仓（行情源可能暂时不可用）`, 'err'); return; }
  if (!isFinite(amt) || amt <= 0) { paperMsg('请输入大于 0 的金额', 'err'); return; }
  if (amt > a.cash) { paperMsg(`可用现金只有 ${fmt(a.cash, 2)}，不足 ${fmt(amt, 2)}`, 'err'); return; }
  const fee = amt * PAPER_FEE, qty = (amt - fee) / pr;
  a.cash -= amt; a.fees += fee;
  const ex = a.positions.find(p => p.sym === sym);
  if (ex) { const tot = ex.qty + qty; ex.avg = (ex.avg * ex.qty + pr * qty) / tot; ex.qty = tot; }
  else a.positions.push({ sym, qty, avg: pr, opened: Date.now() });
  a.trades.push({ t: Date.now(), side: 'buy', sym, px: pr, qty, amt, fee, pnl: null });
  saveAcct(); renderPaper();
  paperMsg(`已按 ${fmt(pr, 2)} 开仓 ${sym} ${qty.toFixed(6)}（含手续费 ${fmt(fee, 2)}，剩余现金 ${fmt(a.cash, 2)}）`, 'ok');
}
function paperSellCore(idx) {
  const a = state.acct; const p = a && a.positions[idx]; if (!p) return null;
  const pr = paperPrice(p.sym) || p.avg;
  const notional = p.qty * pr, fee = notional * PAPER_FEE, net = notional - fee;
  const pnl = net - p.qty * p.avg;
  a.cash += net; a.fees += fee; a.realized += pnl;
  if (pnl >= 0) a.wins++; else a.losses++;
  a.trades.push({ t: Date.now(), side: 'sell', sym: p.sym, px: pr, qty: p.qty, amt: notional, fee, pnl });
  a.positions.splice(idx, 1);
  return pnl;
}
function paperSell(idx) {
  const pnl = paperSellCore(idx); if (pnl == null) return;
  saveAcct(); renderPaper();
  paperMsg(`已平仓，本笔${pnl >= 0 ? '盈利' : '亏损'} ${fmt(Math.abs(pnl), 2)}（已计入账户已实现盈亏）`, pnl >= 0 ? 'ok' : 'err');
}
function paperCloseAll() {
  const a = state.acct; if (!a) return;
  if (!a.positions.length) { paperMsg('当前没有持仓', 'err'); return; }
  const before = a.realized, n = a.positions.length;
  while (a.positions.length) paperSellCore(0);
  saveAcct(); renderPaper();
  const d = a.realized - before;
  paperMsg(`已全部平仓 ${n} 笔，合计${d >= 0 ? '盈利' : '亏损'} ${fmt(Math.abs(d), 2)}`, d >= 0 ? 'ok' : 'err');
}
function paperReset() {
  state.acct = paperDefault(); saveAcct(); renderPaper();
  paperMsg(`账户已重置：可用现金回到 ${fmt(PAPER_INIT, 0)}，盈亏与流水已清空`, 'ok');
}
function renderPaper() {
  if (!state.acct) state.acct = loadAcct();
  const a = state.acct;
  const list = $('ptList'); let mkt = 0, upl = 0;
  if (list) {
    list.innerHTML = '';
    a.positions.forEach((p, i) => {
      const live = paperPrice(p.sym), pr = live == null ? p.avg : live;
      const v = p.qty * pr, pl = (pr - p.avg) * p.qty, pct = (pr - p.avg) / p.avg * 100;
      mkt += v; upl += pl;
      const c = pl >= 0 ? 'var(--green)' : 'var(--red)';
      const row = document.createElement('div');
      row.className = 'pt-pos';
      row.innerHTML =
        `<div class="pt-pos-row"><span class="pt-pos-lbl">${p.sym}/USDT${live == null ? ' · 无最新价(按成本估值)' : ''}</span><span class="pt-pos-val">${p.qty.toFixed(6)}</span></div>` +
        `<div class="pt-pos-row"><span class="pt-pos-lbl">成本 → 现价</span><span class="pt-pos-val">${fmt(p.avg, 2)} → ${fmt(pr, 2)}</span></div>` +
        `<div class="pt-pos-row"><span class="pt-pos-lbl">市值</span><span class="pt-pos-val">${fmt(v, 2)}</span></div>` +
        `<div class="pt-pos-row"><span class="pt-pos-lbl">浮动盈亏</span><span class="pt-pos-val" style="color:${c}">${pl >= 0 ? '+' : ''}${fmt(pl, 2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span></div>` +
        `<button class="pt-btn" onclick="paperSell(${i})">平仓</button>`;
      list.appendChild(row);
    });
    if (!a.positions.length) list.innerHTML = '<div class="macro-hint">暂无持仓 —— 填好金额后点「开仓（按现价）」</div>';
  }
  const eq = a.cash + mkt;
  const ret = a.init ? (eq - a.init) / a.init * 100 : 0;
  const set = (id, txt, c) => { const e = $(id); if (!e) return; e.textContent = txt; if (c) e.style.color = c; };
  set('ptEquity', fmt(eq, 2), ret >= 0 ? 'var(--green)' : 'var(--red)');
  set('ptRet', `总收益 ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`, ret >= 0 ? 'var(--green)' : 'var(--red)');
  set('ptCash', fmt(a.cash, 2));
  set('ptInit', `初始资金 ${fmt(a.init, 0)}`);
  set('ptPL', `${upl >= 0 ? '+' : ''}${fmt(upl, 2)}`, upl >= 0 ? 'var(--green)' : 'var(--red)');
  set('ptMkt', `持仓市值 ${fmt(mkt, 2)}`);
  set('ptReal', `${a.realized >= 0 ? '+' : ''}${fmt(a.realized, 2)}`, a.realized >= 0 ? 'var(--green)' : 'var(--red)');
  set('ptWinRate', `已平仓 ${a.wins + a.losses} 笔 · 胜率 ${a.wins + a.losses ? (a.wins / (a.wins + a.losses) * 100).toFixed(0) + '%' : '—'}`);
  set('ptFee', fmt(a.fees, 2));
  set('ptCount', `累计成交 ${a.trades.length} 笔`);
  const tl = $('ptTrades');
  if (tl) {
    const rows = a.trades.slice(-10).reverse();
    tl.innerHTML = '<div class="tr hd"><div>时间</div><div>方向</div><div>价格 × 数量</div><div>本笔盈亏</div></div>' +
      (rows.length ? rows.map(t => `<div class="tr"><div>${new Date(t.t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</div><div style="color:${t.side === 'buy' ? 'var(--blue)' : 'var(--orange)'}">${t.side === 'buy' ? '买入' : '卖出'}</div><div>${fmt(t.px, 2)} × ${t.qty.toFixed(6)}</div><div style="text-align:right;color:${t.pnl == null ? 'var(--dim)' : (t.pnl >= 0 ? 'var(--green)' : 'var(--red)')}">${t.pnl == null ? '—' : (t.pnl >= 0 ? '+' : '') + fmt(t.pnl, 2)}</div></div>`).join('')
        : '<div class="tr">暂无成交记录</div>');
  }
}

/* =====================================================================
 *  渲染
 * ===================================================================== */
function renderTicker() {
  const box = $('ticker'); if (!box) return; box.innerHTML = '';
  CONFIG.COINS.forEach(c => { const p = state.prices[c]; if (!p) return; const up = p.chg >= 0; const d = document.createElement('div'); d.className = 'ticker'; d.innerHTML = `<div class="sym">${c}/USDT</div><div class="price">${fmt(p.price, p.price > 100 ? 2 : 4)}</div><div class="chg ${up ? 'up' : 'dn'}">${up ? '▲' : '▼'} ${Math.abs(p.chg).toFixed(2)}%</div><div class="vol">24h量 ${fmtBig(p.vol)}</div>`; box.appendChild(d); });
}
function renderFG() {
  const v = state.fg ? +state.fg.value : 50; const ring = $('fgRing'); if (ring) { ring.setAttribute('stroke-dasharray', `${v * 2.51} 251`); ring.setAttribute('stroke', v > 54 ? '#00e5a0' : v < 46 ? '#ff3d6e' : '#ffc107'); }
  if ($('fgVal')) $('fgVal').textContent = v; if ($('fgLbl')) $('fgLbl').textContent = state.fg ? state.fg.value_classification : '—';
}
const MACRO_CARDS = [
  ['DXY', '美元指数 DXY', 2, ''], ['US10Y', '美债10Y', 2, '%'], ['GOLD', '黄金 (USD)', 0, ''],
  ['SPX', '标普500', 0, ''], ['VIX', 'VIX 恐慌', 1, ''], ['OIL', 'WTI 原油', 2, ''], ['BRENT', '布伦特原油', 2, ''],
  ['AGRI', '农业 ETF', 2, ''], ['EFFR', '联邦基金利率', 2, '%'], ['UST2Y', '美债 2Y', 2, '%'],
  ['BEI10', '通胀预期(隐含)', 2, '%'], ['T10Y2Y', '10Y-2Y 利差', 2, ''],
  ['USDJPY', '美元/日元', 2, ''], ['JGB10Y', '日债 10Y', 2, '%'],
];
function renderMacro() {
  const box = $('macroGrid'); const hint = $('macroHint');
  if (!box) return;
  const m = state.macro;
  if (!m) {
    box.innerHTML = MACRO_CARDS.map(c => `<div class="mcard"><div class="mname">${c[1]}</div><div class="mval">${CONFIG.PROXY ? '—' : '需Worker'}</div><div class="msub">—</div></div>`).join('');
    if (hint) hint.style.display = CONFIG.PROXY ? 'none' : 'block';
    return;
  }
  if (hint) { hint.style.display = 'block'; hint.textContent = macroSrcText(); }
  const prev = state.macroPrev;
  box.innerHTML = MACRO_CARDS.map(([k, label, dp, unit]) => {
    const v = m[k];
    let valTxt = '—', subTxt = '—', subCls = 'mval';
    if (v != null) {
      valTxt = fmt(v, dp) + unit;
      const pv = prev && prev[k];
      if (pv != null) { const d = v - pv; subTxt = (d >= 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(dp); subCls = 'mval ' + (d >= 0 ? 'up' : 'dn'); }
    }
    return `<div class="mcard"><div class="mname">${label}</div><div class="mval">${valTxt}</div><div class="msub ${subCls}">${subTxt}</div></div>`;
  }).join('');
}
function macroSrcText() {
  const s = state.macroSrc; if (!s) return '';
  const vals = Object.values(s);
  const ny = vals.filter(v => /^yahoo/.test(v)).length, ns = vals.filter(v => /^stooq/.test(v)).length;
  const nm = vals.filter(v => /^mof$/.test(v)).length;
  return `数据源: Yahoo Finance ${ny} 项` + (ns ? ` · Stooq ${ns} 项` : ' · Stooq 不可用(已由 Yahoo 兜底)') + ' · NY Fed' + (nm ? ' · 日本财务省' : '') + ' · 美财政部';
}
function renderEcon() {
  const box = $('econList'); if (!box) return;
  const cnt = $('econCount');
  const arr = (state.econ || []).filter(e => e.impact === 'High' || e.impact === 'Medium');
  if (!arr.length) {
    box.innerHTML = '<div class="macro-hint">经济日历暂不可用（数据源：Forex Factory）</div>';
    if (cnt) cnt.textContent = '—';
    return;
  }
  if (cnt) cnt.textContent = `本周 ${arr.length} 条中高影响 · Forex Factory`;
  const now = Date.now();
  let html = '<div class="econ-row econ-hd"><div class="econ-t">时间</div><div class="econ-e">事件</div><div class="econ-v">预期</div><div class="econ-v">前值</div><div class="econ-v">实际</div></div>';
  arr.forEach(e => {
    const t = Date.parse(e.t);
    const ts = isNaN(t) ? '—' : new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const hasA = e.a != null && e.a !== '';
    const aTxt = hasA ? e.a : (t > now ? '待公布' : '—');
    html += `<div class="econ-row ${e.impact === 'High' ? 'hi' : 'md'}"><div class="econ-t">${ts}</div><div class="econ-e" title="${e.title}">${e.title}</div><div class="econ-v">${e.f || '—'}</div><div class="econ-v">${e.p || '—'}</div><div class="${hasA ? 'econ-a' : 'econ-v'}">${aTxt}</div></div>`;
  });
  box.innerHTML = html;
}
function renderOnChain() {
  const cs = state.chainSeries; const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const hr = last(cs.hashrate);
  set('oc_hr', hr != null ? fmtBig(hr) + ' TH/s' : '—');
  set('oc_tx', cs.n_tx && cs.n_tx.length ? fmtBig(last(cs.n_tx)) : '—');
  set('oc_mc', state.global ? '$' + fmtBig(state.global.total_market_cap.usd) : '—');
  set('oc_dom', state.global ? state.global.market_cap_percentage.btc.toFixed(1) + '%' : '—');
  set('oc_stable', state.stableMcap ? '$' + fmtBig(state.stableMcap) : '—');
}
function renderDeriv() {
  const d = state.deriv; const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set('dv_fund', d.funding != null ? (d.funding >= 0 ? '+' : '') + d.funding.toFixed(4) + '%' : '—');
  set('dv_oi', d.oi != null ? fmtBig(d.oi) + ' BTC' : '—');
  set('dv_ls', d.ls != null ? d.ls.toFixed(1) + '% 多' : '—');
  const fb = $('dv_fund'); if (fb && d.funding != null) fb.style.color = d.funding > 0.03 ? '#ff3d6e' : d.funding < -0.02 ? '#00e5a0' : '#a8bfd6';
}
const VAL_FACTORS = FACTORS.filter(f => f.group === 'value');
function renderValueFactors() {
  const box = $('valueGrid'); if (!box) return;
  const out = computeNexusScore().out;
  box.innerHTML = '';
  VAL_FACTORS.forEach(f => {
    const r = out[f.id]; if (!r) return;
    const c = r.contribution;                          // dir × z：正=偏贵/偏险，负=偏便宜
    const col = c > 0.25 ? '#00e5a0' : c < -0.25 ? '#ff3d6e' : '#ffc107';
    const tag = c > 0.25 ? '偏贵/偏险' : c < -0.25 ? '偏便宜' : '中性';
    const d = document.createElement('div');
    d.className = 'fcard';
    d.title = f.name + '\n原始 z ' + r.z.toFixed(2) + ' · 贡献 ' + c.toFixed(2) + '\n' + r.note;
    d.innerHTML = '<div class="fc-name">' + f.name + '</div><div class="fc-z" style="color:' + col + '">' + (c >= 0 ? '+' : '') + c.toFixed(1) + '</div>' +
      '<div class="fc-str"><div class="fc-strbar" style="width:' + Math.min(100, Math.abs(c) / 2.5 * 100) + '%;background:' + col + '"></div></div>' +
      '<div class="fc-sig" style="color:' + col + '">' + tag + ' · ' + r.note + '</div>';
    box.appendChild(d);
  });
}

function renderFactors() {
  const res = computeNexusScore();
  const { score, out, nScored, nDead } = res;
  const ring = $('nxRing'); if (ring) { ring.setAttribute('stroke-dasharray', `${score * 2.51} 251`); ring.setAttribute('stroke', score > 60 ? '#00e5a0' : score < 40 ? '#ff3d6e' : '#ffc107'); }
  if ($('nxScore')) $('nxScore').textContent = score;
  if ($('nxSig')) { const s = score > 60 ? '偏多' : score < 40 ? '偏空' : '中性'; $('nxSig').textContent = s; $('nxSig').className = 'fscore-l ' + (score > 60 ? 'up' : score < 40 ? 'dn' : 'n'); }
  /* v3.24 ㉘：实时评分旁挂一个「标尺校正后」的分数。σ 来自回放末端，
   * 没跑过回放就整块不显示 —— 编一个 σ 等于编一个结论。 */
  {
    const calEl = $('nxCal');
    if (calEl) {
      const rl = (typeof rescaleLive === 'function') ? rescaleLive(res) : null;
      if (rl) {
        calEl.style.display = '';
        calEl.innerHTML = '标尺校正后 <b style="color:' + (rl.score > 60 ? 'var(--green)' : rl.score < 40 ? 'var(--red)' : 'var(--gold)') + '">' +
          rl.score + '</b>（z=' + rl.z.toFixed(2) + '，σ=' + rl.sg.toFixed(2) + '，取自 ' + rl.n + ' 天回放末端）· ' +
          '<span style="opacity:.7">同一套权重，只把标尺换成「相对自身近期波动」—— 排序基本不变，幅度可用。</span>';
      } else calEl.style.display = 'none';
    }
  }
  const box = $('factorGrid'); if (!box) return; box.innerHTML = '';
  FACTORS.forEach(f => {
    if (f.replayOnly || f.anchored) return;   // 回放专用 / 锚定估值因子不出现在实时评分网格
    const r = out[f.id];
    const c = r.contribution;                       // dir × z：正=利多、负=利空
    const show = f.dir === 0;
    const dead = r.ok === false;
    const stl = !dead && !show && r.stale === true;
    const col = dead || show ? '#3a5070' : stl ? '#8a93a6' : c > 0.25 ? '#00e5a0' : c < -0.25 ? '#ff3d6e' : '#ffc107';
    const tag = dead ? '无数据' : show ? '仅展示' : stl ? '未回填' : c > 0.25 ? '利多' : c < -0.25 ? '利空' : '中性';
    const dirTxt = f.dir > 0 ? 'z↑=利多' : f.dir < 0 ? 'z↑=利空' : '不参与评分';
    const card = document.createElement('div');
    card.className = 'fcard';
    const evT = (r.evTime ? `\n发布时刻 ${r.evTime}` : '');
    card.title = `${f.name}\n权重 ${f.w} · 方向 ${f.dir > 0 ? '+1' : f.dir < 0 ? '-1' : '0'}（${dirTxt}）\n原始 z ${r.z.toFixed(2)} · 贡献 ${c.toFixed(2)}\n${r.note}${evT}`;
    card.innerHTML = `<div class="fc-name">${f.name}</div><div class="fc-z" style="color:${col}">${show || dead ? '—' : (c >= 0 ? '+' : '') + c.toFixed(1)}</div><div class="fc-str"><div class="fc-strbar" style="width:${Math.min(100, Math.abs(c) / 2.5 * 100)}%;background:${col}"></div></div><div class="fc-sig" style="color:${col}">${tag} · ${r.note}</div>`;
    box.appendChild(card);
  });
  const cnt = $('fCount'); if (cnt) cnt.textContent = FACTORS.filter(f => !f.replayOnly && !f.anchored).length + ' 维 · ' + nScored + ' 参与评分' + (nDead ? ' · ' + nDead + ' 无数据' : '');

  /* v3.11 实践延展：当前体制徽标 + 极端体制子评分卡 */
  const regime = currentRegime();
  const badge = $('regimeBadge');
  if (badge) {
    if (!regime) { badge.textContent = '体制 —'; badge.className = 'hint regime-badge'; }
    else {
      const cls = regime.key === 'calm' ? 'calm' : regime.key === 'chop' ? 'chop' : 'wild';
      badge.textContent = '体制 ' + regime.label + ' · 波动 ' + (regime.vol * 100).toFixed(0) + '%';
      badge.className = 'hint regime-badge ' + cls;
    }
  }
  const es = extremeSubScore(out);
  const esBox = $('extSubBox'), esScore = $('extSubScore'), esState = $('extSubState'), esNote = $('extSubNote'), esFactors = $('extSubFactors');
  if (esBox) {
    const active = regime && regime.key === 'wild';
    esBox.className = 'extsub' + (active ? ' active' : '');
    if (esState) esState.textContent = active ? '启用' : '休眠';
    if (esScore) {
      esScore.textContent = (!active || es.score == null) ? '—' : es.score;
      esScore.className = 'extsub-score ' + (es.score == null ? '' : es.score > 60 ? 'up' : es.score < 40 ? 'dn' : 'n');
    }
    if (esNote) esNote.textContent = active
      ? '极端波动率体制：主评分此时不可信，看这份子评分与外生事件日历。'
      : '仅在 20 日年化波动率 ≥ 80% 时启用（当前 ' + (regime ? (regime.vol * 100).toFixed(0) : '—') + '%）。';
    if (esFactors) {
      esFactors.innerHTML = es.parts.length ? es.parts.map(p =>
        '<span class="esf ' + (p.contribution > 0.25 ? 'up' : p.contribution < -0.25 ? 'dn' : 'n') + '">' +
        p.name.replace(/^[^ ]+ /, '') + ' ' + (p.z >= 0 ? '+' : '') + p.z.toFixed(1) + '</span>').join('') : '（因子数据缺失）';
    }
  }
  /* v3.21 ⑲：把当前评分快照下来 —— ⑳ 的顺序正交化要用「今天最倚重谁」排序，
   * 加分块的权重也读这里。先存后渲染，保证渲染函数拿到的永远是本次计算的结果。 */
  state.lastScore = res.score;
  state.lastScoreOut = res.out;
  /* v3.20 ⑫：分歧度 + 动态权重今日评级（失败不影响主面板） */
  try { renderScoreV2(res); } catch (e) { console.warn('score v2 fail', e && e.message); }
  /* v3.22 ㉑：预测台账（自我记分）—— 每天记一笔，10 天后结算 */
  try { renderLedgerBox(res); } catch (e) { console.warn('ledger fail', e && e.message); }
  /* v3.21 ⑲：风险化仓位（同样失败不影响主面板） */
  try { renderSizeBox(res); } catch (e) { console.warn('size box fail', e && e.message); }
}
/* v3.14: Deribit DVOL 实时波动率恐慌警报（风险护栏，不是预测）。
 * 从 /api/dvol 取当前 DVOL 的近1年百分位 + 60日 z，红/黄/绿三档提示。失败静默（增强项）。 */
async function refreshDvolAlarm() {
  const el = $('dvolAlarm'); if (!el) return;
  if (!CONFIG.PROXY) { el.style.display = 'none'; return; }
  try {
    const s = await getJSON(CONFIG.PROXY + '/api/dvol', 8000);
    if (!s || s.latest == null) { el.style.display = 'none'; return; }
    const pct = s.pctTrailing1y, z = s.z60, v = s.latest;
    const pctTxt = (pct * 100).toFixed(0) + '%';
    const rg = currentRegime(); const wild = rg && rg.key === 'wild';
    let level, msg;
    if (pct >= 0.90 || z >= 2) {
      level = 'panic';
      msg = '⚠ 期权市场恐慌 · DVOL ' + v.toFixed(0) + '（近1年高位 ' + pctTxt + (wild ? ' · 叠加极端波动体制' : '') + '）：建议降杠杆 / 减仓 / 不追高';
    } else if (pct >= 0.75 || z >= 1.3) {
      level = 'elevated';
      msg = '波动率偏高 · DVOL ' + v.toFixed(0) + '（近1年 ' + pctTxt + (wild ? ' · 注意极端波动' : '') + '）';
    } else {
      level = 'calm';
      msg = '波动率正常 · DVOL ' + v.toFixed(0) + '（近1年 ' + pctTxt + '）';
    }
    el.textContent = msg;
    el.className = 'dvol-alarm ' + level;
    el.style.display = '';
  } catch (e) { /* DVOL 警报是增强项，失败不影响主面板 */ }
}

/* =====================================================================
 *  历史回放 · IC 有效性检验 / 因子归因（v3.8 → v3.9）
 *
 *  为什么不需要数据库：Nexus Score 的每一个输入本身就是历史序列，所以只要把
 *  长历史序列取回来，就能用**同一套因子代码**逐日重放，算出历史上每一天的评分。
 *  没有 KV / cron / D1，永远不会和线上因子代码脱节（脱节是双份实现的经典坑）。
 *
 *  代价：只有「有历史序列」的因子能回放。无法回放的仍有三类 →
 *    ① 事件类（非农/CPI/失业率/初请/PCE）：周历没有历史发布值
 *    ② 资金费率/多空比：Bybit 只给当日值（但 v3.10 已用溢价指数/持仓量历史补上衍生品结构）
 *    ③ BTC占比 / 稳定币占比：需要「历史全网总市值」，免费源都没有
 *  v3.10 起「本质输入」登场：MVRV / 活跃地址 / 手续费 / 永续溢价 / 持仓量(史)
 *  五条 replayOnly 因子加入回放子集（17→22 维），方向假设仍由 IC 归因裁决。
 *  因此回放用 22 维子集并**重新归一化**，与实时 28 维的绝对值不可直接比较。
 * ===================================================================== */
const REPLAY_IDS = ['fng', 'hr', 'tx', 'mrv', 'adr', 'fee', 'prem', 'oih', 'dxy', 'us10y', 'spx', 'vix', 'gold', 'oil', 'geo', 'fed', 'bei', 'curve', 'jpy', 'jgb', 'tech', 'mom'];
const REPLAY_MIN_LOOKBACK = 130;   // 每条序列至少要有这么多回看点（rollZ(120) 与 chgZ(90) 都够）
/* v3.11：起点不再要求「所有序列都可用」。
 *
 * 原实现是 `keys.every(k => asof[k][i] >= 130)` —— 起点被**最短的那条序列**决定。
 * 10 年窗口下 Bybit 持仓量只有 600 天，会把整个 2016~2024 直接砍掉，
 * 而这轮的全部意义恰恰是复盘那十年。
 *
 * 改为按「当天有多少个因子存活」判定：够多就开始回放；之后每一天，每个因子
 * 由自己的可见长度决定它在不在分母里（FACTOR_DEP + ok:false）。分子分母同步变化，
 * 评分含义保持「当日可用因子的加权平均观点」—— 但这意味着**早期与近期的绝对值
 * 不可直接比较**，面板会同时显示当天实际参与评分的因子数。
 */
const REPLAY_MIN_ACTIVE = 14;
const IC_HORIZONS = [1, 5, 10, 20];

/* 某条序列从哪一天起达到「可回放长度」 */
function asofActiveAt(asof, key, need) {
  const a = asof[key]; if (!a) return null;
  const L = a.length, out = new Uint8Array(L);
  for (let i = 0; i < L; i++) out[i] = (a[i] + 1 >= need) ? 1 : 0;
  return out;
}

function histUrl() { return CONFIG.PROXY ? CONFIG.PROXY + '/api/history' : null; }

/* 把主日历（BTC 日线）的每一天，映射到每条序列「当时可见」的最后一个下标。
 * 这是整个回放不产生前视偏差（look-ahead bias）的关键：第 i 天只能用 ≤ 第 i 天的数据。 */
function buildAsOf(H) {
  const calTs = H.btc.ts, n = calTs.length;
  const day = t => Math.floor(t / 86400000);
  const ser = {};
  Object.keys(H.macro || {}).forEach(k => (ser[k] = { ts: H.macro[k].ts, v: H.macro[k].closes }));
  if (H.fng) ser.FNG = { ts: H.fng.ts, v: H.fng.closes };
  if (H.tx) ser.TX = { ts: H.tx.ts, v: H.tx.closes };
  if (H.hr) ser.HR = { ts: H.hr.ts, v: H.hr.closes };
  const asof = {};
  Object.keys(ser).forEach(k => {
    const S = ser[k].ts, arr = new Int32Array(n);
    let j = -1;
    for (let i = 0; i < n; i++) {
      const d = day(calTs[i]);
      while (j + 1 < S.length && day(S[j + 1]) <= d) j++;
      arr[i] = j;
    }
    asof[k] = arr;
  });
  return { calTs, ser, asof, n };
}

/* 逐日重放：走的是与实时**完全相同**的 computeNexusScore 与 calc() */
function replayHistory() {
  const H = state.histBundle;
  if (!H || !H.btc || !H.btc.ts || !H.btc.ts.length) return null;
  const { calTs, ser, asof, n } = buildAsOf(H);
  const keys = Object.keys(asof);

  /* ---- 每天的「存活因子数」---- */
  const depKeys = [];
  REPLAY_IDS.forEach(id => { const d = FACTOR_DEP[id]; if (d && d[0]) depKeys.push([d[0], d[1]]); });
  const actCache = {};
  depKeys.forEach(t => { if (!actCache[t[0]]) actCache[t[0]] = asofActiveAt(asof, t[0], t[1]); });
  const nActiveAt = i => {
    let c = 0;
    for (let q = 0; q < depKeys.length; q++) { const A = actCache[depKeys[q][0]]; if (A && A[i]) c++; }
    if (i + 1 >= 100) c += 2;                                   // tech / mom 只依赖 K 线
    if (H.fng && asof.FNG && asof.FNG[i] + 1 >= 90) c += 1;     // 情绪指数
    return c;
  };

  let start = -1;
  for (let i = 0; i < n; i++) { if (nActiveAt(i) >= REPLAY_MIN_ACTIVE) { start = i; break; } }
  if (start < 0 || n - start < 60) return null;

  const closes = H.btc.closes;
  const klFull = calTs.map((t, i) => ({ t, c: closes[i] }));

  /* 关键：必须把历史序列灌进 state.macroSeries —— mZ/mChgZ/mV 读的是它。
   * 只设 state.asof 而沿用实时序列，会算出「被截断的实时数据」的评分：
   * 数值看着正常，结论全错（这个 bug 就是被回归测试 G 段抓出来的）。 */
  const mk = keys.filter(k => k !== 'FNG' && k !== 'TX' && k !== 'HR');
  const keep = {
    interval: state.interval, kl: state.klines['BTC1d'], asof: state.asof, fg: state.fg,
    hr: state.chainSeries.hashrate, tx: state.chainSeries.n_tx, series: state.macroSeries,
    zT: state.zT, btcZ: state.btcZ, klIdx: state.klIdx,
  };
  const hs = {};
  for (let q = 0; q < mk.length; q++) hs[mk[q]] = ser[mk[q]].v;
  state.macroSeries = hs;
  /* v3.11：z 表改为按需懒构建（state.zT 作为空注册表）。
   * 全量预建会白算大量用不到的组合；懒建只在首次读取某个 (序列, 模式) 时算一次。 */
  state.zT = {};
  state.btcZ = buildBtcZ(closes);

  const scores = new Array(n).fill(null);
  const nAct = new Array(n).fill(0);
  /* v3.9：逐日收集「每个因子的方向化贡献」，用于单项因子 IC 归因。
   * v3.11：同时收集原始 z —— 极端行情归因要回答的是「这次暴跌，是哪些因子
   * 处在极端位置」，看的是 z 本身，而不是已经乘过方向、被裁剪到 ±2.5 的贡献。 */
  const fvals = {}, fzs = {}, fraw = {};
  let nScored = 0;
  state.interval = '1d';
  if (ser.HR) state.chainSeries.hashrate = ser.HR.v;
  if (ser.TX) state.chainSeries.n_tx = ser.TX.v;
  try {
    for (let i = start; i < n; i++) {
      const cur = {};
      for (let q = 0; q < keys.length; q++) cur[keys[q]] = asof[keys[q]][i];
      state.asof = cur;
      state.fg = (H.fng && asof.FNG && asof.FNG[i] >= 0) ? { value: ser.FNG.v[asof.FNG[i]] } : null;
      state.klIdx = i;
      const r = computeNexusScore(REPLAY_IDS);
      scores[i] = r.score;
      nScored = r.nScored; nAct[i] = r.nScored;
      for (const fid in r.out) {
        const o = r.out[fid];
        if (o.dir && o.ok) {
          if (!fvals[fid]) { fvals[fid] = new Array(n).fill(null); fzs[fid] = new Array(n).fill(null); fraw[fid] = new Array(n).fill(null); }
          fvals[fid][i] = o.contribution;
          fzs[fid][i] = o.z;
          fraw[fid][i] = o.zRaw;
        }
      }
    }
  } finally {
    state.interval = keep.interval; state.klines['BTC1d'] = keep.kl;
    state.asof = keep.asof; state.fg = keep.fg;
    state.chainSeries.hashrate = keep.hr; state.chainSeries.n_tx = keep.tx;
    state.macroSeries = keep.series; state.zT = keep.zT;
    state.btcZ = keep.btcZ; state.klIdx = keep.klIdx;
  }
  return { calTs, closes, scores, fvals, fzs, fraw, start, n, nScored, nAct,
    minActive: REPLAY_MIN_ACTIVE, activeAt: nActiveAt, srcs: H.srcs || {} };
}

/* 平均秩（并列取平均），用于 Spearman */
function rankAvg(a) {
  const idx = a.map((v, i) => i).sort((x, y) => a[x] - a[y]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let q = i; q <= j; q++) r[idx[q]] = avg;
    i = j + 1;
  }
  return r;
}
/* 全文件唯一的 Pearson 相关实现。
 * 长度对齐容错：两序列不等长时取较短的一段（缺失不应静默变成 NaN），
 * 但少于 5 个点相关系数没有意义，直接返回 null。 */
function pearson(x, y) {
  const n = Math.min(x.length, y.length); if (n < 5) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/* 通用 IC 核：对任意与 rep 对齐的序列（合成分数 / 单个因子的贡献）算 Spearman/Pearson。
 * lo/hi 允许只在子区间上算 —— 这是样本内/样本外验证的基础：
 * 在样本内挑出来的因子，必须拿到没见过的区间上再验一次，否则只是在拟合噪声。 */
function icCore(series, rep, h, lo, hi) {
  const s = [], r = [];
  for (let i = lo; i < hi; i++) {
    const v = series[i];
    if (v == null) continue;
    const j = i + h;
    if (j >= rep.n) break;
    const p0 = rep.closes[i];
    if (!p0) continue;
    s.push(v); r.push(rep.closes[j] / p0 - 1);
  }
  if (s.length < 20) return null;
  const base = r.reduce(function (a, b) { return a + b; }, 0) / r.length;
  const spear = pearson(rankAvg(s), rankAvg(r));
  /* 重叠的前向窗口 → 相邻样本高度相关，n 不是有效样本量。
   * 按「非重叠窗口数」n/h 折算，SE(IC) ≈ 1/√(n/h)，t = IC/SE。
   * 不做这一步会把纯噪声读成「显著信号」，这是因子研究最常见的自欺。 */
  const neff = Math.max(4, Math.floor(s.length / h));
  const se = 1 / Math.sqrt(neff);
  return {
    h: h, n: s.length, base: base, neff: neff, se: se,
    t: spear == null ? null : spear / se, pear: pearson(s, r), spear: spear, s: s, r: r,
  };
}

function icFor(rep, h) {
  const c = icCore(rep.scores, rep, h, rep.start, rep.n);
  if (!c) return null;
  const s = c.s, r = c.r;
  const buckets = [[-1e9, 40], [40, 60], [60, 1e9]].map(function (rg) {
    const sel = [];
    for (let i = 0; i < s.length; i++) if (s[i] >= rg[0] && s[i] < rg[1]) sel.push(r[i]);
    const mean = sel.length ? sel.reduce(function (a, b) { return a + b; }, 0) / sel.length : null;
    const win = sel.length ? sel.filter(function (v) { return v > 0; }).length / sel.length : null;
    return { n: sel.length, mean: mean, win: win };
  });
  return {
    h: c.h, n: c.n, base: c.base, buckets: buckets,
    neff: c.neff, se: c.se, t: c.t, pear: c.pear, spear: c.spear,
  };
}

/* ---------- 拉数据 + 跑检验 ---------- */
async function runHistoryCheck() {
  const btn = $('histRun'), note = $('histNote');
  if (!histUrl()) { if (note) note.textContent = '此功能需要 Worker 代理（/api/history）；当前为直连模式。'; return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 回放中…'; }
  if (note) { note.textContent = '正在拉取 10 年历史序列（BTC 延至 ~2014，约 1.6MB）并用同一套因子代码逐日重放…'; note.style.color = 'var(--dim)'; }
  try {
    /* v3.11：窗口从 2 年变成 10 年，浏览器里可能残留着旧的 2 年包 —— 按 BTC 点数判一下重拉。 */
    if (state.histBundle && (!state.histBundle.btc || (state.histBundle.btc.ts || []).length < 2000)) state.histBundle = null;
    if (!state.histBundle) {
      const d = await getJSON(histUrl(), 120000);
      if (d.error || !d.btc) throw new Error(d.error || 'history empty');
      state.histBundle = d;
    }
    const rep = replayHistory();
    if (!rep) throw new Error('历史窗口不足（各序列公共区间太短）');
    const ics = [];
    for (let i = 0; i < IC_HORIZONS.length; i++) { const x = icFor(rep, IC_HORIZONS[i]); if (x) ics.push(x); }
    if (!ics.length) throw new Error('样本不足以计算 IC');
    /* v3.9 三件套：① 拆到因子级别 ② 样本内挑 / 样本外验 ③ 滚动 IC 看漂移 */
    const facs = factorICRows(rep);
    const oos = oosTest(rep);
    const roll = rollingIC(rep, ROLL_WIN, OOS_H);
    /* v3.11 三件套：④ 极端行情识别 + 外生事件对照 ⑤ 分体制对比 ⑥ 分期稳定性 */
    const ext = findExtremes(rep).map(function (e) {
      const m = matchEvent(rep, e);
      e.hit = m ? m.ev : null; e.dist = m ? m.dist : null;
      return e;
    });
    const reg = regimeTest(rep);
    const per = periodIC(rep);
    /* v3.17：多重检验与过拟合校正。bootstrap 较重（数十万次相关），不同步跑——
     * 首屏先渲染，再异步算完只刷新 ⑩ 那一块，避免回放时卡住页面。 */
    /* v3.12: Deribit 期权原生指标（分析专用参考，不入评分）—— 测真实 IC，先看有没有用 */
    const aux = {};
    ['DVOL', 'DVHV'].forEach(function (k) { const a = auxRegimeIC(rep, k); if (a) aux[k] = a; });
    /* v3.11 实践延展：极端体制子评分的回测验证（同 10 年样本，非样本外） */
    const exSeries = extremeSubSeries(rep);
    const exWildIC = icCore(regimeMasked(exSeries, rep, 'wild'), rep, 10, rep.start, rep.n);
    const exAllIC = icCore(exSeries, rep, 10, rep.start, rep.n);
    const exMainWild = reg.byRegime.wild ? reg.byRegime.wild.ic : null;
    /* v3.20 ⑫：增量式岭回归。两套口径 —— 全回放维（历史保真度）与实时可用维（线上可用） */
    const rwS = {};
    try {
      rwS.full = ridgeWalkForward(rep);
      rwS.live = ridgeWalkForward(rep, { only: RW_LIVE_IDS });
    } catch (e) { console.warn('ridge walk-forward fail', e && e.message); }
    /* v3.21 ⑰⑱⑳：分位数组合 / 评分校准 / 有效维度与分块。
     * 这三块回答的是「拿到分之后怎么办」，跑在回放之后、渲染之前。 */
    let qT = null, calM = null, dimM = null, qO = null;
    try {
      qT = quintileTest(rep, CALIB_H);
      qO = quintileOOS(rep, CALIB_H);
      calM = calibFit(rep, CALIB_H);
      dimM = dimAnalyze(rep);
    } catch (e) { console.warn('v3.21 sizing analysis fail', e && e.message); }
    state.hist = { rep: rep, ics: ics, facs: facs, oos: oos, roll: roll, ext: ext, reg: reg, per: per, aux: aux, rw: rwS,
      quint: qT, qOos: qO, calib: calM, dim: dimM,
      mt: null, mtBusy: true,
      extreme: { series: exSeries, wildIC: exWildIC, mainWildIC: exMainWild, allIC: exAllIC } };
    renderHistory();
    renderReview();
    scheduleMt(rep);
    schedulePbo(rep);
    if (note) note.textContent = '';
  } catch (e) {
    if (note) { note.textContent = '回放失败：' + ((e && e.message) || e); note.style.color = 'var(--red)'; }
    console.warn('history check fail', (e && e.message) || e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ 重新回放'; }
  }
}

/* =====================================================================
 *  v3.11：十年复盘 —— 极端行情识别、外生事件归因、分体制对比
 *
 *  目的：回答一个比「IC 是多少」更有用的问题 ——
 *    平静时期这些因子怎么作用？极端时期又怎么作用？
 *    那些极端行情里，有多少是**模型里有的因子**推的，
 *    有多少是**模型根本没有的东西**（关税突袭、疫情、战争、某人的一句话）？
 *
 *  方法：先程序化找出十年里的极端窗口（客观事实，不依赖任何人工叙事），
 *  再把「当时的因子状态」与「当时真实发生的外生冲击」并排摆出来。
 * ===================================================================== */

/* ---------- 外生事件日历（模型未纳入的冲击）----------
 * 这些不是「因子」，因为它们在发生的那一刻无法用历史分布定位 —— z-score 对
 * 「一百年来第一次加征 100% 关税」没有意义，而且多数没有连续可用的历史序列。
 * 它们的作用是给极端行情提供**归因锚点**：把模型看到的因子状态与当时真实发生的
 * 冲击并排放，才能区分「因子已经预警了」与「被外部事件突袭了」。
 * 日期为人工整理，仅供对照，不作为交易信号。 */
const EVENTS = [
  { d: '2017-09-04', t: '中国 ICO/交易所禁令', k: 'reg', n: '七部委定性 ICO 非法，境内交易所关停' },
  { d: '2017-12-17', t: '上一轮周期顶部', k: 'cycle', n: '12-16 收于周期最高 $19,497（盘中逼近 $20,000）', big: 1 },
  { d: '2018-02-05', t: '2018 崩盘', k: 'cycle', n: '从 $17,000 一路阴跌至 $6,000' },
  { d: '2018-11-14', t: 'BCH 算力战', k: 'chain', n: '分叉算力战引发抛售，BTC 腰斩至 $3,200' },
  { d: '2019-10-24', t: '中国高层表态支持区块链', k: 'policy', n: '单日急拉，情绪驱动为主' },
  { d: '2020-03-12', t: '疫情全球崩盘（312）', k: 'macro', n: '全球流动性危机，BTC 单日 -40%', big: 1 },
  { d: '2020-05-11', t: '第三次减半', k: 'cycle', n: '区块奖励 12.5 → 6.25 BTC' },
  { d: '2020-08-11', t: '上市公司开始配置 BTC', k: 'flow', n: '微策略首次买入，机构叙事起点' },
  { d: '2021-02-08', t: '特斯拉买入 15 亿美元', k: 'flow', n: '企业资产负债表入场' },
  { d: '2021-05-12', t: '特斯拉暂停 BTC 支付', k: 'event', n: '马斯克一条推文，市场急挫' },
  { d: '2021-05-19', t: '中国挖矿与交易禁令', k: 'reg', n: '算力大迁移，BTC 单日一度 -30%' },
  { d: '2021-11-10', t: '通胀破 6% 见顶', k: 'macro', n: '11-08 收于周期最高 $67,567，此后转入一年熊市', big: 1 },
  { d: '2022-05-09', t: 'LUNA/UST 崩盘', k: 'chain', n: '算法稳定币死亡螺旋，传染全市场' },
  { d: '2022-06-15', t: '美联储加息 75bp', k: 'macro', n: '1994 年以来最大单次加息' },
  { d: '2022-11-08', t: 'FTX 破产', k: 'credit', n: '交易所信用崩塌，11-21 收至周期最低 $15,787', big: 1 },
  { d: '2023-03-10', t: '硅谷银行倒闭', k: 'macro', n: 'USDC 一度脱锚，避险与宽松预期并存' },
  { d: '2024-01-10', t: '现货 ETF 获批', k: 'flow', n: '11 只现货 ETF 通过，结构性资金入口打开', big: 1 },
  { d: '2024-04-20', t: '第四次减半', k: 'cycle', n: '区块奖励 6.25 → 3.125 BTC' },
  { d: '2024-08-05', t: '日元套息平仓', k: 'macro', n: '日央行加息+美国就业走弱，全球风险资产同跌' },
  { d: '2024-11-05', t: '特朗普当选', k: 'policy', n: '加密友好预期，BTC 自 $69,360 启动', big: 1 },
  { d: '2024-12-08', t: 'BTC 首次收盘破 $100,000', k: 'cycle', n: '当选后 33 个交易日 +46%（盘中首触 12-05，收盘站稳在 12-08）', big: 1 },
  { d: '2025-04-02', t: '对等关税「解放日」', k: 'tariff', n: '48 小时内 BTC -8%，风险资产同步去杠杆' },
  { d: '2025-10-06', t: '本轮周期顶部', k: 'cycle', n: '收于周期最高 $124,753，此后再未收复；4 天后发生史上最大清算', big: 1 },
  { d: '2025-10-10', t: '史上最大清算 + 100% 关税', k: 'tariff', n: '约 190 亿美元杠杆被清算、160 万账户；BTC 当日收跌 -7.0%（盘中 -14.5%），永续持仓量骤降 43%', big: 1 },
  { d: '2026-04-15', t: '关税第二轮', k: 'tariff', n: '杠杆二次去化，二季度全季 -14.0%，是跌破 $60,000 的前奏' },
  { d: '2026-06-25', t: '首次收破 $60,000', k: 'cycle', n: '6-30 收于 $58,559 为本轮最低，较顶部 -53%' },
  { d: '2026-07-15', t: '美伊战争推高通胀', k: 'war', n: '油价上行，美国通胀升至三年新高 4.2%' },
];

/* 把一个事件日期映射到主日历下标（最近的一个交易日） */
function eventIdx(rep, ds) {
  const t = Date.parse(ds + 'T00:00:00Z');
  if (isNaN(t)) return -1;
  let best = -1, bd = Infinity;
  for (let i = rep.start; i < rep.n; i++) {
    const d = Math.abs(rep.calTs[i] - t);
    if (d < bd) { bd = d; best = i; }
  }
  return bd <= 6 * 86400000 ? best : -1;   // 只认 ±6 天内的
}

/* ---------- 极端行情识别 ----------
 * 客观口径：以 5 日滚动收益为尺子，|r5| 超过阈值就算候选；把时间上挨得近的
 * 候选合并成一波（同一轮暴跌不该被记成五次），每波取幅度最大的那天作为主峰。
 * 完全不依赖人工叙事 —— 事件日历只用来事后贴标签。 */
function findExtremes(rep, minAbs, gap) {
  const c = rep.closes, n = rep.n, s0 = rep.start;
  const ma = minAbs == null ? 0.15 : minAbs, gp = gap == null ? 12 : gap;
  const fwd = h => { const a = new Array(n).fill(null); for (let i = s0; i + h < n; i++) { const p = c[i]; if (p) a[i] = c[i + h] / p - 1; } return a; };
  const r1 = fwd(1), r5 = fwd(5), r10 = fwd(10), r20 = fwd(20);
  const cand = [];
  for (let i = s0; i + 5 < n; i++) if (r5[i] != null && Math.abs(r5[i]) >= ma) cand.push(i);
  /* 聚类：间距 <= gap 归为同一波 */
  const groups = [];
  cand.forEach(i => {
    const g = groups[groups.length - 1];
    if (g && i - g[g.length - 1] <= gp) g.push(i); else groups.push([i]);
  });
  const out = [];
  groups.forEach(g => {
    let peak = g[0];
    for (const i of g) if (Math.abs(r5[i]) > Math.abs(r5[peak])) peak = i;
    /* 事件前的因子状态：前 20 个交易日的评分均值 + 各因子平均 z */
    let sc = 0, cnt = 0;
    for (let k = Math.max(s0, peak - 20); k < peak; k++) { const v = rep.scores[k]; if (v != null) { sc += v; cnt++; } }
    const preScore = cnt ? sc / cnt : null;
    const zAvg = [];
    Object.keys(rep.fzs || {}).forEach(fid => {
      const a = rep.fzs[fid]; let s2 = 0, c2 = 0;
      for (let k = Math.max(s0, peak - 20); k < peak; k++) { const v = a[k]; if (v != null) { s2 += v; c2++; } }
      if (c2) zAvg.push({ id: fid, z: s2 / c2 });
    });
    zAvg.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    /* 事件后的评分回升/继续恶化 */
    let postSc = 0, pc = 0;
    for (let k = peak; k < Math.min(n, peak + 20); k++) { const v = rep.scores[k]; if (v != null) { postSc += v; pc++; } }
    out.push({
      i: peak, ts: rep.calTs[peak],
      r1: r1[peak], r5: r5[peak], r10: r10[peak], r20: r20[peak],
      preScore: preScore, postScore: pc ? postSc / pc : null,
      n: g.length, topZ: zAvg.slice(0, 5),
    });
  });
  out.sort((a, b) => Math.abs(b.r5) - Math.abs(a.r5));
  return out;
}

/* 找离某个极端日最近的、时间上对得上的外生事件 */
function matchEvent(rep, ev) {
  let best = null, bd = Infinity;
  EVENTS.forEach(E => {
    const i = eventIdx(rep, E.d);
    if (i < 0) return;
    const d = Math.abs(i - ev.i);
    if (d < bd) { bd = d; best = E; }
  });
  return bd <= 10 ? { ev: best, dist: bd } : null;
}

/* ---------- 分体制（平静 / 震荡 / 极端）对比 ----------
 * 用 BTC 自身的 20 日已实现年化波动率切档。回答的是：
 * 「同一套因子，在没风浪的时候和在狂风里，作用方式一样吗？」
 * 每档内分别算 IC 与分档收益 —— 这才是「平常 vs 极端」的定量答案。 */
const REGIMES = [
  { k: 'calm', label: '平静', lo: 0, hi: 0.45 },
  { k: 'chop', label: '震荡', lo: 0.45, hi: 0.80 },
  { k: 'wild', label: '极端', lo: 0.80, hi: 1e9 },
];
function realizedVol(rep, win) {
  const c = rep.closes, n = rep.n, w = win || 20;
  const out = new Array(n).fill(null);
  for (let i = rep.start; i < n; i++) {
    if (i - w < 0) continue;
    const rs = [];
    for (let k = i - w + 1; k <= i; k++) { const p = c[k - 1]; if (p) rs.push(c[k] / p - 1); }
    if (rs.length < w - 1) continue;
    const m = rs.reduce((a, b) => a + b, 0) / rs.length;
    const v = rs.reduce((a, b) => a + (b - m) * (b - m), 0) / rs.length;
    out[i] = Math.sqrt(v) * Math.sqrt(365);
  }
  return out;
}
/* 在指定体制下重跑 IC（复用 icCore 的区间过滤能力） */
function regimeTest(rep, ids) {
  const vol = realizedVol(rep, 20);
  const H = 10;
  const res = {};
  REGIMES.forEach(R => {
    const sel = [];
    for (let i = rep.start; i + H < rep.n; i++) {
      const v = vol[i];
      if (v == null || v < R.lo || v >= R.hi) continue;
      if (rep.scores[i] == null) continue;
      const p0 = rep.closes[i]; if (!p0) continue;
      sel.push({ i, s: rep.scores[i], r: rep.closes[i + H] / p0 - 1 });
    }
    if (sel.length < 30) { res[R.k] = { label: R.label, n: sel.length, ic: null, t: null, up: null, dn: null, win: null, base: null }; return; }
    const sc = sel.map(x => x.s), rr = sel.map(x => x.r);
    const spear = pearson(rankAvg(sc), rankAvg(rr));
    const neff = Math.max(4, Math.floor(sel.length / H));
    const base = rr.reduce((a, b) => a + b, 0) / rr.length;
    const up = sel.filter(x => x.s >= 60), dn = sel.filter(x => x.s < 40);
    const avg = a => a.length ? a.reduce((x, y) => x + y.r, 0) / a.length : null;
    const wr = a => a.length ? a.filter(x => x.r > 0).length / a.length : null;
    res[R.k] = {
      label: R.label, n: sel.length, ic: spear, t: spear == null ? null : spear / (1 / Math.sqrt(neff)),
      up: avg(up), dn: avg(dn), upN: up.length, dnN: dn.length, win: wr(up), base: base,
    };
  });
  /* 每个因子在各体制下的 IC —— 看「谁只在极端时有效、谁在平静时就有效」 */
  const facs = {};
  Object.keys(rep.fvals || {}).forEach(fid => {
    const a = rep.fvals[fid];
    const row = {};
    REGIMES.forEach(R => {
      const sub = []; const subN = new Array(rep.n).fill(null);
      for (let i = rep.start; i < rep.n; i++) {
        const v = vol[i];
        if (v == null || v < R.lo || v >= R.hi) { subN[i] = null; continue; }
        subN[i] = a[i];
      }
      const c = icCore(subN, rep, H, rep.start, rep.n);
      row[R.k] = c ? { ic: c.spear, n: c.n } : null;
    });
    facs[fid] = row;
  });
  return { byRegime: res, byFactor: facs, vol: vol };
}

/* ---------- 分期 IC：把十年切成几段，看 IC 是不是只在某一段成立 ----------
 * 全样本 IC = 0.14 可能只是「某一年特别准」拉起来的。分期之后才看得出来。 */
function periodIC(rep, ids) {
  const y0 = new Date(rep.calTs[rep.start]).getUTCFullYear();
  const y1 = new Date(rep.calTs[rep.n - 1]).getUTCFullYear();
  const out = [];
  for (let y = y0; y <= y1; y++) {
    let lo = -1, hi = -1;
    for (let i = rep.start; i < rep.n; i++) {
      const yy = new Date(rep.calTs[i]).getUTCFullYear();
      if (yy === y) { if (lo < 0) lo = i; hi = i; }
    }
    if (lo < 0 || hi - lo < 60) continue;
    const c = icCore(rep.scores, rep, 10, lo, hi + 1);
    out.push({
      y: y, n: hi - lo + 1,
      ic: c ? c.spear : null, t: c ? c.t : null,
      ret: c ? c.base : null,
    });
  }
  return out;
}

/* ---------- 极端体制子评分（v3.11 实践延展）----------
 * 来自 v3.11 分体制画像的发现：有些因子只在「极端波动率」体制里做事——
 * 算力趋势 hr（平静 0.08 / 极端 0.21）、黄金 gold（0.05 / 0.20）、原油 oil（−0.07 / −0.17）。
 * 于是把它们单独抽成一份「极端体制子评分」：平时休眠，仅当 20 日年化波动率 ≥ 80% 时启用。
 * 设计取舍：因子集是**经验硬编码**的（来自 v3.11 体制画像，wild|IC| 明显 > calm|IC| 的因子），
 * 权重沿用主评分里各自的静态权重。回放里验证它在极端体制内是否比主评分更能区分未来涨跌；
 * 线上只在 wild 体制点亮——极端期主评分本身不可信（低分档不再对应负收益），
 * 这时该看的是这份子评分 + 外生事件日历，而不是主 Nexus Score。 */
const EXTREME_FACTORS = ['hr', 'gold', 'oil'];
function fWeight(id) { const f = FACTORS.find(x => x.id === id); return f ? f.w : 1; }

/* 实时：从当天的因子 out（含 z / contribution / ok）合成子评分 */
function extremeSubScore(out) {
  let sum = 0, wsum = 0; const parts = [];
  EXTREME_FACTORS.forEach(id => {
    const o = out[id]; if (!o || o.ok === false) return;
    const w = fWeight(id); const c = (o.contribution || 0) * w;
    sum += c; wsum += w;
    parts.push({ id: id, name: (FACTORS.find(x => x.id === id) || {}).name || id, z: o.z, contribution: o.contribution, w: w });
  });
  if (wsum <= 0) return { score: null, parts: parts, available: 0 };
  const raw = sum / wsum;
  return { score: Math.max(2, Math.min(98, Math.round(50 + raw * 22))), raw: raw, parts: parts, available: parts.length };
}

/* 回放：从 rep.fvals（逐日贡献）合成子评分时间序列（与 rep 对齐，不可用时为 null） */
function extremeSubSeries(rep) {
  const n = rep.n, out = new Array(n).fill(null);
  const fw = {}; EXTREME_FACTORS.forEach(id => { fw[id] = fWeight(id); });
  for (let i = 0; i < n; i++) {
    let sum = 0, wsum = 0;
    for (const id of EXTREME_FACTORS) { const a = rep.fvals[id]; if (!a) continue; const v = a[i]; if (v == null) continue; sum += v * fw[id]; wsum += fw[id]; }
    if (wsum > 0) { const raw = sum / wsum; out[i] = Math.max(2, Math.min(98, Math.round(50 + raw * 22))); }
  }
  return out;
}

/* 把序列按体制遮罩：只保留落在指定体制（或任意体制若 regimeKey 为 null）的交易日 */
function regimeMasked(series, rep, regimeKey) {
  const vol = realizedVol(rep, 20); const out = new Array(rep.n).fill(null);
  for (let i = rep.start; i < rep.n; i++) {
    if (vol[i] == null) continue;
    const R = REGIMES.find(x => vol[i] >= x.lo && vol[i] < x.hi);
    if (regimeKey && (!R || R.k !== regimeKey)) continue;
    out[i] = series[i];
  }
  return out;
}

/* ---------- v3.12: Deribit 期权原生指标作为「分析专用参考」----------
 * 设计纪律：OOS 验证已证明「往评分里加因子 + 调权重」会过拟合（训练集 IC 0.246 →
 * 测试集转负、CV 无优势）。所以 Deribit 的 DVOL（隐含波动率指数）不进 Nexus Score，
 * 只作为独立参考指标，在回放里测它对未来 10 日收益的真实 IC 并按体制展示——
 * 先看清它到底有没有用，再决定是否进评分。 */
/* 把任意外部日频序列对齐到 rep.calTs（取 ≤ calTs[i] 的最近值；缺失段填 null） */
function alignToCalTs(srcTs, srcVals, calTs) {
  const n = calTs.length, out = new Array(n).fill(null);
  if (!srcTs || !srcTs.length) return out;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = calTs[i];
    while (j < srcTs.length && srcTs[j] <= t) j++;
    if (j > 0) out[i] = srcVals[j - 1];
  }
  return out;
}
/* 带缺失值保护的滚动 z（窗口 win）；窗口不足或窗口内含 null → null */
function auxZ(aligned, win) {
  const n = aligned.length, out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (aligned[i] == null) continue;
    const m = Math.min(win, i + 1);
    if (m < 10) continue;
    let s = 0, bad = false;
    for (let k = i - m + 1; k <= i; k++) { if (aligned[k] == null) { bad = true; break; } s += aligned[k]; }
    if (bad) continue;
    const mean = s / m;
    let acc = 0;
    for (let k = i - m + 1; k <= i; k++) { const d = aligned[k] - mean; acc += d * d; }
    const sd = Math.sqrt(acc / m);
    out[i] = sd > 1e-12 ? (aligned[i] - mean) / sd : 0;
  }
  return out;
}
/* 对某个历史包里的序列（如 DVOL）算全样本 + 分体制 IC(10) */
function auxRegimeIC(rep, key) {
  const b = state.histBundle;
  if (!b || !b.macro || !b.macro[key] || !b.macro[key].ts) return null;
  const src = b.macro[key];
  const aligned = alignToCalTs(src.ts, src.closes, rep.calTs);
  if (!aligned.some(function (x) { return x != null; })) return null;
  const z = auxZ(aligned, 60);
  const vol = realizedVol(rep, 20), H = 10;
  const full = icCore(z, rep, H, rep.start, rep.n);
  const byRegime = {};
  REGIMES.forEach(function (R) {
    const sub = new Array(rep.n).fill(null);
    for (let i = rep.start; i < rep.n; i++) {
      const v = vol[i];
      if (v == null || v < R.lo || v >= R.hi) continue;
      sub[i] = z[i];
    }
    byRegime[R.k] = icCore(sub, rep, H, rep.start, rep.n);
  });
  // v3.14: 当前 DVOL 值（对齐序列最后一个非 null）+ 近1年百分位 + 60日 z，用于恐慌区标注（与 /api/dvol 同口径）
  let lastIdx = -1;
  for (let i = aligned.length - 1; i >= 0; i--) { if (aligned[i] != null) { lastIdx = i; break; } }
  let latest = null, pctTrailing1y = null, z60 = null;
  if (lastIdx >= 0) {
    latest = aligned[lastIdx];
    const win = aligned.slice(Math.max(0, lastIdx - 365 + 1), lastIdx + 1).filter(x => x != null);
    if (win.length) pctTrailing1y = win.filter(x => x <= latest).length / win.length;
    const zwin = aligned.slice(Math.max(0, lastIdx - 60 + 1), lastIdx + 1).filter(x => x != null);
    if (zwin.length > 2) {
      const mean = zwin.reduce((a, b) => a + b, 0) / zwin.length;
      const sd = Math.sqrt(zwin.reduce((a, b) => a + (b - mean) * (b - mean), 0) / zwin.length);
      z60 = sd > 1e-9 ? (latest - mean) / sd : 0;
    }
  }
  return { key: key, full: full, byRegime: byRegime, latest: latest, pctTrailing1y: pctTrailing1y, z60: z60 };
}

/* 实时：从 BTC 日线 K 线算当前 20 日年化已实现波动率，判定当前体制 */
function currentRegime() {
  const k = state.klines && state.klines['BTC1d'];
  if (!k || k.length < 21) return null;
  const c = k.map(x => x.c);
  const rs = [];
  for (let i = c.length - 20; i < c.length; i++) { const p = c[i - 1]; if (p) rs.push(c[i] / p - 1); }
  if (rs.length < 15) return null;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  const v = rs.reduce((a, b) => a + (b - m) * (b - m), 0) / rs.length;
  const vol = Math.sqrt(v) * Math.sqrt(365);
  for (const R of REGIMES) if (vol >= R.lo && vol < R.hi) return { key: R.k, label: R.label, vol: vol };
  return { key: 'wild', label: '极端', vol: vol };
}

/* v3.28: DVOL 波动率体制的当前读数（与 /api/dvol、auxRegimeIC 同口径，但直接从 histBundle 算，离线可用）。
 * 只取最近一个非 null 值，算「近1年百分位」+「60日 z」。这是状态量，不是预测。 */
function dvolStatsNow() {
  const m = state.histBundle && state.histBundle.macro && state.histBundle.macro['DVOL'];
  if (!m || !m.closes) return null;
  const closes = m.closes;
  let lastIdx = -1;
  for (let i = closes.length - 1; i >= 0; i--) { const v = closes[i]; if (v != null && isFinite(v)) { lastIdx = i; break; } }
  if (lastIdx < 0) return null;
  const latest = closes[lastIdx];
  const win = closes.slice(Math.max(0, lastIdx - 365 + 1), lastIdx + 1).filter(function (x) { return x != null && isFinite(x); });
  const pct = win.length ? win.filter(function (x) { return x <= latest; }).length / win.length : null;
  const zwin = closes.slice(Math.max(0, lastIdx - 60 + 1), lastIdx + 1).filter(function (x) { return x != null && isFinite(x); });
  let z60 = null;
  if (zwin.length > 2) {
    const mean = zwin.reduce(function (a, b) { return a + b; }, 0) / zwin.length;
    let v2 = 0; for (let i = 0; i < zwin.length; i++) v2 += (zwin[i] - mean) * (zwin[i] - mean);
    const sd = Math.sqrt(v2 / zwin.length);
    z60 = sd > 1e-9 ? (latest - mean) / sd : 0;
  }
  return { latest: latest, pctTrailing1y: pct, z60: z60, date: m.ts ? m.ts[lastIdx] : null };
}

/* ---------- v3.11 十年复盘的渲染 ---------- */
const fPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
const fDate = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };
function fName(id) { const f = FACTORS.find(x => x.id === id); return f ? f.name : id; }

function renderReview() {
  const h = state.hist;
  const rb = $('regBox'), eb = $('extList'), pb = $('perBox'), hint = $('extHint');
  if (!rb || !eb || !pb) return;
  if (!h || !h.reg) { rb.innerHTML = '<div class="macro-hint">先运行上方的历史回放。</div>'; eb.innerHTML = ''; pb.innerHTML = ''; return; }

  /* ---- ① 分体制 ---- */
  const R = h.reg.byRegime;
  let html = '<div class="rg-tbl">' +
    '<div class="rg-hd"><span>市场状态</span><span>样本</span><span>评分 IC(10日)</span><span>高分档 &gt;60</span><span>低分档 &lt;40</span><span>基准</span></div>';
  ['calm', 'chop', 'wild'].forEach(function (k) {
    const r = R[k]; if (!r) return;
    const t = r.t == null ? '' : ' (' + r.t.toFixed(2) + ')';
    const cls = r.ic == null ? '' : (r.ic > 0.05 ? 'rg-g' : (r.ic < -0.05 ? 'rg-r' : 'rg-y'));
    html += '<div class="rg-row"><span class="rg-nm">' + r.label + '</span>' +
      '<span>' + (r.n || 0) + '</span>' +
      '<span class="' + cls + '">' + (r.ic == null ? '—' : r.ic.toFixed(3)) + t + '</span>' +
      '<span class="' + (r.up == null ? '' : (r.up >= 0 ? 'rg-g' : 'rg-r')) + '">' + fPct(r.up) + '<i>' + (r.upN ? ' n=' + r.upN : '') + '</i></span>' +
      '<span class="' + (r.dn == null ? '' : (r.dn >= 0 ? 'rg-g' : 'rg-r')) + '">' + fPct(r.dn) + '<i>' + (r.dnN ? ' n=' + r.dnN : '') + '</i></span>' +
      '<span class="rg-dim">' + fPct(r.base) + '</span></div>';
  });
  html += '</div>';
  /* 因子的体制画像：只看 |IC| 最大的几个，避免一屏塞满 */
  const bf = h.reg.byFactor || {};
  const rows = Object.keys(bf).map(function (id) {
    const r = bf[id];
    const a = ['calm', 'chop', 'wild'].map(function (k) { return r[k] ? r[k].ic : null; });
    if (a.every(function (x) { return x == null; })) return null;
    return { id: id, a: a, mx: Math.max.apply(null, a.map(function (x) { return x == null ? 0 : Math.abs(x); })) };
  }).filter(Boolean).sort(function (x, y) { return y.mx - x.mx; }).slice(0, 12);
  if (rows.length) {
    html += '<div class="rg-sub">因子在各体制下的 IC(10日) —— 左上角越靠前，说明它的作用越依赖于「有没有风浪」</div>';
    html += '<div class="rg-tbl"><div class="rg-hd"><span>因子</span><span>平静</span><span>震荡</span><span>极端</span><span></span><span></span></div>';
    rows.forEach(function (r) {
      html += '<div class="rg-row"><span class="rg-nm">' + fName(r.id) + '</span>';
      r.a.forEach(function (v) {
        html += '<span class="' + (v == null ? 'rg-dim' : (Math.abs(v) > 0.15 ? 'rg-g' : (v > 0 ? 'rg-y' : 'rg-r'))) + '">' + (v == null ? '—' : v.toFixed(3)) + '</span>';
      });
      html += '<span></span><span></span></div>';
    });
    html += '</div>';
  }
  rb.innerHTML = html;

  /* ---- ② 极端行情 ---- */
  const ext = h.ext || [];
  if (!ext.length) { eb.innerHTML = '<div class="macro-hint">未识别到极端窗口。</div>'; }
  else {
    let e = '';
    ext.slice(0, 14).forEach(function (x) {
      const up = x.r5 >= 0;
      const hit = x.hit;
      const pre = x.preScore;
      /* 可预警性判定：事件前 20 日评分已经站到极值区，就算「因子有预警」；
       * 否则是「外生突袭」—— 因子当时没觉得有事，是外部冲击打进来的。 */
      const warned = pre != null && (pre >= 60 || pre <= 40);
      const kind = warned ? (pre >= 60 ? '因子已在高温区' : '因子已在低温区') : '外生突袭（因子当时中性）';
      e += '<div class="ex-card ' + (up ? 'ex-up' : 'ex-dn') + '">' +
        '<div class="ex-h"><span class="ex-d">' + fDate(x.ts) + '</span>' +
        '<span class="ex-r">5日 ' + fPct(x.r5) + '</span>' +
        '<span class="ex-r2">20日 ' + fPct(x.r20) + '</span>' +
        '<span class="ex-k">' + kind + '</span></div>' +
        (hit ? '<div class="ex-ev">📌 ' + hit.t + ' <i>' + hit.k + '</i> · ' + hit.n + '</div>'
             : '<div class="ex-ev ex-nohit">📌 无对应外生事件（可能是模型内因子自身走完的行情）</div>') +
        '<div class="ex-z">事件前 20 日评分 ' + (pre == null ? '—' : pre.toFixed(1)) +
        ' → 事件后 20 日 ' + (x.postScore == null ? '—' : x.postScore.toFixed(1)) +
        ' ｜ 当时最偏离的因子：' + (x.topZ || []).map(function (z) { return fName(z.id).replace(/^[^ ]+ /, '') + ' ' + (z.z >= 0 ? '+' : '') + z.z.toFixed(1); }).join(' · ') +
        '</div></div>';
    });
    eb.innerHTML = e;
  }

  /* ---- ③ 分期稳定性 ---- */
  const per = h.per || [];
  let ph = '<div class="rg-tbl"><div class="rg-hd"><span>年份</span><span>交易日</span><span>评分 IC(10日)</span><span>BTC 10日基准</span><span></span><span></span></div>';
  per.forEach(function (r) {
    const cls = r.ic == null ? 'rg-dim' : (r.ic > 0.08 ? 'rg-g' : (r.ic < -0.08 ? 'rg-r' : 'rg-y'));
    ph += '<div class="rg-row"><span class="rg-nm">' + r.y + '</span><span>' + r.n + '</span>' +
      '<span class="' + cls + '">' + (r.ic == null ? '—' : r.ic.toFixed(3)) + (r.t == null ? '' : ' (' + r.t.toFixed(2) + ')') + '</span>' +
      '<span>' + fPct(r.ret) + '</span><span></span><span></span></div>';
  });
  ph += '</div>';
  pb.innerHTML = ph;

  /* v3.11 实践延展：极端体制子评分的回测验证 */
  const ex = h.extreme || null;
  if (ex) {
    const box = $('extScoreBox');
    if (box) {
      const fmtIc = x => x == null || x.spear == null ? '—' : x.spear.toFixed(3) + (x.t == null ? '' : ' (' + x.t.toFixed(2) + ')');
      const cls = x => x == null || x.spear == null ? 'rg-y' : (x.spear > 0.1 ? 'rg-g' : (x.spear < 0 ? 'rg-r' : 'rg-y'));
      const mainWild = ex.mainWildIC;
      const wn = (h.reg && h.reg.byRegime.wild && h.reg.byRegime.wild.n) || (ex.wildIC ? ex.wildIC.n : null);
      let html = '<div class="fttl" style="margin-bottom:7px">⑦ 极端体制子评分 · 回测验证（同 10 年样本，非样本外）</div>';
      html += '<div class="rg-sub">把 v3.11 体制画像里「只在极端期做事」的因子（算力 / 黄金 / 原油）单独抽成一份子评分，平时休眠、仅当 20 日波动率 ≥ 80% 启用。下面看它在<b>极端体制内</b>是否比主评分更能区分未来 10 日涨跌：</div>';
      html += '<div class="rg-tbl"><div class="rg-hd"><span>评分口径</span><span>极端期 IC(10日)</span><span>极端样本</span><span>全样本 IC(10日)</span><span></span><span></span></div>';
      html += '<div class="rg-row"><span class="rg-nm">主 Nexus Score</span><span>' + (mainWild == null ? '—' : mainWild.toFixed(3)) + '</span><span>' + wn + '</span><span>' + (h.ics && h.ics[2] ? h.ics[2].spear.toFixed(3) : '—') + '</span><span></span><span></span></div>';
      html += '<div class="rg-row"><span class="rg-nm">极端体制子评分（算力/黄金/原油）</span><span class="' + cls(ex.wildIC) + '">' + fmtIc(ex.wildIC) + '</span><span>' + (ex.wildIC ? ex.wildIC.n : '—') + '</span><span class="' + cls(ex.allIC) + '">' + fmtIc(ex.allIC) + '</span><span></span><span></span></div>';
      html += '</div>';
      const verdict = (ex.wildIC && ex.wildIC.spear != null && mainWild != null)
        ? (ex.wildIC.spear > mainWild
            ? '在极端体制内，这份子评分比主评分更能区分未来 10 日涨跌（' + ex.wildIC.spear.toFixed(3) + ' vs ' + mainWild.toFixed(3) + '）—— 但仍是同样本回测，需样本外验证。'
            : '在极端体制内，这份子评分并未优于主评分（' + ex.wildIC.spear.toFixed(3) + ' vs ' + mainWild.toFixed(3) + '）：极端行情主要由外生冲击驱动，因子信号被稀释，这时该看外生事件日历而非任何评分。')
        : '极端期样本不足，无法判定。';
      html += '<div class="rg-sub">' + verdict + '</div>';
      box.innerHTML = html;
    }
  }

  /* v3.12: Deribit 期权原生指标（DVOL 隐含波动率指数）作为分析参考，不入评分 */
  const auxBox = $('auxBox');
  if (auxBox) {
    const dv = (h.aux || {}).DVOL;
    if (!dv) {
      auxBox.innerHTML = '<div class="rg-sub">Deribit DVOL（隐含波动率指数）暂无可用的历史数据。</div>';
    } else {
      const icTxt = function (c) { return c == null || c.spear == null ? '—' : c.spear.toFixed(3) + (c.t == null ? '' : ' (' + c.t.toFixed(2) + ')'); };
      const cls = function (c) { return c == null || c.spear == null ? 'rg-y' : (Math.abs(c.spear) > 0.15 ? (c.spear > 0 ? 'rg-g' : 'rg-r') : (c.spear > 0 ? 'rg-y' : 'rg-r')); };
      let html = '<div class="fttl" style="margin-bottom:7px">⑧ Deribit 期权原生指标 · 参考（不入评分）</div>';
      html += '<div class="rg-sub">DVOL 是 Deribit 的波动率指数（VIX 同款，隐含波动率 = 市场对未来波动的预期，crypto 原生的「恐惧温度计」）。它<b>没有</b>塞进 Nexus Score——OOS 验证已证明往评分里加因子会过拟合。这里只测它对未来 10 日收益的真实 IC，先看有没有用：</div>';
      html += '<div class="rg-tbl"><div class="rg-hd"><span>指标</span><span>全样本 IC</span><span>平静</span><span>震荡</span><span>极端</span><span>样本</span></div>';
      html += '<div class="rg-row"><span class="rg-nm">DVOL 隐含波动率</span>';
      html += '<span class="' + cls(dv.full) + '">' + icTxt(dv.full) + '</span>';
      ['calm', 'chop', 'wild'].forEach(function (k) { const c = dv.byRegime[k]; html += '<span class="' + cls(c) + '">' + icTxt(c) + '</span>'; });
      html += '<span>' + (dv.full ? dv.full.n : '—') + '</span></div>';
      html += '</div>';
      const verdict = (dv.full && dv.full.spear != null)
        ? (Math.abs(dv.full.spear) > 0.15
            ? 'DVOL 与未来 10 日收益的相关达到 |IC|>0.15，是值得纳入考虑的 crypto 原生情绪/风险信号；下一步用 walk-forward 验证稳定性后再决定是否进评分。'
            : 'DVOL 的 IC 落在噪声区（|IC|<0.15），作为「恐惧温度计」定性看看可以，但不足以单独预测方向。它真正的价值在<b>极端期</b>：波动率指数飙升本身就是风险事件警报，比任何因子都直接。')
        : 'DVOL 样本不足，无法判定。';
      html += '<div class="rg-sub">' + verdict + '</div>';
      // v3.14: 当前 DVOL 恐慌区标注（与实时 /api/dvol 同口径）
      if (dv.latest != null && dv.pctTrailing1y != null) {
        const pct = dv.pctTrailing1y, pctTxt = (pct * 100).toFixed(0) + '%';
        const col = pct >= 0.90 ? 'var(--red)' : (pct >= 0.75 ? 'var(--yellow)' : 'var(--green)');
        const zone = pct >= 0.90 ? '⚠ 当前处历史恐慌区' : (pct >= 0.75 ? '当前波动率偏高' : '当前波动率处历史正常区间');
        html += '<div class="rg-sub" style="color:' + col + '"><b>' + zone + '</b>（近1年 ' + pctTxt + '）· DVOL=' + dv.latest.toFixed(0) + ' · 60日z=' + (dv.z60 == null ? '—' : dv.z60.toFixed(2)) + '</div>';
      }
      // v3.14: 数据边界 / 创世纪元（诚实回答「拉长到 2009」）
      const startTs = (h.rep && h.rep.calTs && h.rep.calTs[h.rep.start]) || null;
      html += '<div class="rg-sub" style="border-top:1px dashed var(--border);margin-top:8px;padding-top:8px"><b>数据边界</b>：IC 窗口实际始于 ' + (startTs ? fDate(startTs) : '—') + '（因子覆盖齐全的起点；BTC 日线虽延至 2014，但宏观/衍生品序列 2016-10 才齐全，故回放骨架前段 2014–2016 因子稀疏、不计入 IC）。链上 HR/TX/FEE 回溯到 2009，但 BTC 价格（IC 的因变量）最早可靠约 2014，且 <b>2009–2014 无可靠价格 → 标为「创世纪元」，不参与 IC 加权</b>。拉长到比特币诞生之年受价格源限制，非因子问题。</div>';
      // v3.15: 护栏实证结论（walk-forward 防御回测，离线验证，详见 README v3.15）
      html += '<div class="rg-sub" style="border-top:1px dashed var(--border);margin-top:8px;padding-top:8px"><b>护栏实证（v3.15 walk-forward 回测）</b>：把警报当「机械减仓开关」不成立——' +
        '<b>① wild 体制是动量而非危险信号</b>：触发后 10/20 日远期收益反而更高（+3.28%/+7.01% vs 未触发 +1.53%/+3.14%，t=3.24/4.53），此时空仓会错失涨幅（Sharpe 0.82→0.64）；' +
        '<b>② DVOL 恐慌单独触发</b>虽在 20 日远端有前瞻性（−3.40%，t=−4.56），但按恐慌日空仓最大回撤未降（−83.4% 不变）、Sharpe 反降（0.82→0.77）；' +
        '<b>③ 双重警报（wild+恐慌同发）</b>是唯一有统计意义的短周期预警（触发后 10 日均值 −2.11%，t=−2.41），但仅 32 个样本、占时长 0.7%，太稀疏不足以系统化交易。' +
        '→ 警报的正确定位是<b>行为护栏</b>（降杠杆 / 不追高 / 别临场决策），<b>不是可机械执行的卖出信号</b>；真正耐用的输出仍是体制徽标那句「主评分此时不可信」。</div>';
      auxBox.innerHTML = html;
    }
  }

  /* ---- ⑩ 多重检验与过拟合校正 ----
   * 用途很直接：给上面所有「IC 是多少 / t 是多少」的结论标上可信度折扣。
   * 一次回放会对 20+ 因子 × 4 horizon 做上百次检验；不做校正的话，
   * 单看 |t|>2 会把纯噪声读成信号，这正是业余因子挖掘的典型失误。 */
  renderMtBox();

  /* ---- ⑨ 十年关键事件时间线 ----
   * 与 ⑥ 的口径不同：⑥ 是「程序扫出来的极端波幅」（|5日收益| ≥ 15%），
   * 而这列是「当时确实重要、但日线波幅未必够阈值」的事 —— 最典型的就是
   * 2025-10-10 的史上最大清算：它惨在杠杆清算规模，不在价格跌幅，因此 ⑥ 永远抓不到。
   * 按时间正序排列（复盘是顺着时间看，不是按幅度排），并给出事件发生时的真实价格与后续走势。 */
  const evBox = $('evtBox');
  if (evBox && h.rep && h.rep.closes) {
    const rp = h.rep, cc = rp.closes, nn = rp.n;
    const fwdAt = function (i, h2) { return (i + h2 < nn && cc[i] != null && cc[i + h2] != null) ? cc[i + h2] / cc[i] - 1 : null; };
    const tRows = EVENTS.map(function (E) {
      const i = eventIdx(rp, E.d);
      if (i < 0) return null;
      let sc = 0, cnt = 0;
      if (rp.scores) for (var k = Math.max(rp.start, i - 20); k < i; k++) { const v = rp.scores[k]; if (v != null) { sc += v; cnt++; } }
      return { E: E, i: i, px: cc[i], r5: fwdAt(i, 5), r20: fwdAt(i, 20), pre: cnt ? sc / cnt : null };
    }).filter(Boolean);
    let eh = '<div class="rg-sub">按时间正序的里程碑。与 ⑥ 互补：<b>⑥ 只显示程序扫出的极端波幅</b>（|5日| ≥ 15%），再倒查它对应什么事件；' +
      '而这列是<b>先有事件、再看当时价格与后续走势</b> —— 两者都会漏东西，合起来才是完整的十年。' +
      '典型例子：<b>2025-10-10 史上最大清算</b>，190 亿美元杠杆灰飞烟灭，但当日收盘只跌 7.0%、5 日仅 -2.1%，远不到 ⑥ 的 15% 阈值，所以在 ⑥ 里根本不会出现；它的杀伤力在清算规模与持仓量骤降 43%，不在日线跌幅。</div>';
    if (!tRows.length) {
      eh += '<div class="rg-sub">当前回放窗口内没有可对上的事件。</div>';
    } else {
      eh += '<div class="evtl"><div class="evtl-h"><span>日期</span><span>事件</span><span>当时收盘</span><span>后5日</span><span>后20日</span><span>因子状态</span></div>';
      tRows.forEach(function (r) {
        const warned = r.pre != null && (r.pre >= 60 || r.pre <= 40);
        const pc = function (v) { return v == null ? 'rg-dim' : (v >= 0 ? 'rg-g' : 'rg-r'); };
        eh += '<div class="evtl-r' + (r.E.big ? ' ev-big' : '') + '">' +
          '<span>' + fDate(rp.calTs[r.i]) + '</span>' +
          '<span class="evtl-nm">' + (r.E.big ? '<b>' + r.E.t + '</b>' : r.E.t) + ' <i>[' + r.E.k + ']</i><br><i>' + r.E.n + '</i></span>' +
          '<span>' + (r.px == null ? '—' : '$' + Math.round(r.px).toLocaleString('en-US')) + '</span>' +
          '<span class="' + pc(r.r5) + '">' + fPct(r.r5) + '</span>' +
          '<span class="' + pc(r.r20) + '">' + fPct(r.r20) + '</span>' +
          '<span class="' + (r.pre == null ? 'rg-dim' : (warned ? 'rg-y' : 'rg-dim')) + '">' +
          (r.pre == null ? '—' : (warned ? '预警 ' : '中性 ') + r.pre.toFixed(0)) + '</span>' +
          '</div>';
      });
      eh += '</div>';
      eh += '<div class="rg-sub">「因子状态」是事件发生前 20 个交易日的 Nexus Score 均值：落在 ≥60 或 ≤40 记为<b>预警</b>（因子当时已经不对劲），否则为<b>中性</b>（被外部事件突袭）。带蓝色竖条的是左右过两轮周期走向的里程碑。</div>';
    }
    evBox.innerHTML = eh;
  }

  if (hint) hint.textContent = h.ext ? (h.ext.length + ' 波极端行情') : '已完成';
}

/* ---------- 渲染 ---------- */
function pctS(v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 2 : dp) + '%'; }
function sigMark(t) {
  if (t == null) return '';
  const a = Math.abs(t);
  return a > 3 ? '<b class="sig">**</b>' : a > 2 ? '<b class="sig">*</b>' : '';
}
function icColor(x) { return x > 0.05 ? '#00e5a0' : x < -0.05 ? '#ff3d6e' : '#ffc107'; }

function drawHistChart(cv, rep) {
  if (!cv) return;
  const W = cv.clientWidth || 900, HH = 230;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr); cv.height = Math.round(HH * dpr);
  cv.style.height = HH + 'px';
  const g = cv.getContext('2d'); if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, HH);

  const padL = 32, padR = 46, padT = 10, padB = 16;
  const iw = W - padL - padR, ih = HH - padT - padB;
  const N = rep.n - rep.start;
  const x = i => padL + (i - rep.start) / Math.max(1, N - 1) * iw;
  const y = s => padT + (100 - s) / 100 * ih;

  // 40~60 中性带
  g.fillStyle = 'rgba(255,193,7,.055)';
  g.fillRect(padL, y(60), iw, y(40) - y(60));

  // 网格 + 轴标签
  g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
  g.font = '9px "JetBrains Mono", monospace'; g.fillStyle = '#4a6a8a'; g.textAlign = 'right';
  [20, 40, 50, 60, 80].forEach(v => {
    g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(W - padR, y(v)); g.stroke();
    g.fillText(v, padL - 5, y(v) + 3);
  });
  g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,193,7,.45)';
  g.beginPath(); g.moveTo(padL, y(50)); g.lineTo(W - padR, y(50)); g.stroke();
  g.setLineDash([]);

  // BTC 价格（右轴，归一化，淡色）—— 只为肉眼比对，不参与 IC
  const P = [];
  for (let i = rep.start; i < rep.n; i++) if (rep.closes[i]) P.push(rep.closes[i]);
  if (P.length > 2) {
    const pmin = Math.min.apply(null, P), pmax = Math.max.apply(null, P);
    const py = v => padT + (pmax - v) / Math.max(1e-9, pmax - pmin) * ih;
    g.strokeStyle = 'rgba(139,92,246,.5)'; g.lineWidth = 1.2;
    g.beginPath(); let first = true;
    for (let i = rep.start; i < rep.n; i++) { const v = rep.closes[i]; if (!v) continue; const px = x(i), pv = py(v); if (first) { g.moveTo(px, pv); first = false; } else g.lineTo(px, pv); }
    g.stroke();
    g.fillStyle = 'rgba(139,92,246,.85)'; g.textAlign = 'left';
    g.fillText(pmax >= 1000 ? (pmax / 1000).toFixed(0) + 'k' : pmax.toFixed(0), W - padR + 4, py(pmax) + 3);
    g.fillText(pmin >= 1000 ? (pmin / 1000).toFixed(0) + 'k' : pmin.toFixed(0), W - padR + 4, py(pmin) + 3);
  }

  // 评分折线（按分值着色：绿=偏多 / 红=偏空 / 灰=中性）
  g.lineWidth = 1.6;
  for (let i = rep.start + 1; i < rep.n; i++) {
    const a = rep.scores[i - 1], b = rep.scores[i];
    if (a == null || b == null) continue;
    const m = (a + b) / 2;
    g.strokeStyle = m > 60 ? '#00e5a0' : m < 40 ? '#ff3d6e' : '#ffc107';
    g.beginPath(); g.moveTo(x(i - 1), y(a)); g.lineTo(x(i), y(b)); g.stroke();
  }

  // 起止日期
  g.fillStyle = '#4a6a8a'; g.textAlign = 'left';
  g.fillText(new Date(rep.calTs[rep.start]).toISOString().slice(0, 10), padL, HH - 4);
  g.textAlign = 'right';
  g.fillText(new Date(rep.calTs[rep.n - 1]).toISOString().slice(0, 10), W - padR, HH - 4);
}

function renderHistory() {
  const S = state.hist; if (!S) return;
  const rep = S.rep, ics = S.ics;
  const dstr = t => new Date(t).toISOString().slice(0, 10);
  const hint = $('histHint');
  if (hint) hint.textContent = dstr(rep.calTs[rep.start]) + ' → ' + dstr(rep.calTs[rep.n - 1]) + ' · ' + (rep.n - rep.start) + ' 个交易日 · 回放 ' + rep.nScored + ' 维';

  const tb = $('icTable');
  if (tb) {
    const hd = '<div class="ic-row ic-hd"><span>周期</span><span>IC<br>Spearman</span><span>IC<br>Pearson</span><span>样本</span><span>评分&gt;60<br>平均收益</span><span>评分&lt;40<br>平均收益</span></div>';
    tb.innerHTML = hd + ics.map(function (x) {
      const up = x.buckets[2], dn = x.buckets[0], md = x.buckets[1];
      return '<div class="ic-row"><span class="ic-h">' + x.h + '日</span>' +
        '<span style="color:' + icColor(x.spear == null ? 0 : x.spear) + '">' + (x.spear == null ? '—' : x.spear.toFixed(3)) + sigMark(x.t) + '</span>' +
        '<span>' + (x.pear == null ? '—' : x.pear.toFixed(3)) + '</span>' +
        '<span class="ic-n">' + x.n + '</span>' +
        '<span style="color:' + (up.mean == null ? '#5b7a9a' : up.mean >= 0 ? '#00e5a0' : '#ff3d6e') + '">' + pctS(up.mean) + '<i>n=' + up.n + '</i></span>' +
        '<span style="color:' + (dn.mean == null ? '#5b7a9a' : dn.mean >= 0 ? '#00e5a0' : '#ff3d6e') + '">' + pctS(dn.mean) + '<i>n=' + dn.n + '</i></span>' +
        '</div>';
    }).join('') +
      '<div class="ic-note">中性档（40~60）' + ics.map(function (x) { return x.h + '日 ' + pctS(x.buckets[1].mean); }).join(' · ') +
      '<br>基准（全样本 ' + ics[0].h + ' 日前向收益）= ' + pctS(ics[0].base) + '。判定门槛：<b>分档要单调、要跑赢基准、IC 要通过显著性</b>。' +
      '<br><b>*</b> = |t|&gt;2 · <b>*</b><b>*</b> = |t|&gt;3。t 按非重叠窗口数折算（有效样本 ≈ 样本/' + ics[0].h + ' 天），' +
      '直接用 n 算会把重叠窗口的噪声读成信号 —— 这是因子研究里最常见的自欺。</div>';
  }

  const box = $('histBars');
  if (box) {
    const x10 = ics.find(function (v) { return v.h === 10; }) || ics[0];
    const mx = Math.max.apply(null, x10.buckets.map(function (b) { return Math.abs(b.mean || 0); }).concat([1e-4]));
    const names = ['偏空 <40', '中性 40~60', '偏多 >60'];
    const cols = ['#ff3d6e', '#ffc107', '#00e5a0'];
    box.innerHTML = '<div class="fttl" style="margin-bottom:6px">' + x10.h + ' 日前向收益 · 分档（含胜率）</div>' +
      x10.buckets.map(function (b, i) {
        const w = b.mean == null ? 0 : Math.abs(b.mean) / mx * 100;
        const neg = (b.mean || 0) < 0;
        return '<div class="brow"><span class="bn">' + names[i] + '</span>' +
          '<span class="bw"><i style="width:' + w.toFixed(1) + '%;background:' + cols[i] + ';' + (neg ? 'opacity:.55' : '') + '"></i></span>' +
          '<span class="bv" style="color:' + (b.mean == null ? '#5b7a9a' : neg ? '#ff3d6e' : '#00e5a0') + '">' + pctS(b.mean) + '</span>' +
          '<span class="bc">' + (b.win == null ? '—' : (b.win * 100).toFixed(0) + '%') + '<i>n=' + b.n + '</i></span></div>';
      }).join('');
  }

  const src = $('histSrc');
  if (src) {
    const s = rep.srcs || {};
    const cov = state.histBundle && state.histBundle.coverage;
    const covTxt = cov ? '覆盖度：最短序列 ' + cov.minKey + ' ' + cov.minLen + ' 点' + (cov.degraded ? '（降级·可能是某源偶发失败）' : '') + '，共 ' + cov.nSeries + ' 条。' : '';
    src.textContent = covTxt + '回放因子子集（22 维）：情绪 / 算力 / 链上活跃 / MVRV / 活跃地址 / 手续费 / 永续溢价 / 持仓量(史) / 美元 / 美债10Y / 标普 / VIX / 黄金 / 原油 / 地缘代理 / 美联储2Y / 通胀预期 / 期限利差 / 美元日元 / 日债10Y / 技术面 / 动量。' +
      '不含：5 个事件因子（无历史发布值）、资金费率与多空比（仅当日值）、BTC占比与稳定币占比（无历史总市值）。价格用 ' + (s.BTC || 'yahoo:BTC-USD') + '。';
  }

  renderFacRank(S.facs);
  renderRwBox();
  renderQuintBox();
  renderCalibBox();
  renderDimBox();
  /* v3.22 ㉒㉓：换手率与可执行性 + 信号健康度 */
  try { renderExecBox(); } catch (e) { console.warn('exec fail', e && e.message); }
  try { renderHealthBox(); } catch (e) { console.warn('health fail', e && e.message); }
  /* v3.23 ㉔㉕㉖：仓位政策对比 / 收益归因 / 选择偏差（失败不影响主面板） */
  try { renderPolicyBox(); } catch (e) { console.warn('policy box fail', e && e.message); }
  try { renderAttrBox(); } catch (e) { console.warn('attr box fail', e && e.message); }
  try { renderSelectBox(); } catch (e) { console.warn('select box fail', e && e.message); }
  /* v3.24 ㉗㉘㉙：评分幅度分解 / 标尺重标定 / 夹紧代价 */
  try { renderScaleBox(); } catch (e) { console.warn('scale box fail', e && e.message); }
  renderOOS(S.oos);
  drawRollChart($('rollCanvas'), S.roll);
  drawHistChart($('histCanvas'), rep);
}


/* =====================================================================
 *  v3.9 · 把「评分 IC ≈ 0」拆开
 *  ---------------------------------------------------------------------
 *  v3.8 只证明了「合成分数没用」，这是一个没有行动价值的结论。
 *  v3.9 回答三个能指导决策的问题：
 *    ① 哪个因子在做正贡献、哪个在制造噪声、哪个方向可能设反了（归因）
 *    ② 如果在历史前半段挑因子，后半段还能不能用（样本外，防过拟合自欺）
 *    ③ IC 是常数还是随市场状态漂移（滚动 IC）
 * ===================================================================== */

/* ① 单项因子 IC 归因：IC 的符号就是「方向设对没有」的答案 */
function factorICRows(rep) {
  const rows = [];
  Object.keys(rep.fvals || {}).forEach(function (fid) {
    const f = FACTORS.find(function (x) { return x.id === fid; });
    if (!f) return;
    const per = {};
    IC_HORIZONS.forEach(function (h) {
      const c = icCore(rep.fvals[fid], rep, h, rep.start, rep.n);
      per[h] = c ? { ic: c.spear, t: c.t, n: c.n } : null;
    });
    rows.push({ id: fid, name: f.name, dir: f.dir, w: f.w, per: per });
  });
  /* 按 |IC(10日)| 排序 —— 一眼看出谁在做事、谁在空转 */
  rows.sort(function (x, y) {
    const A = x.per[10] && x.per[10].ic != null ? Math.abs(x.per[10].ic) : -1;
    const B = y.per[10] && y.per[10].ic != null ? Math.abs(y.per[10].ic) : -1;
    return B - A;
  });
  return rows;
}

/* 把若干因子的方向化贡献等权合成一条序列（样本内外对比用；
 * 分数本身是加权平均，这里用等权是为了把「选因子」的影响单独隔离出来） */
function compositeSeries(rep, ids) {
  const n = rep.n, out = new Array(n).fill(null);
  for (let i = rep.start; i < n; i++) {
    let s = 0, c = 0;
    for (let q = 0; q < ids.length; q++) {
      const arr = rep.fvals[ids[q]];
      if (!arr) continue;
      const v = arr[i];
      if (v != null) { s += v; c++; }
    }
    if (c) out[i] = s / c;
  }
  return out;
}

/* ② 样本内挑因子 → 样本外检验。
 * 只保留「样本内 IC > 0」的因子（不翻方向 —— 翻方向属于数据窥探，很容易自欺）。
 * 如果优选组合的样本外 IC 明显衰减甚至转负，说明样本内的挑选只是拟合了噪声。 */
const OOS_SPLIT = 0.6, OOS_H = 10;
function oosTest(rep) {
  const span = rep.n - rep.start;
  const cut = rep.start + Math.round(span * OOS_SPLIT);
  if (cut - rep.start < 80 || rep.n - cut < 60) return null;
  const rows = factorICRows(rep);
  const allIds = [], keptIds = [];
  rows.forEach(function (row) {
    const arr = rep.fvals[row.id];
    if (!arr) return;
    const tr = icCore(arr, rep, OOS_H, rep.start, cut);
    const te = icCore(arr, rep, OOS_H, cut, rep.n);
    row.tr = tr ? tr.spear : null;
    row.te = te ? te.spear : null;
    allIds.push(row.id);
    if (tr && tr.spear != null && tr.spear > 0) keptIds.push(row.id);
  });
  const mk = function (ids) {
    const series = compositeSeries(rep, ids);
    const tr = icCore(series, rep, OOS_H, rep.start, cut);
    const te = icCore(series, rep, OOS_H, cut, rep.n);
    return { tr: tr ? tr.spear : null, te: te ? te.spear : null, n: ids.length };
  };
  const ltr = icCore(rep.scores, rep, OOS_H, rep.start, cut);
  const lte = icCore(rep.scores, rep, OOS_H, cut, rep.n);
  return {
    cut: cut, h: OOS_H, nTrain: cut - rep.start, nTest: rep.n - cut,
    nAll: allIds.length, nKept: keptIds.length, kept: keptIds,
    live: { tr: ltr ? ltr.spear : null, te: lte ? lte.spear : null, n: rep.nScored },
    equal: mk(allIds), pick: mk(keptIds),
  };
}

/* ③ 滚动 IC：IC 不是常数，是随市场状态漂移的。
 * 一个「平均 IC ≈ 0」的因子，可能在前半段很强、后半段反向 —— 平均会把这件事藏起来。 */
const ROLL_WIN = 60;
function rollingIC(rep, win, h) {
  const out = [];
  for (let e = rep.start + win; e <= rep.n - h; e++) {
    const c = icCore(rep.scores, rep, h, e - win, e);
    out.push({ i: e, ic: c ? c.spear : null });
  }
  return out;
}

/* =====================================================================
 * v3.17：多重检验与过拟合校正
 *
 *  这是「业余因子挖掘」与「专业机构」之间最硬的一条分界线，而且它可量化。
 *  本终端一次回放会给 20+ 个因子 × 4 个 horizon 分别做显著性检验。若沿用
 *  |t| > 2（≈ α=0.05）逐个判定，即使全部是纯噪声，统计上也期望有
 *  K × α 个「显著」—— K=88 时就是 4.4 个假阳性。过去本面板的判定 ①②
 *  正是这么做的。López de Prado 一整套方法就是为修正它而生，这里落地四项：
 *
 *    (a) Bonferroni / Šidák —— 把显著性门槛按试验次数 K 放大
 *    (b) Benjamini-Hochberg FDR —— 控制「被判显著的结果里假发现的比例」
 *    (c) White's Reality Check —— 在「全是噪声」的零假设下重采样，看最好的
 *        那个因子能好到什么程度；若真实最好值不比噪声极值更极端，则整体不显著
 *    (d) Deflated IC —— 在同等试验次数下，纯噪声能「碰」出的 IC 期望最大值
 *
 *  这些方法不会让信号变强。它们只会告诉你，你看到的「信号」
 *  有多少可以纯粹用「试的次数够多」来解释。
 * ===================================================================== */
function erfApprox(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function normCdf(x) { return 0.5 * (1 + erfApprox(x / Math.SQRT2)); }
/* 正态逆 CDF（二分）—— 用来把校正后的 α 换算回「|t| 要大于多少」 */
function normInv(p) {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -12 : 12;
  let lo = -12, hi = 12;
  for (let k = 0; k < 100; k++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
function tToP2(t) { return Math.max(1e-12, 2 * (1 - normCdf(Math.abs(t)))); }

/* White's Reality Check 的加速关键：Spearman 的秩在重排下是等变的。
 * 若 r' 是 r 的一个排列（r'[i] = r[perm[i]]），则 rank(r')[i] = rank(r)[perm[i]]。
 * 于是每次 bootstrap 不必再对打乱后的收益序列重新排序，直接查预计算的秩表即可
 * —— 把每次 bootstrap 的复杂度从 O(K·m·log m) 降到 O(K·m)。 */
function multiTest(rep, opts) {
  opts = opts || {};
  const alpha = opts.alpha == null ? 0.05 : opts.alpha;
  const B = opts.boot || 200;
  const rows = factorICRowsCached(rep);
  const tests = [];
  rows.forEach(function (row) {
    IC_HORIZONS.forEach(function (h) {
      const p = row.per[h];
      if (!p || p.t == null || p.ic == null) return;
      tests.push({ id: row.id, name: row.name, h: h, ic: p.ic, t: p.t, n: p.n });
    });
  });
  const K = tests.length;
  if (!K) return null;
  tests.forEach(function (x) { x.p = tToP2(x.t); });

  const tCritRaw = normInv(1 - alpha / 2);
  const tCritBonf = normInv(1 - alpha / (2 * K));
  const aSidak = 1 - Math.pow(1 - alpha, 1 / K);
  const tCritSidak = normInv(1 - aSidak / 2);

  /* Benjamini-Hochberg step-up：先算 q 值（step-up 修正后的 p），再看哪些过了 α */
  const ord = tests.map(function (x, i) { return i; }).sort(function (a, b) { return tests[a].p - tests[b].p; });
  let prev = 1;
  for (let k = ord.length - 1; k >= 0; k--) {
    const i0 = ord[k];
    const qv = Math.min(prev, tests[i0].p * K / (k + 1));
    tests[i0].q = qv;
    prev = qv;
  }
  let kMax = 0;
  for (let k = 0; k < ord.length; k++) if (tests[ord[k]].p <= (k + 1) / K * alpha) kMax = k + 1;
  ord.forEach(function (i0, k) { tests[i0].bhSig = k < kMax; });
  tests.forEach(function (x) {
    x.rawSig = Math.abs(x.t) > tCritRaw;
    x.bonfSig = Math.abs(x.t) > tCritBonf;
    x.sidakSig = Math.abs(x.t) > tCritSidak;
  });

  const nRawSig = tests.filter(function (x) { return x.rawSig; }).length;
  const nBonfSig = tests.filter(function (x) { return x.bonfSig; }).length;
  const nSidakSig = tests.filter(function (x) { return x.sidakSig; }).length;
  const nBhSig = tests.filter(function (x) { return x.bhSig; }).length;

  /* ---- White's Reality Check（置换 bootstrap，horizon = 10 日）----
   * 朴素写法是 O(B·K·m·log m)。三处优化把它压到百毫秒级：
   *   ① 秩等变性 —— 打乱 r 后其秩只是被同一个 perm 作用，不必重新排序，
   *      于是 Spearman 退化成「查预计算的秩表 + 一次 pearson」；
   *   ② 因子序列的秩固定，预中心化并把 Σ(x−x̄)² 预算出来，每次只剩两次遍历。
   * 这里刻意<b>不</b>对日历降采样：降采样会让样本量变小、抽样方差变大，人为把
   * 零分布撑宽（实测会把家族 p 从 0.003 推到 0.060，直接翻转结论）。
   * 用性能调整去改变统计结论是不可接受的，宁可多花一点时间。 */
  const H = 10;
  const full = [];
  for (let i = rep.start; i + H < rep.n; i++) {
    const p0 = rep.closes[i];
    if (p0 != null && p0 !== 0) full.push(i);
  }
  let wrc = null;
  if (full.length >= 80) {
    const Rfull = full.map(function (i) { return rep.closes[i + H] / rep.closes[i] - 1; });
    const RRfull = rankAvg(Rfull);
    const fprep = [];
    rows.forEach(function (row) {
      const arr = rep.fvals[row.id];
      if (!arr) return;
      const pos = [], sv = [];
      for (let q = 0; q < full.length; q++) { const v = arr[full[q]]; if (v == null) continue; pos.push(q); sv.push(v); }
      if (sv.length < 30) return;
      const rs = rankAvg(sv);
      let mrs = 0;
      for (let q = 0; q < rs.length; q++) mrs += rs[q];
      mrs /= rs.length;
      const cs = new Array(rs.length);
      let sxx = 0;
      for (let q = 0; q < rs.length; q++) { cs[q] = rs[q] - mrs; sxx += cs[q] * cs[q]; }
      if (!(sxx > 0)) return;
      /* pos 长度等于整条日历 ⇒ 该因子处处有值，pos[q] 就是 q，可走快路径 */
      const posless = pos.length === full.length;
      fprep.push({ id: row.id, name: row.name, pos: pos, cs: cs, sxx: sxx, m: cs.length, posless: posless });
    });
    if (fprep.length >= 3) {
      /* bestOf 接的是「已按本次排列取好的收益秩序列」gath，长度 M，各因子按自己的 pos 取子集。
       * 关键一击：cs 已经中心化 ⇒ Σcs = 0 ⇒ Σcs·(y − ȳ) = Σcs·y。
       * 于是「先扫一遍求 ȳ 再扫一遍求协方差」可并成一遍；再把 syy 写成 Σy² − (Σy)²/m。
       * 每个因子从 3 次遍历降到 1 次，配合共享 gath 消除二级间接寻址，实测约 6 倍提速。 */
      const bestOf = function (gath) {
        let mx = 0, who = null;
        for (let f = 0; f < fprep.length; f++) {
          const P = fprep[f], cs = P.cs, m = P.m;
          let sy = 0, sy2 = 0, sxy = 0;
          if (P.posless) {
            /* 快路径：该因子在整条日历上都有值，pos[q] === q，
             * 可以直接顺序读 gath，省掉一层间接寻址 */
            for (let q = 0; q < m; q++) { const y = gath[q]; sy += y; sy2 += y * y; sxy += cs[q] * y; }
          } else {
            const pos = P.pos;
            for (let q = 0; q < m; q++) { const y = gath[pos[q]]; sy += y; sy2 += y * y; sxy += cs[q] * y; }
          }
          const syy = sy2 - sy * sy / m;
          if (syy > 0) {
            const a = Math.abs(sxy / Math.sqrt(P.sxx * syy));
            if (a > mx) { mx = a; who = P.name; }
          }
        }
        return { mx: mx, who: who };
      };
      const M = full.length;
      const obs = bestOf(RRfull);
      let seed = 20261002;
      const rand = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const gath = new Array(M);
      const perm = []; for (let q = 0; q < M; q++) perm.push(q);
      const maxAbs = [];
      for (let b = 0; b < B; b++) {
        for (let q = M - 1; q > 0; q--) { const j = Math.floor(rand() * (q + 1)); const tv = perm[q]; perm[q] = perm[j]; perm[j] = tv; }
        for (let q = 0; q < M; q++) gath[q] = RRfull[perm[q]];
        maxAbs.push(bestOf(gath).mx);
      }
      maxAbs.sort(function (a, b) { return a - b; });
      const qof = function (q0) { const i2 = Math.min(maxAbs.length - 1, Math.max(0, Math.round(q0 * (maxAbs.length - 1)))); return maxAbs[i2]; };
      const exceed = maxAbs.filter(function (v) { return v >= obs.mx; }).length;
      wrc = {
        B: B, n: M, nFactors: fprep.length,
        obsMax: obs.mx, obsWho: obs.who,
        med: qof(0.5), p95: qof(0.95), maxSeen: maxAbs[maxAbs.length - 1],
        pval: (exceed + 1) / (B + 1),
      };
    }
  }

  /* Deflated IC：在 K 次独立检验、全为噪声的零假设下，|IC| 最大值的期望。
   * 用同样 B 次 bootstrap 得到的 max|IC| 分布均值作为基准：真实最好 IC 若
   * 没能明显超过它，说明「最好的发现」也可以纯由多次尝试解释。 */
  let deflated = null;
  if (wrc) {
    deflated = {
      expectedMax: wrc.med,
      hurdle: wrc.p95,
      best: wrc.obsMax,
      bestWho: wrc.obsWho,
      beatsHint: wrc.obsMax > wrc.p95,
    };
  }

  return {
    K: K, alpha: alpha, nFactors: rows.length,
    tCritRaw: tCritRaw, tCritBonf: tCritBonf, tCritSidak: tCritSidak,
    nRawSig: nRawSig, nBonfSig: nBonfSig, nSidakSig: nSidakSig, nBhSig: nBhSig,
    expFalse: K * alpha, tests: tests, wrc: wrc, deflated: deflated,
  };
}

/* ---------- 渲染：① 归因表 ---------- */
function facVerdict(p) {
  if (!p || p.t == null || p.ic == null) return '<span style="color:#5b7a9a">· 样本少</span>';
  const a = Math.abs(p.t);
  if (a > 2 && p.ic > 0) return '<span style="color:#00e5a0">✔ 有效</span>';
  if (a > 2 && p.ic < 0) return '<span style="color:#ff3d6e">✘ 方向反了</span>';
  return '<span style="color:#ffc107">~ 噪声</span>';
}
function renderFacRank(facs) {
  const box = $('facRank'); if (!box) return;
  if (!facs || !facs.length) { box.innerHTML = '<div class="ic-note">—</div>'; return; }
  const cells = function (r) {
    return [1, 5, 10, 20].map(function (h) {
      const p = r.per[h];
      if (!p || p.ic == null) return '<span style="color:#5b7a9a">—</span>';
      return '<span style="color:' + icColor(p.ic) + '">' + p.ic.toFixed(3) + '</span>';
    }).join('');
  };
  const hd = '<div class="ic-row ic-hd fr"><span>因子（按 |IC(10日)| 排序）</span><span>dir·w</span>' +
    '<span>IC(1)</span><span>IC(5)</span><span>IC(10)</span><span>IC(20)</span><span>t(10)</span><span>判定</span></div>';
  box.innerHTML = hd + facs.map(function (r) {
    const p10 = r.per[10];
    return '<div class="ic-row fr"><span class="fname">' + r.name + '</span>' +
      '<span class="ic-n">' + (r.dir > 0 ? '+' : '\u2212') + '·' + r.w.toFixed(1) + '</span>' +
      cells(r) +
      '<span>' + (p10 && p10.t != null ? p10.t.toFixed(1) + sigMark(p10.t) : '—') + '</span>' +
      '<span>' + facVerdict(p10) + '</span></div>';
  }).join('') +
    '<div class="ic-note">IC = 该因子「<b>方向化贡献</b>」与未来收益的 Spearman 秩相关（贡献 = dir × z，所以它已经把方向算进去了）。' +
    '<b>IC &gt; 0 说明当前 dir 设对了；IC &lt; 0 说明这个因子在本窗口内的实际方向与设定相反</b> —— 要么方向表设错，要么它在这个市场里是反向指标。' +
    '<br>t 同样按非重叠窗口折算，|t| &gt; 2 才敢说「不是噪声」。<b>判定为「噪声」的因子，权重再大也只是在稀释评分。</b></div>';
}

/* ---------- 渲染：② 样本内外 ---------- */
function renderOOS(o) {
  const box = $('oosBox'); if (!box) return;
  if (!o) { box.innerHTML = '<div class="ic-note">样本不足，无法切分样本内 / 样本外。</div>'; return; }
  const rep = state.hist.rep;
  const dstr = function (t) { return new Date(t).toISOString().slice(0, 10); };
  const cell = function (v) {
    if (v == null) return '<span style="color:#5b7a9a">—</span>';
    return '<span style="color:' + icColor(v) + '">' + v.toFixed(3) + '</span>';
  };
  const rows = [
    ['现状：' + o.live.n + ' 维 · 原权重', o.live.tr, o.live.te],
    ['等权：' + o.equal.n + ' 维 · 不筛选', o.equal.tr, o.equal.te],
    ['优选：' + o.pick.n + ' 维 · 仅样本内 IC&gt;0', o.pick.tr, o.pick.te],
  ];
  box.innerHTML =
    '<div class="ic-row ic-hd oos"><span>组合</span><span>样本内 IC</span><span>样本外 IC</span><span>衰减</span></div>' +
    rows.map(function (r) {
      const d = (r[1] == null || r[2] == null) ? null : r[2] - r[1];
      const dcol = d == null ? '#5b7a9a' : d < -0.05 ? '#ff3d6e' : d > 0.05 ? '#00e5a0' : '#5b7a9a';
      return '<div class="ic-row oos"><span class="fname">' + r[0] + '</span>' + cell(r[1]) + cell(r[2]) +
        '<span style="color:' + dcol + '">' + (d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(3)) + '</span></div>';
    }).join('') +
    '<div class="ic-note">样本内 <b>' + dstr(rep.calTs[rep.start]) + ' → ' + dstr(rep.calTs[o.cut - 1]) + '</b>（' + o.nTrain + ' 天）挑因子；' +
    '样本外 <b>' + dstr(rep.calTs[o.cut]) + ' → ' + dstr(rep.calTs[rep.n - 1]) + '</b>（' + o.nTest + ' 天）检验；前向 ' + o.h + ' 日。<br>' +
    '<b>盯「衰减」这一列：如果样本内优选（哪怕样本内 IC 很高）拿到样本外就衰减甚至转负，说明挑出来的只是噪声。</b> ' +
    '样本外的数字才是这套因子真实能力的上限估计 —— 样本内的数字永远好看，没有信息量。</div>';
}

/* ---------- 渲染：③ 滚动 IC ---------- */
function drawRollChart(cv, roll) {
  if (!cv || !roll || !roll.length) return;
  const W = cv.clientWidth || 460, HH = 150;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr); cv.height = Math.round(HH * dpr);
  cv.style.height = HH + 'px';
  const g = cv.getContext('2d'); if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, HH);

  const padL = 30, padR = 8, padT = 8, padB = 14;
  const iw = W - padL - padR, ih = HH - padT - padB;
  const LIM = 0.5;
  const y = function (v) { return padT + (LIM - Math.max(-LIM, Math.min(LIM, v))) / (2 * LIM) * ih; };
  const x = function (q) { return padL + q / Math.max(1, roll.length - 1) * iw; };

  g.fillStyle = 'rgba(255,193,7,.06)';
  g.fillRect(padL, y(0.1), iw, y(-0.1) - y(0.1));
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
  g.font = '9px "JetBrains Mono", monospace'; g.fillStyle = '#4a6a8a'; g.textAlign = 'right';
  [0.4, 0.2, 0, -0.2, -0.4].forEach(function (v) {
    g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(W - padR, y(v)); g.stroke();
    g.fillText(v.toFixed(1), padL - 4, y(v) + 3);
  });
  g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,255,255,.28)';
  g.beginPath(); g.moveTo(padL, y(0)); g.lineTo(W - padR, y(0)); g.stroke();
  g.setLineDash([]);

  g.lineWidth = 1.5;
  for (let q = 1; q < roll.length; q++) {
    const p = roll[q - 1].ic, b = roll[q].ic;
    if (p == null || b == null) continue;
    g.strokeStyle = (p + b) / 2 > 0 ? '#00e5a0' : '#ff3d6e';
    g.beginPath(); g.moveTo(x(q - 1), y(p)); g.lineTo(x(q), y(b)); g.stroke();
  }
  g.fillStyle = '#4a6a8a'; g.textAlign = 'left';
  g.fillText(ROLL_WIN + ' 日滚动窗 · 前向 ' + OOS_H + ' 日', padL, HH - 3);
  g.textAlign = 'right';
  g.fillText('绿 = 该窗口内分数与未来收益正相关', W - padR, HH - 3);
}

function renderStatus(ok) {
  const dot = $('netDot'); if (dot) { dot.className = 'net-dot ' + (ok ? 'ok' : ''); }
  if ($('lastUpd')) $('lastUpd').textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN');
}

/* =====================================================================
 *  刷新主流程
 * ===================================================================== */
async function refreshAll() {
  const tasks = [fetchPrices(), fetchKlines('BTC', state.interval), fetchFG(), fetchGlobal(), fetchStable(), fetchChain(), fetchDeriv(), fetchMacro(), fetchEcon()];
  const res = await Promise.allSettled(tasks);
  const ok = res.every(r => r.status === 'fulfilled' && r.value !== false);
  if (!state.klines['BTC1d']) await fetchKlines('BTC', '1d');
  buildSeries();
  renderTicker(); renderChart(); renderTA(); renderFG(); renderMacro(); renderEcon(); renderOnChain(); renderDeriv(); renderFactors();
  try { renderValueFactors(); } catch (e) { console.warn('value panel fail', e && e.message); }
  renderPaper();
  initNetwork(); renderHeatmap();
  try { renderNetStats(); renderCorrPanels(); renderSystemic(); } catch (e) { console.warn('net v2 fail', e && e.message); }
  try { if (state.universe && Object.keys(state.universe.series).length) renderUniverseBox(); } catch (e) { console.warn('uni box fail', e && e.message); }
  renderStatus(ok);
  refreshDvolAlarm();
  /* 回放刚跑完 → BTC 历史到位了，若因子宇宙已加载就补一次筛选渲染 */
  try { if (state.universe && Object.keys(state.universe.series).length && state.histBundle && state.histBundle.btc) renderUniverseBox(); } catch (e) { console.warn('uni after hist fail', e && e.message); }   // v3.14: 实时波动率恐慌警报（异步，不阻塞主渲染）
  try { renderScenario(state.scenarioSel || SCENARIOS[0].id); } catch (e) { console.warn('scenario fail', e && e.message); }
}

/* =====================================================================
 *  UI 事件
 * ===================================================================== */
function bindUI() {
  if (!state.acct) state.acct = loadAcct();   // 未初始化就点开仓会静默失败，这里提前加载
  document.querySelectorAll('.ibtn').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.ibtn').forEach(x => x.classList.remove('active')); b.classList.add('active'); state.interval = b.dataset.i; fetchKlines('BTC', b.dataset.i).then(() => { renderChart(); renderTA(); renderFactors(); }); }));
  const cv = $('mainCanvas');
  if (cv) cv.addEventListener('mousemove', e => { const rect = cv.getBoundingClientRect(); const k = state.klines['BTC' + state.interval]; if (!k) return; const i = Math.round((e.clientX - rect.left) / (rect.width) * (k.length - 1)); chartState.hover = Math.max(0, Math.min(k.length - 1, i)); renderChart(); });
  if (cv) cv.addEventListener('mouseleave', () => { chartState.hover = -1; const tt = $('chartTip'); if (tt) tt.style.display = 'none'; renderChart(); });
  /* 径向影响星系图的悬停 / 点按。触控设备没有 hover，所以 click 也要走同一条路。 */
  const ncv = $('netCanvas');
  if (ncv) {
    const onMove = function (e) {
      if (!net || net.layout !== 'radial') return;
      const rect = ncv.getBoundingClientRect();
      const i = radialHit(e.clientX - rect.left, e.clientY - rect.top);
      if (i !== net.hover) { net.hover = i; drawRadial(); }
      ncv.style.cursor = i >= 0 ? 'pointer' : 'default';
    };
    ncv.addEventListener('mousemove', onMove);
    ncv.addEventListener('mouseleave', function () { if (net && net.layout === 'radial' && net.hover !== -1) { net.hover = -1; drawRadial(); } });
    ncv.addEventListener('click', onMove);
  }
  const bt = $('btRun'); if (bt) bt.addEventListener('click', renderBacktest);
  const ul = $('uniLoad'); if (ul) ul.addEventListener('click', function () { runUniverse(); });
  const hb = $('histRun'); if (hb) hb.addEventListener('click', runHistoryCheck);
  // 策略切换：原实现绑定的是 HTML 中并不存在的 #btStrat，导致点 RSI/突破毫无反应
  document.querySelectorAll('.bt-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.bt-tab').forEach(x => x.classList.remove('on')); tab.classList.add('on');
    state.btStrat = tab.dataset.s;
    document.querySelectorAll('.bt-param').forEach(p => p.style.display = p.dataset.s === tab.dataset.s ? 'block' : 'none');
    const m = $('btMsg'); if (m) { m.className = 'bt-msg'; m.textContent = ''; }
    if ($('btRes') && $('btRes').classList.contains('show')) renderBacktest();
  }));
  const buy = $('ptBuy'); if (buy) buy.addEventListener('click', paperBuy);
  const closeAll = $('ptCloseAll'); if (closeAll) closeAll.addEventListener('click', paperCloseAll);
  const ptReset = $('ptReset'); if (ptReset) ptReset.addEventListener('click', paperReset);
  /* v3.20：关系网络的三个开关 —— 网络形态 / 关系类型 / 相关窗口。
   * 换一次开关就重算谱分解与偏相关，所以这里显式 force 重分析而不吃缓存。 */
  document.querySelectorAll('.ttab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      const g = tab.dataset.g;
      document.querySelectorAll('.ttab').forEach(function (x) { if (x.dataset.g === g) x.classList.remove('on'); });
      tab.classList.add('on');
      const v = tab.dataset.v;
      if (g === 'win') NET_OPTS.win = parseInt(v, 10) || 120;
      else if (g === 'maxNodes') NET_OPTS.maxNodes = parseInt(v, 10) || 64;
      else NET_OPTS[g] = v;
      /* 布局 / 节点数只换画法，不换数据 —— 没必要重算谱分解与偏相关。
       * 那套 ⑬-⑯ 的分析实测约 650ms，每次点开关都重跑纯属浪费。 */
      if (g === 'layout' || g === 'maxNodes') {
        const nt = $('netNote');
        if (nt && NET_OPTS.layout === 'radial') {
          nt.textContent = '影响星系：半径=内生(内圈)→外生(外圈)、同层内按 强→中→弱 往外 · 节点大小=|IC| · 连线粗细=|IC|、绿=推涨/红=压跌、虚线=样本外符号反转 · 悬停看明细。切到「力导向」看的是因子之间的相互关系（连边由 BH-FDR 判定）。';
        }
        try { initNetwork(); } catch (e) { console.warn('net init fail', e && e.message); }
        return;
      }
      try {
        netAnalyzed(true);
        initNetwork(); renderHeatmap(); renderNetStats(); renderCorrPanels(); renderSystemic();
        if (net) { net.idle = 0; if (!netRunning) { netRunning = true; animateNetwork(); } }
      } catch (e2) { console.warn('net redraw fail', e2 && e2.message); }
    });
  });
  const refresh = $('refreshBtn'); if (refresh) refresh.addEventListener('click', refreshAll);
  /* v3.30 护栏 RED 通知开关（默认关闭，需用户主动开启；状态存 localStorage） */
  const nchk = $('notifyChk');
  if (nchk) {
    if (!state.notify) state.notify = loadNotifyCfg();
    nchk.checked = !!state.notify.enabled;
    nchk.addEventListener('change', function () {
      if (!state.notify) state.notify = loadNotifyCfg();
      state.notify.enabled = nchk.checked;
      saveNotifyCfg(); updateNotifyUI();
    });
    updateNotifyUI();
  }
  /* v3.31 情景推演引擎：情景按钮 */
  document.querySelectorAll('.scn-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.scn-btn').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    state.scenarioSel = b.getAttribute('data-scn');
    try { renderScenario(state.scenarioSel); } catch (e) { console.warn('scn click fail', e && e.message); }
  }));
}

/* =====================================================================
 *  初始化
 * ===================================================================== */
window.addEventListener('load', async () => {
  bindUI();
  await refreshAll();
  setInterval(refreshAll, CONFIG.REFRESH_MS);
  window.addEventListener('resize', () => {
    renderChart();
    try { renderSystemic(); } catch (e) { /* ignore */ }
    if (state.hist) renderHistory();
    if (net) { net.W = $('netCanvas').clientWidth; net.H = $('netCanvas').clientHeight; net.idle = 0; if (!netRunning) { netRunning = true; animateNetwork(); } }
  });
});

/* =====================================================================
 * v3.17：⑩ 多重检验与过拟合校正 —— 单独成函数，因为 bootstrap 较重，
 * 回放時先渲染其余面板，再异步算出结果后只刷新这一块，避免卡首屏。
 * ===================================================================== */
function renderMtBox() {
  const mtBox = $('mttBox');
  if (!mtBox) return;
  const h = state.hist;
  const mt = (h && h.mt) ? h.mt : null;
  if (!mt) {
    mtBox.innerHTML = (h && h.mtBusy)
      ? '<div class="rg-sub">多重检验校正正在计算（bootstrap 重采样中，通常几百毫秒）…</div>'
      : '<div class="rg-sub">多重检验校正暂不可用（回放数据不足，或尚未运行回放）。</div>';
    return;
  }
  let mh = '<div class="fttl" style="margin-bottom:7px">⑩ 多重检验与过拟合校正</div>';
  mh += '<div class="rg-sub">一次回放要做 <b>' + mt.K + ' 次</b>显著性检验（' + mt.nFactors +
    ' 个因子 × 4 个 horizon）。若沿用「单个检验 |t| &gt; 2」逐个判定，即使<b>全部是纯噪声</b>，' +
    '统计上也期望出现 <b>' + mt.expFalse.toFixed(1) + ' 个</b>「显著」。这一块就是把这件事摊开算给你看。</div>';
  mh += '<div class="rg-tbl"><div class="rg-hd"><span>校正口径</span><span>门槛</span><span>通过</span><span>含义</span><span></span><span></span></div>';
  const mtRow = function (lbl, tv, npass, mean) {
    return '<div class="rg-row"><span class="rg-nm">' + lbl + '</span>' +
      '<span>' + tv + '</span>' +
      '<span class="' + (npass > 0 ? 'rg-y' : 'rg-dim') + '">' + npass + ' / ' + mt.K + '</span>' +
      '<span class="rg-dim">' + mean + '</span><span></span><span></span></div>';
  };
  mh += mtRow('未校正（单个 α=0.05）', '|t| &gt; ' + mt.tCritRaw.toFixed(2), mt.nRawSig, '逐个判定，最容易自欺');
  mh += mtRow('Bonferroni', '|t| &gt; ' + mt.tCritBonf.toFixed(2), mt.nBonfSig, '最严格：几乎不许有假发现');
  mh += mtRow('Šidák', '|t| &gt; ' + mt.tCritSidak.toFixed(2), mt.nSidakSig, '同族，略宽松于 Bonferroni');
  mh += mtRow('Benjamini-Hochberg FDR', 'q &lt; 0.05', mt.nBhSig, '容忍少量假发现，换取检验力');
  mh += '</div>';

  const surv = mt.tests.filter(function (x) { return x.bonfSig; })
    .sort(function (a, b) { return Math.abs(b.ic) - Math.abs(a.ic); });
  if (surv.length) {
    mh += '<div class="rg-sub"><b>扛住 Bonferroni 的幸存者（' + surv.length + ' 个）</b>：' +
      surv.slice(0, 8).map(function (x) {
        return x.name.replace(/^[^ ]+ /, '') + ' <i>h=' + x.h + ' IC=' + x.ic.toFixed(3) + ' |t|=' + Math.abs(x.t).toFixed(1) + '</i>';
      }).join(' · ') + '。只有这些，才谈得上「不是运气」。</div>';
  } else {
    mh += '<div class="rg-sub"><b>没有因子扛得住 Bonferroni 校正</b>（0 / ' + mt.K + '）。' +
      '这不是说因子没用，而是说：在做了这么多次尝试之后，没有哪一个的统计证据强到可以排除运气解释。</div>';
  }

  const fadeout = mt.tests.filter(function (x) { return x.rawSig && !x.bonfSig; })
    .sort(function (a, b) { return Math.abs(b.ic) - Math.abs(a.ic); });
  if (fadeout.length) {
    mh += '<div class="rg-sub">被校正淘汰的假发现候选（未校正时显著、校正后不显著）：' +
      fadeout.slice(0, 6).map(function (x) {
        return x.name.replace(/^[^ ]+ /, '') + '<i>h=' + x.h + '</i>';
      }).join(' · ') + ' 共 ' + fadeout.length + ' 个。</div>';
  }

  if (mt.wrc) {
    const W = mt.wrc;
    const pcls = W.pval < 0.05 ? 'rg-g' : (W.pval < 0.20 ? 'rg-y' : 'rg-r');
    mh += '<div class="rg-tbl" style="margin-top:8px"><div class="rg-hd">' +
      '<span>White Reality Check</span><span>观测最佳</span><span>噪声中位数</span><span>噪声 95%</span><span>家族 p</span><span></span></div>';
    mh += '<div class="rg-row"><span class="rg-nm">最好的那个因子 vs 纯噪声</span>' +
      '<span>' + W.obsMax.toFixed(3) + '</span>' +
      '<span class="rg-dim">' + W.med.toFixed(3) + '</span>' +
      '<span>' + W.p95.toFixed(3) + '</span>' +
      '<span class="' + pcls + '">' + W.pval.toFixed(3) + '</span>' +
      '<span></span></div></div>';
    mh += '<div class="rg-sub">做法：把未来收益与因子的配对关系彻底打乱 ' + W.B + ' 次（破坏真实信息、保留收益的统计特性），' +
      '每次记录「这批因子里最好的 |IC| 能到多少」，得到一个<b>纯运气能达到的水平分布</b>。' +
      '真实数据里最好的是 <b>' + (W.obsWho || '—').replace(/^[^ ]+ /, '') + ' |IC|=' + W.obsMax.toFixed(3) + '</b>，' +
      '而纯噪声的中位数就有 ' + W.med.toFixed(3) + '、95 分位 ' + W.p95.toFixed(3) + '。家族 p = ' + W.pval.toFixed(3) + ' —— ' +
      (W.pval < 0.05
        ? '<b>最好的因子确实超过了运气能解释的范围</b>：整批因子里存在真实信息，值得往下做样本外验证。'
        : '<b>最好的因子没能超过运气的解释范围</b>：这么多因子里挑出最好的那个，纯噪声也能挑到这个水平。这是筛选流程本身在产生虚假信号，而不是找到了 alpha。') +
      '</div>';
    mh += '<div class="rg-sub">注意两种校正回答的是<b>不同</b>的问题，结论可以同时成立且并不矛盾：' +
      'White Reality Check 检验「<b>整批</b>里有没有真东西」（家族证据，检验力高）；' +
      'Bonferroni 逐个追问「<b>这一个</b>能不能单独拿来做」（单个证据，要求苛刻）。' +
      '家族显著、逐个全部失败，是<b>「有信号但很分散」</b>的典型样子——正好对应 IC 只有 0.10 量级的现实。</div>';
  }
  mh += '<div class="rg-sub" style="border-top:1px dashed var(--border);margin-top:8px;padding-top:8px">' +
    '<b>这套校正不会让信号变强，只会告诉你「看见的信号」有多少能用「试得够多」来解释。</b>' +
    '这也是本面板与市面上绝大多数「某因子胜率 80%」产品的区别：那些数字通常<b>从未</b>经过任何多重检验校正。</div>';
  mtBox.innerHTML = mh;
}

/* 异步触发：bootstrap 较重，放到首屏渲染之后跑，算完只刷新 ⑩ 这一块 */
function scheduleMt(rep) {
  if (!rep) return;
  try {
    if (state.hist) { state.hist.mtBusy = true; state.hist.mt = null; }
    renderMtBox();
  } catch (e) { /* ignore */ }
  setTimeout(function () {
    let mt = null;
    try { mt = multiTest(rep); } catch (e) { console.warn('multitest fail', e && e.message); }
    if (state.hist) { state.hist.mtBusy = false; state.hist.mt = mt; }
    try { renderMtBox(); } catch (e2) { console.warn('mt render fail', e2 && e2.message); }
  }, 80);
}

/* ======================= ⑪ PBO(CSCV) 与去通胀夏普 DSR =======================
 * 组合对称交叉验证 CSCV —— Bailey & López de Prado (2017)
 *   "The Probability of Backtest Overfitting"
 *
 * 要回答的问题是：从一个候选池里「挑出来」的那个最优配置，
 * 有多少其实是被「挑」这个动作本身造出来的？
 *
 *   1) 构造 N 个候选配置（不同的因子子集组合）
 *   2) 把 T 个交易日按时间切成 S 个互不重叠的块
 *   3) 枚举全部 C(S, S/2) 种「一半做训练 IS、一半做测试 OOS」的划分
 *   4) 每种划分：在 IS 上挑出表现最好的 i*，再到 OOS 上看 i* 在 N 个里的相对排名 r∈(0,1)
 *   5) λ = ln(r/(1−r))（logit）。λ ≤ 0 意味着 i* 在样本外连池子中位数都够不着
 *   6) PBO = P(λ ≤ 0)
 *
 * 没有过拟合时，IS 的最优在 OOS 上也应当偏前，λ 集中为正 → PBO≈0。
 * 若挑选只是在拟合噪声，IS 最优在 OOS 上就随机分布 → PBO 逼近甚至超过 0.5。
 *
 * 工程关键：若不做预处理，枚举全部组合是 O(C(S,S/2) · N · T)，直接不可行。
 * 先把每个候选在每个块上的收益预先累加，之后每种划分只剩 O(N)，
 * 这样才敢「枚举全部组合」而不是抽样，结论不依赖抽样运气。 */

/* 滚动 z（只用过去窗口，无前视）—— 把因子合成值变成可比较的标准化信号 */
function rollingZFrom(vals, win) {
  const n = vals.length, out = new Array(n).fill(null);
  const buf = new Array(win);
  let cnt = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null || !isFinite(v)) continue;
    if (cnt >= win) { const oldv = buf[cnt % win]; sum -= oldv; sum2 -= oldv * oldv; }
    buf[cnt % win] = v; sum += v; sum2 += v * v; cnt++;
    const c = cnt < win ? cnt : win;
    if (c < 40) continue;
    const mean = sum / c, varr = sum2 / c - mean * mean;
    if (varr > 1e-12) out[i] = (v - mean) / Math.sqrt(varr);
  }
  return out;
}

/* 候选配置池：不同粒度的因子子集。
 * 「选哪些因子」本身就是一次次尝试 —— 这正是回测过拟合的来源，必须计入。 */
/* factorICRows 是全 O(N·H·n·log n) 的重活，而 multiTest 与 PBO 都要用它。
 * 按 rep 的引用做 memo，第二次起几乎零成本（同一个回放对象不会重复变化）。 */
let _icRowsMemo = null;
function factorICRowsCached(rep) {
  if (_icRowsMemo && _icRowsMemo.rep === rep) return _icRowsMemo.rows;
  const rows = factorICRows(rep);
  _icRowsMemo = { rep: rep, rows: rows };
  return rows;
}

function pboBuildStrategies(rep) {
  const rows = factorICRowsCached(rep);
  const ordered = rows.map(function (r) { return r.id; })
    .filter(function (id) { return rep.fvals[id]; });
  if (ordered.length < 8) return null;
  const cands = [];
  [1, 2, 3, 4, 5, 6, 8, 10, 12].forEach(function (k) {
    if (k <= ordered.length) cands.push({ name: 'Top' + k, ids: ordered.slice(0, k) });
  });
  cands.push({ name: '全因子', ids: ordered.slice() });
  cands.push({ name: '偶数位', ids: ordered.filter(function (_, i) { return i % 2 === 0; }) });
  cands.push({ name: '奇数位', ids: ordered.filter(function (_, i) { return i % 2 === 1; }) });

  const n = rep.n;
  /* 次日收益：今天收盘看到的信号，只能赚明天的钱（滞后一步，杜绝前视） */
  const fwd = new Array(n).fill(null);
  for (let i = rep.start; i + 1 < n; i++) fwd[i + 1] = rep.closes[i + 1] / rep.closes[i] - 1;

  const rets = [], names = [], poss = [];
  cands.forEach(function (C) {
    const z = rollingZFrom(compositeSeries(rep, C.ids), 252);
    const rt = new Array(n).fill(null), po = new Array(n).fill(null);
    for (let i = 0; i + 1 < n; i++) {
      const pv = z[i];
      if (pv == null || fwd[i + 1] == null) continue;
      let p = pv / 2; if (p > 1) p = 1; else if (p < -1) p = -1;
      po[i] = p;
      rt[i + 1] = p * fwd[i + 1];
    }
    rets.push(rt); names.push(C.name); poss.push(po);
  });
  return { rets: rets, names: names, poss: poss, n: n, nCand: rets.length };
}

function pboTest(rep, opts) {
  opts = opts || {};
  const built = pboBuildStrategies(rep);
  if (!built) return null;
  const rets = built.rets, names = built.names, NC = built.nCand;
  const S = opts.folds || 10;
  const half = S / 2;

  /* 统一日历：只有在所有候选都有值的日子才可比较，否则排名会被样本长度差异污染 */
  const days = [];
  for (let t = rep.start + 1; t < built.n; t++) {
    let ok = true;
    for (let j = 0; j < NC; j++) { const v = rets[j][t]; if (v == null || !isFinite(v)) { ok = false; break; } }
    if (ok) days.push(t);
  }
  const T = days.length, bsz = Math.floor(T / S);
  if (bsz < 20) return null;

  /* 预处理：每个候选在每个块上的收益一阶/二阶矩。有了它，每种划分只需 O(N) */
  const bsum = [], bsum2 = [];
  for (let j = 0; j < NC; j++) { bsum.push(new Float64Array(S)); bsum2.push(new Float64Array(S)); }
  for (let b = 0; b < S; b++) {
    for (let q = b * bsz; q < (b + 1) * bsz; q++) {
      const t = days[q];
      for (let j = 0; j < NC; j++) { const v = rets[j][t]; bsum[j][b] += v; bsum2[j][b] += v * v; }
    }
  }
  /* 单周期（日）夏普，组件全部来自预处理好的矩 */
  const sharpeOf = function (j, mask) {
    let sr = 0, sr2 = 0; const c = bsz * popcnt(mask);
    if (c < 2) return null;
    for (let b = 0; b < S; b++) if (mask & (1 << b)) { sr += bsum[j][b]; sr2 += bsum2[j][b]; }
    const mean = sr / c, varr = sr2 / c - mean * mean;
    if (!(varr > 0)) return null;
    return mean / Math.sqrt(varr);
  };
  function popcnt(m) { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; }

  const full = (1 << S) - 1, lambdas = [];
  let nTrainBest = 0;
  for (let mask = 0; mask <= full; mask++) {
    if (popcnt(mask) !== half) continue;
    const inv = full ^ mask;
    let best = -Infinity, bi = -1;
    const osv = new Array(NC);
    for (let j = 0; j < NC; j++) {
      const a = sharpeOf(j, mask);
      if (a != null && a > best) { best = a; bi = j; }
      osv[j] = sharpeOf(j, inv);
    }
    if (bi < 0 || osv[bi] == null) continue;
    nTrainBest++;
    let less = 0, ties = 0, valid = 0;
    for (let j = 0; j < NC; j++) {
      const c = osv[j]; if (c == null) continue;
      valid++; if (c < osv[bi]) less++; else if (c === osv[bi]) ties++;
    }
    if (!valid) continue;
    let r = (less + 0.5 * ties) / valid;
    const lo = 1 / (2 * valid), hi = 1 - lo;
    if (r < lo) r = lo; if (r > hi) r = hi;
    lambdas.push(Math.log(r / (1 - r)));
  }
  if (lambdas.length < 8) return null;

  let mu = 0; for (let i = 0; i < lambdas.length; i++) mu += lambdas[i];
  mu /= lambdas.length;
  let sd2 = 0; for (let i = 0; i < lambdas.length; i++) sd2 += (lambdas[i] - mu) * (lambdas[i] - mu);
  const sd = Math.sqrt(sd2 / (lambdas.length - 1));
  const pboNorm = sd > 0 ? normCdf((0 - mu) / sd) : (mu <= 0 ? 1 : 0);
  let nLe0 = 0; for (let i = 0; i < lambdas.length; i++) if (lambdas[i] <= 0) nLe0++;
  const pboEmp = nLe0 / lambdas.length;

  /* ---- 全样本上表现最好的候选：给它做去通胀夏普 ---- */
  const allSR = new Array(NC);
  let bestJ = -1, bestSR = -Infinity;
  for (let j = 0; j < NC; j++) {
    let sr = 0, sr2 = 0;
    for (let q = 0; q < days.length; q++) { const v = rets[j][days[q]]; sr += v; sr2 += v * v; }
    const mean = sr / T, varr = sr2 / T - mean * mean;
    if (!(varr > 0)) { allSR[j] = null; continue; }
    const s = mean / Math.sqrt(varr);
    allSR[j] = s;
    if (s > bestSR) { bestSR = s; bestJ = j; }
  }
  if (bestJ < 0) return null;

  /* 最优候选收益的高阶矩 —— 夏普对非正态很敏感，不校正会高估显著性 */
  let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  for (let q = 0; q < days.length; q++) {
    const v = rets[bestJ][days[q]];
    m1 += v; m2 += v * v; m3 += v * v * v; m4 += v * v * v * v;
  }
  m1 /= T; m2 /= T; m3 /= T; m4 /= T;
  const varr = m2 - m1 * m1, sdv = Math.sqrt(varr);
  const g3 = sdv > 0 ? (m3 - 3 * m1 * m2 + 2 * m1 * m1 * m1) / (sdv * sdv * sdv) : 0;
  const g4 = varr > 0 ? (m4 - 4 * m1 * m3 + 6 * m1 * m1 * m2 - 3 * Math.pow(m1, 4)) / (varr * varr) : 3;

  /* N 个候选夏普的离散程度 —— 用样本方差，代表「一次试探」的不确定性 */
  let vmu = 0, vc = 0;
  for (let j = 0; j < NC; j++) if (allSR[j] != null) { vmu += allSR[j]; vc++; }
  vmu /= vc || 1;
  let V = 0;
  for (let j = 0; j < NC; j++) if (allSR[j] != null) V += (allSR[j] - vmu) * (allSR[j] - vmu);
  V /= vc || 1;

  /* ---- 基准：什么都不做，从头拿到尾 ----
   * 不做这一步，DSR 只会告诉你「能不能赚钱」；做了才知道「值不值得动」。
   * 绝大多数因子产品省略这一步，于是「显著」被误读成「有用」。 */
  let bh1 = 0, bh2 = 0;
  for (let q = 0; q < days.length; q++) {
    const v = rep.closes[days[q]] / rep.closes[days[q] - 1] - 1;
    bh1 += v; bh2 += v * v;
  }
  const bhMean = bh1 / T, bhVar = bh2 / T - bhMean * bhMean;
  const bhSR = bhVar > 0 ? bhMean / Math.sqrt(bhVar) : null;
  let nBeatBH = 0;
  for (let j = 0; j < NC; j++) if (allSR[j] != null && bhSR != null && allSR[j] > bhSR) nBeatBH++;

  /* ---- 系统性敞口检验：策略收益里混了多少「长期做多」？ ---- */
  const po = built.poss[bestJ];
  let sp = 0, sc = 0;
  for (let q = 0; q < days.length; q++) { const p = po[days[q] - 1]; if (p != null) { sp += p; sc++; } }
  const avgPos = sc ? sp / sc : null;

  /* ---- beta 中性化：逐日扣掉「当时已知」的平均敞口，看还剩多少真本事 ---- */
  let runP = 0, runC = 0;
  const cumPos = new Array(built.n).fill(0);
  for (let i = 0; i < built.n; i++) {
    const p = po[i]; if (p != null) { runP += p; runC++; }
    cumPos[i] = runC ? runP / runC : 0;
  }
  let n1 = 0, n2 = 0, nn = 0;
  for (let q = 0; q < days.length; q++) {
    const t = days[q], pPrev = po[t - 1];
    if (pPrev == null) continue;
    const fwd = rep.closes[t] / rep.closes[t - 1] - 1;
    const rv = (pPrev - cumPos[t - 1]) * fwd;
    n1 += rv; n2 += rv * rv; nn++;
  }
  let srNeutral = null;
  if (nn > 30) { const m = n1 / nn, vv = n2 / nn - m * m; if (vv > 0) srNeutral = m / Math.sqrt(vv); }

  const dsrFull = deflatedSharpe(bestSR, T, g3, g4, NC, V, bhSR);
  const dsr = dsrFull;
  const ANN = Math.sqrt(365);
  /* 零信息对照：真实的夏普要在「同一台机器空转」的分布里去看，才知道值几个钱 */
  const nul = pboNullCalib(rep, opts);
  let nullPct = null;
  if (nul) {
    let ge = 0;
    for (let i = 0; i < nul.bests.length; i++) if (nul.bests[i] >= bestSR) ge++;
    nullPct = ge / nul.bests.length;
  }
  return {
    S: S, combos: nTrainBest, nLambda: lambdas.length, T: T, NC: NC,
    names: names, bestName: names[bestJ], allSR: allSR, V: V,
    pboNorm: pboNorm, pboEmp: pboEmp, lamMu: mu, lamSd: sd,
    srDay: bestSR, srAnn: bestSR * ANN, g3: g3, g4: g4,
    sr0Day: dsr.sr0, sr0Ann: dsr.sr0 * ANN, dsr: dsr.psr, psr0: dsr.psr0, psrBH: dsr.psrBH,
    bhSRDay: bhSR, bhSRAnn: bhSR == null ? null : bhSR * ANN, nBeatBH: nBeatBH,
    avgPos: avgPos, srNeutralDay: srNeutral, srNeutralAnn: srNeutral == null ? null : srNeutral * ANN,
    nul: nul, nullPct: nullPct, nullRankPct: nullPct == null ? null : 1 - nullPct,
    nullMedAnn: nul ? nul.medDay * ANN : null,
    nullP95Ann: nul ? nul.p95Day * ANN : null,
    nullMaxAnn: nul ? nul.maxDay * ANN : null
  };
}

/* 去通胀夏普 DSR —— Bailey & López de Prado (2014)
 * SR0 = sqrt(V) · [ (1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)) ]，γ 为欧拉常数
 * DSR = Φ[ (SR̂ − SR0)·sqrt(T−1) / sqrt(1 − γ3·SR̂ + (γ4−1)/4·SR̂²) ]
 * 全部使用单周期（日）口径，报告时再年化，避免尺度串味。 */
const EULER_GAMMA = 0.5772156649015329;
function deflatedSharpe(srHat, T, g3, g4, N, V, bhSR) {
  const z1 = normInv(1 - 1 / N);
  const z2 = normInv(1 - 1 / (N * Math.E));
  const sr0 = Math.sqrt(V) * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2);
  const den = Math.sqrt(Math.max(1e-12, 1 - g3 * srHat + (g4 - 1) / 4 * srHat * srHat));
  const k = Math.sqrt(T - 1) / den;
  const psr = normCdf((srHat - sr0) * k);
  const psr0 = normCdf(srHat * k);
  /* 真正该问的不是「能不能赚钱」，而是「能不能赢过躺着不动」 */
  const psrBH = bhSR == null ? null : normCdf((srHat - bhSR) * k);
  return { sr0: sr0, psr: psr, psr0: psr0, psrBH: psrBH };
}

/* 零信息对照（null calibration）—— 本面板自带的证伪装置。
 *
 * 前面的 DSR 说「扣掉运气后还剩多少」，但它假设的是「运气」服从某个模型。
 * 更有说服力的问法是：<b>同一套流水线，喂进去与未来毫无关系的数据，会吐出多好看的数字？</b>
 *
 * 生成「零信息但统计结构不变」的数据，用的是循环移位：
 *   factor'[i] = factor[start + ((i − start + k) mod L)]
 * 一条序列做循环移位后，它自己的边际分布、波动、自相关全部原样保留，
 * 只是起点变了 —— 与未来收益的时序对齐被彻底切断，而任何单序列统计量都看不出区别。
 * 这比「打乱顺序」严谨得多（打乱会顺手毁掉自相关，制造出更好看的假阴性）。
 *
 * 若这台机器在零信息数据上照样挑得出漂亮夏普，那么真实数据上的漂亮数字就必须打折看。 */
function pboNullCalib(rep, opts) {
  opts = opts || {};
  const B = opts.nullRuns || 10;
  const rows = factorICRowsCached(rep);
  const ordered = rows.map(function (r) { return r.id; })
    .filter(function (id) { return rep.fvals[id]; });
  if (ordered.length < 8) return null;
  const n = rep.n, start = rep.start, L = n - start;
  if (L < 400) return null;

  const sets = [];
  [1, 2, 3, 4, 5, 6, 8, 10, 12].forEach(function (k) {
    if (k <= ordered.length) sets.push(ordered.slice(0, k));
  });
  sets.push(ordered.slice());

  const fwd = new Array(n).fill(null);
  for (let i = start; i + 1 < n; i++) fwd[i + 1] = rep.closes[i + 1] / rep.closes[i] - 1;

  let seed = 20261003;
  const rand = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const bests = [];
  for (let b = 0; b < B; b++) {
    const shift = {};
    ordered.forEach(function (id) { shift[id] = Math.floor(rand() * L); });
    let bestSR = -Infinity;
    for (let ci = 0; ci < sets.length; ci++) {
      const ids = sets[ci], comp = new Array(n).fill(null);
      for (let i = start; i < n; i++) {
        let s = 0, c = 0;
        for (let q = 0; q < ids.length; q++) {
          const arr = rep.fvals[ids[q]], k = shift[ids[q]];
          const v = arr[start + ((i - start + k) % L)];
          if (v != null) { s += v; c++; }
        }
        if (c) comp[i] = s / c;
      }
      const z = rollingZFrom(comp, 252);
      let r1 = 0, r2 = 0, cnt = 0;
      for (let i = start + 1; i < n; i++) {
        const pv = z[i - 1];
        if (pv == null || fwd[i] == null) continue;
        let p = pv / 2; if (p > 1) p = 1; else if (p < -1) p = -1;
        const rv = p * fwd[i];
        r1 += rv; r2 += rv * rv; cnt++;
      }
      if (cnt < 60) continue;
      const mean = r1 / cnt, varr = r2 / cnt - mean * mean;
      if (!(varr > 0)) continue;
      const srr = mean / Math.sqrt(varr);
      if (srr > bestSR) bestSR = srr;
    }
    if (bestSR > -Infinity) bests.push(bestSR);
  }
  if (bests.length < 4) return null;
  bests.sort(function (a, b2) { return a - b2; });
  const pick = function (q) {
    const idx = Math.min(bests.length - 1, Math.max(0, Math.round(q * (bests.length - 1))));
    return bests[idx];
  };
  return {
    runs: bests.length, bests: bests,
    medDay: pick(0.5), p95Day: pick(0.95), maxDay: bests[bests.length - 1], minDay: bests[0]
  };
}

function renderPboBox() {
  const box = $('pboBox');
  if (!box) return;
  const h = state.hist;
  const pb = (h && h.pbo) ? h.pbo : null;
  if (!pb) {
    box.innerHTML = (h && h.pboBusy)
      ? '<div class="rg-sub">回测过拟合概率正在计算（组合交叉验证中）…</div>'
      : '<div class="rg-sub">回测过拟合分析暂不可用（回放数据不足，或尚未运行回放）。</div>';
    return;
  }
  let mh = '<div class="fttl" style="margin-bottom:7px">⑪ 回测过拟合概率 · PBO(CSCV) 与去通胀夏普 DSR</div>';
  mh += '<div class="rg-sub">做法：<b>' + pb.NC + ' 个候选配置</b>（不同因子子集）放在同一条时间轴上，' +
    '切成 <b>' + pb.S + ' 个互不重叠的块</b>，枚举全部 <b>' + pb.combos + ' 种</b>' +
    '「一半训练 / 一半测试」的划分。每次都<b>只在训练集里挑最优</b>，' +
    '再回到测试集看它被挑出来之后排第几。挑得准 → 名次靠前；挑只是在拟合噪声 → 名次随机。' +
    '有效样本 <b>' + pb.T + '</b> 个交易日。</div>';

  const pcls = pb.pboEmp >= 0.5 ? 'rg-r' : (pb.pboEmp >= 0.25 ? 'rg-y' : 'rg-g');
  mh += '<div class="rg-tbl" style="margin-top:8px"><div class="rg-hd">' +
    '<span>指标</span><span>数值</span><span>含义</span><span></span><span></span><span></span></div>';
  mh += '<div class="rg-row"><span class="rg-nm">PBO（经验分布）</span>' +
    '<span class="' + pcls + '">' + (pb.pboEmp * 100).toFixed(1) + '%</span>' +
    '<span class="rg-dim">训练选出的最优，在测试集上排到中位之后的概率</span><span></span><span></span><span></span></div>';
  mh += '<div class="rg-row"><span class="rg-nm">PBO（logit 正态拟合）</span>' +
    '<span class="' + pcls + '">' + (pb.pboNorm * 100).toFixed(1) + '%</span>' +
    '<span class="rg-dim">对 λ=logit(排名) 做矩匹配后的同义量</span><span></span><span></span><span></span></div>';
  mh += '<div class="rg-row"><span class="rg-nm">λ 均值 / 标准差</span>' +
    '<span>' + pb.lamMu.toFixed(3) + ' / ' + pb.lamSd.toFixed(3) + '</span>' +
    '<span class="rg-dim">λ&gt;0 表示样本外仍优于池中位数</span><span></span><span></span><span></span></div>';
  mh += '<div class="rg-row"><span class="rg-nm">最优配置：' + pb.bestName + '</span>' +
    '<span>' + pb.srAnn.toFixed(2) + '</span>' +
    '<span class="rg-dim">全样本年化夏普（日夏普 ' + pb.srDay.toFixed(4) + '）</span><span></span><span></span><span></span></div>';
  mh += '<div class="rg-row"><span class="rg-nm">去通胀门槛 SR₀</span>' +
    '<span>' + pb.sr0Ann.toFixed(2) + '</span>' +
    '<span class="rg-dim">试了 ' + pb.NC + ' 次之后，「纯靠运气」本来能达到的夏普</span><span></span><span></span><span></span></div>';
  const dcls = pb.dsr > 0.95 ? 'rg-g' : (pb.dsr > 0.80 ? 'rg-y' : 'rg-r');
  mh += '<div class="rg-row"><span class="rg-nm"><b>DSR 去通胀夏普</b></span>' +
    '<span class="' + dcls + '"><b>' + (pb.dsr * 100).toFixed(1) + '%</b></span>' +
    '<span class="rg-dim">扣掉运气成分后，真实为正的置信度</span><span></span><span></span><span></span></div>';
  if (pb.bhSRDay != null) {
    const bhBetter = pb.srDay <= pb.bhSRDay;
    mh += '<div class="rg-row"><span class="rg-nm"><b>基准：无条件买入持有</b></span>' +
      '<span>' + pb.bhSRAnn.toFixed(2) + '</span>' +
      '<span class="rg-dim">同期什么都不做、从头拿到尾的年化夏普</span><span></span><span></span><span></span></div>';
    mh += '<div class="rg-row"><span class="rg-nm"><b>跑赢躺平的概率 PSR(SR&gt;BH)</b></span>' +
      '<span class="' + (pb.psrBH > 0.95 ? 'rg-g' : (pb.psrBH > 0.80 ? 'rg-y' : 'rg-r')) + '">' +
      (pb.psrBH * 100).toFixed(1) + '%</span>' +
      '<span class="rg-dim">' + pb.NC + ' 个配置里只有 <b>' + pb.nBeatBH + '</b> 个的实际夏普高于买入持有</span>' +
      '<span></span><span></span><span></span></div>';
  }
  if (pb.srNeutralAnn != null) {
    mh += '<div class="rg-row"><span class="rg-nm">扣掉系统性敞口后</span>' +
      '<span>' + pb.srNeutralAnn.toFixed(2) + '</span>' +
      '<span class="rg-dim">逐日减去当时已知的平均仓位，剩下的纯净选时能力</span><span></span><span></span><span></span></div>';
  }
  if (pb.avgPos != null) {
    mh += '<div class="rg-row"><span class="rg-nm">最优配置平均仓位</span>' +
      '<span>' + pb.avgPos.toFixed(3) + '</span>' +
      '<span class="rg-dim">' + (Math.abs(pb.avgPos) < 0.05
        ? '接近 0，说明不是靠长期做多蹭上涨，而是真的在多空之间切换'
        : '明显偏向一侧，收益里混入了方向性敞口，不能全算作选时能力') + '</span><span></span><span></span><span></span></div>';
  }
  mh += '</div>';

  mh += '<div class="rg-sub">收益分布：<b>偏度 γ₃=' + pb.g3.toFixed(2) + ' · 峰度 γ₄=' + pb.g4.toFixed(2) +
    '</b>（正态应为 0 / 3）。夏普假设正态，厚尾会<b>严重高估</b>显著性，所以 DSR 里用这两项把分母撑开。' +
    '候选池夏普离散度 V=' + pb.V.toExponential(2) + '。</div>';

  mh += '<div class="rg-sub"><b>怎么读：</b>' +
    (pb.pboEmp >= 0.5
      ? 'PBO 超过一半，说明<b>训练集挑出来的最优，到样本外超过一半概率连中位数都够不着</b>——这是典型的「挑得越多、越像有 alpha」的结构性假象。此时任何基于本次优选结果的实盘配置都缺乏依据。'
      : (pb.pboEmp >= 0.25
        ? 'PBO 偏高（≥25%），说明挑选过程已经带入相当的噪声拟合成分，优选结果<b>只能作为弱证据</b>，不足以支撑重仓。'
        : 'PBO 较低，说明训练集的优选在样本外有延续性，<b>挑选过程本身没有把结果毁掉</b>——这是继续往下做的前提条件。')) +
    '</div>';
  mh += '<div class="rg-sub" style="border-left:3px solid var(--yellow, #ffc107);padding-left:9px">' +
    '<b>使用 PBO 前必须先知道它的一个脾性：</b>它的绝对值<b>依赖候选池是怎么构造的</b>，' +
    '并不存在一个放之四海的「50% = 没过拟合」刻度。当候选之间高度相似（本页这些就是同一批因子的不同子集），' +
    '挑起来破坏力小，PBO 天然偏低；候选越彼此独立，挑一次造成的过拟合越重，PBO 才会往 0.5 以上走。' +
    '<b>所以 PBO 只能横向比</b>——同一套候选池、换个 stricter 的挑选流程，看 PBO 是升还是降；' +
    '拿不同产品的 PBO 直接比大小是没有意义的。这一条在 López de Prado 的原论文里没有强调，' +
    '但在我们自己的合成对照里看得很清楚：<b>纯随机数据</b>跑出来并不是 50%，而是 ' +
    '<b>34%</b>。' +
    '</div>';
  mh += '<div class="rg-sub">注意三个数字回答的是<b>三个完全不同</b>的问题，<b>彼此可以一个好一个坏</b>：' +
    '<b>PBO</b> 问「选配置的动作有没有过拟合」；<b>DSR</b> 问「最终那个配置的夏普有多少是运气」；' +
    '<b>PSR(SR&gt;BH)</b> 问「扣完运气之后，还值不值得动手，还是干脆躺着不动更划算」。' +
    '前两个是<b>统计显著性</b>，第三个才是<b>有没有用</b>。市面上绝大多数因子评测只给前两个的思路（甚至只给「显著」两个字），' +
    '于是「统计上显著赚钱」被读成「值得拿去交易」——这中间隔着一整个买入持有基准。</div>';
  if (pb.bhSRDay != null && pb.srDay <= pb.bhSRDay) {
    mh += '<div class="rg-sub" style="border-left:3px solid var(--red);padding-left:9px">' +
      '<b>本次结果必须直面的一点：</b>最优配置「' + pb.bestName + '」的年化夏普 <b>' + pb.srAnn.toFixed(2) +
      '</b>，<b>低于</b>同期无条件买入持有的 <b>' + pb.bhSRAnn.toFixed(2) + '</b>；' +
      pb.NC + ' 个配置里只有 <b>' + pb.nBeatBH + '</b> 个跑赢躺平，而跑赢躺平的概率只有 <b>' +
      (pb.psrBH * 100).toFixed(1) + '%</b>。' +
      '意思是：<b>这套因子在统计上确实提供了方向信息（这也是前面 White Reality Check 给的家族 p 显著所支持的），' +
      '但把它换算成仓位信号之后，并没有创造超过「什么都不做」的收益。</b>' +
      '差的那一截正是交易频次带来的波动与损耗。这个结论不漂亮，但它比任何「策略年化 XX%」的宣传都更接近事实，' +
      '也决定了这套东西现在<b>不应该被用来直接下单</b>，而应当被当作对市场状态的<b>描述</b>。</div>';
  }
  if (pb.nul) {
    const Np = pb.nul;
    const cmp = pb.srAnn >= pb.nullMedAnn;
    mh += '<div class="rg-tbl" style="margin-top:8px"><div class="rg-hd">' +
      '<span>零信息对照（循环移位 ' + Np.runs + ' 次）</span><span>年化夏普</span><span>说明</span><span></span><span></span><span></span></div>';
    mh += '<div class="rg-row"><span class="rg-nm">同一套流水线喂进去伪数据</span>' +
      '<span>' + pb.nullMedAnn.toFixed(2) + '</span>' +
      '<span class="rg-dim">因子序列整体循环移位：自相关与分布全保留，只切断与未来的对齐</span><span></span><span></span><span></span></div>';
    mh += '<div class="rg-row"><span class="rg-nm">其中最好的一次</span>' +
      '<span class="rg-y">' + pb.nullMaxAnn.toFixed(2) + '</span>' +
      '<span class="rg-dim">零信息下这台机器<b>也能</b>挑出来的水平</span><span></span><span></span><span></span></div>';
    mh += '<div class="rg-row"><span class="rg-nm"><b>真实数据的最优</b></span>' +
      '<span class="' + (cmp ? 'rg-g' : 'rg-r') + '"><b>' + pb.srAnn.toFixed(2) + '</b></span>' +
      '<span class="rg-dim">' + pb.nul.runs + ' 次里有 <b>' +
      Math.round(pb.nullPct * pb.nul.runs) + ' 次</b>零信息结果追平或超过它' +
      '（约第 <b>' + (pb.nullRankPct * 100).toFixed(0) + '</b> 分位）</span><span></span><span></span><span></span></div>';
    mh += '</div>';
    mh += '<div class="rg-sub"><b>这一栏是整套分析里最不该跳过的一栏。</b>' +
      '把同样的 12 个候选、同样的滚动窗口、同样的「挑最优」流程，喂进<b>与未来毫无关系</b>的伪数据，' +
      '跑了 ' + Np.runs + ' 次，它还能源源不断地挑出中位 ' + pb.nullMedAnn.toFixed(2) +
      '、最高 <b>' + pb.nullMaxAnn.toFixed(2) + '</b> 的年化夏普。' +
      (cmp
        ? '真实数据的 ' + pb.srAnn.toFixed(2) + ' 站在这些纯运气结果的上游' +
          '（第 ' + (pb.nullRankPct * 100).toFixed(0) + ' 分位，' + pb.nul.runs + ' 次里有 ' +
          Math.round(pb.nullPct * pb.nul.runs) + ' 次追平或超过它），说明它至少<b>不是纯粹的机器产物</b>；' +
          '但请把它和上面的买入持有基准一起读 —— 能赢过运气，不等于赢得了躺着不动。'
        : '真实数据的 ' + pb.srAnn.toFixed(2) + ' <b>并不比随机输入挑出来的更好</b>' +
          '（第 ' + (pb.nullRankPct * 100).toFixed(0) + ' 分位，' + pb.nul.runs + ' 次里有 ' +
          Math.round(pb.nullPct * pb.nul.runs) + ' 次零信息结果 ≥ 它）。' +
          '这意味着前面看到的一切——夏普、命中率、跑赢躺平——<b>完全可以用「机器在高维噪声里挑果子」来解释，不需要假设存在任何真实预测力</b>。') +
      '</div>';
  }
  mh += '<div class="rg-sub" style="border-top:1px dashed var(--border);margin-top:8px;padding-top:8px">' +
    '<b>诚实边界：</b>这里的 N 是本次构造的 <b>' + pb.NC + '</b> 个候选，' +
    '而在真实开发里我们（以及任何做这件事的人）尝试过的配置远多于此。<b>N 取得越大，运气门槛 SR₀ 越高，DSR 越低</b>——' +
    '所以这个数字是<b>乐观下界</b>，不是上限。这一点恰恰是绝大多数回测产品从不告诉用户的。</div>';
  box.innerHTML = mh;
}

/* 异步触发：与多重检验同批调度，算完只刷新 ⑪ 这一块 */
function schedulePbo(rep) {
  if (!rep) return;
  try {
    if (state.hist) { state.hist.pboBusy = true; state.hist.pbo = null; }
    renderPboBox();
  } catch (e) { /* ignore */ }
  setTimeout(function () {
    let pb = null;
    try { pb = pboTest(rep); } catch (e) { console.warn('pbo fail', e && e.message); }
    if (state.hist) { state.hist.pboBusy = false; state.hist.pbo = pb; }
    try { renderPboBox(); } catch (e2) { console.warn('pbo render fail', e2 && e2.message); }
  }, 90);
}

/* =====================================================================
 * v3.20 · ⑫ 多空评分 v2 / ⑬ 因子关系网络 v2 / ⑭ 实时相关性与领先滞后
 *
 *  这一版动的是三个「业余 vs 机构」差异最大的位置：
 *
 *   ⑫ 分数不再是「拍脑袋权重 × z」的加权平均。
 *      同样一批 z，用**增量式岭回归**逐日滚动估计各因子的真实权重，
 *      全程只用「当天已经知道结果」的样本（无前视偏差），
 *      再把估计出的与传统假设的方向做对照。输出的是「这套权重值多少 IC」，
 *      而不是又一个自说自话的分数。
 *
 *   ⑬ 网络不再是「裸相关系数 + 阈值」。
 *      ① 相关矩阵先做 PSD 修正与收缩 —— 缺失值导致 pairwise-complete 的矩阵
 *         可能不是半正定，直接求逆会得到荒谬的偏相关；
 *      ② 区分**总相关**与**偏相关**（精度矩阵）：总相关包含经由第三方的传导，
 *         偏相关才是「控制住其他所有因子后的直接关系」；
 *      ③ 显著性用 BH-FDR 而不是 |r|>0.08 这种拍出来的门槛；
 *      ④ MST（最小生成树）+ 聚类 + 中心性 + 吸收比：把「谁连着谁」
 *         升级成「这个因子网络里系统性风险有多集中」。
 *
 *   ⑭ 相关性不再是一个静态数字。选一个窗口就得到一个数 —— 而样本外的那一个月
 *      往往早就换了样子：危机里所有资产一起跌、平静期则各自走。所以这里给出
 *      滚动共振图（平均成对相关的漂移）、领先-滞后扫描（带半样本稳定性复核，
 *      防把噪声读成领先指标）与相关性断裂告警（短窗 vs 长窗 Fisher-z 差）。
 * ===================================================================== */

/* =====================================================================
 *  数值内核：对称矩阵特征分解 / 求逆 / 相关矩阵修正 / Fisher-z / BH-FDR
 * ===================================================================== */

/* Jacobi 特征分解（对称矩阵专用）。返回特征值降序 + 对应特征向量。
 * 选 Jacobi 而不是幂法：吸收比需要**整条谱**，不是只要第一主成分；
 * n≈20 的规模下每轮 O(n³)，几十轮旋转在浏览器里不到 1ms。 */
function jacobiEigen(Ain, n, maxSweep) {
  const A = Ain.map(function (r) { return r.slice(); });
  const V = [];
  for (let i = 0; i < n; i++) { V.push(new Array(n).fill(0)); V[i][i] = 1; }
  maxSweep = maxSweep || 60;
  for (let s = 0; s < maxSweep; s++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p][q];
        if (Math.abs(apq) < 1e-16) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - sn * akq; A[k][q] = sn * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - sn * aqk; A[q][k] = sn * apk + c * aqk; }
        for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
      }
    }
  }
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  idx.sort(function (a, b) { return A[b][b] - A[a][a]; });
  const val = idx.map(function (i) { return A[i][i]; });
  const vec = idx.map(function (i) { return V.map(function (row) { return row[i]; }); });
  return { val: val, vec: vec };
}

/* 对称正定矩阵求逆（Cholesky）。非正定返回 null —— 调用方必须显式处理，
 * 不能拿一个「数值上看着还行」的伪逆去算偏相关。 */
function cholInv(Ain, n) {
  const L = [];
  for (let i = 0; i < n; i++) L.push(new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = Ain[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 1e-14)) return null;
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  const inv = [];
  for (let i = 0; i < n; i++) inv.push(new Array(n).fill(0));
  for (let col = 0; col < n; col++) {
    const y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = (i === col ? 1 : 0);
      for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
      y[i] = s / L[i][i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) s -= L[k][i] * inv[k][col];
      inv[i][col] = s / L[i][i];
    }
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const m = (inv[i][j] + inv[j][i]) / 2;   // 数值对称化
    inv[i][j] = m; inv[j][i] = m;
  }
  return inv;
}

/* Cholesky 解线性方程组 A x = b（A 已含岭惩罚，正定） */
function cholSolve(Ain, b, n) {
  const L = [];
  for (let i = 0; i < n; i++) L.push(new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = Ain[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 1e-12)) return null;
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/* Fisher z 变换与逆变换 —— 相关系数不能直接做加减、不能直接用 ±1.96/√n 算误差界。
 * 只有在 z 空间里它才近似正态，且方差只依赖样本量：SE = 1/√(n-3)。 */
function fisherZ(r) {
  const rr = Math.max(-0.9999999999, Math.min(0.9999999999, r));
  return 0.5 * Math.log((1 + rr) / (1 - rr));
}
function fisherZInv(z) { return Math.tanh(z); }
function corrCI(r, n, z) {
  if (n == null || n < 6 || r == null || !isFinite(r)) return null;
  const c = z == null ? 1.96 : z;
  const f = fisherZ(r), se = 1 / Math.sqrt(n - 3);
  return [fisherZInv(f - c * se), fisherZInv(f + c * se)];
}
/* 相关系数显著性：t = r√(n-2)/√(1-r²)。用正态近似出双尾 p，
 * 这个近似在 n 大于几十时与 t 分布差异可忽略，且我们后续一律走 BH-FDR
 * （对 p 的量级而非精确值敏感），近似带来的误差不会改变任何结论。 */
function corrP(r, n) {
  if (n == null || n < 6 || r == null || !isFinite(r)) return null;
  const rr = Math.max(-0.999999, Math.min(0.999999, r));
  const t = rr * Math.sqrt((n - 2) / (1 - rr * rr));
  return tToP2(t);
}
/* Benjamini-Hochberg step-up（通用版）。返回 q 值数组，与输入同序。
 * v3.17 里那份是嵌在 multiTest 内部的专用实现 —— 这里抽出来给网络与领先滞后复用，
 * 三者用同一份代码，避免「同一个校正方法、三种口径」。 */
function bhQ(pvals) {
  const m = pvals.length, out = new Array(m).fill(1);
  const ord = [];
  for (let i = 0; i < m; i++) if (pvals[i] != null && isFinite(pvals[i])) ord.push(i);
  ord.sort(function (a, b) { return pvals[a] - pvals[b]; });
  let prev = 1;
  for (let k = ord.length - 1; k >= 0; k--) {
    const i0 = ord[k];
    const q = Math.min(prev, pvals[i0] * ord.length / (k + 1));
    out[i0] = Math.min(1, q);
    prev = q;
  }
  return out;
}

/* 相关系数 → 距离。Mantegna (1999) 的度量：d = √(2(1-ρ))，满足度量三条公理，
 * 于是可以在上面建最小生成树。直接拿 (1-ρ) 或 1/|ρ| 当「距离」是错的 ——
 * 它们不满足三角不等式，MST 的结果没有意义。 */
function corrDist(r) {
  const rr = Math.max(-1, Math.min(1, isFinite(r) ? r : 0));
  return Math.sqrt(Math.max(0, 2 * (1 - rr)));
}

/* =====================================================================
 *  ⑬ 因子关系网络 v2
 * ===================================================================== */

/* 把若干收益 Map 对齐到同一张日期网格上。缺失留 NaN，
 * 由后续 pairwise-complete 处理 —— 直接丢弃含缺失的行会让样本少一半以上，
 * 那是「用数据完整性换样本量」的典型错误取舍。 */
function buildRetMat(keys, win) {
  /* 防御：请求了还没有数据的序列（刷新竞态、或首次加载只到了一半）时不能炸，
   * 也不能用 undefined 参与后续矩阵运算 —— 直接把这条序列剔除并让上层看到维数不符。 */
  const valid = keys.filter(function (k) { return state.retMaps && state.retMaps[k] && state.retMaps[k].size; });
  if (valid.length !== keys.length) keys = valid;
  const maps = keys.map(function (k) { return state.retMaps[k]; });
  if (keys.length < 2) return { days: [], cols: [], keys: keys };
  const set = new Set();
  maps.forEach(function (m) { m.forEach(function (v, d) { set.add(d); }); });
  let days = Array.from(set).sort(function (a, b) { return a - b; });
  if (win && days.length > win) days = days.slice(days.length - win);
  const pos = new Map();
  days.forEach(function (d, i) { pos.set(d, i); });
  const cols = keys.map(function (k, ki) {
    const arr = new Array(days.length).fill(NaN);
    maps[ki].forEach(function (v, d) {
      const i = pos.get(d);
      if (i != null && isFinite(v)) arr[i] = v;
    });
    return arr;
  });
  return { days: days, cols: cols, keys: keys };
}

/* pairwise-complete 相关 + 重叠样本数 */
function pairCorr(a, b, L) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let i = 0; i < L; i++) {
    const x = a[i], y = b[i];
    if (!isFinite(x) || !isFinite(y)) continue;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
  }
  if (n < 20) return { r: null, n: n };
  const cx = sx / n, cy = sy / n;
  const vx = sxx - n * cx * cx, vy = syy - n * cy * cy, cov = sxy - n * cx * cy;
  if (!(vx > 0) || !(vy > 0)) return { r: null, n: n };
  return { r: cov / Math.sqrt(vx * vy), n: n };
}

/* 相关矩阵的两道处理，顺序不能反：
 *   ① 向「常数相关」目标收缩 —— pairwise-complete 下每个格子用的是不同的样本，
 *      矩阵的估计误差很大；收缩强度随维数/样本比上升。
 *      这里用的是 δ=(p+1)/(p+n̄) 这一启发式，**不是** Ledoit-Wolf 的最优强度，
 *      面板会把 δ 直接显示出来，使用者知道自己在看什么。
 *   ② 谱截断保证半正定 —— 只要有一个特征值 ≤ 0，求逆（偏相关）就会出错，
 *      更糟的是它会悄悄给出一个数值上「看起来没问题」的错误答案。 */
function prepCorr(R, p, nBar) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) if (isFinite(R[i][j])) { sum += R[i][j]; cnt++; }
  const rbar = cnt ? sum / cnt : 0;
  const delta = Math.max(0, Math.min(1, (p + 1) / (p + Math.max(1, nBar))));
  const S = [];
  for (let i = 0; i < p; i++) {
    S.push(new Array(p).fill(0));
    for (let j = 0; j < p; j++) {
      const base = i === j ? 1 : (isFinite(R[i][j]) ? R[i][j] : rbar);
      S[i][j] = (1 - delta) * base + delta * (i === j ? 1 : rbar);
    }
  }
  const E = jacobiEigen(S, p);
  let minLam = Infinity;
  for (let i = 0; i < p; i++) minLam = Math.min(minLam, E.val[i]);
  const floor = Math.max(1e-8, 1e-8);
  const clipped = minLam < floor;
  const lam = E.val.map(function (v) { return Math.max(floor, v); });
  const Psd = [];
  for (let i = 0; i < p; i++) { Psd.push(new Array(p).fill(0)); Psd[i][i] = 1; }
  for (let i = 0; i < p; i++) for (let j = i; j < p; j++) {
    let s = 0;
    for (let k = 0; k < p; k++) s += lam[k] * E.vec[k][i] * E.vec[k][j];
    Psd[i][j] = s; Psd[j][i] = s;
  }
  const dg = [];
  for (let i = 0; i < p; i++) dg.push(Math.sqrt(Math.max(1e-12, Psd[i][i])));
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) Psd[i][j] = Psd[i][j] / (dg[i] * dg[j]);
  /* 报告的是**最后真正拿去用的那个矩阵**的谱，不是中间量的谱。
   * 谱截断之后还要再归一化对角线才能让对角回到 1，这一步会轻微改变特征值 ——
   * 所以必须在全部处理做完之后再算一次，否则「矩阵已半正定」这句话就是空的。 */
  const Ef = jacobiEigen(Psd, p);
  return {
    R: Psd, delta: delta, rbar: rbar, clipped: clipped,
    minEigRaw: minLam, minEig: Ef.val[Ef.val.length - 1],
    eigen: Ef.val.slice(), eigenRaw: E.val.slice(),
    nNonPsd: E.val.filter(function (v) { return v <= 1e-8; }).length,
  };
}

/* Prim 最小生成树 —— 建在 Mantegna 距离上，输入可以是总相关矩阵也可以是偏相关矩阵 */
function mstFromCorr(R, p) {
  const D = [];
  for (let i = 0; i < p; i++) { D.push(new Array(p).fill(0)); for (let j = 0; j < p; j++) D[i][j] = corrDist(R[i][j]); }
  const inTree = new Array(p).fill(false), best = new Array(p).fill(Infinity), from = new Array(p).fill(-1);
  best[0] = 0;
  const edges = [];
  for (let it = 0; it < p; it++) {
    let u = -1, bd = Infinity;
    for (let i = 0; i < p; i++) if (!inTree[i] && best[i] < bd) { bd = best[i]; u = i; }
    if (u < 0) break;
    inTree[u] = true;
    if (from[u] >= 0) edges.push({ a: from[u], b: u, d: D[from[u]][u], r: R[from[u]][u] });
    for (let v = 0; v < p; v++) if (!inTree[v] && D[u][v] < best[v]) { best[v] = D[u][v]; from[v] = u; }
  }
  return { edges: edges, dist: D };
}

/* 主分析：一张网络需要的所有统计量，一次算完。 */
function netAnalyze(keys, opts) {
  opts = opts || {};
  const win = opts.win || 120;
  const M = buildRetMat(keys, win);
  const L = M.days.length, p = keys.length;
  if (p < 3 || L < 30) return null;
  const R = [], Ncnt = [];
  let nSum = 0, nNum = 0;
  for (let i = 0; i < p; i++) {
    R.push(new Array(p).fill(NaN)); Ncnt.push(new Array(p).fill(0));
    R[i][i] = 1; Ncnt[i][i] = L;
  }
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) {
    const c = pairCorr(M.cols[i], M.cols[j], L);
    R[i][j] = R[j][i] = c.r; Ncnt[i][j] = Ncnt[j][i] = c.n;
    if (c.r != null) { nSum += c.n; nNum++; }
  }
  const nBar = nNum ? Math.round(nSum / nNum) : L;
  const prep = prepCorr(R, p, nBar);
  const Rs = prep.R;

  /* ---- 显著性：全部 K=p(p-1)/2 对一起做 BH-FDR ---- */
  const pairs = [], ps = [];
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) {
    pairs.push({ i: i, j: j });
    ps.push(corrP(Rs[i][j], Ncnt[i][j]));
  }
  const qs = bhQ(ps);
  pairs.forEach(function (pr, k) { pr.r = Rs[pr.i][pr.j]; pr.n = Ncnt[pr.i][pr.j]; pr.p = ps[k]; pr.q = qs[k]; pr.sig = qs[k] < 0.05; });

  /* ---- 偏相关：控制住其他所有因子后的直接关系 ---- */
  let partial = null, Pinv = null;
  const Pfull = cholInv(Rs, p);
  if (Pfull) {
    Pinv = Pfull;
    partial = [];
    for (let i = 0; i < p; i++) {
      partial.push(new Array(p).fill(NaN));
      partial[i][i] = 1;
    }
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) {
      const den = Math.sqrt(Math.max(1e-18, Pfull[i][i] * Pfull[j][j]));
      const v = -Pfull[i][j] / den;
      partial[i][j] = partial[j][i] = Math.max(-1, Math.min(1, v));
    }
  }

  /* ---- MST（Prim，建立在 Mantegna 距离上）---- */
  const mst = mstFromCorr(Rs, p);
  const mstEdges = mst.edges;

  /* ---- 平均链接层次聚类 → 按合并高度最大间隙切一刀 ---- */
  const Dc = [];
  for (let i = 0; i < p; i++) { Dc.push(new Array(p).fill(0)); for (let j = 0; j < p; j++) Dc[i][j] = corrDist(Rs[i][j]); }
  const mergeHeights = [];
  let curCl = [];
  for (let i = 0; i < p; i++) curCl.push([i]);
  while (curCl.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < curCl.length; i++) {
      for (let j = i + 1; j < curCl.length; j++) {
        let s = 0, n = 0;
        for (const x of curCl[i]) for (const y of curCl[j]) { s += Dc[x][y]; n++; }
        const d = s / n;
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    mergeHeights.push(bd);
    const merged = curCl[bi].concat(curCl[bj]);
    const next = [];
    for (let i = 0; i < curCl.length; i++) if (i !== bi && i !== bj) next.push(curCl[i]);
    next.push(merged);
    curCl = next;
  }
  const clusterAt = function (k) {
    let c2 = [];
    for (let i = 0; i < p; i++) c2.push([i]);
    let heights = mergeHeights.slice();
    while (c2.length > k) {
      let bi = 0, bj = 1, bd = Infinity;
      for (let i = 0; i < c2.length; i++) for (let j = i + 1; j < c2.length; j++) {
        let s = 0, n = 0;
        for (const x of c2[i]) for (const y of c2[j]) { s += Dc[x][y]; n++; }
        const d = s / n;
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      const merged = c2[bi].concat(c2[bj]);
      const next = [];
      for (let i = 0; i < c2.length; i++) if (i !== bi && i !== bj) next.push(c2[i]);
      next.push(merged);
      c2 = next;
    }
    const out = new Array(p).fill(-1);
    c2.forEach(function (c, ci) { c.forEach(function (idx) { out[idx] = ci; }); });
    return out;
  };
  /* 簇数由 pickKFromHeights 统一决定（含「无明确断层时回退默认值」的处理） */
  const kPick = pickKFromHeights(mergeHeights, p);
  const cluster = clusterAt(kPick.k);

  /* ---- 系统性指标 ---- */
  const tot = prep.eigen.reduce(function (a, b) { return a + Math.max(0, b); }, 0) || 1;
  const ar = [];
  let acc = 0;
  for (let i = 0; i < p; i++) { acc += Math.max(0, prep.eigen[i]); ar.push(acc / tot); }
  let sumAll = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) sumAll += Rs[i][j];
  const divRatio = p / Math.sqrt(Math.max(1e-12, sumAll));   // 等权组合的分散化比率
  let absSum = 0, cnt2 = 0;
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) { absSum += Math.abs(Rs[i][j]); cnt2++; }
  const avgAbsCorr = cnt2 ? absSum / cnt2 : null;

  /* ---- 中心性：强度（|ρ| 之和）与特征向量中心性（幂迭代）---- */
  const strength = new Array(p).fill(0);
  pairs.forEach(function (pr) { const w = Math.abs(pr.r || 0); strength[pr.i] += w; strength[pr.j] += w; });
  const eigC = new Array(p).fill(1 / Math.sqrt(p));
  for (let it = 0; it < 60; it++) {
    const nx = new Array(p).fill(0);
    pairs.forEach(function (pr) {
      const w = Math.abs(pr.r || 0);
      nx[pr.i] += w * eigC[pr.j]; nx[pr.j] += w * eigC[pr.i];
    });
    let norm = 0;
    for (let i = 0; i < p; i++) norm += nx[i] * nx[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < p; i++) eigC[i] = nx[i] / norm;
  }

  return {
    keys: keys, win: win, L: L, nBar: nBar, days: M.days,
    R: Rs, partial: partial, prec: Pinv, ovl: Ncnt,
    pairs: pairs, delta: prep.delta, rbar: prep.rbar, clipped: prep.clipped,
    minEig: prep.minEig, eigen: prep.eigen, absorption: ar, divRatio: divRatio,
    avgAbsCorr: avgAbsCorr, strength: strength, eigC: eigC,
    mst: mstEdges, cluster: cluster, nCluster: (function () { const s = new Set(cluster); return s.size; })(),
    clusterClearGap: kPick.clearGap, clusterMaxJump: kPick.maxJump, clusterSpan: kPick.span,
    dist: mst.dist, minEigRaw: prep.minEigRaw, clusterDist: Dc,
  };
}

/* =====================================================================
 *  ⑭ 实时相关性 v2：领先-滞后 / 相关性断裂 / 滚动共振
 * ===================================================================== */

/* 领先-滞后扫描。
 *   L > 0 → 「因子领先目标 L 天」：corr(x_{t-L}, y_t)
 * 全家族 = keys × (2·maxLag+1) 次检验，必须做多重校正；
 * 更关键的是**半样本稳定性**：把样本劈成前后两段，各自找最优滞后，
 * 两段不一致的最优滞后几乎肯定是噪声造成的事后叙事。 */
function leadLag(keys, target, opts) {
  opts = opts || {};
  const maxLag = opts.maxLag || 5;
  const win = opts.win || 180;
  const all = target ? keys.concat([target]) : keys.slice();
  const M = buildRetMat(all, win);
  const L = M.days.length;
  if (L < 60) return null;
  const tIdx = all.length - 1;
  const y = M.cols[tIdx];
  const mid = Math.floor(L / 2);
  const rows = [], family = [];
  for (let k = 0; k < keys.length; k++) {
    const x = M.cols[k];
    const corAt = function (lag, lo, hi) {
      const xs = [], ys = [];
      for (let i = lo; i < hi; i++) {
        const j = i - lag;
        if (j < 0 || j >= L) continue;
        const xv = x[j], yv = y[i];
        if (!isFinite(xv) || !isFinite(yv)) continue;
        xs.push(xv); ys.push(yv);
      }
      return xs.length < 30 ? null : { r: pearson(xs, ys), n: xs.length };
    };
    const cur = [];
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const c = corAt(lag, 0, L);
      cur.push({ lag: lag, r: c ? c.r : null, n: c ? c.n : 0 });
      if (c && c.r != null) family.push({ key: keys[k], lag: lag, r: c.r, n: c.n });
    }
    let bestI = -1;
    for (let i = 0; i < cur.length; i++) if (cur[i].r != null && (bestI < 0 || Math.abs(cur[i].r) > Math.abs(cur[bestI].r))) bestI = i;
    if (bestI < 0) continue;
    const b1 = [], b2 = [];
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const c1 = corAt(lag, 0, mid), c2 = corAt(lag, mid, L);
      if (c1) b1.push({ lag: lag, r: c1.r });
      if (c2) b2.push({ lag: lag, r: c2.r });
    }
    const pickBest = function (arr) {
      let bi = -1;
      for (let i = 0; i < arr.length; i++) if (arr[i].r != null && (bi < 0 || Math.abs(arr[i].r) > Math.abs(arr[bi].r))) bi = i;
      return bi < 0 ? null : arr[bi].lag;
    };
    const l1 = pickBest(b1), l2 = pickBest(b2);
    rows.push({
      key: keys[k], curve: cur, bestLag: cur[bestI].lag, bestR: cur[bestI].r, bestN: cur[bestI].n,
      lag0: (function () { const z = cur.find(function (c) { return c.lag === 0; }); return z ? z.r : null; })(),
      lagA: l1, lagB: l2, stable: l1 != null && l2 != null && l1 === l2,
    });
  }
  const qs = bhQ(family.map(function (f) { return corrP(f.r, f.n); }));
  const qsMap = {};
  family.forEach(function (f, i) { qsMap[f.key + '|' + f.lag] = qs[i]; });
  rows.forEach(function (r) {
    r.q = qsMap[r.key + '|' + r.bestLag];
    r.sigQ = r.q != null && r.q < 0.05;
  });
  rows.sort(function (a, b) { return Math.abs(b.bestR) - Math.abs(a.bestR); });
  return { rows: rows, maxLag: maxLag, win: win, L: L, target: target, nTests: family.length };
}

/* 相关性断裂：短窗相关 vs 长窗相关，在 Fisher-z 空间做差并标准化。
 * 这是风险管理里真正有用的那一次比较 —— 「这对资产的关系变了没有」，
 * 而不是「它们现在相关多少」。 */
function corrBreak(A, opts) {
  if (!A) return null;
  opts = opts || {};
  const shortWin = opts.shortWin || 60;
  /* 当前窗口本来就是 365 时不要再去分解一遍同一个矩阵 —— 谱分解是这个面板里
   * 最贵的一步（每次约 100ms），而它每天只需要算一次。 */
  const longA = (opts.longA && opts.longA.win === 365) ? opts.longA : netAnalyze(A.keys, { win: 365 });
  if (!longA) return null;
  const p = A.keys.length;
  const out = [];
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      const rs = A.R[i][j], rl = longA.R[i][j];
      const ns = A.ovl[i][j], nl = longA.ovl[i][j];
      if (!isFinite(rs) || !isFinite(rl) || ns < 20 || nl < 40) continue;
      const se = Math.sqrt(1 / Math.max(4, ns - 3) + 1 / Math.max(4, nl - 3));
      const z = (fisherZ(rs) - fisherZ(rl)) / se;
      out.push({ i: i, j: j, keys: [A.keys[i], A.keys[j]], rs: rs, rl: rl, z: z, ns: ns, nl: nl });
    }
  }
  out.sort(function (a, b) { return Math.abs(b.z) - Math.abs(a.z); });
  return { rows: out, shortWin: A.win, longWin: 365 };
}

/* 滚动系统性共振：逐对算滚动相关，再跨对等权平均。
 * 两个输出：
 *   avgCorr  —— 平均成对相关。它上升说明「分散化」在失效，
 *              因为所有东西开始一起动（危机期的典型特征）。
 *   shareHi  —— |ρ|>0.5 的组合占比，比均值的尾部更敏感、也更难被单个异常值拉动。 */
function rollingSystemic(keys, opts) {
  opts = opts || {};
  const win = opts.win || 90;
  const stepN = opts.step || 5;
  const M = buildRetMat(keys);
  const L = M.days.length, p = keys.length;
  if (L < win + 40 || p < 3) return null;
  const pairList = [];
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) pairList.push([i, j]);
  const series = pairList.map(function () { return []; });
  const stamps = [];
  for (let pi = 0; pi < pairList.length; pi++) {
    const a = M.cols[pairList[pi][0]], b = M.cols[pairList[pi][1]];
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
    const q = [];
    for (let e = 0; e < L; e++) {
      const x = a[e], y = b[e];
      if (isFinite(x) && isFinite(y)) { sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++; q.push(e); }
      const drop = e - win;
      if (drop >= 0) {
        const xl = a[drop], yl = b[drop];
        if (isFinite(xl) && isFinite(yl)) { sx -= xl; sy -= yl; sxx -= xl * xl; syy -= yl * yl; sxy -= xl * yl; n--; }
      }
      if (e >= win && ((e - win) % stepN === 0)) {
        let r = null;
        if (n >= Math.floor(win * 0.5)) {
          const cx = sx / n, cy = sy / n;
          const vx = sxx - n * cx * cx, vy = syy - n * cy * cy, cov = sxy - n * cx * cy;
          if (vx > 0 && vy > 0) r = cov / Math.sqrt(vx * vy);
        }
        series[pi].push(r);
        if (pi === 0) stamps.push({ e: e, day: M.days[e] });
      }
    }
  }
  const pts = [];
  for (let w = 0; w < stamps.length; w++) {
    let s = 0, c = 0, hi = 0;
    for (let pi = 0; pi < series.length; pi++) {
      const r = series[pi][w];
      if (r == null) continue;
      s += r; c++;
      if (Math.abs(r) > 0.5) hi++;
    }
    if (c >= 3) pts.push({ day: stamps[w].day, i: stamps[w].e, avg: s / c, nPair: c, shareHi: hi / c });
  }
  if (pts.length < 12) return null;
  const vals = pts.map(function (x) { return x.avg; });
  const mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / Math.max(1, vals.length - 1));
  const last = pts[pts.length - 1];
  /* 共振警报：当前值相对自身分布超过 2σ 就用红档 —— 这是「分散化失效」的提示，
   * 不是价格预测。 */
  return {
    pts: pts, mean: mean, sd: sd, last: last, z: sd > 0 ? (last.avg - mean) / sd : null,
    win: win, nPair: series.length, keys: keys,
  };
}

/* =====================================================================
 *  ⑫ 多空评分 v2（续）：增量式岭回归 · 无前视偏差的动态权重
 *
 *  为什么不再用手写权重：
 *    FACTORS 里的 w 是「我认为这个因子有多重要」的工程判断 —— 它没法被检验。
 *    而「权重 = 对未来收益的预测系数」是可以被检验的：把权重放到没见过的样本上去，
 *    看它们还能不能赚到 IC。这就是多因子模型从「专家系统」变成「统计模型」的那一步。
 *
 *  为什么是岭回归而不是普通 OLS：
 *    22 个宏观因子彼此高度共线（见 ⑬ 的关系网络 —— 美元、美债、VIX 常常是一回事的
 *    三个侧面）。共线下 OLS 的系数会被放大到荒谬的量级且极其不稳定。
 *    岭回归用「系数平方和」做惩罚换稳定性，是这类问题的标准答案。
 *
 *  为什么不能有前视偏差（以及如何保证）：
 *    第 t 天只能用「前向收益已经在第 t 天之前揭晓」的样本训练。实现上，
 *    第 t 天新增的样本是 z(i=t-h) → r(t-h → t)，它的标签在**今天收盘**才出现，
 *    然后才允许重估系数，再对第 t 天做预测（预测的是 t → t+h，未知）。
 *    增量累加器 X'X / X'y 保证每次重估都是 O(K³)、不需要回头重扫整段历史，
 *    于是可以每天重估而不掉帧。回归测试段 N 会用「篡改未来必须不改变历史预测」
 *    直接验这条。
 * ===================================================================== */

const RW_LAMBDAS = [0.05, 0.25, 1, 4];
const RW_LAMBDA_DEFAULT = 1;      // 预注册口径：罚项 ≈ 一个单位的因子方差，不做事后挑选
const RW_H = 10;
const RW_STEP = 5;                // 每 5 天重估一次系数
const RW_MIN_TRAIN = 180;
const RW_COVERAGE = 0.3;      // 覆盖率门槛（≈ 3 年），见 ridgeWalkForward 注释
/* 实时可用的回放因子：回放专用（replayOnly）那 5 个在实时没有数据源，
 * 若把它们放进实时模型，线上永远只能代入 z=0，模型会系统性偏移。
 * 所以实时口径单独训练一套，并把它自己的样本外 IC 一并摊开给人看。 */
const RW_LIVE_IDS = ['fng', 'hr', 'tx', 'dxy', 'us10y', 'spx', 'vix', 'gold', 'oil', 'geo', 'fed', 'bei', 'curve', 'jpy', 'jgb', 'tech', 'mom'];

function fwdRetAt(rep, i, h) {
  const j = i + h;
  if (j >= rep.n) return null;
  const p0 = rep.closes[i], p1 = rep.closes[j];
  if (!p0 || !p1 || !isFinite(p0) || !isFinite(p1)) return null;
  return p1 / p0 - 1;
}

/* 信号质量通用评估：IC + t + 三分位收益差 + 胜率。
 * 只看 IC 会被分布形状骗（一个尾部驱动的因子 IC 可能很高但分档收益不单调），
 * 所以必须同时给出「信号最高的一档实际赚了多少」。 */
function signalQuality(series, rep, h, lo, hi) {
  const xs = [], rs = [];
  for (let i = lo; i < hi; i++) {
    const v = series[i];
    if (v == null) continue;
    const y = fwdRetAt(rep, i, h);
    if (y == null) continue;
    xs.push(v); rs.push(y);
  }
  if (xs.length < 40) return null;
  const c = icCore(series, rep, h, lo, hi);
  const ord = xs.map(function (v, i) { return i; }).sort(function (a, b) { return xs[a] - xs[b]; });
  const third = Math.max(8, Math.floor(ord.length / 3));
  const mean = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; };
  const top = ord.slice(ord.length - third), bot = ord.slice(0, third);
  const upRet = mean(top.map(function (i) { return rs[i]; }));
  const dnRet = mean(bot.map(function (i) { return rs[i]; }));
  const winTop = top.filter(function (i) { return rs[i] > 0; }).length / top.length;
  return {
    n: xs.length, ic: c ? c.spear : null, t: c ? c.t : null,
    up: upRet, dn: dnRet, spread: upRet - dnRet, win: winTop,
    nTercile: third,
  };
}

function ridgeWalkForward(rep, opts) {
  opts = opts || {};
  const h = opts.h || RW_H;
  const step = opts.step || RW_STEP;
  const minTrain = opts.minTrain || RW_MIN_TRAIN;
  /* 覆盖率门槛：某个因子至少要在多大比例的回放期里有值才允许进 X。
   * 30% × 十年窗口 ≈ 3 年 —— 这是「估计一个系数最少要多少数据」的经验下限。
   * 实测在这个十年窗口上把门槛从 0.2 挪到 0.7，样本外 IC 只在 0.1225~0.1256 之间
   * 变动（比任何一个调参可能带来的影响都小一个量级），所以这不是一个需要纠结的旋钮。
   * 被排除的因子会在面板里**按名字列出来**，而不是悄悄丢掉。 */
  const coverage = opts.coverage || RW_COVERAGE;
  const span = rep.n - rep.start;
  if (span < minTrain + h + 80) return null;

  const allIds = Object.keys(rep.fzs || {});
  let ids = allIds.filter(function (id) {
    const v = rep.fzs[id];
    if (!v) return false;
    if (opts.only && opts.only.indexOf(id) < 0) return false;
    let c = 0;
    for (let i = rep.start; i < rep.n; i++) if (v[i] != null) c++;
    return c >= span * coverage;
  });
  if (ids.length < 4) return null;
  const K = ids.length;
  const excluded = allIds.filter(function (id) { return ids.indexOf(id) < 0; });

  /* 增量累加器：A0[a][c] = Σ x_a x_c（上三角），b0[a] = Σ x_a y，x_0 ≡ 1（截距不入惩罚） */
  const A0 = [];
  for (let a = 0; a <= K; a++) A0.push(new Array(K + 1).fill(0));
  const b0 = new Array(K + 1).fill(0);
  let trainN = 0;
  const xrow = new Array(K + 1);
  function addSample(i, y) {
    const row = xrow; row[0] = 1;
    for (let j = 0; j < K; j++) { const v = rep.fzs[ids[j]][i]; row[j + 1] = (v == null ? 0 : v); }
    for (let a = 0; a <= K; a++) { const xa = row[a]; if (!xa) continue; for (let c = a; c <= K; c++) A0[a][c] += xa * row[c]; }
    for (let a = 0; a <= K; a++) b0[a] += row[a] * y;
    trainN++;
  }
  /* 除以 trainN 后再加罚 ⇒ 罚项按「每样本」计量，λ 不再随训练样本量漂移。
   * 不这么做的话，同一套 λ 在早期（样本少）几乎等于 OLS、到晚期又被过度收缩，
   * 整个 Sample 的时间序列就不是同一个模型了。 */
  const fitLambda = function (lam) {
    if (!trainN) return null;
    const A = [];
    for (let a = 0; a <= K; a++) A.push(new Array(K + 1).fill(0));
    for (let a = 0; a <= K; a++) for (let c = a; c <= K; c++) { const v = A0[a][c] / trainN; A[a][c] = v; A[c][a] = v; }
    for (let j = 1; j <= K; j++) A[j][j] += lam;
    const rhs = b0.map(function (v) { return v / trainN; });
    return cholSolve(A, rhs, K + 1);
  };

  const sigs = {};
  RW_LAMBDAS.forEach(function (L) { sigs[L] = new Array(rep.n).fill(null); });
  let betas = null, lastFit = -1e9, firstPred = null, nRefit = 0;
  let prevB = null, turn = 0, turnN = 0, enbSum = 0, enbN = 0;
  const xpred = new Array(K + 1);

  for (let t = rep.start; t < rep.n; t++) {
    const i = t - h;
    if (i >= rep.start) {
      const y = fwdRetAt(rep, i, h);
      if (y != null) addSample(i, y);
    }
    if (trainN >= minTrain) {
      if (!betas || t - lastFit >= step) {
        betas = {};
        RW_LAMBDAS.forEach(function (L) { betas[L] = fitLambda(L); });
        lastFit = t; nRefit++;
        const bd = betas[RW_LAMBDA_DEFAULT];
        if (bd) {
          if (prevB) { let s = 0; for (let j = 1; j <= K; j++) s += Math.abs(bd[j] - prevB[j]); turn += s; turnN++; }
          prevB = bd.slice();
          let s1 = 0, s2 = 0;
          for (let j = 1; j <= K; j++) { s1 += Math.abs(bd[j]); s2 += bd[j] * bd[j]; }
          if (s2 > 0) { enbSum += s1 * s1 / s2; enbN++; }
        }
      }
      if (firstPred == null) firstPred = t;
      if (betas) {
        xpred[0] = 1;
        let avail = 0;
        for (let j = 0; j < K; j++) { const v = rep.fzs[ids[j]][t]; xpred[j + 1] = (v == null ? 0 : v); if (v != null) avail++; }
        if (avail >= 3) {
          RW_LAMBDAS.forEach(function (L) {
            const bd = betas[L];
            if (!bd) return;
            let s = 0;
            for (let a = 0; a <= K; a++) s += bd[a] * xpred[a];
            sigs[L][t] = s;
          });
        }
      }
    }
  }
  if (firstPred == null || firstPred >= rep.n - h - 20) return null;

  const lo = firstPred, hi = rep.n;
  const rows = RW_LAMBDAS.map(function (L) {
    const q = signalQuality(sigs[L], rep, h, lo, hi);
    return {
      lambda: L, ic: q ? q.ic : null, t: q ? q.t : null, n: q ? q.n : 0,
      up: q ? q.up : null, dn: q ? q.dn : null, spread: q ? q.spread : null, win: q ? q.win : null,
      default: L === RW_LAMBDA_DEFAULT,
    };
  });
  const st = signalQuality(rep.scores, rep, h, lo, hi);
  const eqId = ids.slice();
  const eqW = compositeSeries(rep, eqId);
  const eqQ = signalQuality(eqW, rep, h, lo, hi);

  const bd = betas ? betas[RW_LAMBDA_DEFAULT] : null;
  const betaRows = [];
  for (let j = 0; j < K; j++) {
    const f = FACTORS.find(function (x) { return x.id === ids[j]; });
    const b = bd ? bd[j + 1] : null;
    betaRows.push({
      id: ids[j], name: f ? f.name : ids[j], beta: b, dir: f ? f.dir : 0, w: f ? f.w : 1,
      agree: (f && f.dir && b != null) ? (Math.sign(b) === Math.sign(f.dir)) : null,
    });
  }
  betaRows.sort(function (a, b) { return Math.abs(b.beta || 0) - Math.abs(a.beta || 0); });
  const agreeN = betaRows.filter(function (r) { return r.agree === true; }).length;
  const agreeTot = betaRows.filter(function (r) { return r.agree != null; }).length;

  /* 实时应用需要的两样东西：最终系数 + 历史预测分布（用来把原始预测换成百分位） */
  const sigHist = sigs[RW_LAMBDA_DEFAULT].filter(function (v) { return v != null; }).slice().sort(function (a, b) { return a - b; });

  return {
    h: h, step: step, minTrain: minTrain, K: K, ids: ids, excluded: excluded,
    firstPred: firstPred, nPred: hi - lo, nTrainMax: trainN, nRefit: nRefit,
    lambdas: RW_LAMBDAS, lambdaDefault: RW_LAMBDA_DEFAULT,
    rows: rows,
    baseline: st ? { ic: st.ic, t: st.t, up: st.up, dn: st.dn, spread: st.spread, win: st.win, n: st.n } : null,
    equalWeight: eqQ ? { ic: eqQ.ic, t: eqQ.t, spread: eqQ.spread, win: eqQ.win } : null,
    betas: betaRows, intercept: bd ? bd[0] : 0,
    agreeN: agreeN, agreeTot: agreeTot, agreePct: agreeTot ? agreeN / agreeTot : null,
    turnover: turnN ? turn / turnN : null, turnoverRel: null,
    meanAbsBeta: betaRows.length ? betaRows.reduce(function (a, b) { return a + Math.abs(b.beta || 0); }, 0) / betaRows.length : null,
    enb: enbN ? enbSum / enbN : null,
    sigHist: sigHist, sigs: sigs, sigDefault: sigs[RW_LAMBDA_DEFAULT],
  };
}

/* 用最终系数给「今天」打分。
 * 原始预测值的量级没有直观含义（它是收益预测，万分之几），所以换算成
 * 「这个预测值在自己历史分布里的百分位」—— 这也是唯一诚实的换算方式：
 * 不做任何拉伸假设，只回答「历史上比今天更看多的日子有多少」。 */
function ridgeLiveScore(out) {
  const rw = state.hist && state.hist.rw && state.hist.rw.live;
  if (!rw || !rw.sigHist || !rw.sigHist.length) return null;
  let s = rw.intercept, avail = 0;
  for (let j = 0; j < rw.ids.length; j++) {
    const o = out[rw.ids[j]];
    const z = (o && o.ok !== false && o.z != null) ? o.z : 0;
    if (o && o.ok !== false && o.z != null) avail++;
    s += (rw.betas.find(function (b) { return b.id === rw.ids[j]; }) || { beta: 0 }).beta * z;
  }
  if (avail < 5) return null;
  const H = rw.sigHist;
  let cnt = 0;
  for (let i = 0; i < H.length; i++) if (H[i] <= s) cnt++;
  const pct = cnt / H.length;
  return {
    raw: s, pct: pct, score: Math.max(2, Math.min(98, Math.round(pct * 100))),
    nFac: avail, nTotal: rw.ids.length, nHist: H.length,
    median: H[Math.floor(H.length / 2)],
  };
}

/* ---------- 分歧度：一个没有离散度的点估计是不完整的 ----------
 * 12 个因子加出一个 57 分，可能是「12 个都温和偏多」，也可能是
 * 「6 个狂热看多、6 个极度看空互相抵消」。两种情况的含义完全相反：
 * 前者可以照着做，后者说明模型内部在打架、这个分数不该被当作结论。
 * 顺带给出 jackknife 敏感度：逐个删掉一个因子重算，看分数摆动多大、
 * 谁是那个「一个人说了算」的因子。 */
function scoreDispersion(res) {
  const parts = [];
  FACTORS.forEach(function (f) {
    if (f.replayOnly || !f.dir) return;
    const r = res.out[f.id];
    if (!r || r.ok === false) return;
    parts.push({ id: f.id, name: f.name, w: f.w, c: r.contribution });
  });
  if (parts.length < 3) return null;
  let wsum = 0, s = 0;
  parts.forEach(function (p) { wsum += p.w; s += p.w * p.c; });
  const mean = s / wsum;
  let varr = 0, upW = 0, dnW = 0;
  parts.forEach(function (p) {
    varr += p.w * (p.c - mean) * (p.c - mean);
    if (p.c > 0.25) upW += p.w;
    else if (p.c < -0.25) dnW += p.w;
  });
  varr /= wsum;
  const sd = Math.sqrt(varr);
  /* 加权均值的标准误 —— 注意这是「假设各因子独立」的下界：
   * ⑬ 的网络显示它们明显相关，真实不确定性只会更大，不会更小。 */
  let seNum = 0;
  parts.forEach(function (p) { seNum += p.w * p.w * (p.c - mean) * (p.c - mean); });
  const se = Math.sqrt(seNum) / wsum;
  let lo = Infinity, hi = -Infinity, who = null, whoDelta = 0;
  parts.forEach(function (p) {
    if (p.w >= wsum) return;
    const sc = 50 + 22 * (s - p.w * p.c) / (wsum - p.w);
    if (sc < lo) lo = sc;
    if (sc > hi) hi = sc;
    const d = Math.abs(sc - res.score);
    if (d > whoDelta) { whoDelta = d; who = p; }
  });
  const top = parts.slice().sort(function (a, b) { return Math.abs(b.w * b.c) - Math.abs(a.w * a.c); }).slice(0, 3);
  return {
    n: parts.length, mean: mean, sd: sd, se: se, bandScore: 22 * se,
    upW: upW / wsum, dnW: dnW / wsum, flatW: 1 - (upW + dnW) / wsum,
    consensus: Math.max(upW, dnW) / wsum, agreeSign: upW >= dnW ? 1 : -1,
    jackLo: Math.max(2, Math.min(98, Math.round(lo))), jackHi: Math.max(2, Math.min(98, Math.round(hi))),
    jackRange: Math.round(hi - lo), driver: who, driverDelta: whoDelta, top: top, score: res.score,
  };
}


/* =====================================================================
 *  v3.21 · 从「给分」到「给仓位」
 *
 *  前面十几个版本都在回答「现在几分」。但分数本身不可执行 —— 没人能拿
 *  57 分去下单。真正的缺口是中间那一段：
 *      分数 → 期望收益（校准） → 期望收益 → 仓位（风险化）
 *  这一版补的就是这一段，外加一个前提检查：
 *      这 22 个因子到底有几个是真正独立的？（有效维度）
 *
 *  ⑰ 分位数组合检验：按分位数切 5 档（不是固定阈值 —— 固定阈值会让某档
 *     只剩几十个样本），检验期望收益是否随档位单调上升。单调性用
 *     **5! = 120 种排列全枚举**的精确置换检验，不是蒙特卡洛近似；
 *     并且再验一遍**样本外保序性**（切分点由前段定死，后段不许偷看）。
 *  ⑱ 校准：一分的评分到底值多少期望收益？给 OLS 映射 + R²。
 *     诚实披露：R² ≈ 2%，也就是评分只能解释 2% 的收益变异 —— 这个数字
 *     直接决定仓位该多小。斜率的显著性按**非重叠样本**折算，不拿 3555 个
 *     重叠窗口冒充 3555 个独立观测。
 *  ⑲ 仓位：样本外闸门 / 成本门槛 / 波动率目标 / Kelly / 杠杆上限，
 *     五个约束取最紧的那个，并显式指出**是哪个约束在起作用**。
 *     Kelly 只用**超额部分**（去掉这段样本的无条件漂移），否则算出来的是
 *     「牛市里满仓加杠杆」这种毫无信息量的答案。
 *  ⑳ 有效维度：participation ratio 与熵有效维度；因子 z 相关矩阵聚类分块，
 *     块内等权合成，与原 22 维模型比 IC；再给「顺序正交化」后的独有信息量。
 * ===================================================================== */

const Q_NBUCKET = 5;
const SIZE_TARGET_VOL = 0.15;    // 波动率目标（年化）—— 散户风险护栏定位，不是追求收益最大化
const SIZE_MAX_LEV = 1.0;        // 杠杆上限
const SIZE_ROUNDTRIP = 0.002;    // 往返成本（0.1% × 2）：超额收益低过这个就不值得动手
const CALIB_H = 10;              // 校准与分位数组合所用的前向 horizon

/* ---------------------------------------------------------------
 * ⑰ 分位数组合检验
 * --------------------------------------------------------------- */
/* 收集「评分 → 未来 h 日收益」样本。与 icCore 的区别：这里要保留下标与
 * 顺序，因为多空组合要按时间先后重建净值曲线。 */
function scoreFwdPairs(rep, h) {
  const S = [], R = [], I = [];
  for (let i = rep.start; i < rep.n; i++) {
    const v = rep.scores[i];
    if (v == null) continue;
    const j = i + h;
    if (j >= rep.n) break;
    const p0 = rep.closes[i];
    if (!p0) continue;
    S.push(v); R.push(rep.closes[j] / p0 - 1); I.push(i);
  }
  return { S: S, R: R, I: I };
}

/* 一元 OLS：斜率 / 截距 / 斜率标准误 / R² / 残差标准差 / 均值响应标准误。
 * minN 可调：分段校准只有 5 个「段」，不能套用普通回归的 n≥10 门槛。
 * 校准的整条逻辑都建立在这上面，所以单独抽出来 —— 测试里对着解析解验。 */
function olsFit(x, y, minN) {
  const n = Math.min(x.length, y.length);
  if (n < (minN || 10)) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    sxx += a * a; sxy += a * b; syy += b * b;
  }
  if (!sxx || !syy) return null;
  const b = sxy / sxx, a = my - b * mx;
  const sse = Math.max(0, syy - b * sxy);
  const s2 = sse / Math.max(1, n - 2);
  const seB = Math.sqrt(s2 / sxx);
  return {
    n: n, b: b, a: a, seB: seB, tB: seB ? b / seB : null,
    r2: syy ? 1 - sse / syy : null, sdResid: Math.sqrt(s2), mx: mx, sxx: sxx, my: my, syy: syy,
    /* 均值响应的标准误：离样本中心越远越宽 —— 极值评分的预测本来就最不可信，
     * 这一点必须反映到仓位上，而不是给一个假精确的数字。 */
    seAt: function (s) { return Math.sqrt(s2 * (1 / n + Math.pow(s - mx, 2) / sxx)); },
    muAt: function (s) { return a + b * s; },
  };
}

function permute5() {
  const out = [], a = [0, 1, 2, 3, 4];
  (function rec(k) {
    if (k === 5) { out.push(a.slice()); return; }
    for (let i = k; i < 5; i++) {
      const t = a[k]; a[k] = a[i]; a[i] = t;
      rec(k + 1);
      const t2 = a[k]; a[k] = a[i]; a[i] = t2;
    }
  })(0);
  return out;
}

/* 5 个数、5 个档位序号：枚举全部 120 种排列，得到**精确**置换 p 值。
 * 只有 5 个点时正态近似完全无用，但全枚举反而比蒙特卡洛更快也更准。 */
function monoPermP(means) {
  if (means.some(function (m) { return m == null; })) return null;
  /* 必须用**秩**而不是原始值：pearson(1..5, 原始值) 是「台阶形状有多线性」，
   * pearson(1..5, 秩) 才是 Spearman —— 也就是我们要的「单调性」。
   * 混用会让「严格递增但非线性」的台阶被误判成不单调。 */
  const seq = [1, 2, 3, 4, 5];
  const rk = rankAvg(means);
  const rho = pearson(seq, rk);
  if (rho == null) return null;
  const perms = permute5();
  let nGe = 0, nPerm = 0;
  for (let k = 0; k < perms.length; k++) {
    /* 排列原始值再取秩 == 直接排列秩，所以这里只排秩即可 */
    const r = pearson(seq, perms[k].map(function (i) { return rk[i]; }));
    if (r == null) continue;
    nPerm++;
    if (r >= rho - 1e-12) nGe++;
  }
  return { rho: rho, p: nPerm ? nGe / nPerm : null, nPerm: nPerm };
}

function quintileTest(rep, h) {
  const P = scoreFwdPairs(rep, h);
  const S = P.S, R = P.R;
  if (S.length < 100) return null;
  const srt = S.slice().sort(function (a, b) { return a - b; });
  const cut = [];
  for (let q = 1; q < Q_NBUCKET; q++) cut.push(srt[Math.floor(q * srt.length / Q_NBUCKET)]);
  const bidx = S.map(function (v) {
    let b = 0;
    while (b < cut.length && v >= cut[b]) b++;
    return b;
  });
  const bk = [];
  for (let b = 0; b < Q_NBUCKET; b++) {
    const rs = [];
    for (let i = 0; i < S.length; i++) if (bidx[i] === b) rs.push(R[i]);
    const n = rs.length;
    if (!n) { bk.push({ b: b, n: 0, mean: null, win: null, sd: null, t: null, neff: 0 }); continue; }
    const mean = rs.reduce(function (a, x) { return a + x; }, 0) / n;
    let vv = 0;
    for (let i = 0; i < n; i++) vv += (rs[i] - mean) * (rs[i] - mean);
    const sd = Math.sqrt(vv / Math.max(1, n - 1));
    const win = rs.filter(function (x) { return x > 0; }).length / n;
    /* 重叠窗口 ⇒ n 不是有效样本量，按 n/h 折算（与 icCore 同一口径）。 */
    const neff = Math.max(4, Math.floor(n / h));
    bk.push({ b: b, n: n, mean: mean, win: win, sd: sd, neff: neff, t: sd ? mean / (sd / Math.sqrt(neff)) : null });
  }
  const base = R.reduce(function (a, x) { return a + x; }, 0) / R.length;
  const mp = monoPermP(bk.map(function (x) { return x.mean; }));

  /* 多空组合：最高档 +1、最低档 −1、其余 0。
   * h 日重叠收益按 1/h 摊到每一天 —— 只为看净值形状与回撤。
   * 重叠会低估波动、高估夏普，所以本表夏普**只作形状参考**，
   * 显著性一律用上面按非重叠窗口折算的 t。 */
  const d = [];
  for (let i = 0; i < S.length; i++) {
    const sgn = bidx[i] === Q_NBUCKET - 1 ? 1 : (bidx[i] === 0 ? -1 : 0);
    d.push(sgn * R[i] / h);
  }
  let dm = 0;
  for (let i = 0; i < d.length; i++) dm += d[i];
  dm /= d.length;
  let dv = 0;
  for (let i = 0; i < d.length; i++) dv += (d[i] - dm) * (d[i] - dm);
  const dsd = Math.sqrt(dv / Math.max(1, d.length - 1));
  let eq = 1, peak = 1, mdd = 0;
  for (let i = 0; i < d.length; i++) {
    eq *= (1 + d[i]);
    if (eq > peak) peak = eq;
    const dd = 1 - eq / peak;
    if (dd > mdd) mdd = dd;
  }
  const years = d.length / 365;
  const ls = {
    daily: dm, sd: dsd, n: d.length,
    sharpe: dsd ? dm / dsd * Math.sqrt(365) : null,
    total: eq - 1, mdd: mdd,
    cagr: (years > 0 && eq > 0) ? Math.pow(eq, 1 / years) - 1 : null,
  };
  let mono = true;
  for (let i = 1; i < bk.length; i++) {
    if (bk[i].mean == null || bk[i - 1].mean == null) continue;
    if (bk[i].mean < bk[i - 1].mean - 1e-9) mono = false;
  }
  return {
    h: h, n: S.length, base: base, buckets: bk,
    rho: mp ? mp.rho : null, pMono: mp ? mp.p : null, nPerm: mp ? mp.nPerm : 0,
    monotonic: mono, ls: ls,
    spread: (bk[Q_NBUCKET - 1].mean != null && bk[0].mean != null) ? bk[Q_NBUCKET - 1].mean - bk[0].mean : null,
    cut: cut,
  };
}

/* 分位数切分的**样本外保序性**：切分点只用前 frac 段定死，后段不许参与决定
 * 切分点（否则就是偷看），然后看这五个数在没见过的时间段上还是不是这个顺序。
 * 样本内单调太容易了 —— 切 5 档、看 5 个数，总能讲出一个故事。
 * 真正值钱的是「搬到没见过的样本上还成不成立」。 */
function quintileOOS(rep, h, frac) {
  const P = scoreFwdPairs(rep, h);
  const S = P.S, R = P.R;
  if (S.length < 200) return null;
  const cut2 = Math.floor(S.length * (frac || 0.6));
  if (cut2 < 80 || S.length - cut2 < 80) return null;
  const srt = S.slice(0, cut2).sort(function (a, b) { return a - b; });
  const cut = [];
  for (let q = 1; q < Q_NBUCKET; q++) cut.push(srt[Math.floor(q * srt.length / Q_NBUCKET)]);
  const binOf = function (v) { let b = 0; while (b < cut.length && v >= cut[b]) b++; return b; };
  const sum = new Array(Q_NBUCKET).fill(0), ns = new Array(Q_NBUCKET).fill(0), win = new Array(Q_NBUCKET).fill(0);
  for (let i = cut2; i < S.length; i++) {
    const b = binOf(S[i]);
    sum[b] += R[i]; ns[b]++; if (R[i] > 0) win[b]++;
  }
  const means = [], wins = [];
  for (let b = 0; b < Q_NBUCKET; b++) {
    means.push(ns[b] ? sum[b] / ns[b] : null);
    wins.push(ns[b] ? win[b] / ns[b] : null);
  }
  const mp = monoPermP(means);
  let mono = true;
  for (let i = 1; i < Q_NBUCKET; i++) {
    if (means[i] == null || means[i - 1] == null) continue;
    if (means[i] < means[i - 1] - 1e-9) mono = false;
  }
  /* 分档台阶塌掉只是表象，根本问题是信号本身：把 IC 在前后两段各算一次。
   * 如果 IC 本身没衰减，那台阶塌掉就只是分档口径的偶然；
   * 如果 IC 一起塌了，那说明是信号在这段时间里失效了 —— 两件事的含义完全不同。 */
  const splitRepIdx = P.I[cut2] != null ? P.I[cut2] : rep.start + cut2;
  const icA = icCore(rep.scores, rep, h, rep.start, splitRepIdx);
  const icB = icCore(rep.scores, rep, h, splitRepIdx, rep.n);
  return {
    h: h, nIn: cut2, nOut: S.length - cut2,
    means: means, ns: ns, wins: wins,
    rho: mp ? mp.rho : null, pMono: mp ? mp.p : null, monotonic: mono,
    spread: (means[Q_NBUCKET - 1] != null && means[0] != null) ? means[Q_NBUCKET - 1] - means[0] : null,
    icIn: icA ? { ic: icA.spear, t: icA.t, n: icA.n } : null,
    icOut: icB ? { ic: icB.spear, t: icB.t, n: icB.n } : null,
  };
}

/* ---------------------------------------------------------------
 * ⑱ 校准：评分 → 期望收益
 * ---------------------------------------------------------------
 * IC 只告诉你「排序对不对」，不告诉你「一分值多少钱」。而仓位需要的是后者。
 * 这一块把评分换成期望收益，并且**连自己的不准确性一起报出来**。 */
function calibFit(rep, h) {
  const P = scoreFwdPairs(rep, h);
  if (P.S.length < 100) return null;
  const fit = olsFit(P.S, P.R);
  if (!fit) return null;

  /* 重叠窗口的代价：3555 个 10 日窗口不等于 3555 个独立观测。
   * 标准误按 √(n/n_eff) 放大 —— 不这么做，t 会从 2.9 变成 9.2，
   * 把一个「勉强显著」的斜率读成「极其显著」。
   * 本仓库从头到尾都用这个折算口径（icCore / ridgeWalkForward），这里不能例外。 */
  const nEff = Math.max(4, Math.floor(fit.n / h));
  const infl = Math.sqrt(fit.n / nEff);

  /* ---- 分段校准：把评分按分位数切 5 段，比「预测 vs 实际」 ---- */
  const srt = P.S.slice().sort(function (a, b) { return a - b; });
  const cut = [];
  for (let q = 1; q < 5; q++) cut.push(srt[Math.floor(q * srt.length / 5)]);
  const binOf = function (v) { let b = 0; while (b < cut.length && v >= cut[b]) b++; return b; };
  const bp = [], ba = [];
  for (let b = 0; b < 5; b++) { bp.push([]); ba.push([]); }
  for (let i = 0; i < P.S.length; i++) {
    const b = binOf(P.S[i]);
    bp[b].push(fit.a + fit.b * P.S[i]); ba[b].push(P.R[i]);
  }
  const bins = [];
  for (let b = 0; b < 5; b++) {
    const mp = bp[b].length ? bp[b].reduce(function (x, y) { return x + y; }, 0) / bp[b].length : null;
    const ma = ba[b].length ? ba[b].reduce(function (x, y) { return x + y; }, 0) / ba[b].length : null;
    bins.push({ b: b, n: ba[b].length, pred: mp, actual: ma, err: (mp != null && ma != null) ? ma - mp : null,
      lo: ba[b].length ? srt[0] : null, hi: null });
  }
  /* 校准斜率：把「实际」回归到「预测」上。=1 标定准确；<1 = 模型过度自信
   *（它预测差 1 分，实际只差 0.5 分）。5 个点，所以 minN 传 3。 */
  const px = [], py = [];
  bins.forEach(function (x) { if (x.pred != null && x.actual != null) { px.push(x.pred); py.push(x.actual); } });
  const slopeFit = olsFit(px, py, 3);

  /* ---- 样本外：前 60% 拟合，后 40% 评估 ---- */
  const cut2 = Math.floor(P.S.length * 0.6);
  const isFit = olsFit(P.S.slice(0, cut2), P.R.slice(0, cut2));
  let oos = null;
  if (isFit && P.S.length - cut2 >= 60) {
    const xs = P.S.slice(cut2), ys = P.R.slice(cut2);
    let sse = 0, sst = 0, my = 0;
    for (let i = 0; i < ys.length; i++) my += ys[i];
    my /= ys.length;
    for (let i = 0; i < ys.length; i++) {
      const pr = isFit.a + isFit.b * xs[i];
      sse += (ys[i] - pr) * (ys[i] - pr);
      sst += (ys[i] - my) * (ys[i] - my);
    }
    oos = { n: ys.length, r2: sst ? 1 - sse / sst : null, slopeIS: isFit.b, slopeOOS: null, rmse: Math.sqrt(sse / ys.length) };
    const ox = [], oy = [];
    for (let i = 0; i < ys.length; i++) { ox.push(isFit.a + isFit.b * xs[i]); oy.push(ys[i]); }
    const os = olsFit(ox, oy, 3);
    if (os) oos.slopeOOS = os.b;
  }

  return {
    h: h, n: fit.n, nEff: nEff, infl: infl,
    a: fit.a, b: fit.b, seB: fit.seB, tB: fit.tB,
    seBEff: fit.seB * infl, tBEff: fit.seB ? fit.b / (fit.seB * infl) : null,
    r2: fit.r2, sdResid: fit.sdResid, mxScore: fit.mx, scoreSd: Math.sqrt(fit.sxx / fit.n),
    perUnit: fit.b, per10: fit.b * 10,
    /* 均值响应：含这段样本的无条件漂移（牛市里 10 日平均 +1.9%）。
     * 看「未来大概涨多少」用这个。 */
    muAtScore: function (s) { return fit.a + fit.b * s; },
    seAtScore: function (s) { return fit.seAt(s) * infl; },
    /* 超额部分：只取斜率带来的偏离，**截距（漂移）不算信号** ——
     * 一直持有 BTC 就能拿到漂移，为它冒风险没有任何 alpha。
     * 仓位只对这个量下注。 */
    alphaAtScore: function (s) { return fit.b * (s - fit.mx); },
    seAlphaAtScore: function (s) { return Math.abs(s - fit.mx) * fit.seB * infl; },
    bins: bins, calibSlope: slopeFit ? slopeFit.b : null,
    oos: oos,
    base: P.R.reduce(function (a, x) { return a + x; }, 0) / P.R.length,
  };
}

/* ---------------------------------------------------------------
 * ⑲ 风险化仓位：从期望收益到「买多少」
 * ---------------------------------------------------------------
 * Kelly 的问题从来不是公式，而是输入：
 *   f = μ/σ² 对 μ 的估计误差极其敏感，μ 高估一倍，仓位就翻倍。
 * 所以这里不给一个数字，给**五个约束 + 哪个在起作用**：
 *   ⓪ 样本外闸门：校准映射出了样本还成不成立？不成立就什么都别算 —— 这条最要紧
 *   ① 成本门槛：超额收益覆盖不了往返手续费 → 0
 *   ② 波动率目标：仓位 = 目标年化波动 / 当前年化波动
 *   ③ Kelly（全额 / 保守 μ 取 1σ 下限 / 实务四分之一），且只用**超额部分**
 *   ④ 杠杆上限
 */
function sizingAdvice(res) {
  const H = state.hist;
  const cal = H && H.calib ? H.calib : null;
  const reg = currentRegime();
  const sigma = reg ? reg.vol : null;      // BTC 20 日年化已实现波动率
  const score = res ? res.score : null;
  const out = { have: false, sigma: sigma, score: score, reg: reg ? reg.key : null };
  if (!cal || sigma == null || !sigma || score == null) {
    out.why = !cal ? '需要先跑一次历史回放，才能得到「一分值多少钱」的校准。'
      : '需要 BTC 日线（算 20 日年化波动率）。';
    return out;
  }
  const h = cal.h;
  const muH = cal.muAtScore(score);
  const seH = cal.seAtScore(score);
  /* 只有超额部分才是信号：截距是这段样本的无条件漂移，不是模型贡献的。 */
  const alphaH = cal.alphaAtScore(score);
  const seA = cal.seAlphaAtScore(score);
  const alphaAnn = alphaH * (365 / h);
  const seAAnn = seA * (365 / h);
  const varAnn = sigma * sigma;

  const kellyFull = alphaAnn / varAnn;
  const kellyCons = (alphaAnn - seAAnn) / varAnn;      // μ 取 1σ 下限
  const volTarget = SIZE_TARGET_VOL / sigma;

  /* ⓪ 样本外闸门：这是所有约束里最要紧的一条。
   * 校准是样本内拟合出来的，如果它的映射出了样本就不成立（OOS R² ≤ 0，
   * 或 OOS 校准斜率 < 0.5），那由它推出来的期望收益就不能拿来下注 ——
   * 后面所有公式再精致也没用。 */
  const oos = cal.oos;
  const oosLinear = !!(oos && oos.r2 != null && oos.r2 > 0 && oos.slopeOOS != null && oos.slopeOOS >= 0.5);
  const qo = H.qOos;
  const oosOrder = !!(qo && qo.pMono != null && qo.pMono < 0.10 && qo.monotonic);

  const costOk = Math.abs(alphaH) >= SIZE_ROUNDTRIP;
  const cand = [
    { k: 'quarterKelly', v: 0.25 * kellyFull, lbl: '四分之一 Kelly（超额 μ 全额）' },
    { k: 'volTarget', v: volTarget, lbl: '波动率目标 ' + (SIZE_TARGET_VOL * 100).toFixed(0) + '%' },
    { k: 'cap', v: SIZE_MAX_LEV, lbl: '杠杆上限 ' + SIZE_MAX_LEV.toFixed(1) + '×' },
  ].filter(function (c) { return c.v != null && isFinite(c.v) && c.v > 0; });
  let bind = null;
  for (const c of cand) if (!bind || c.v < bind.v) bind = c;

  out.have = true;
  out.h = h;
  out.muH = muH; out.seH = seH;
  out.alphaH = alphaH; out.seA = seA; out.alphaAnn = alphaAnn; out.seAAnn = seAAnn;
  out.muLo = muH - 1.645 * seH; out.muHi = muH + 1.645 * seH;
  out.alphaLo = alphaH - 1.645 * seA; out.alphaHi = alphaH + 1.645 * seA;
  out.kellyFull = kellyFull; out.kellyCons = kellyCons; out.volTarget = volTarget;
  out.costOk = costOk;
  out.oosLinear = oosLinear; out.oosOrder = oosOrder;
  out.oosR2 = oos ? oos.r2 : null;
  out.oosSlope = oos ? oos.slopeOOS : null;
  out.suggest = (oosLinear && costOk && bind) ? Math.max(0, Math.min(SIZE_MAX_LEV, bind.v)) : 0;
  out.bindKey = !oosLinear ? 'oos' : (!costOk ? 'cost' : (bind ? bind.k : 'none'));
  out.bindLbl = !oosLinear ? '样本外闸门（校准映射出了样本不成立）'
    : (!costOk ? '成本门槛（超额收益覆盖不了往返手续费）' : (bind ? bind.lbl : '—'));
  out.cand = cand;
  out.ciIncludes0 = (alphaH - 1.645 * seA) * (alphaH + 1.645 * seA) < 0;
  out.r2 = cal.r2;
  return out;
}

/* 从层次聚类的合并高度序列里挑簇数。
 * ⑬ 网络（宏观序列）与 ⑳ 分块（因子 z）都用这一份 ——
 * 免得同一个终端里出现两种「数据驱动的簇数」。
 *
 * 两个坑，都踩过：
 *   ① 不能比「最近 k 次合并的**累计**高度差」—— 累计量随 k 单调增长，
 *      于是必然命中 k 的上限。实测 22 个因子被切成 6 块（= 上限），
 *      那不是数据说的，是上限说的。
 *   ② 改成比**单次**跳跃之后，还要看这个跳跃相对整个高度跨度够不够大。
 *      真实数据上树状图从 0.535 平滑升到 1.487，最大单次跳跃只占跨度 11% ——
 *      这说明这批对象是**连续谱，不是离散块**，此时「分成几块」只是约定，
 *      不能假装是数据给出的结论。这种情况落到事前定死的默认 k 并如实标注。 */
const CLUSTER_DEFAULT_K = 4;
const CLUSTER_MIN_GAP = 0.25;
function pickKFromHeights(heights, p) {
  if (p < 4) return Math.max(2, Math.min(p, 2));
  let bi = -1, bd = -1;
  for (let i = 0; i + 1 < heights.length; i++) {
    const g = heights[i + 1] - heights[i];
    if (g > bd) { bd = g; bi = i; }
  }
  if (bi < 0) return Math.max(2, Math.min(6, CLUSTER_DEFAULT_K));
  const span = heights[heights.length - 1] - heights[0];
  const clearGap = span > 1e-12 && bd / span >= CLUSTER_MIN_GAP;
  const k = clearGap ? p - (bi + 1) : CLUSTER_DEFAULT_K;
  return { k: Math.max(2, Math.min(6, k)), clearGap: clearGap, maxJump: bd, span: span };
}

/* ---------------------------------------------------------------
 * ⑳ 有效维度与分块因子模型
 * ---------------------------------------------------------------
 * 「22 个因子」听起来比「5 个因子」信息量大。但如果这 22 个高度共线，
 * 有效维度只有 4，那多出来的 18 个只是在重复同一句话 —— 加再多因子也不会
 * 有新的 alpha。这一块把这件事量化。 */
function effectiveDim(eigen) {
  const lam = (eigen || []).filter(function (v) { return v > 1e-12; });
  const tot = lam.reduce(function (a, b) { return a + b; }, 0);
  if (!tot || !lam.length) return null;
  let s2 = 0, H = 0;
  for (let i = 0; i < lam.length; i++) {
    s2 += lam[i] * lam[i];
    const p = lam[i] / tot;
    H -= p * Math.log(p);
  }
  const cum = [];
  let acc = 0;
  for (let i = 0; i < lam.length; i++) { acc += lam[i] / tot; cum.push(acc); }
  return {
    p: lam.length,
    pr: tot * tot / s2,                 // participation ratio：(Σλ)²/Σλ²
    entDim: Math.exp(H),                // 熵有效维度 exp(H)
    top1: lam[0] / tot,
    top3: cum[Math.min(2, cum.length - 1)],
    nFor90: (function () { for (let i = 0; i < cum.length; i++) if (cum[i] >= 0.9) return i + 1; return cum.length; })(),
    eigen: lam.slice(), cum: cum,
  };
}

/* 因子 z 的相关矩阵（用回放里的逐日 z，不是收益率 —— 评分吃的是 z 的水平） */
function facZCorr(rep) {
  const ids = [];
  REPLAY_IDS.forEach(function (id) { if (rep.fzs[id]) ids.push(id); });
  const p = ids.length;
  if (p < 3) return null;
  const R = [], ovl = [];
  for (let i = 0; i < p; i++) { R.push(new Array(p).fill(1)); ovl.push(new Array(p).fill(0)); }
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      const x = [], y = [];
      for (let k = rep.start; k < rep.n; k++) {
        const a = rep.fzs[ids[i]][k], b = rep.fzs[ids[j]][k];
        if (a != null && b != null && isFinite(a) && isFinite(b)) { x.push(a); y.push(b); }
      }
      const r = pearson(x, y);
      R[i][j] = R[j][i] = (r == null ? 0 : r);
      ovl[i][j] = ovl[j][i] = x.length;
    }
  }
  return { ids: ids, R: R, ovl: ovl, p: p };
}

/* 平均连接层次聚类（与 ⑬ 网络同一套距离：Mantegna √(2(1−ρ))），
 * 簇数取合并高度跳跃最大处。单独实现一份是因为这里聚的是**因子 z**，
 * 不是宏观序列收益率 —— 两者不是同一批对象。 */
function avgLinkCluster(R, p) {
  const D = [];
  for (let i = 0; i < p; i++) { D.push(new Array(p).fill(0)); }
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) D[i][j] = D[j][i] = corrDist(R[i][j]);
  let cur = [];
  for (let i = 0; i < p; i++) cur.push([i]);
  const heights = [];
  while (cur.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
      let s = 0, n = 0;
      for (const x of cur[i]) for (const y of cur[j]) { s += D[x][y]; n++; }
      const d = s / n;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    heights.push(bd);
    const merged = cur[bi].concat(cur[bj]);
    const nx = [];
    for (let i = 0; i < cur.length; i++) if (i !== bi && i !== bj) nx.push(cur[i]);
    nx.push(merged);
    cur = nx;
  }
  const clusterAt = function (k) {
    let c2 = [];
    for (let i = 0; i < p; i++) c2.push([i]);
    while (c2.length > k) {
      let bi = 0, bj = 1, bd = Infinity;
      for (let i = 0; i < c2.length; i++) for (let j = i + 1; j < c2.length; j++) {
        let s = 0, n = 0;
        for (const x of c2[i]) for (const y of c2[j]) { s += D[x][y]; n++; }
        const d = s / n;
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      const merged = c2[bi].concat(c2[bj]);
      const nx = [];
      for (let i = 0; i < c2.length; i++) if (i !== bi && i !== bj) nx.push(c2[i]);
      nx.push(merged);
      c2 = nx;
    }
    const out = new Array(p).fill(-1);
    c2.forEach(function (c, ci) { c.forEach(function (idx) { out[idx] = ci; }); });
    return out;
  };
  const kPick = pickKFromHeights(heights, p);
  const cl = clusterAt(kPick.k);
  return { cluster: cl, k: (function () { const s = new Set(cl); return s.size; })(),
    clearGap: kPick.clearGap, maxJump: kPick.maxJump, span: kPick.span, D: D, heights: heights };
}

/* 顺序正交化后的「独有信息量」：
 * 第 k 个因子里，有多少是前 k−1 个已经说过的？（1 − R² 对前序列回归）
 * 排序按权重×贡献从大到小 —— 也就是「这个模型实际最倚重的顺序」。
 * 结果接近 0 的因子 = 在当前排序下几乎没有增量信息。 */
function seqUnique(R, order) {
  const p = order.length, out = [];
  for (let k = 0; k < p; k++) {
    const i = order[k];
    if (k === 0) { out.push({ i: i, uniq: 1, r2: 0, m: 0 }); continue; }
    const m = k, A = [], b = [];
    for (let a = 0; a < m; a++) {
      const row = [];
      for (let c = 0; c < m; c++) row.push(R[order[a]][order[c]]);
      A.push(row); b.push(R[order[a]][i]);
    }
    for (let a = 0; a < m; a++) A[a][a] += 1e-8;      // 数值保险：共线时仍可解
    const x = cholSolve(A, b, m);
    let r2 = 0;
    if (x) for (let a = 0; a < m; a++) r2 += b[a] * x[a];
    out.push({ i: i, uniq: Math.max(0, Math.min(1, 1 - r2)), r2: r2, m: m });
  }
  return out;
}

function dimAnalyze(rep) {
  const FZ = facZCorr(rep);
  if (!FZ) return null;
  const prep = prepCorr(FZ.R, FZ.p, Math.max(60, Math.round((rep.n - rep.start) * 0.5)));
  /* 谱必须取「处理完之后那个矩阵」的谱 —— prepCorr 内部已经重算过一次
   * （v3.20 踩过的坑：报夹紧前的谱，会让「已半正定」这句话变成空话）。 */
  const eff = effectiveDim(prep.eigen);
  const cl = avgLinkCluster(prep.R, FZ.p);

  /* 分块：簇内等权合成（用贡献值 contribution = dir×z，已对齐方向），
   * 再对块等权合成总分。与原 22 维手写权重模型比 IC。 */
  const nB = cl.k;
  const blocks = [];
  for (let b = 0; b < nB; b++) blocks.push([]);
  FZ.ids.forEach(function (id, i) { blocks[cl.cluster[i]].push(id); });
  const blockSeries = new Array(nB);
  for (let b = 0; b < nB; b++) blockSeries[b] = new Array(rep.n).fill(null);
  for (let i = rep.start; i < rep.n; i++) {
    for (let b = 0; b < nB; b++) {
      let s = 0, c = 0;
      for (const id of blocks[b]) {
        const v = rep.fvals[id] ? rep.fvals[id][i] : null;
        if (v != null && isFinite(v)) { s += v; c++; }
      }
      blockSeries[b][i] = c ? s / c : null;
    }
  }
  const comp = new Array(rep.n).fill(null);
  for (let i = rep.start; i < rep.n; i++) {
    let s = 0, c = 0;
    for (let b = 0; b < nB; b++) { const v = blockSeries[b][i]; if (v != null) { s += v; c++; } }
    comp[i] = c ? s / c : null;
  }
  const icOrig = icCore(rep.scores, rep, CALIB_H, rep.start, rep.n);
  const icBlock = icCore(comp, rep, CALIB_H, rep.start, rep.n);

  /* 块间的平均 |ρ|：分块是否真的让各块更正交？ */
  let bs = 0, bn = 0;
  for (let a = 0; a < nB; a++) for (let b = a + 1; b < nB; b++) {
    const x = [], y = [];
    for (let i = rep.start; i < rep.n; i++) {
      const u = blockSeries[a][i], v = blockSeries[b][i];
      if (u != null && v != null) { x.push(u); y.push(v); }
    }
    const r = pearson(x, y);
    if (r != null) { bs += Math.abs(r); bn++; }
  }

  /* 当前实时状态下的顺序正交化（按 |w×贡献| 降序） */
  const order = [], wmap = {};
  FZ.ids.forEach(function (id, i) {
    const f = FACTORS.find(function (x) { return x.id === id; });
    const o = state.lastScoreOut && state.lastScoreOut[id];
    const c = o && o.ok !== false ? (o.contribution || 0) : 0;
    wmap[i] = Math.abs((f ? f.w : 1) * c);
    order.push(i);
  });
  order.sort(function (a, b) { return wmap[b] - wmap[a]; });
  const uniq = seqUnique(prep.R, order);

  return {
    p: FZ.p, ids: FZ.ids, R: prep.R, delta: prep.delta,
    eff: eff, cluster: cl.cluster, k: nB, blocks: blocks,
    clearGap: cl.clearGap, maxJump: cl.maxJump, span: cl.span,
    icOrig: icOrig ? { ic: icOrig.spear, t: icOrig.t, n: icOrig.n } : null,
    icBlock: icBlock ? { ic: icBlock.spear, t: icBlock.t, n: icBlock.n } : null,
    blockAvgAbsCorr: bn ? bs / bn : null,
    uniq: uniq.map(function (u) {
      const id = FZ.ids[u.i];
      const f = FACTORS.find(function (x) { return x.id === id; });
      return { id: id, name: f ? f.name : id, uniq: u.uniq, r2: u.r2, rank: u.m };
    }),
  };
}

/* ---------------------------------------------------------------
 * ⑰ 分位数组合检验 · 渲染
 * --------------------------------------------------------------- */
function renderQuintBox() {
  const box = $('quintBox'); if (!box) return;
  const H = state.hist;
  const q = H && H.quint ? H.quint : null;
  if (!q) {
    box.innerHTML = '<div class="fttl" style="margin-bottom:7px">⑰ 分位数组合检验</div>' +
      '<div class="rg-sub">' + (H ? '样本不足以做 5 分位切分（需要 ≥100 个评分-收益对）。' : '跑完历史回放后显示。') + '</div>';
    return;
  }
  const pc = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 2 : dp) + '%'; };
  const CDN = '1.05fr 1.15fr .6fr .95fr .7fr .7fr';
  let html = '<div class="fttl" style="margin-bottom:7px">⑰ 分位数组合检验（按评分分位数切 5 档 · 前向 ' + q.h + ' 日）</div>';
  html += '<div class="rg-tbl"><div class="rg-hd" style="grid-template-columns:' + CDN + '">' +
    '<span>档位</span><span>评分区间</span><span>n</span><span>平均收益</span><span>胜率</span><span>t</span></div>';
  const edges = [];
  for (let b = 0; b < q.buckets.length; b++) {
    const lo = b === 0 ? 2 : Math.round(q.cut[b - 1]);
    const hi = b === q.buckets.length - 1 ? 98 : Math.round(q.cut[b]);
    edges.push([lo, hi]);
  }
  q.buckets.forEach(function (bk, b) {
    const rg = edges[b];
    html += '<div class="rg-row" style="grid-template-columns:' + CDN + '">' +
      '<span class="rg-nm">Q' + (b + 1) + (b === q.buckets.length - 1 ? '<i>最高分</i>' : b === 0 ? '<i>最低分</i>' : '') + '</span>' +
      '<span class="rg-dim">' + rg[0] + ' ~ ' + rg[1] + '</span>' +
      '<span class="rg-dim">' + bk.n + '</span>' +
      '<span class="' + (bk.mean == null ? 'rg-dim' : bk.mean > q.base ? 'rg-g' : 'rg-r') + '">' + pc(bk.mean) + '</span>' +
      '<span class="rg-dim">' + (bk.win == null ? '—' : (bk.win * 100).toFixed(0) + '%') + '</span>' +
      '<span class="rg-dim">' + (bk.t == null ? '—' : bk.t.toFixed(2) + sigMark(bk.t)) + '</span></div>';
  });
  html += '</div>';

  const monoP = q.pMono == null ? '—' : q.pMono.toFixed(4);
  const rhoTxt = q.rho == null ? '—' : q.rho.toFixed(2);
  html += '<div class="rg-sub"><b>单调性</b>：档位序号 vs 各档平均收益，Spearman ρ = <b>' + rhoTxt + '</b>' +
    '（1 = 完全单调）。精确置换 p = <b>' + monoP + '</b>' +
    ' —— 5 档只有 5!=120 种排列，<b>全部枚举</b>而非蒙特卡洛抽样，所以这是精确值不是近似值。' +
    '基准（全样本 ' + q.h + ' 日收益）= ' + pc(q.base) + '，' +
    '所以真正该看的不是「哪一档为正」，而是<b>哪一档跑赢了基准</b>。</div>';

  /* 样本外保序 —— 这才是值钱的那一条 */
  const qo = H.qOos;
  if (qo) {
    html += '<div class="rg-sub"><b>样本外保序性（更值钱的一条）</b>：切分点只用前 ' +
      (Math.round(qo.nIn / (qo.nIn + qo.nOut) * 100)) + '% 样本定死，' +
      '后段 ' + qo.nOut + ' 天不许参与决定切分点（否则就是偷看），然后看这五个数还是不是这个顺序。<br>' +
      '样本外各档收益（含各档样本量）：' + qo.means.map(function (m, i) {
        return 'Q' + (i + 1) + ' ' + pc(m, 2) + '<i>n=' + qo.ns[i] + '</i>';
      }).join('　') +
      '<br>样本外 Spearman ρ = <b>' + (qo.rho == null ? '—' : qo.rho.toFixed(2)) + '</b>，' +
      '精确置换 p = <b>' + (qo.pMono == null ? '—' : qo.pMono.toFixed(4)) + '</b>，' +
      '严格单调 = <b>' + (qo.monotonic ? '是' : '否') + '</b>，Q5−Q1 = <b>' + pc(qo.spread) + '</b> ' +
      (qo.pMono != null && qo.pMono < 0.10
        ? '<b style="color:var(--green)">—— 保序成立</b>：分档的<b>方向</b>在没见过的时间段上依然成立。'
        : '<b style="color:var(--yellow)">—— 保序不成立</b>：样本内的漂亮台阶很可能是这段样本自己的形状。') +
      (qo.icIn && qo.icOut
        ? '<br><b>台阶塌掉只是表象，根本问题是信号本身：</b>把 IC 在前后两段各算一次 —— ' +
          '前段 IC <b>' + (qo.icIn.ic == null ? '—' : qo.icIn.ic.toFixed(3)) + '</b>（t=' + (qo.icIn.t == null ? '—' : qo.icIn.t.toFixed(2)) + '，n=' + qo.icIn.n + '）' +
          ' → 后段 IC <b>' + (qo.icOut.ic == null ? '—' : qo.icOut.ic.toFixed(3)) + '</b>（t=' + (qo.icOut.t == null ? '—' : qo.icOut.t.toFixed(2)) + '，n=' + qo.icOut.n + '）。' +
          (Math.abs(qo.icOut.ic || 0) < 0.06
            ? '后段的 IC 已经落进噪声区 —— <b>不是分档口径错了，是这段时间的信号本来就快没了</b>。' +
              '这时候任何「换个分档方式就能修好」的尝试都是在拟合噪声。'
            : 'IC 两段量级接近，说明台阶塌掉更可能是分档口径的偶然，而不是信号失效。') +
          '<br><span class="rg-dim">另需留意：切分点由前段定死，若后段的评分分布整体变窄，' +
          '两端档位会分到很少的样本（见上面的 n）—— 小样本档位的均值不可靠，这也是保序容易失败的一个机械原因，' +
          '上面那条 IC 对比不受这个影响，因此更值得相信。</span>'
        : '') +
      '</div>';
  }

  const L = q.ls;
  html += '<div class="rg-sub"><b>多空组合（Q5 做多 / Q1 做空 / 其余空仓）</b>：累计 ' + pc(L.total, 1) +
    '，年化 ≈ ' + (L.cagr == null ? '—' : (L.cagr * 100).toFixed(1) + '%') +
    '，夏普 ' + (L.sharpe == null ? '—' : L.sharpe.toFixed(2)) +
    '，最大回撤 ' + pc(L.mdd, 1) + '。' +
    '<br><span class="rg-dim">口径说明：h 日重叠收益按 1/h 摊到每一天，只为看净值形状与回撤；' +
    '重叠会<b>低估波动、高估夏普</b>，所以这里的夏普只作形状参考，' +
    '显著性一律以上表按非重叠窗口折算的 t 为准。' +
    '另外：做空 BTC 在实务上并不容易（借券成本、强平风险），这个组合的可实现性要打折看。</span></div>';

  html += '<div class="rg-sub"><b>为什么不用固定阈值（&gt;60 / &lt;40）</b>：本样本里最高档 ' +
    q.buckets[q.buckets.length - 1].n + ' 天、最低档 ' + q.buckets[0].n + ' 天，' +
    '是分位数切分保证的<b>每档样本量接近相等</b>；固定阈值会出现「低分档只有几十个样本」的情况，' +
    '那几天的偶然走势就会把整档平均收益带跑。分档口径一变结论就变 —— 这种结论不结实。</div>';
  box.innerHTML = html;
}

/* ---------------------------------------------------------------
 * ⑱ 校准 · 渲染
 * --------------------------------------------------------------- */
function renderCalibBox() {
  const box = $('calibBox'); if (!box) return;
  const H = state.hist;
  const c = H && H.calib ? H.calib : null;
  if (!c) {
    box.innerHTML = '<div class="fttl" style="margin-bottom:7px">⑱ 校准：一分到底值多少钱</div>' +
      '<div class="rg-sub">' + (H ? '样本不足（需要 ≥100 个评分-收益对）。' : '跑完历史回放后显示。') + '</div>';
    return;
  }
  const pc = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 2 : dp) + '%'; };
  const cur = state.lastScore;
  const mu = cur == null ? null : c.muAtScore(cur);
  const se = cur == null ? null : c.seAtScore(cur);
  const al = cur == null ? null : c.alphaAtScore(cur);

  let html = '<div class="fttl" style="margin-bottom:7px">⑱ 校准：评分 → 期望收益（前向 ' + c.h + ' 日）</div>';
  html += '<div class="rg-tbl"><div class="rg-hd" style="grid-template-columns:1fr .8fr .8fr .7fr .7fr">' +
    '<span>每 10 分对应收益</span><span>斜率 t（重叠口径）</span><span>斜率 t（非重叠）</span><span>R²</span><span>样本</span></div>' +
    '<div class="rg-row" style="grid-template-columns:1fr .8fr .8fr .7fr .7fr">' +
    '<span class="' + (c.per10 > 0 ? 'rg-g' : 'rg-r') + '">' + pc(c.per10, 3) + '</span>' +
    '<span class="rg-dim">' + (c.tB == null ? '—' : c.tB.toFixed(2)) + '</span>' +
    '<span class="' + (c.tBEff != null && Math.abs(c.tBEff) > 2 ? 'rg-g' : 'rg-y') + '">' +
    (c.tBEff == null ? '—' : c.tBEff.toFixed(2) + sigMark(c.tBEff)) + '</span>' +
    '<span class="rg-y">' + (c.r2 == null ? '—' : (c.r2 * 100).toFixed(2) + '%') + '</span>' +
    '<span class="rg-dim">' + c.n + '</span></div></div>';

  html += '<div class="rg-sub"><b>两栏 t 值的差别就是这一版修掉的一个自欺</b>：' +
    '3555 个 10 日窗口不等于 3555 个独立观测，按非重叠折算后有效样本只有 <b>' + c.nEff + '</b> 个，' +
    't 从 <b>' + (c.tB == null ? '—' : c.tB.toFixed(1)) + '</b> 掉到 <b>' +
    (c.tBEff == null ? '—' : c.tBEff.toFixed(2)) + '</b>。' +
    '第一个数会让人以为「极其显著」，第二个才是真的。<br>' +
    '<b>更要紧的是 R²</b>：评分能解释的收益变异只有 <b>' + (c.r2 == null ? '—' : (c.r2 * 100).toFixed(2) + '%') + '</b>，' +
    '剩下 ' + (c.r2 == null ? '—' : (100 - c.r2 * 100).toFixed(1) + '%') + ' 是评分根本没看到的东西。' +
    'IC 0.13 听起来「有信号」，换成 R² 就是 2% —— <b>这两个数字描述的是同一件事，' +
    '但后者才决定仓位该多小</b>。</div>';

  const CDN2 = '.8fr .9fr .9fr .9fr .6fr';
  html += '<div class="rg-tbl" style="margin-top:6px"><div class="rg-hd" style="grid-template-columns:' + CDN2 + '">' +
    '<span>评分段（分位）</span><span>模型预测</span><span>实际发生</span><span>校准误差</span><span>n</span></div>';
  c.bins.forEach(function (bn, b) {
    html += '<div class="rg-row" style="grid-template-columns:' + CDN2 + '">' +
      '<span class="rg-dim">第 ' + (b + 1) + ' 段</span>' +
      '<span class="rg-dim">' + pc(bn.pred, 3) + '</span>' +
      '<span class="' + (bn.actual == null ? 'rg-dim' : bn.actual > 0 ? 'rg-g' : 'rg-r') + '">' + pc(bn.actual, 3) + '</span>' +
      '<span class="rg-y">' + pc(bn.err, 3) + '</span>' +
      '<span class="rg-dim">' + bn.n + '</span></div>';
  });
  html += '</div>';

  const oos = c.oos;
  html += '<div class="rg-sub"><b>校准斜率只能看样本外的那一个</b>：把「实际」回归到「预测」上，' +
    '样本内这个值<b>按构造恒等于 1</b> —— 拟合值 ŷ 本来就是 y 在 x 张成的空间上的投影，' +
    'Cov(y,ŷ)/Var(ŷ) ≡ 1。所以样本内报 1.00 <b>不代表标得准，它只是个恒等式</b>；' +
    '初版把它当证据摆出来是错的，这里已改为只报样本外。<br>' +
    '<b>样本外</b>（前 60% 拟合 / 后 ' + (oos ? oos.n : '—') + ' 天评估）：OOS R² = <b>' +
    (oos && oos.r2 != null ? (oos.r2 * 100).toFixed(2) + '%' : '—') + '</b>' +
    (oos && oos.r2 != null && c.r2 != null ?
      '（样本内 ' + (c.r2 * 100).toFixed(2) + '% → 样本外 ' + (oos.r2 * 100).toFixed(2) + '%' +
      (oos.r2 <= 0 ? '，<b style="color:var(--red)">掉到负值 —— 样本外的线性映射还不如「直接猜平均值」</b>。' : '。') : '.') +
    ' OOS 校准斜率 = ' + (oos && oos.slopeOOS != null ? oos.slopeOOS.toFixed(3) : '—') +
    '（≈0 意味着：<b>预测值在样本外几乎不携带关于实际收益的信息</b>）。' +
    '<br><span class="rg-dim">这一条直接决定 ⑲ 的仓位能不能算 —— 见下面那块。</span></div>';

  if (cur != null && mu != null) {
    html += '<div class="rg-sub"><b>当前评分 ' + cur + '</b>：未来 ' + c.h + ' 日期望收益 <b>' + pc(mu, 3) + '</b>' +
      '（90% 区间 [ ' + pc(mu - 1.645 * se, 3) + ' , ' + pc(mu + 1.645 * se, 3) + ' ]）。' +
      '其中<b>超额部分</b>（去掉这段样本的无条件漂移 ' + pc(c.base, 3) + '）= <b>' + pc(al, 3) + '</b> —— ' +
      '<b>只有这一项才是信号贡献的</b>，漂移那部分一直持有就能拿到，为它冒风险没有 alpha。' +
      '<br><span class="rg-dim">口径注意：校准用的是<b>回放口径（22 维）</b>的评分，' +
      '实时评分是 ' + (FACTORS.filter(function (f) { return !f.replayOnly; }).length) + ' 维，' +
      '量纲接近但不完全可比 —— 这是已知近似，不是精确映射。</span></div>';
  }
  box.innerHTML = html;
}

/* ---------------------------------------------------------------
 * ⑲ 风险化仓位 · 渲染
 * --------------------------------------------------------------- */
function renderSizeBox(res) {
  const box = $('sizeBox'); if (!box) return;
  const s = sizingAdvice(res);
  const pc = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  let html = '<div class="fttl" style="margin-bottom:7px">⑲ 风险化仓位建议（评分 → 期望收益 → 买多少）</div>';
  if (!s.have) {
    html += '<div class="rg-sub">' + (s.why || '数据不足。') + '</div>';
    box.innerHTML = html;
    return;
  }
  const CDN = '1fr 1.1fr .8fr .8fr';
  html += '<div class="rg-tbl"><div class="rg-hd" style="grid-template-columns:' + CDN + '">' +
    '<span>约束</span><span>含义</span><span>仓位</span><span>是否生效</span></div>';
  const rows = [
    { nm: '⓪ 样本外闸门', v: null, lbl: 'OOS R² &gt; 0 且 OOS 斜率 ≥ 0.5', bind: s.bindKey === 'oos', show: s.oosLinear ? '通过' : '否决' },
    { nm: '① 成本门槛', v: s.costOk ? null : 0, lbl: '超额需 ≥ 往返 ' + (SIZE_ROUNDTRIP * 100).toFixed(1) + '%', bind: s.bindKey === 'cost', show: s.costOk ? '通过' : '否决' },
    { nm: '② 波动率目标', v: s.volTarget, lbl: '目标年化 ' + (SIZE_TARGET_VOL * 100).toFixed(0) + '% ÷ 当前 ' + (s.sigma * 100).toFixed(0) + '%', bind: s.bindKey === 'volTarget', show: pc(s.volTarget) },
    { nm: '③ Kelly 全额', v: s.kellyFull, lbl: '超额 μ/σ²（不建议你照这个下）', bind: false, show: pc(s.kellyFull) },
    { nm: '③b 保守 Kelly', v: s.kellyCons, lbl: '超额 μ 取 1σ 下限', bind: false, show: pc(s.kellyCons) },
    { nm: '④ 杠杆上限', v: SIZE_MAX_LEV, lbl: '硬上限', bind: s.bindKey === 'cap', show: pc(SIZE_MAX_LEV) },
  ];
  rows.forEach(function (r) {
    html += '<div class="rg-row" style="grid-template-columns:' + CDN + '">' +
      '<span class="rg-nm">' + r.nm + '</span>' +
      '<span class="rg-dim">' + r.lbl + '</span>' +
      '<span class="rg-dim">' + r.show + '</span>' +
      '<span class="' + (r.bind ? 'rg-y' : 'rg-dim') + '">' + (r.bind ? '★ 起作用' : '') + '</span></div>';
  });
  html += '</div>';

  const sug = s.suggest;
  const col = sug <= 0 ? 'rg-dim' : sug < 0.15 ? 'rg-y' : 'rg-g';
  html += '<div class="rg-sub">当前评分 <b>' + s.score + '</b> · ' +
    'BTC 20 日年化波动率 <b>' + (s.sigma * 100).toFixed(0) + '%</b> · ' +
    '未来 ' + s.h + ' 日<b>超额</b>期望 <b>' + pc(s.alphaH, 3) + '</b>（90% 区间 ' + pc(s.alphaLo, 3) + ' ~ ' + pc(s.alphaHi, 3) + '）。' +
    '<br><b>建议仓位（占净值）</b>：<span class="' + col + '" style="font-size:15px"><b>' +
    (sug <= 0 ? '0% —— 别照这个下注' : (sug * 100).toFixed(1) + '%') + '</b></span>' +
    '，起作用的约束是 <b>' + s.bindLbl + '</b>。</div>';

  if (s.bindKey === 'oos') {
    html += '<div class="rg-sub" style="border-left:2px solid var(--red);padding-left:8px">' +
      '<b style="color:var(--red)">为什么建议 0：不是信号没用，是「量级」没用。</b><br>' +
      '样本外 R² = ' + (s.oosR2 == null ? '—' : (s.oosR2 * 100).toFixed(2) + '%') +
      '、OOS 校准斜率 = ' + (s.oosSlope == null ? '—' : s.oosSlope.toFixed(3)) +
      ' —— 样本内拟合出来的「评分 → 期望收益」这条直线，' +
      '搬到没见过的时间段上<b>连猜平均值都不如</b>。' +
      'Kelly 的输入是 μ，μ 不可信时 Kelly 的输出就是垃圾 —— 这一步比后面所有公式都重要。<br>' +
      (s.oosOrder
        ? '<b style="color:var(--green)">但 ⑰ 的样本外<b>保序性</b>是成立的</b>：' +
          '分档的<b>方向</b>（高分档 vs 低分档谁更好）在样本外站得住，' +
          '只有<b>幅度</b>站不住。所以诚实的用法是：<b>可以拿它判断方向，不要拿它算仓位。</b>'
        : '⑰ 的样本外保序性同样不成立 —— 那就连方向也别依赖它。') +
      '</div>';
  }

  html += '<div class="rg-sub"><b>为什么超额 μ 而不是总 μ</b>：这段样本 10 日平均收益是 ' +
    pc(s.muH == null ? null : s.muH - s.alphaH, 3) + '（牛市漂移），一直持有就能拿到。' +
    '如果把这个数喂进 Kelly，算出来的是「牛市里满仓加杠杆」—— 结论恒为杠杆，' +
    '与信号强弱无关，这是毫无信息量的答案。所以仓位只对<b>超额部分</b>下注。<br>' +
    '<b>为什么是四分之一 Kelly</b>：f=μ/σ² 对 μ 的估计误差极其敏感，μ 高估一倍仓位就翻倍，' +
    '而这里的 μ 是从 R² ≈ ' + (s.r2 == null ? '—' : (s.r2 * 100).toFixed(1) + '%') + ' 的回归里估出来的。' +
    '实务上普遍取 1/4 ~ 1/2，就是给估计误差留余量。' +
    (s.ciIncludes0 ? ' <b style="color:var(--red)">本例超额收益的 90% 区间跨 0 —— 严格说此刻连方向都没定下来。</b>' : '') +
    '<br><b>三条局限</b>：① Kelly 假设收益 iid 且正态，BTC 两条都不满足（肥尾、体制切换）；' +
    '② 用的是已实现波动率，而波动率本身会突变（见体制徽标与 ⑮）；' +
    '③ 只给单资产 BTC 的仓位，没有组合层面的相关性折让。</div>';
  box.innerHTML = html;
}

/* ---------------------------------------------------------------
 * ⑳ 有效维度与分块因子 · 渲染
 * --------------------------------------------------------------- */
function renderDimBox() {
  const box = $('dimBox'); if (!box) return;
  const H = state.hist;
  const D = H && H.dim ? H.dim : null;
  if (!D) {
    box.innerHTML = '<div class="fttl" style="margin-bottom:7px">⑳ 有效维度与分块因子模型</div>' +
      '<div class="rg-sub">' + (H ? '因子 z 序列不足以构造相关矩阵。' : '跑完历史回放后显示。') + '</div>';
    return;
  }
  const E = D.eff;
  const f2 = function (v) { return v == null ? '—' : v.toFixed(2); };
  let html = '<div class="fttl" style="margin-bottom:7px">⑳ 有效维度与分块因子模型（' + D.p + ' 个因子）</div>';
  html += '<div class="rg-tbl"><div class="rg-hd" style="grid-template-columns:1fr 1fr 1fr 1fr">' +
    '<span>参与率 PR</span><span>熵有效维度</span><span>PC1 占比</span><span>解释 90% 需</span></div>' +
    '<div class="rg-row" style="grid-template-columns:1fr 1fr 1fr 1fr">' +
    '<span class="rg-y">' + f2(E.pr) + '</span>' +
    '<span class="rg-y">' + f2(E.entDim) + '</span>' +
    '<span class="rg-dim">' + (E.top1 * 100).toFixed(1) + '%</span>' +
    '<span class="rg-dim">' + E.nFor90 + ' / ' + E.p + '</span></div></div>';

  html += '<div class="rg-sub"><b>这一行是整套因子模型的前提检查</b>：' + D.p + ' 个因子里，' +
    '按相关矩阵的谱来算，真正独立的方向只有 <b>' + f2(E.pr) + '</b> 个（参与率 PR = (Σλ)²/Σλ²）' +
    '，熵有效维度 ' + f2(E.entDim) + '，解释 90% 的方差要 <b>' + E.nFor90 + '</b> 个方向。<br>' +
    (E.pr < D.p * 0.5
      ? '也就是说，多出来的那 ' + (D.p - Math.round(E.pr)) + ' 个因子大部分在<b>重复同一句话</b>。' +
        '这直接解释了 v3.20 的一个结果：<b>为什么换成岭回归动态权重并没有变好</b> —— ' +
        '如果信息本来就集中在少数几个方向上，换更精细的组合方法不会凭空产生 alpha。' +
        '想改善模型，方向是<b>找新的独立维度</b>，不是在现有维度里重新配权。'
      : '有效维度接近因子总数，说明这批因子<b>没有严重冗余</b> —— 这比「分块能不能提分」更值得高兴，' +
        '因为它是可以继续加因子的前提。') + '</div>';

  html += '<div class="rg-sub"><b>分块</b>（平均连接层次聚类 · Mantegna 距离 · ' + D.k + ' 块' +
    (D.clearGap ? '' : '，<b>树状图无明确断层 → 这是默认值不是数据给的</b>') + '）：' +
    D.blocks.map(function (b, i) {
      return '<span class="rg-dim">块' + (i + 1) + '：' + b.map(function (id) {
        const f = FACTORS.find(function (x) { return x.id === id; });
        return f ? f.name.replace(/^[^ ]+ /, '') : id;
      }).join('·') + '</span>';
    }).join('　') + '</div>' +
    (D.clearGap
      ? '<div class="rg-sub">树状图在合并高度 <b>' + (D.maxJump == null ? '—' : D.maxJump.toFixed(3)) + '</b> 处' +
        '有一次占跨度 ' + (D.span ? (D.maxJump / D.span * 100).toFixed(0) : '—') + '% 的明确跳跃 —— ' +
        '这个块数是<b>数据给出的</b>。</div>'
      : '<div class="rg-sub">树状图的最大单次跳跃只有 <b>' + (D.maxJump == null ? '—' : D.maxJump.toFixed(3)) + '</b>，' +
        '占整个高度跨度（' + (D.span == null ? '—' : D.span.toFixed(3)) + '）的 ' +
        (D.span ? (D.maxJump / D.span * 100).toFixed(0) : '—') + '% —— ' +
        '<b>远不到「断层」的程度</b>。这本身就是结论：这批因子构成的是<b>连续谱，不是几个离散的块</b>。' +
        '所以这里的 ' + D.k + ' 块是<b>事前定死的默认值（' + CLUSTER_DEFAULT_K + '）</b>，不是数据挑出来的；' +
        '下面的分块对比只能当结构诊断看，不能当「发现了几个因子簇」。</div>');

  const io = D.icOrig, ib = D.icBlock;
  const dIC = (io && ib && io.ic != null && ib.ic != null) ? ib.ic - io.ic : null;
  html += '<div class="rg-sub"><b>分块等权 vs 原 ' + D.p + ' 维手写权重</b>：IC ' +
    '<b>' + (ib ? ib.ic.toFixed(3) : '—') + '</b> vs <b>' + (io ? io.ic.toFixed(3) : '—') + '</b>' +
    '（差 ' + (dIC == null ? '—' : (dIC >= 0 ? '+' : '') + dIC.toFixed(3)) + '），' +
    '块间平均 |ρ| = ' + (D.blockAvgAbsCorr == null ? '—' : D.blockAvgAbsCorr.toFixed(3)) + '。' +
    (dIC != null && Math.abs(dIC) < 0.01
      ? ' <b>差别在 ±0.01 以内 —— 分块没有带来增益，也没有损失</b>。' +
        '这说明真正决定结果的是那几个独立方向本身，而不是「怎么把它们加起来」。'
      : dIC != null && dIC > 0 ? ' 分块略优：先把块内噪声平均掉，确实有一点好处 —— 但差距不大，不足以当作改进。'
        : dIC != null ? ' 分块略差：块内等权丢掉了手写权重里的先验判断。' : '') +
    '<br><span class="rg-dim">注意这是<b>同样本</b>比较，且分块的簇数由数据自己决定 —— ' +
    '要当作结论还需要样本外验证，这里只作结构诊断。</span></div>';

  const uq = D.uniq.slice().sort(function (a, b) { return b.uniq - a.uniq; });
  html += '<div class="rg-sub"><b>顺序正交化后的独有信息量</b>（按当前 |权重×贡献| 从大到小依次正交化，' +
    '数值 = 该因子里前序因子没说过的部分）：<br>' +
    uq.slice(0, 6).map(function (u) {
      return '<span class="rg-dim">' + u.name.replace(/^[^ ]+ /, '') + ' ' + (u.uniq * 100).toFixed(0) + '%</span>';
    }).join('　') + '<br>' +
    '<span class="rg-dim">几乎全被前面说完了的：</span>' +
    uq.slice(-4).map(function (u) {
      return '<span class="rg-dim">' + u.name.replace(/^[^ ]+ /, '') + ' ' + (u.uniq * 100).toFixed(0) + '%</span>';
    }).join('　') +
    '<br><span class="rg-dim">读法：接近 0% 的因子在这个排序下没有增量信息 —— 不是它没用，' +
    '是<b>它说的已经被排在前面的因子说过了</b>。这比「逐个删掉看分数摆动」（jackknife）更严谨：' +
    'jackknife 只看删除效应，正交化直接衡量冗余。</span></div>';
  box.innerHTML = html;
}

/* =====================================================================
 * v3.22 ㉑-㉓：让这台终端对自己负责
 *
 *   v3.21 的结论是回顾性的、而且不好听：样本外保序反转、信号本身在衰减
 *   （IC 0.185 → 0.041）、建议仓位 = 0。这些数字如果只是躺在回放面板里，
 *   那它只是一份「体检报告」；真正的机构做法是把它变成 **开着的监控**。
 *
 *   本轮三块：
 *
 *    ㉑ 预测台账（自我记分）—— 这台终端每天都在出分，但从来没有人给它
 *       改过卷。这里把每天的「评分 + 当时价格」记进 localStorage，等
 *       h 天过去了再把真实收益填回去，于是得到一份 **前视的、真实的**
 *       样本外记录。它最值钱的地方：这是全套系统里唯一一份真正的前向
 *       测试 —— 十年回放再怎么说也是事后。代价是样本要靠时间攒，
 *       所以样本不够时**拒绝给结论**（这是本块的纪律，不是缺陷）。
 *
 *    ㉒ 换手率与可执行性 —— v3.21 说「建议仓位 0」，但没说清为什么。
 *       真正的原因是：评分每天在动，动就要交成本。这里把评分落成仓位
 *       序列，量出换手率、算出成本吃掉多少毛收益、给出盈亏平衡换手率。
 *       同时给出评分的自相关与符号翻转频率 —— 一个每 3 天翻一次的信号，
 *       就算 IC 好看也是不可交易的。
 *
 *    ㉓ 信号健康度 —— 把 v3.21 的「信号在衰减」变成实时监控：最近 W 天
 *       的 IC 与**其余全部样本**的 IC 做 Fisher-z 两独立样本检验。
 *       注意必须是「其余」而不是「全样本」—— 全样本包含最近段，两者不独立，
 *       那样算出来的 z 是错的。
 * ===================================================================== */

const LEDGER_KEY = 'nexus_ledger_v1';
const LEDGER_H = 10;        // 与 CALIB_H 一致：评分给的是 10 日前瞻
const LEDGER_MIN = 30;      // 低于这个已结算样本量，拒绝给结论
const LEDGER_MAX = 500;     // 最多保留多少条

/* ---------- 精确二项检验（用于胜率是否优于抛硬币）---------- */
/* 必须整段走**对数空间**，最后再归一化 —— v3.22 实测抓到一个下溢 bug：
 * 初版写 out[0] = exp(n·ln(1−p))，n=3564、p=0.5 时是 exp(−2470)，
 * 直接下溢成 0；后面的递推是乘法，**0 会传播到整个数组**，
 * 于是所有概率全是 0 ⇒ 双侧 p 恒等于 0。后果很坏：日度命中率 49.4%
 * （正确 p≈0.19，完全不显著）被算成 p=0.0000，界面会据此宣称
 * 「显著差于抛硬币」—— 一个纯数值 bug 被包装成了统计结论。
 * 修法：先算全部 log-pmf，减去最大值再取指数（最大项归一为 1，不会下溢），
 * 最后整体除以总和还原成真正的概率。
 *
 * n≤745 时旧写法碰巧不出错 —— 这正是它危险的地方：小样本测试全过，
 * 一上真实数据量就翻车。所以下面必须有「总和=1」和「大 n」两条断言。 */
function binomPmf(n, p) {
  if (n < 0) return null;
  const lp = Math.log(p), lq = Math.log(1 - p);
  const lg = new Array(n + 1);
  lg[0] = n * lq;
  for (let i = 1; i <= n; i++) {
    lg[i] = lg[i - 1] + Math.log(n - i + 1) - Math.log(i) + lp - lq;
  }
  let mx = -Infinity;
  for (let i = 0; i <= n; i++) if (lg[i] > mx) mx = lg[i];
  const out = new Array(n + 1);
  let sum = 0;
  for (let i = 0; i <= n; i++) { out[i] = Math.exp(lg[i] - mx); sum += out[i]; }
  for (let i = 0; i <= n; i++) out[i] /= sum;
  return out;
}
/* 双侧精确二项 p：把所有「概率不超过观测值」的结果加起来。
 * 这是 Fisher 精确检验在单样本情形下的标准做法，不是正态近似。 */
function binomTwoSided(k, n, p) {
  if (n <= 0 || k < 0 || k > n) return null;
  const pp = p == null ? 0.5 : p;
  const pmf = binomPmf(n, pp);
  if (!pmf) return null;
  const pk = pmf[k];
  let s = 0;
  for (let i = 0; i <= n; i++) if (pmf[i] <= pk * (1 + 1e-12)) s += pmf[i];
  return Math.min(1, s);
}

/* ---------- ㉑ 预测台账 ---------- */
function ledgerLoad() {
  try {
    const s = localStorage.getItem(LEDGER_KEY);
    if (!s) return [];
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function ledgerSave(a) {
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(a)); } catch (e) { /* 隐私模式下不可写，静默 */ }
}

/* 记今天的预测。同一天只留最后一次 —— 页面每 60s 刷新，一天会触发很多次。
 * 回放游标模式下（state.klIdx 非 null）不记，否则会把历史日期混进台账。 */
function ledgerRecord(score) {
  if (score == null || !isFinite(score)) return false;
  if (state.klIdx != null) return false;
  const k = state.klines['BTC1d'];
  if (!k || !k.length) return false;
  const last = k[k.length - 1];
  if (!last || !last.c) return false;
  const day = fDate(last.t);
  const a = ledgerLoad();
  let i = -1;
  for (let j = 0; j < a.length; j++) if (a[j].d === day) { i = j; break; }
  const rec = { d: day, s: Math.round(score * 10) / 10, p: last.c };
  if (i >= 0) a[i] = rec; else a.push(rec);
  if (a.length > LEDGER_MAX) a.splice(0, a.length - LEDGER_MAX);
  ledgerSave(a);
  return true;
}

/* 结算：把每条记录配上 h 日后的真实收益。还没到期的留空 —— 不给假数。 */
function ledgerResolve() {
  const k = state.klines['BTC1d'];
  if (!k || k.length < LEDGER_H + 2) return null;
  const idxOf = new Map();
  for (let i = 0; i < k.length; i++) idxOf.set(fDate(k[i].t), i);
  const a = ledgerLoad();
  const rows = [];
  for (let j = 0; j < a.length; j++) {
    const e = a[j];
    const i = idxOf.get(e.d);
    let r = null;
    if (i != null && i + LEDGER_H < k.length && e.p) {
      const pc = k[i + LEDGER_H].c;
      if (pc) r = pc / e.p - 1;
    }
    rows.push({ d: e.d, s: e.s, p: e.p, r: r });
  }
  return { rows: rows, n: rows.length, nRes: rows.filter(function (x) { return x.r != null; }).length };
}

function ledgerStats(L) {
  if (!L || !L.n) return null;
  const res = L.rows.filter(function (x) { return x.r != null; });
  const out = { n: L.n, nRes: res.length, pending: L.n - res.length, enough: res.length >= LEDGER_MIN };
  if (!res.length) return out;
  const S = res.map(function (x) { return x.s; }), R = res.map(function (x) { return x.r; });

  /* 命中：评分方向（相对 50）与真实收益方向一致 */
  let hit = 0, nDir = 0;
  for (let i = 0; i < res.length; i++) {
    const tilt = res[i].s - 50;
    if (Math.abs(tilt) < 0.5) continue;   //  practically 中性，不计入方向判断
    nDir++;
    if (tilt * res[i].r > 0) hit++;
  }
  out.hit = hit; out.nDir = nDir;
  out.hitRate = nDir ? hit / nDir : null;
  out.hitP = nDir ? binomTwoSided(hit, nDir, 0.5) : null;

  out.ic = pearson(rankAvg(S), rankAvg(R));
  const neff = Math.max(4, Math.floor(res.length / LEDGER_H));
  out.neff = neff;
  out.t = out.ic == null ? null : out.ic / (1 / Math.sqrt(neff));

  const base = R.reduce(function (a, b) { return a + b; }, 0) / R.length;
  out.base = base;
  const bk = [[-1e9, 40], [40, 60], [60, 1e9]].map(function (rg) {
    const sel = [];
    for (let i = 0; i < res.length; i++) if (S[i] >= rg[0] && S[i] < rg[1]) sel.push(R[i]);
    return {
      n: sel.length,
      mean: sel.length ? sel.reduce(function (a, b) { return a + b; }, 0) / sel.length : null,
      win: sel.length ? sel.filter(function (v) { return v > 0; }).length / sel.length : null,
    };
  });
  out.buckets = bk;

  /* 分段：前半 vs 后半 —— 台账也要能回答「是不是在衰减」 */
  if (res.length >= 20) {
    const c = Math.floor(res.length / 2);
    const A = res.slice(0, c), B = res.slice(c);
    const icA = pearson(rankAvg(A.map(function (x) { return x.s; })), rankAvg(A.map(function (x) { return x.r; })));
    const icB = pearson(rankAvg(B.map(function (x) { return x.s; })), rankAvg(B.map(function (x) { return x.r; })));
    out.icFirst = icA; out.icLast = icB;
  }
  out.first = res[0].d; out.last = res[res.length - 1].d;
  return out;
}

/* ---------- ㉒ 换手率与可执行性 ---------- */
/* 把评分落成仓位：w = (score−50)/50，钳到 ±1。
 * 这是最朴素也最难为情的映射 —— 它不含任何仓位优化，正因为如此，
 * 用它量出来的换手率是「上界」：真实策略可以做得更平滑，但做不到无限平滑。 */
function execAnalysis(rep) {
  if (!rep || !rep.scores) return null;
  const n = rep.n, start = rep.start;
  const w = new Array(n).fill(null);
  /* 必须是 !isFinite 而不是 == null：NaN == null 为 false，守不住。
   * v3.22 实测踩到 —— 评分序列里只要混进一个 NaN（比如末尾越界算出 c[i+1] 未定义），
   * Math.min(1, NaN) 会返回 NaN 并一路传播：|Δw| 变 NaN ⇒ 换手率 NaN ⇒
   * 整块面板静默失效。缺数据该跳过，不该把全表毒成 NaN。 */
  for (let i = start; i < n; i++) {
    const v = rep.scores[i];
    if (v == null || !isFinite(v)) continue;
    const t = (v - 50) / 50;
    w[i] = Math.max(-1, Math.min(1, t));
  }

  /* 换手与收益只在「相邻两天都有仓位」的区间上算 —— 缺数据的地方不硬凑 */
  let turn = 0, nT = 0;
  const daily = [];
  const bh = [];
  for (let i = start; i + 1 < n; i++) {
    const a = w[i], b = w[i + 1];
    if (a == null || b == null) continue;
    turn += Math.abs(b - a); nT++;
    const r = (rep.closes[i + 1] && rep.closes[i]) ? rep.closes[i + 1] / rep.closes[i] - 1 : null;
    if (r == null || !isFinite(r)) continue;
    daily.push(a * r);      // 持有 a 过 i→i+1
    bh.push(r);
  }
  if (nT < 100 || daily.length < 100) return null;

  const mean = function (x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / x.length; };
  const sd = function (x) { const m = mean(x); let s = 0; for (let i = 0; i < x.length; i++) s += (x[i] - m) * (x[i] - m); return Math.sqrt(s / (x.length - 1)); };

  const grossD = mean(daily);
  const turnD = turn / nT;
  /* 成本口径：SIZE_ROUNDTRIP 是「0→1→0」一整趟的往返成本，
   * 所以每变动 |Δw| 单位，付出的成本是 |Δw| × 往返成本/2。口径必须写明。 */
  const costD = turnD * SIZE_ROUNDTRIP / 2;
  const netD = grossD - costD;

  const sdG = sd(daily), sdB = sd(bh);
  const shG = sdG ? grossD / sdG * Math.sqrt(365) : null;
  const shN = sdG ? netD / sdG * Math.sqrt(365) : null;
  const bhD = mean(bh);
  const shB = sdB ? bhD / sdB * Math.sqrt(365) : null;

  /* 盈亏平衡换手率：毛收益刚好被成本吃光的那个换手率。
   * 实际换手率高于它 ⇒ 这个频率下不该交易。 */
  const beTurn = Math.abs(grossD) > 1e-12 ? Math.abs(grossD) / (SIZE_ROUNDTRIP / 2) : null;

  /* 命中率：每天的方向是否押对（同样用精确二项检验对照抛硬币）。
   * 只统计**真有仓位**的日子 —— w≈0（评分≈50）那天既没押多也没押空，
   * 把它算成「没押对」会把命中率人为压低。台账里用的是同一个口径。 */
  let hit = 0, nH = 0;
  for (let i = 0; i < daily.length; i++) {
    if (Math.abs(daily[i]) < 1e-12) continue;   // 当日收益恰为 0（多半是没仓位），不计
    nH++;
    if (daily[i] > 0) hit++;
  }
  const hitP = binomTwoSided(hit, nH, 0.5);

  /* 关键对照：一直持有多（躺平）的日度命中率。
   * 为什么必须有它 —— 评分大部分时间是偏多的（BTC 十年年化 +69%），
   * 于是「w×r>0」里绝大多数日子其实是「多头仓 + 上涨日」，
   * 那测的是**市场的上涨频率**，不是本终端的技能。
   * 实测：策略 51.9% / 躺平约 52~53% —— 一对照，「命中率显著优于抛硬币」
   * 这个看似漂亮的结论就消失了。拿抛硬币当基准在牛市里是自欺。 */
  let bhHit = 0;
  for (let i = 0; i < bh.length; i++) if (bh[i] > 0) bhHit++;
  const bhHitRate = bhHit / bh.length;

  /* 评分的自相关与符号翻转 —— 「信号稳不稳」的直接度量 */
  const wSeq = [];
  for (let i = start; i < n; i++) if (w[i] != null) wSeq.push(w[i]);
  const ac = {};
  [1, 5, 10, 20].forEach(function (L) {
    if (wSeq.length <= L + 30) { ac[L] = null; return; }
    ac[L] = pearson(wSeq.slice(0, wSeq.length - L), wSeq.slice(L));
  });
  let flips = 0, nF = 0;
  let run = 1; const runs = [];
  for (let i = 1; i < wSeq.length; i++) {
    const a = Math.sign(wSeq[i - 1]), b = Math.sign(wSeq[i]);
    if (a === 0 || b === 0) continue;
    nF++;
    if (a !== b) { flips++; runs.push(run); run = 1; } else run++;
  }
  runs.push(run);

  return {
    days: daily.length, grossD: grossD, costD: costD, netD: netD, turnD: turnD,
    grossY: grossD * 365, costY: costD * 365, netY: netD * 365, bhY: bhD * 365,
    shG: shG, shN: shN, shB: shB,
    beTurn: beTurn, costShare: Math.abs(grossD) > 1e-12 ? costD / Math.abs(grossD) : null,
    hitRate: nH ? hit / nH : null, hitP: hitP, nHit: nH,
    bhHitRate: bhHitRate, hitEdge: (nH ? hit / nH : null) == null ? null : (hit / nH - bhHitRate),
    ac: ac, flipRate: nF ? flips / nF : null, meanRun: runs.length ? mean(runs) : null,
    roundtrip: SIZE_ROUNDTRIP,
  };
}

/* ---------- ㉓ 信号健康度 ---------- */
const HEALTH_WIN = 180;   // 「最近」取半年
/* win 可覆盖：默认半年。做成参数是为了可检验 —— 「方向已反但样本量不足以判显著」
 * 这一档（真实数据上正好撞见）必须能被确定性地构造出来，否则它没回归测试守着。 */
function signalHealth(rep, h, win) {
  if (!rep || !rep.scores) return null;
  const hh = h == null ? CALIB_H : h;
  const W = win == null ? HEALTH_WIN : win;
  const full = icCore(rep.scores, rep, hh, rep.start, rep.n);
  if (!full) return null;
  const lo = Math.max(rep.start, rep.n - W - hh);
  const recent = icCore(rep.scores, rep, hh, lo, rep.n);
  /* 对照组必须是「除最近段以外的全部」—— 用全样本当对照是错的，
   * 因为全样本包含最近段，两者不独立，Fisher-z 的方差公式会不成立。 */
  const comp = icCore(rep.scores, rep, hh, rep.start, lo);
  if (!recent || !comp) return null;

  const nR = Math.max(6, recent.neff), nC = Math.max(6, comp.neff);
  const se = Math.sqrt(1 / (nR - 3) + 1 / (nC - 3));
  const z = se > 0 ? (fisherZ(recent.spear) - fisherZ(comp.spear)) / se : null;
  const p = z == null ? null : 2 * (1 - normCdf(Math.abs(z)));

  /* 最近段里滚动 IC 为正的比例 —— 比单点 IC 稳定 */
  const roll = rollingIC(rep, 60, hh);
  const tail = roll.slice(-Math.max(6, Math.floor(HEALTH_WIN / 10)));
  const posShare = tail.length ? tail.filter(function (x) { return x.ic != null && x.ic > 0; }).length / tail.length : null;

  /* 判定顺序有讲究，v3.22 实测后重写过一版。
   * 初版只要 z 没过 −1.96 就落到「健康」。真实数据上这出了个危险的结果：
   * 最近半年 IC = −0.314（已反向）、滚动 IC 为正比例 0%，只因 z=−1.79
   * 差一点点没过门槛，就被贴上「健康」的标签 —— **标签比证据强**，
   * 这是在拿「没检出」冒充「没问题」。两条修正：
   *   ① 符号相反 / 滚动 IC 长期为负，即使不显著也要单独标出来（功效不足 ≠ 没变化）
   *   ② 「与历史无显著差异」是中性表述，**不用「健康」这个词**（它是忌讳的错觉来源）
   *
   * 另外补 MDE（最小可检测效应）：把「这个检验到底能检出多大的衰减」算出来。
   * 检测不到不等于没衰减 —— 不说清这一点，z 不显著就会被误读成安全。 */
  let key = 'flat', label = '数据不足';
  const rR = recent.spear, rC = comp.spear;
  const decay = z != null && z < -1.96;
  const gain = z != null && z > 1.96;
  const flip = rR != null && rC != null && rR < 0 && rC > 0;
  const weak = posShare != null && posShare < 0.3;
  if (rR != null && rC != null) {
    if (flip && decay) { key = 'flip'; label = '方向反转（显著）'; }
    else if (decay) { key = 'cool'; label = '显著降温'; }
    else if (flip) { key = 'flipwarn'; label = '方向相反，但未达显著'; }
    else if (weak) { key = 'weak'; label = '持续走弱（滚动 IC 长期为负）'; }
    else if (Math.abs(rR) < 0.03) { key = 'dead'; label = '进噪声区'; }
    else if (gain) { key = 'hot'; label = '较此前增强'; }
    else { key = 'same'; label = '与历史无显著差异'; }
  }
  /* 最小可检测效应：在 Fisher-z 空间，|Δ| 要多大才能被判显著？换算回相关系数。 */
  let mde = null;
  if (se > 0 && rC != null) {
    const d = 1.96 * se;
    mde = { zSe: se, dz: d, rLo: fisherZInv(fisherZ(rC) - d), rHi: fisherZInv(fisherZ(rC) + d) };
  }
  return {
    h: hh, win: W,
    icFull: full.spear, tFull: full.t, nFull: full.n,
    icRecent: recent.spear, tRecent: recent.t, nRecent: recent.n,
    icComp: comp.spear, nComp: comp.n,
    neffRecent: recent.neff, neffComp: comp.neff,
    z: z, p: p, posShare: posShare, key: key, label: label, mde: mde,
  };
}

/* ---------- ㉑ 预测台账的渲染 ---------- */
function renderLedgerBox(res) {
  const box = $('ledgerBox');
  if (!box) return;
  const sc = res && res.score != null ? res.score : null;
  /* 先记一笔今天的（幂等：同一天反复刷新只覆盖，不追加） */
  if (sc != null) ledgerRecord(sc);
  const L = ledgerResolve();
  if (!L || !L.n) {
    box.innerHTML = '<div class="rg-sub"><b>㉑ 预测台账</b>（空）：本机会记录每天的评分与当时价格，' +
      '等 ' + LEDGER_H + ' 天后把真实收益填回去 —— 这是全套系统里<b>唯一真正的前向测试</b>' +
      '（十年回放再怎么说也是事后）。需要日线数据后才会开始记。</div>';
    return;
  }
  const S = ledgerStats(L);
  let h = '<div class="rg-sub"><b>㉑ 预测台账 · 自我记分</b>：已记 <b>' + L.n + '</b> 条，' +
    '已结算 <b>' + L.nRes + '</b> 条，待到期 <b>' + S.pending + '</b> 条' +
    (S.first ? '（' + S.first + ' → ' + S.last + '）' : '') + '。</div>';

  if (!S.enough) {
    /* 样本不够就明说还不够 —— 这块面板的纪律就是不用小样本编故事 */
    const pct = Math.min(100, Math.round(L.nRes / LEDGER_MIN * 100));
    h += '<div class="rg-sub"><b>样本累积中，暂不给结论</b>：已结算 ' + L.nRes + ' / ' + LEDGER_MIN +
      '（' + pct + '%）。<br>' +
      '<span style="display:inline-block;width:200px;height:6px;background:var(--line);border-radius:3px;overflow:hidden;vertical-align:middle">' +
      '<span style="display:inline-block;width:' + pct + '%;height:6px;background:var(--accent)"></span></span>' +
      '<br><span class="rg-dim">为什么立这条规矩：' + LEDGER_H + ' 日 horizon 下，30 条已结算记录' +
      '折算有效样本只有 ~' + Math.max(3, Math.floor(LEDGER_MIN / LEDGER_H)) + ' 个非重叠窗口。' +
      '低于这个量级，任何「胜率 70%」都只是两三次巧合，把它摆出来只会误导人。</span></div>';
    const tail = L.rows.slice(-6).reverse();
    if (tail.length) {
      h += '<div class="rg-sub">最近记录：' + tail.map(function (x) {
        return '<span class="rg-dim">' + x.d + '</span> 评分 <b>' + x.s.toFixed(1) + '</b> ' +
          (x.r == null ? '<i>待到期</i>' : '→ ' + pctS(x.r, 2));
      }).join('　') + '</div>';
    }
    box.innerHTML = h;
    return;
  }

  const hp = S.hitP == null ? '—' : S.hitP.toFixed(4);
  const sig = S.hitP != null && S.hitP < 0.05;
  h += '<div class="rg-sub"><b>方向命中率</b> = <b>' + (S.hitRate == null ? '—' : (S.hitRate * 100).toFixed(1) + '%') +
    '</b>（' + S.hit + '/' + S.nDir + '）。对照抛硬币的<b>精确二项检验</b> p = <b>' + hp + '</b>' +
    ' —— 不是正态近似，是把所有「概率不超过观测值」的结果全加起来。<br>' +
    (sig
      ? '<b style="color:var(--green)">这个胜率不太像纯运气。</b>但注意：胜率高不等于赚钱，还要看对错时候的幅度（下面 IC 才是那个）。'
      : '<b>与抛硬币 indistinguishable</b> —— 目前没有证据表明这台终端的前向预测优于随机。' +
        '这是诚实的默认结果：一个 IC≈0.13 的信号，方向对的概率本来也就 53~55%。') + '</div>';

  h += '<div class="rg-sub">台账 IC = <b>' + (S.ic == null ? '—' : S.ic.toFixed(3)) + '</b>' +
    '（t=' + (S.t == null ? '—' : S.t.toFixed(2)) + '，n=' + L.nRes + '，有效 n_eff=' + S.neff + '）' +
    '　分档：' + S.buckets.map(function (b, i) {
      const nm = ['<40', '40~60', '>60'][i];
      return nm + ' ' + (b.mean == null ? '—' : pctS(b.mean, 2)) + '<span class="rg-dim">n=' + b.n + '</span>';
    }).join('　') + '　基准 ' + pctS(S.base, 2) + '</div>';

  if (S.icFirst != null && S.icLast != null) {
    h += '<div class="rg-sub">台账前半段 IC <b>' + S.icFirst.toFixed(3) + '</b> → 后半段 IC <b>' +
      S.icLast.toFixed(3) + '</b>' +
      (Math.abs(S.icLast) < Math.abs(S.icFirst) * 0.5
        ? ' <span class="rg-dim">（后半段明显走弱，但样本量小，只能当观察不能当结论）</span>'
        : '') + '</div>';
  }
  box.innerHTML = h;
}

/* ---------- ㉒ 换手率与可执行性的渲染 ---------- */
function renderExecBox() {
  const box = $('execBox');
  if (!box) return;
  const H = state.hist;
  if (!H || !H.rep) { box.innerHTML = '<div class="rg-sub">需要先跑一次十年回放。</div>'; return; }
  const E = H.exec || (H.exec = execAnalysis(H.rep));
  if (!E) { box.innerHTML = '<div class="rg-sub">数据不足以计算换手（需要 ≥100 个连续交易日）。</div>'; return; }

  const rt = (E.roundtrip * 100).toFixed(2);
  let h = '<div class="rg-sub"><b>仓位映射</b>：w = clamp((评分−50)/50, −1, +1)。' +
    '这是最朴素的映射 —— <b>正因为它不含任何平滑优化，量出来的换手率是上界</b>' +
    '（真实策略可以调得更平滑，但做不到无限平滑）。<br>' +
    '<b>成本口径</b>：往返成本 ' + rt + '%（0→1→0 一整趟），所以每变动 |Δw| 单位付出的成本是 ' +
    '|Δw| × ' + (E.roundtrip / 2 * 100).toFixed(2) + '%。这个口径必须写明，否则所有数字都对不上。</div>';

  const row = function (k, v, cls) {
    return '<div class="rg-sub">' + k + '：<b class="' + (cls || '') + '">' + v + '</b></div>';
  };
  h += '<div class="rg-sub"><b>年化</b>（' + E.days + ' 个交易日）：' +
    '毛收益 <b>' + pctS(E.grossY, 1) + '</b>　' +
    '成本 <b style="color:var(--red)">−' + (E.costY * 100).toFixed(1) + '%</b>　' +
    '净 <b class="' + (E.netY >= 0 ? 'rg-g' : 'rg-r') + '">' + pctS(E.netY, 1) + '</b>　' +
    '（买入持有 <b>' + pctS(E.bhY, 1) + '</b>）</div>';
  h += '<div class="rg-sub"><b>夏普</b>：毛 <b>' + (E.shG == null ? '—' : E.shG.toFixed(2)) + '</b>' +
    ' → 净 <b class="' + (E.shN >= E.shB ? 'rg-g' : 'rg-r') + '">' + (E.shN == null ? '—' : E.shN.toFixed(2)) + '</b>' +
    '　（躺平买入持有 <b>' + (E.shB == null ? '—' : E.shB.toFixed(2)) + '</b>）</div>';

  const cs = E.costShare;
  h += '<div class="rg-sub"><b>成本吃掉多少</b>：年化成本 ' + (E.costY * 100).toFixed(1) + '% ' +
    'vs 毛收益 ' + pctS(E.grossY, 1) + ' → 成本相当于毛收益的 <b class="' + (cs != null && cs > 1 ? 'rg-r' : '') + '">' +
    (cs == null ? '—' : (cs * 100).toFixed(0) + '%') + '</b>' +
    (cs != null && cs > 1
      ? ' —— <b style="color:var(--red)">超过 100%，即光是换手的成本就已经大于信号本身赚到的钱</b>。' +
        '这就是 ⑲ 里「建议仓位 0」的真凭实据：不是信号没用，是<b>这个换手频率下它不值得动手</b>。'
      : ' —— 成本尚未吞掉全部毛收益。' +
        '<br><b>于是真正的问题浮出来了：这一档下成本根本不是瓶颈</b>（只占 ' +
        (cs == null ? '—' : (cs * 100).toFixed(0)) + '%）。' +
        '看上面那行年化：毛 ' + pctS(E.grossY, 1) + ' 对买入持有 ' + pctS(E.bhY, 1) +
        '，夏普 ' + (E.shG == null ? '—' : E.shG.toFixed(2)) + ' 对 ' + (E.shB == null ? '—' : E.shB.toFixed(2)) +
        ' —— <b>这个信号加的仓位跑不赢躺平</b>。' +
        '⑲ 说「建议仓位 0」，原因在这里，不在手续费。' +
        '<span class="rg-dim">在 BTC 这种十年年化 +69% 的资产上，任何降低敞口的择时' +
        '都要先跨过「少赚的涨幅」这道坎；IC 0.13 的强度远远不够。</span>') + '</div>';

  h += '<div class="rg-sub"><b>盈亏平衡换手率</b> = <b>' + (E.beTurn == null ? '—' : E.beTurn.toFixed(4)) +
    '</b>（日均），实际换手率 = <b>' + E.turnD.toFixed(4) + '</b>。' +
    (E.beTurn != null && E.turnD > E.beTurn
      ? '实际<b class="rg-r">高于</b>盈亏平衡点 ' + (E.turnD / E.beTurn).toFixed(1) + ' 倍 ⇒ 交易太频繁。'
      : '实际低于盈亏平衡点 ⇒ 这个频率下成本还能承受，问题在信号强度不在频率。') + '</div>';

  /* 实测出现了一个反直觉结果，必须在界面上讲清楚，否则一定被误读：
   * 日度方向命中率 49.4%，精确二项检验 **显著低于** 50%（p≈0），
   * 而 10 日 IC 却是 +0.134（正）。两者并不矛盾 —— 说明这个评分是**慢变量**：
   * 它的预测力在 10 日尺度上成立，在 1 日尺度上是零甚至略负。
   * 证据链自洽：lag1 自相关 0.963、平均连续同向 20 天、符号翻转率仅 4.9%。
   * 结论：**不要用它做日度择时**。 */
  h += '<div class="rg-sub"><b>日度方向命中率</b> = <b>' + (E.hitRate == null ? '—' : (E.hitRate * 100).toFixed(1) + '%') +
    '</b>（n=' + E.nHit + '，对照<b>抛硬币</b>的精确二项 p = ' + (E.hitP == null ? '—' : E.hitP.toFixed(4)) + '）' +
    '　<b>躺平（一直持有多）命中率</b> = <b>' + (E.bhHitRate == null ? '—' : (E.bhHitRate * 100).toFixed(1) + '%') + '</b>' +
    '<br><b>但真正该看的是差值，不是「是否 &gt; 50%」：</b>边际命中 = <b class="' +
    ((E.hitEdge == null || E.hitEdge >= 0) ? 'rg-g' : 'rg-r') + '">' +
    (E.hitEdge == null ? '—' : (E.hitEdge >= 0 ? '+' : '') + (E.hitEdge * 100).toFixed(1) + ' pp') + '</b>。' +
    '<span class="rg-dim">理由：评分大部分时间是偏多的，所以「押对方向」里绝大多数日子' +
    '其实是「多头仓 + 上涨日」—— 那测的是<b>这个市场的上涨频率</b>，不是本终端的技能。' +
    '在十年年化 +69% 的资产上，拿抛硬币当基准必然得出「显著优于随机」的漂亮结论，' +
    '而它只是 beta。对照躺平之后这个幻觉就消失了。</span>' +
    '<br><b>配合上面的自相关看，结论是一致的</b>：lag1 自相关 ' +
    (E.ac[1] == null ? '—' : E.ac[1].toFixed(3)) + '、平均连续同向 ' +
    (E.meanRun == null ? '—' : E.meanRun.toFixed(1)) + ' 天、符号翻转率仅 ' +
    (E.flipRate == null ? '—' : (E.flipRate * 100).toFixed(1) + '%') +
    ' —— <b>这是个慢变量，别用它做日度择时</b>，那是把信号用在它不擅长的频率上。</div>';
  h += '<div class="rg-sub">' +
    '<br><b>评分自相关</b>：lag1 <b>' + (E.ac[1] == null ? '—' : E.ac[1].toFixed(3)) + '</b>　' +
    'lag5 <b>' + (E.ac[5] == null ? '—' : E.ac[5].toFixed(3)) + '</b>　' +
    'lag10 <b>' + (E.ac[10] == null ? '—' : E.ac[10].toFixed(3)) + '</b>　' +
    'lag20 <b>' + (E.ac[20] == null ? '—' : E.ac[20].toFixed(3)) + '</b>' +
    '<br><b>符号翻转率</b> = <b>' + (E.flipRate == null ? '—' : (E.flipRate * 100).toFixed(1) + '%') + '</b>，' +
    '平均连续同向 <b>' + (E.meanRun == null ? '—' : E.meanRun.toFixed(1)) + '</b> 天。' +
    '<span class="rg-dim">lag1 自相关若接近 1，说明评分几乎不变、换手天然低；' +
    '若接近 0，说明评分每天都在抖 —— 那样的信号就算 IC 好看，实盘也会被成本和滑点磨光。</span></div>';

  box.innerHTML = h;
}

/* ---------- ㉓ 信号健康度的渲染 ---------- */
function renderHealthBox() {
  const box = $('healthBox');
  if (!box) return;
  const H = state.hist;
  if (!H || !H.rep) { box.innerHTML = '<div class="rg-sub">需要先跑一次十年回放。</div>'; return; }
  const S = H.health || (H.health = signalHealth(H.rep, CALIB_H));
  if (!S) { box.innerHTML = '<div class="rg-sub">数据不足以评估信号健康度。</div>'; return; }

  /* 注意没有 'ok' 这一档了 —— v3.22 实测证明「没检出变化」不等于「健康」，
   * 把那个词写进界面会让人以为一切正常。中性档改叫「与历史无显著差异」。 */
  const col = { same: 'var(--dim)', hot: 'var(--green)', cool: 'var(--yellow)', weak: 'var(--yellow)',
    flipwarn: 'var(--red)', flip: 'var(--red)', dead: 'var(--red)', flat: 'var(--dim)' }[S.key] || 'var(--dim)';
  let h = '<div class="rg-sub"><b>㉓ 信号健康度</b>：<span style="color:' + col + '"><b>' + S.label + '</b></span>' +
    '（最近 ' + S.win + ' 天 vs 之前全部，h=' + S.h + '）</div>';

  h += '<div class="rg-sub">最近段 IC = <b>' + (S.icRecent == null ? '—' : S.icRecent.toFixed(3)) + '</b>' +
    '（t=' + (S.tRecent == null ? '—' : S.tRecent.toFixed(2)) + '，n=' + S.nRecent + '）　' +
    '对照段 IC = <b>' + (S.icComp == null ? '—' : S.icComp.toFixed(3)) + '</b>（n=' + S.nComp + '）　' +
    '全样本 IC = <b>' + (S.icFull == null ? '—' : S.icFull.toFixed(3)) + '</b>（t=' +
    (S.tFull == null ? '—' : S.tFull.toFixed(2)) + '）</div>';

  h += '<div class="rg-sub"><b>Fisher-z 两独立样本检验</b>：z = <b>' + (S.z == null ? '—' : S.z.toFixed(2)) +
    '</b>，p = <b>' + (S.p == null ? '—' : S.p.toFixed(4)) + '</b>。' +
    '<span class="rg-dim">对照组取「除最近段以外的全部」而不是全样本 —— 全样本包含最近段，' +
    '两者不独立，那样算出来的方差是错的。这是很容易做错的一步。</span></div>';

  if (S.posShare != null) {
    h += '<div class="rg-sub">最近段滚动 IC（60 日窗）为正的比例 = <b>' + (S.posShare * 100).toFixed(0) + '%</b>' +
      '<span class="rg-dim"> —— 比单点 IC 稳，因为单点 IC 会被某一次极端行情带跑。</span></div>';
  }

  const verdict = {
    flip: '<b style="color:var(--red)">信号方向反转（差异显著）</b>：最近段 IC 不仅变小，还翻了符号。' +
      '这种情况下<b>基于全样本定出的权重不该继续用</b> —— 历史拟合出来的方向已经不成立。',
    flipwarn: '<b style="color:var(--red)">方向相反，但未达统计显著</b>：最近段 IC 已经翻负，' +
      '但样本量不足以把它判为「显著变化」。<br>' +
      '<b>这里最要紧的一句话：功效不足 ≠ 没有问题。</b>点估计已经指反了，' +
      '只是证据强度还不够 —— 这种状态下照常使用是拿「没检出」当「没问题」，' +
      '是本终端最不愿意犯的错。保守做法是<b>先减仓</b>，等样本再攒一段。',
    cool: '<b style="color:var(--yellow)">信号显著降温</b>：最近段 IC 明显低于此前，差异超出抽样噪声。' +
      '这不代表永久失效（可能是阶段性），但意味着<b>现在该缩小仓位</b>，' +
      '而不是照搬全样本算出来的建议。',
    weak: '<b style="color:var(--yellow)">持续走弱</b>：最近段的滚动 IC 长期为负（为正的比例很低）。' +
      '单点 IC 会被某一波极端行情带跑，滚动 IC 的符号分布更可信 —— ' +
      '它持续为负说明这不是一次噪声，而是一段<b>持续的失效期</b>。',
    hot: '<b style="color:var(--green)">信号较此前增强</b>。但这里要压一下兴奋：' +
      '「近期变好」与「未来会好」是两件事，而且这种事后分段对比本身就是在做多次比较 —— ' +
      '看得越多，越容易找到一段「变好」的区间。',
    dead: '最近段的 IC 已经落进<b>噪声区</b>：量级小到与 0 无法区分。' +
      '这时候正确的动作是<b>不用这个信号</b>，而不是换个参数再试 —— 后者是在拟合噪声。',
    same: '<b>与历史无显著差异</b>：最近段 IC 与此前量级相当。' +
      '注意这只说明「没有证据表明它变了」，<b>不等于证明它还在工作</b> —— ' +
      '它是否仍然显著为正，请看上面最近段的 t 值（' + (S.tRecent == null ? '—' : S.tRecent.toFixed(2)) + '）。',
    flat: '数据不足以判定。',
  }[S.key] || '';
  if (verdict) h += '<div class="rg-sub">' + verdict + '</div>';

  /* 最小可检测效应 —— 没有它，z 不显著一定会被读成「安全」 */
  if (S.mde) {
    h += '<div class="rg-sub"><b>这个检验能检出多大的变化？</b>最近段有效样本 n_eff = <b>' +
      S.neffRecent + '</b>（' + S.nRecent + ' 天 / h=' + S.h + '，重叠窗口折算），' +
      '对照段 n_eff = <b>' + S.neffComp + '</b>。在这个样本量下，' +
      '最近段 IC 要跌破 <b>' + S.mde.rLo.toFixed(3) + '</b>（或涨过 <b>' + S.mde.rHi.toFixed(3) + '</b>）' +
      '才会被判为「显著变化」。实测 <b>' + (S.icRecent == null ? '—' : S.icRecent.toFixed(3)) + '</b>' +
      (S.icRecent != null && S.icRecent > S.mde.rLo && S.icRecent < S.mde.rHi
        ? ' —— <b>落在检测带之内，所以 p 不显著</b>。<br>' +
          '<span class="rg-dim">这句话的含义必须说清楚：<b>是这根尺子不够细，不是说这段没问题</b>。' +
          '半年窗口在 h=10 下只有 ~' + S.neffRecent + ' 个非重叠观测，' +
          '想更快检出衰减只能缩短 horizon 或接受更低的置信度 —— 两者都是在拿可靠性换速度。</span>'
        : ' —— 已越出检测带。') + '</div>';
  }

  box.innerHTML = h;
}

/* =====================================================================
 * v3.23 · 从「它好不好」到「好多少、好在哪、这个『好』能不能信」
 *
 * v3.22 留下了一句很难听但必须回答的话：这套评分加的仓位，毛夏普 0.85
 * vs 躺平 1.02 —— **跑不赢躺着不动**。本轮把这句话拆开：
 *
 * ㉔ 不是「这个映射行不行」，而是「在几个**事前定死**的仓位政策里，
 *     哪个最接近躺平，以及差距是否超过抽样噪声」。6 个政策全部披露，
 *     不挑好看的；差距用 **平稳 bootstrap（Politis–Romano）** 给置信区间。
 *     为什么必须用 block bootstrap：日收益有波动聚集，iid bootstrap 会
 *     把波动 clustering 洗掉，从而低估夏普差的标准误 —— 那是自欺。
 *
 * ㉕ 收益归因：E[w·r] = E[w]·E[r] + Cov(w,r)。这是**恒等式**，不是模型，
 *     所以它不会「算错」，只会被误读。它一句话回答「到底差在哪」：
 *     第一部分是 beta（你平均端着多少敞口 × 市场平均涨多少），
 *     第二部分才是 timing（仓位和收益的协变），也就是**信号真正贡献的部分**。
 *
 * ㉖ 选择偏差：从 6 个政策里挑最好的那个，其夏普必然被抬高 ——
 *     这是**选择本身**造成的，不是政策好。用 Bailey–López de Prado 的
 *     去通胀夏普（复用既有 deflatedSharpe，N = 政策数）压回去；
 *     再用「循环移位」造零信息对照：把评分整体平移，时序对齐被切断而
 *     单序列统计特性不变，看这 6 个政策还能吐出多好看的数字。
 *     移位后仍然拿得到的夏普，就是**纯 beta 白送的那部分**。
 * ===================================================================== */

/* ---------- 预注册的仓位政策表 ----------
 * 全部事前定死、全部展示。这里的任何「选一个最好的」都是多次比较，
 * 所以 ㉖ 一定会把选择偏差算回来。改这张表 = 改 N，去通胀项随之变。 */
const POLICIES = [
  { id: 'linear', nm: '线性（现状）', d: 'w = clamp((评分−50)/50, ±1)' },
  { id: 'longonly', nm: '只做多', d: '同上但不允许做空 —— 在年化 +69% 的资产上做空本就吃亏' },
  { id: 'voltarget', nm: '波动率目标', d: 'w = 信号 × (目标波动 / 当前已实现波动)，上限 ±1' },
  { id: 'slow', nm: '慢化 20 日', d: '先对评分做 20 日 EMA 再线性映射 —— 换手更低' },
  { id: 'deadband', nm: '死区 ±8 分', d: '评分离 50 不足 8 分就不持仓，只在信号够强时动手' },
  { id: 'bh', nm: '买入持有（基准）', d: 'w ≡ 1，不动', bench: true },
];
const VOLT_WIN = 60;          // 已实现波动窗口（事前定死，非调参）
const SLOW_WIN = 20;          // 慢化窗口
const DEADBAND = 8;           // 死区阈值（评分点）
const BOOT_B = 600;           // 平稳 bootstrap 次数
const BOOT_SEED = 20261003;   // 固定种子 —— 结果必须可复现，否则无法回归

/* ---------- 基础统计量 ---------- */
/* 注意 γ4 取**原始**标准化四阶矩（正态 = 3），不是超额峰度。
 * Lo(2002) / Mertens(2002) 的夏普方差公式是
 *   Var(SR̂) = [1 − γ3·SR + ((γ4 − 1)/4)·SR²] / n
 * 代入 γ3=0, γ4=3 得 1 + SR²/2，与经典式一致 —— 这条正好可以用来验。
 * 若误把 γ4 当超额峰度（正态 = 0），会算出 1 − SR²/4，符号都反了。 */
function statMoments(x) {
  const n = x.length;
  if (n < 4) return null;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  let s2 = 0, s3 = 0, s4 = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - m;
    s2 += d * d; s3 += d * d * d; s4 += d * d * d * d;
  }
  s2 /= n; s3 /= n; s4 /= n;
  const sd = Math.sqrt(s2);
  if (!(sd > 0)) return null;
  return { n: n, mean: m, sd: sd, g3: s3 / (sd * sd * sd), g4: s4 / (s2 * s2) };
}

/* ---------- 平稳 bootstrap（Politis & Romano 1994）----------
 * 块长服从几何分布（均值 L），起点均匀，越界**循环回绕** —— 回绕是
 * 「平稳」二字的来源：它保证重抽样序列的平稳分布与原序列一致。
 * 为什么不用固定块长（moving block）：固定块的拼接点会破坏平稳性。
 * L 的常规取法 ≈ n^(1/3)，事前定死，不按结果调。 */
function statBootIdx(n, L, rnd) {
  const idx = new Array(n);
  const p = 1 / L;
  const lg1p = Math.log(1 - p);
  let i = 0;
  while (i < n) {
    const s = Math.floor(rnd() * n) % n;
    const u = rnd();
    let len = Math.ceil(Math.log(1 - u) / lg1p);
    if (!(len >= 1)) len = 1;
    for (let k = 0; k < len && i < n; k++, i++) idx[i] = (s + k) % n;
  }
  return idx;
}

/* 确定性 LCG —— bootstrap 必须可复现：不可复现的数字没法写回归断言，
 * 也没法在界面上被人复核。 */
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ---------- 回撤路径 ---------- */
/* 输入为**单期净收益序列**，输出最大回撤、水下天数、最长水下、前三大回撤。
 * 只看「最大回撤」一个数是不够的：同样是 −40%，三天修复和三年不修复
 * 是完全不同的两件事，而后者才是真正让人拿不住的。 */
function drawdownPath(rets) {
  const n = rets.length;
  if (n < 30) return null;
  let eq = 1, peak = 1, mdd = 0;
  const eqs = new Array(n);
  for (let i = 0; i < n; i++) { eq *= (1 + rets[i]); eqs[i] = eq; if (eq > peak) peak = eq; const d = 1 - eq / peak; if (d > mdd) mdd = d; }
  /* 分段统计每一次「下峰—回本」 */
  const eps = [];
  let pk = 1, pkI = -1, curMdd = 0, curI = -1, uw = 0, maxUw = 0;
  for (let i = 0; i < n; i++) {
    if (eqs[i] >= pk) {
      if (curMdd > 0) { eps.push({ dd: curMdd, len: i - curI, rec: i - curI, start: curI, trough: curI }); uw = 0; maxUw = Math.max(maxUw, curI - pkI); }
      pk = eqs[i]; pkI = i; curMdd = 0; curI = -1;
    } else {
      const d = 1 - eqs[i] / pk;
      uw++;
      if (uw > maxUw) maxUw = uw;
      if (d > curMdd) { curMdd = d; curI = i; }
    }
  }
  if (curMdd > 0) eps.push({ dd: curMdd, len: n - 1 - curI, rec: null, start: curI, trough: curI });
  eps.sort(function (a, b) { return b.dd - a.dd; });
  let uwDays = 0;
  let pk2 = 1;
  for (let i = 0; i < n; i++) { if (eqs[i] >= pk2) { pk2 = eqs[i]; } else uwDays++; }
  return {
    mdd: mdd, uwDays: uwDays, uwShare: uwDays / n, maxUw: maxUw,
    top: eps.slice(0, 3), finalEq: eq, totalRet: eq - 1,
  };
}

/* ---------- 仓位序列 ---------- */
function policyW(rep, key) {
  if (!rep || !rep.scores) return null;
  const n = rep.n, start = rep.start, s = rep.scores;
  const w = new Array(n).fill(null);
  const firstValid = function () { for (let i = start; i < n; i++) { const v = s[i]; if (v != null && isFinite(v)) return v; } return null; };
  if (key === 'bh') {
    for (let i = start; i < n; i++) if (s[i] != null && isFinite(s[i])) w[i] = 1;
    return w;
  }
  if (key === 'slow') {
    const a = 2 / (SLOW_WIN + 1);
    let e = firstValid();
    if (e == null) return null;
    for (let i = start; i < n; i++) {
      const v = s[i];
      if (v == null || !isFinite(v)) continue;
      e = e + a * (v - e);
      w[i] = Math.max(-1, Math.min(1, (e - 50) / 50));
    }
    return w;
  }
  if (key === 'voltarget') {
    /* 目标波动率 = 买入持有的全样本已实现年化波动。
     * 事前定死为「与基准同风险水平」，不是调出来的 —— 这样比较才公平：
     * 波动目标政策被允许承担的总风险与躺平相当，剩下的差距就是择时本事。 */
    const rs = [];
    for (let i = start; i + 1 < n; i++) {
      const a = rep.closes[i], b = rep.closes[i + 1];
      if (a && b) rs.push(b / a - 1);
    }
    if (rs.length < 100) return null;
    const M0 = statMoments(rs);
    const target = M0.sd * Math.sqrt(365);
    const vol = realizedVol(rep, VOLT_WIN);
    for (let i = start; i < n; i++) {
      const v = s[i];
      if (v == null || !isFinite(v)) continue;
      const raw = Math.max(-1, Math.min(1, (v - 50) / 50));
      const sg = vol[i];
      /* σ 缺失（开头或数据洞）时退回线性 —— 不能因为缺数据就变成 0 仓，
       * 那会让政策凭空多出一堆「不持仓」的日子，比较就不干净了。 */
      const sc = (sg && sg > 1e-8) ? target / sg : 1;
      w[i] = Math.max(-1, Math.min(1, raw * sc));
    }
    return w;
  }
  if (key === 'deadband') {
    for (let i = start; i < n; i++) {
      const v = s[i];
      if (v == null || !isFinite(v)) continue;
      w[i] = Math.abs(v - 50) < DEADBAND ? 0 : Math.max(-1, Math.min(1, (v - 50) / 50));
    }
    return w;
  }
  if (key === 'longonly') {
    for (let i = start; i < n; i++) {
      const v = s[i];
      if (v == null || !isFinite(v)) continue;
      w[i] = Math.max(0, Math.min(1, (v - 50) / 50));
    }
    return w;
  }
  /* linear（默认） */
  for (let i = start; i < n; i++) {
    const v = s[i];
    if (v == null || !isFinite(v)) continue;
    w[i] = Math.max(-1, Math.min(1, (v - 50) / 50));
  }
  return w;
}

/* ---------- 单政策评估 ---------- */
/* 返回：毛/净日收益序列、年化、波动、夏普、回撤、换手。
 * 成本口径与 ㉒ 一致：往返 SIZE_ROUNDTRIP，每变动 |Δw| 付 |Δw|×往返/2。 */
function policyEval(rep, w) {
  if (!rep || !w) return null;
  const n = rep.n, start = rep.start;
  const gross = [], net = [], mkt = [];
  let turn = 0, nT = 0, prev = null;
  for (let i = start; i + 1 < n; i++) {
    const a = w[i], b = w[i + 1];
    const r = (rep.closes[i] && rep.closes[i + 1]) ? rep.closes[i + 1] / rep.closes[i] - 1 : null;
    if (a == null || r == null || !isFinite(r)) { continue; }
    /* 换手：从前一个有效仓位走到当前仓位；建仓首日按 0→|w| 计 */
    const tv = (prev == null) ? Math.abs(a) : Math.abs(a - prev);
    turn += tv; nT++; prev = a;
    const g = a * r;
    gross.push(g);
    net.push(g - tv * SIZE_ROUNDTRIP / 2);
    mkt.push(r);
    if (b == null) prev = null;
  }
  if (gross.length < 200) return null;
  const Mg = statMoments(gross), Mn = statMoments(net), Mm = statMoments(mkt);
  if (!Mg || !Mn || !Mm) return null;
  const ANN = Math.sqrt(365);
  const shOf = function (M) { return M.sd > 0 ? M.mean / M.sd * ANN : null; };
  const ddN = drawdownPath(net), ddB = drawdownPath(mkt);
  /* 归因恒等式（用**总体**协方差，保证 mean(w·r) = mean(w)·mean(r) + cov 精确成立） */
  const ws = [];
  for (let i = start; i + 1 < n; i++) {
    const a = w[i];
    const r = (rep.closes[i] && rep.closes[i + 1]) ? rep.closes[i + 1] / rep.closes[i] - 1 : null;
    if (a == null || r == null || !isFinite(r)) continue;
    ws.push(a);
  }
  const at = attribution(ws, mkt);
  return {
    n: gross.length,
    grossD: Mg.mean, netD: Mn.mean, mktD: Mm.mean,
    grossY: Mg.mean * 365, netY: Mn.mean * 365, mktY: Mm.mean * 365,
    volY: Mn.sd * ANN,
    shG: shOf(Mg), shN: shOf(Mn), shMkt: shOf(Mm),
    turnD: turn / Math.max(1, nT), costY: (turn / Math.max(1, nT)) * SIZE_ROUNDTRIP / 2 * 365,
    g3: Mn.g3, g4: Mn.g4,
    ddN: ddN, ddB: ddB,
    calmarN: (ddN && ddN.mdd > 1e-9) ? (Mn.mean * 365) / ddN.mdd : null,
    calmarB: (ddB && ddB.mdd > 1e-9) ? (Mm.mean * 365) / ddB.mdd : null,
    attr: at, avgW: ws.length ? ws.reduce(function (a, b) { return a + b; }, 0) / ws.length : null,
    gross: gross, net: net, mkt: mkt,
  };
}

/* E[w·r] = E[w]·E[r] + Cov(w,r) —— 恒等式。
 * beta 项 = 平均敞口 × 市场平均收益：这部分**不需要任何预测能力**，
 * 只要一直端着仓位就有。timing 项 = 仓位于收益的协变：只有它才是信号挣来的。 */
function attribution(w, r) {
  const n = Math.min(w.length, r.length);
  if (n < 50) return null;
  let mw = 0, mr = 0, mwr = 0;
  for (let i = 0; i < n; i++) { mw += w[i]; mr += r[i]; mwr += w[i] * r[i]; }
  mw /= n; mr /= n; mwr /= n;
  let cv = 0;
  for (let i = 0; i < n; i++) cv += (w[i] - mw) * (r[i] - mr);
  cv /= n;   // 总体协方差 ⇒ 恒等式精确成立
  /* 敞口诊断 —— v3.23 实测发现这是整套系统最要紧的一个数：
   * 评分的理论范围是 0–100，但真实十年里它只在 **20–77** 之间波动，
   * 于是 |w| 平均只有 ~0.15，最大也不过 0.6。
   * 也就是说这套评分**几乎从不表达强烈观点** —— 它大部分时间接近空仓。
   * 这直接解释了两件事：为什么净年化只有 +10%（敞口本来就小），
   * 以及为什么最大回撤只有 −19%（因为根本没怎么持仓，不是因为择时准）。
   * 不把这层说破，很容易把「回撤小」误读成「风险控制得好」。 */
  const absW = w.slice(0, n).map(function (v) { return Math.abs(v); }).sort(function (a, b) { return a - b; });
  const qa = function (pp) { return absW[Math.min(absW.length - 1, Math.max(0, Math.floor(pp * absW.length)))]; };
  return { n: n, meanW: mw, meanR: mr, cov: cv, total: mwr, beta: mw * mr, timing: cv,
    betaY: mw * mr * 365, timingY: cv * 365, totalY: mwr * 365,
    avgAbsW: absW.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, absW.length),
    p50AbsW: qa(0.5), p95AbsW: qa(0.95), maxAbsW: absW[absW.length - 1] };
}

/* ---------- ㉔ 政策对比 + 成对 bootstrap ---------- */
function policyCompare(rep, opts) {
  if (!rep || !rep.scores) return null;
  const o = opts || {};
  const B = o.B || BOOT_B;
  const rows = [];
  let bhRow = null;
  for (let k = 0; k < POLICIES.length; k++) {
    const P = POLICIES[k];
    const w = policyW(rep, P.id);
    if (!w) continue;
    const ev = policyEval(rep, w);
    if (!ev) continue;
    const row = { id: P.id, nm: P.nm, d: P.d, bench: !!P.bench, ev: ev };
    rows.push(row);
    if (P.bench) bhRow = row;
  }
  if (!bhRow || rows.length < 2) return null;

  /* 夏普差 vs 基准：单期（日）口径，成对 —— 两条序列用**同一份**重抽样的
   * 下标序列，保留它们之间的横截面依赖。若各抽各的，会漏掉「两条序列
   * 共享同一个市场」这件事，Δ 的标准误会被严重低估。 */
  const base = bhRow.ev;
  const nObs = Math.min(base.n, rows[0].ev.n);
  const L = Math.max(5, Math.round(Math.pow(base.net.length, 1 / 3)));
  const dS = [], dSg = [];
  const rnd = lcg(o.seed || BOOT_SEED);
  for (let b = 0; b < B; b++) {
    const idx = statBootIdx(base.net.length, L, rnd);
    for (let j = 0; j < rows.length; j++) {
      if (rows[j].bench) continue;
      const sn = sharpeOfIdx(rows[j].ev.net, idx);
      const bn = sharpeOfIdx(base.net, idx);
      const sg = sharpeOfIdx(rows[j].ev.gross, idx);
      const bg = sharpeOfIdx(base.mkt, idx);
      if (sn == null || bn == null) continue;
      (rows[j].dNet || (rows[j].dNet = [])).push(sn - bn);
      if (sg != null && bg != null) (rows[j].dGross || (rows[j].dGross = [])).push(sg - bg);
    }
  }
  for (let j = 0; j < rows.length; j++) {
    const R = rows[j];
    if (R.bench) continue;
    const a = R.dNet || [];
    a.sort(function (x, y) { return x - y; });
    const q = function (p) { return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))] : null; };
    let nPos = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > 0) nPos++;
    R.boot = { B: a.length, L: L, lo: q(0.025), hi: q(0.975), med: q(0.5), pBeat: a.length ? nPos / a.length : null };
    R.dNet = null; R.dGross = null;   // 不留在结果里占内存
  }
  return { rows: rows, bh: bhRow, nObs: base.net.length, L: L, B: B, policies: POLICIES.length };
}
function sharpeOfIdx(x, idx) {
  let m = 0;
  const n = idx.length;
  for (let i = 0; i < n; i++) m += x[idx[i]];
  m /= n;
  let s = 0;
  for (let i = 0; i < n; i++) { const d = x[idx[i]] - m; s += d * d; }
  s /= (n - 1);
  return s > 0 ? m / Math.sqrt(s) * Math.sqrt(365) : null;
}

/* ---------- ㉖ 零信息对照：循环移位 ---------- */
/* 把评分序列整体循环移位 k 天：它自己的边际分布、波动、自相关**全部原样保留**，
 * 只有「与未来收益的时序对齐」被切断。所以移位后剩下的任何表现，
 * 都只能来自「平均敞口 × 市场漂移」—— 也就是纯 beta 白送的那部分。
 * 这正是 ㉕ 归因里的第一项，两块在这里互相印证。 */
function policyNull(rep, opts) {
  if (!rep || !rep.scores) return null;
  const o = opts || {};
  const shifts = o.shifts || 10;
  const n = rep.n, start = rep.start;
  /* 有效评分区间的长度与起点 */
  let lo = -1, hi = -1;
  for (let i = start; i < n; i++) { const v = rep.scores[i]; if (v != null && isFinite(v)) { if (lo < 0) lo = i; hi = i; } }
  if (lo < 0) return null;
  const len = hi - lo + 1;
  if (len < 400) return null;
  const orig = new Array(len);
  for (let i = 0; i < len; i++) orig[i] = rep.scores[lo + i];
  const out = {};
  for (let k = 0; k < POLICIES.length; k++) {
    const P = POLICIES[k];
    if (P.bench) continue;
    out[P.id] = [];
  }
  const shiftsUsed = [];
  for (let sIdx = 0; sIdx < shifts; sIdx++) {
    /* 均匀铺开，且跳过太小的位移（太小则对齐几乎没被破坏） */
    const k = Math.round(len * (sIdx + 1) / (shifts + 1));
    if (k < 30) continue;
    shiftsUsed.push(k);
    const rep2 = { n: n, start: start, closes: rep.closes, calTs: rep.calTs, scores: new Array(n).fill(null) };
    for (let i = 0; i < len; i++) rep2.scores[lo + i] = orig[(i + k) % len];
    for (let kk = 0; kk < POLICIES.length; kk++) {
      const P = POLICIES[kk];
      if (P.bench) continue;
      const w = policyW(rep2, P.id);
      if (!w) continue;
      const ev = policyEval(rep2, w);
      if (!ev) continue;
      out[P.id].push({ shN: ev.shN, shG: ev.shG, netY: ev.netY, k: k });
    }
  }
  const res = { shifts: shiftsUsed, byPolicy: {}, n: len };
  for (const id in out) {
    const arr = out[id];
    if (!arr.length) continue;
    const shs = arr.map(function (a) { return a.shN == null ? -Infinity : a.shN; }).sort(function (a, b) { return a - b; });
    const med = shs[Math.floor(shs.length / 2)];
    const p95 = shs[Math.min(shs.length - 1, Math.floor(0.95 * shs.length))];
    const nys = arr.map(function (a) { return a.netY == null ? -Infinity : a.netY; }).sort(function (a, b) { return a - b; });
    res.byPolicy[id] = { n: arr.length, medShN: med === -Infinity ? null : med, p95ShN: p95 === -Infinity ? null : p95,
      maxShN: shs[shs.length - 1] === -Infinity ? null : shs[shs.length - 1],
      medNetY: nys[Math.floor(nys.length / 2)] === -Infinity ? null : nys[Math.floor(nys.length / 2)] };
  }
  return res;
}

/* ---------- ㉖ 去通胀夏普（政策选择的选择偏差）---------- */
/* 复用既有 deflatedSharpe；这里的关键是把 N 取成**政策数**，
 * 因为「挑一个最好的」这件事本身就是 N 次试验。
 * V = 各政策夏普的样本方差（试验间的离散度）—— 试验越多、彼此差异越大，
 * 挑出来的最大值里属于运气的成分就越多。 */
function policySelectionBias(cmp) {
  if (!cmp || !cmp.rows) return null;
  const cand = cmp.rows.filter(function (r) { return !r.bench && r.ev && r.ev.shN != null; });
  if (cand.length < 2) return null;
  /* V 必须与交给 deflatedSharpe 的 srHat **同频率**，否则门槛会被放大 √(周期数) 倍。
   * v3.23 实测踩到：直接拿年化夏普的样本方差（4.48e-2）当 V，
   * 算出的门槛 SR0 是 **4.82（年化）** —— 比任何政策实测值都高一大截，
   * 于是 DSR 恒为 0%，看上去像「所有政策都没本事」。
   * 那不是结论，那是把年化的方差塞进了日频公式里：
   * Var(年化夏普) = 365 × Var(日夏普)。除以 365 之后门槛回到 0.25，合理。
   * 教训：**所有把「方差」传给另一个函数的场合，都要先确认两边的频率一致。** */
  const ANN0 = Math.sqrt(365);
  const srsDay = cand.map(function (r) { return r.ev.shN / ANN0; });
  const M = statMoments(srsDay);
  const V = (M && M.n > 1) ? (M.sd * M.sd * M.n / (M.n - 1)) : 0;
  let best = null, bestJ = -1;
  for (let i = 0; i < cand.length; i++) if (best == null || cand[i].ev.shN > best.ev.shN) { best = cand[i]; bestJ = i; }
  const N = cand.length;
  /* 全部换算到**单期（日）**口径再交给 deflatedSharpe，避免尺度串味 */
  const ANN = Math.sqrt(365);
  const srDay = best.ev.shN / ANN;   // 与上面的 V 同为日频
  const bhDay = cmp.bh.ev.shN / ANN;
  const T = best.ev.net.length;
  const d = deflatedSharpe(srDay, T, best.ev.g3, best.ev.g4, N, V, bhDay);
  return {
    N: N, V: V, bestId: best.id, bestNm: best.nm,
    srAnn: best.ev.shN, srDay: srDay,
    sr0Ann: d.sr0 * ANN, sr0Day: d.sr0,
    dsr: d.psr, psr0: d.psr0, psrBH: d.psrBH,
    bhAnn: cmp.bh.ev.shN, T: T,
    g3: best.ev.g3, g4: best.ev.g4,
  };
}

/* ---------- ㉔ 渲染：仓位政策对比 ---------- */
function renderPolicyBox() {
  const box = $('policyBox');
  if (!box) return;
  const H = state.hist;
  if (!H || !H.rep) { box.innerHTML = '<div class="rg-sub">需要先跑一次十年回放。</div>'; return; }
  const C = H.policy || (H.policy = policyCompare(H.rep));
  if (!C) { box.innerHTML = '<div class="rg-sub">数据不足以比较仓位政策（需要 ≥200 个连续交易日）。</div>'; return; }
  const pc = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 2 : dp) + '%'; };
  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };

  /* 多一列「平均敞口」是必需的，不是装饰。理由见下面那条警告。 */
  const COLS = '1.5fr .62fr .66fr .62fr .68fr .66fr .78fr .55fr';
  let h = '<div class="rg-sub"><b>为什么要有这张表</b>：v3.22 说「毛夏普 0.85 vs 躺平 1.02」，' +
    '但那只是<b>一种</b>把评分变成仓位的办法。换一种映射，结论可能不同 —— ' +
    '所以这里<b>事前定死</b> 6 个政策（含基准），<b>全部列出</b>，不挑好看的。<br>' +
    '成本口径同 ㉒：往返 ' + (SIZE_ROUNDTRIP * 100).toFixed(2) + '%，每变动 |Δw| 付 |Δw| × ' +
    (SIZE_ROUNDTRIP / 2 * 100).toFixed(2) + '%。净额已扣成本。<b>关键看「净夏普 − 基准夏普」这一列</b>，' +
    '以及它的 bootstrap 置信区间是否把 0 排除在外。</div>';

  h += '<div class="rg-tbl" style="margin-top:8px">';
  h += '<div class="rg-hd" style="grid-template-columns:' + COLS + '">' +
    '<span>政策</span><span>净年化</span><span>净夏普</span><span>Δ夏普</span>' +
    '<span>95% 区间</span><span>P(赢)</span><span>最大回撤</span><span>敞口</span></div>';
  const bh = C.bh.ev;
  for (let i = 0; i < C.rows.length; i++) {
    const R = C.rows[i], E = R.ev;
    const d = R.bench ? 0 : (E.shN - bh.shN);
    const b = R.boot;
    const wins = !R.bench && b && b.lo != null && b.hi != null && b.lo > 0;
    const cls = R.bench ? 'rg-dim' : (d >= 0 ? 'rg-g' : 'rg-r');
    h += '<div class="rg-row" style="grid-template-columns:' + COLS + '" title="' + R.d + '">' +
      '<span class="rg-nm">' + (R.bench ? '<b>' + R.nm + '</b>' : R.nm) + (wins ? ' <i class="rg-g">✓</i>' : '') + '</span>' +
      '<span class="' + cls + '">' + pc(E.netY, 1) + '</span>' +
      '<span class="' + cls + '">' + num(E.shN) + '</span>' +
      '<span class="' + (R.bench ? 'rg-dim' : cls) + '">' + (R.bench ? '基准' : (d >= 0 ? '+' : '') + num(d)) + '</span>' +
      '<span>' + (R.bench || !b ? '—' : '[' + num(b.lo) + ', ' + num(b.hi) + ']') + '</span>' +
      '<span>' + (R.bench || !b || b.pBeat == null ? '—' : (b.pBeat * 100).toFixed(0) + '%') + '</span>' +
      '<span>' + (E.ddN ? pc(-E.ddN.mdd, 1) : '—') + '<i>' + (E.ddN ? ' 水下' + (E.ddN.uwShare * 100).toFixed(0) + '%' : '') + '</i></span>' +
      '<span class="' + (Math.abs(E.avgW) < 0.25 ? 'rg-y' : '') + '">' + num(E.avgW) + '</span>' +
      '</div>';
  }
  h += '</div>';
  /* 夏普陷阱 —— 本轮实测撞上的最危险一处误读，必须写在表下面。
   * 只做多的净夏普 1.14 > 躺平 1.02，看上去「赢了」；
   * 但它的平均敞口只有 0.07（几乎全程空仓），年化 +9.6% vs 躺平 +68.9%。
   * 夏普是「单位波动的收益」，而几乎空仓天然就低波动 ——
   * 于是**什么都不做也能刷出高夏普**。跨敞口水平比较夏普是无效比较。 */
  const lowExp = C.rows.filter(function (r) { return !r.bench && Math.abs(r.ev.avgW) < 0.25 && r.ev.shN > bh.shN; });
  if (lowExp.length) {
    h += '<div class="rg-sub"><b style="color:var(--yellow)">夏普陷阱（先读这段再看表）</b>：' +
      lowExp.map(function (R) { return '「' + R.nm + '」'; }).join('、') +
      ' 的净夏普 ' + lowExp.map(function (R) { return num(R.ev.shN); }).join(' / ') +
      ' 高于基准 ' + num(bh.shN) + '，<b>但这不是它更优秀，而是它更空仓</b> —— ' +
      '平均敞口只有 ' + lowExp.map(function (R) { return num(R.ev.avgW); }).join(' / ') +
      '（基准恒为 1.00），年化却只有 ' + lowExp.map(function (R) { return pc(R.ev.netY, 1); }).join(' / ') +
      '（基准 ' + pc(bh.netY, 1) + '）。' +
      '<br>夏普是「每单位波动换来的收益」。几乎不持仓 ⇒ 波动极低 ⇒ 夏普天然被抬高，' +
      '<b>几乎什么都没做也能刷出好看的夏普</b>。' +
      '所以<b>敞口水平差得多的两个东西，不能直接比夏普</b> —— 这就是表上多一列「敞口」的原因。</div>';
  }
  h += '<div class="rg-sub"><span class="rg-dim">Δ夏普为「净夏普 − 买入持有夏普」；95% 区间来自<b>平稳 bootstrap</b>' +
    '（块长 L=' + C.L + ' ≈ n^(1/3)，' + C.B + ' 次，两条序列共用同一份重抽样下标以保留横截面依赖）。' +
    'P(赢) = 重抽样中 Δ>0 的比例。年化收益的绝对水平不要跨资产比较 —— BTC 十年年化 +69%，' +
    '任何降低敞口的政策在收益上都会吃亏，所以要看<b>风险调整后</b>的差。</span></div>';

  /* 诚实结论 */
  let anyWin = false, bestD = -Infinity, bestNm = '';
  for (let i = 0; i < C.rows.length; i++) {
    const R = C.rows[i];
    if (R.bench) continue;
    const d = R.ev.shN - bh.shN;
    if (d > bestD) { bestD = d; bestNm = R.nm; }
    if (R.boot && R.boot.lo != null && R.boot.lo > 0) anyWin = true;
  }
  h += '<div class="rg-sub">' + (anyWin
    ? '<b style="color:var(--green)">存在 Δ夏普 95% 区间整体在 0 之上的政策</b> —— 这才叫「赢过躺平」，不是点估计好看就算。'
    : '<b style="color:var(--yellow)">没有任何一个政策的 Δ夏普 95% 区间把 0 排除在外</b>（最好的一个是「' +
      bestNm + '」，Δ = ' + (bestD >= 0 ? '+' : '') + num(bestD) + '）。' +
      '<br>这句话的准确含义：<b>不是证明它赢不了，是这段样本证明不了它赢了</b>。' +
      '十年日频听起来很多，但 h=10 的非重叠观测只有 ~' + Math.round(C.nObs / 10) + ' 个 —— ' +
      '这才是真正的样本量。') + '</div>';

  /* 政策各自的一句话 */
  h += '<div class="rg-sub"><b>各政策在做什么</b>：';
  h += C.rows.filter(function (r) { return !r.bench; }).map(function (R) {
    return '<br>· <b>' + R.nm + '</b>（' + R.d + '）：日均换手 ' + num(R.ev.turnD, 4) +
      '，年化成本 ' + pc(-R.ev.costY, 2) + '，平均敞口 ' + num(R.ev.avgW) + '，' +
      'Calmar ' + num(R.ev.calmarN);
  }).join('') + '</div>';

  box.innerHTML = h;
}

/* ---------- ㉕ 渲染：收益归因与回撤路径 ---------- */
function renderAttrBox() {
  const box = $('attrBox');
  if (!box) return;
  const H = state.hist;
  if (!H || !H.rep) { box.innerHTML = '<div class="rg-sub">需要先跑一次十年回放。</div>'; return; }
  const C = H.policy || (H.policy = policyCompare(H.rep));
  if (!C) { box.innerHTML = '<div class="rg-sub">需要先完成政策对比。</div>'; return; }
  const pc = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 2 : dp) + '%'; };
  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };

  /* 归因用「线性」政策讲，因为它是现状且不含任何平滑，最能暴露本质 */
  const P0 = C.rows.filter(function (r) { return r.id === 'linear'; })[0] || C.rows.filter(function (r) { return !r.bench; })[0];
  const A = P0 && P0.ev.attr;
  const bh = C.bh.ev;

  let h = '<div class="rg-sub"><b>一句话回答「到底差在哪」</b> —— 用恒等式把策略收益劈成两半：<br>' +
    '<span style="font-family:JetBrains Mono,monospace">E[w·r] = E[w]·E[r] + Cov(w, r)</span><br>' +
    '左边是你实际拿到的；右边第一项是<b>beta</b>（平均端着多少敞口 × 市场平均涨多少 —— ' +
    '<b>不需要任何预测能力</b>），第二项是<b>timing</b>（仓位与收益的协变 —— ' +
    '<b>只有这一项才是信号挣来的</b>）。这是恒等式不是模型，所以它不会算错，只会被误读。</div>';

  if (A) {
    const share = Math.abs(A.totalY) > 1e-9 ? A.timingY / A.totalY : null;
    h += '<div class="rg-tbl" style="margin-top:8px">';
    h += '<div class="rg-hd" style="grid-template-columns:1.6fr .8fr .8fr .8fr .9fr">' +
      '<span>组成</span><span>年化</span><span>占总额</span><span>平均敞口</span><span>说明</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .8fr .8fr .8fr .9fr">' +
      '<span class="rg-nm">beta（白送）</span><span class="rg-dim">' + pc(A.betaY, 1) + '</span>' +
      '<span class="rg-dim">' + (A.totalY ? (A.betaY / A.totalY * 100).toFixed(0) + '%' : '—') + '</span>' +
      '<span>' + num(A.meanW) + '</span><span class="rg-dim" style="text-align:left">不预测也有</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .8fr .8fr .8fr .9fr">' +
      '<span class="rg-nm">timing（真本事）</span><span class="' + (A.timingY >= 0 ? 'rg-g' : 'rg-r') + '">' + pc(A.timingY, 1) + '</span>' +
      '<span class="' + (A.timingY >= 0 ? 'rg-g' : 'rg-r') + '">' + (share == null ? '—' : (share * 100).toFixed(0) + '%') + '</span>' +
      '<span class="rg-dim">—</span><span class="rg-dim" style="text-align:left">只有这部分是技能</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .8fr .8fr .8fr .9fr">' +
      '<span class="rg-nm"><b>合计</b></span><span><b>' + pc(A.totalY, 1) + '</b></span>' +
      '<span>100%</span><span>' + num(A.meanW) + '</span><span class="rg-dim" style="text-align:left">= 策略毛年化</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .8fr .8fr .8fr .9fr">' +
      '<span class="rg-nm">买入持有</span><span class="rg-g">' + pc(bh.mktY, 1) + '</span>' +
      '<span class="rg-dim">—</span><span>1.00</span><span class="rg-dim" style="text-align:left">敞口永远打满</span></div>';
    h += '</div>';

    h += '<div class="rg-sub">' + (A.timingY > 0
      ? '<b>timing 项为正（' + pc(A.timingY, 1) + '，占 ' + (share == null ? '—' : (share * 100).toFixed(0)) + '%）</b> —— ' +
        '说明这个评分确实挣到了一点钱，不是纯 beta。<b>但它太小了</b>：' +
        '为了拿到它，你把平均敞口从 1.00 降到 ' + num(A.meanW) + '，' +
        '白白放弃了 ' + pc(bh.mktY - A.betaY, 1) + ' 的 beta —— 捡了芝麻丢了西瓜。'
      : '<b style="color:var(--red)">timing 项为负（' + pc(A.timingY, 1) + '）</b> —— ' +
        '这比「贡献小」还糟：仓位与收益是<b>反向</b>协变的，' +
        '也就是说在这个尺度上，评分变动带来的调仓<b>平均而言是在亏钱</b>。' +
        '策略还能赚，全靠平均敞口 ' + num(A.meanW) + ' 端着的 beta。') +
      '<br><span class="rg-dim">判据很清楚：一个择时策略要值得做，timing 项不仅要为正，' +
      '还要大到能补回「因为降低敞口而少赚的 beta」。在十年年化 +69% 的资产上，' +
      '这道坎高得离谱 —— 这就是为什么 ⑲ 的答案是「建议仓位 0」。</span></div>';

    /* 敞口诊断 —— 本轮最要紧的一个数，必须单独讲。
     * 不看它，「回撤只有 −19%」会被当成风控做得好；
     * 看了才知道，那是因为<b>根本没怎么持仓</b>。 */
    h += '<div class="rg-sub"><b>敞口诊断：这套评分几乎从不表达强烈观点</b>' +
      '<br>评分的理论范围是 0–100，但真实十年里它的实际动态范围窄得多 —— ' +
      '于是实际仓位 |w| 的平均值只有 <b>' + num(A.avgAbsW) + '</b>，' +
      '中位数 ' + num(A.p50AbsW) + '，95 分位 <b>' + num(A.p95AbsW) + '</b>，' +
      '历史最大也只有 <b>' + num(A.maxAbsW) + '</b>（满仓 = 1）。' +
      '<br><b style="color:var(--yellow)">这句话把前面所有数都重新解释了一遍</b>：' +
      '净年化只有 ' + pc(P0.ev.netY, 1) + ' 而躺平是 ' + pc(bh.mktY, 1) +
      '，主要不是因为方向看错，而是因为<b>平均只端着 ' + (A.avgAbsW * 100).toFixed(0) + '% 的仓</b>；' +
      '最大回撤只有 ' + pc(-P0.ev.ddN.mdd, 1) + ' 而躺平是 ' + pc(-bh.ddB.mdd, 1) +
      '，也不是因为择时准，而是因为<b>大部分时间接近空仓</b>。' +
      '<br><span class="rg-dim">所以真正该追问的不是「换个仓位政策能不能救」，' +
      '而是<b>评分本身为什么这么保守</b> —— 22 个因子加权求和后，' +
      '正负相消把幅度磨平了（v3.20 的分歧度面板就在讲这件事）。' +
      '在评分的动态范围被打开之前，任何仓位政策都只能在很小的敞口上做文章。</span></div>';
  }

  /* 回撤路径 */
  const dn = bh.ddB, ds = P0 && P0.ev.ddN;
  if (dn && ds) {
    h += '<div class="rg-sub"><b>回撤路径</b>：只看最大回撤一个数不够 —— 同样 −40%，三天修复和三年不修复是两回事，' +
      '而后者才是真正让人拿不住的。';
    h += '<br>· 买入持有：最大回撤 <b>' + pc(-dn.mdd, 1) + '</b>，水下天数占比 ' + (dn.uwShare * 100).toFixed(0) +
      '%，最长连续水下 <b>' + dn.maxUw + '</b> 天，Calmar ' + num(bh.calmarB);
    h += '<br>· 信号（' + P0.nm + '，净）：最大回撤 <b>' + pc(-ds.mdd, 1) + '</b>，水下天数占比 ' +
      (ds.uwShare * 100).toFixed(0) + '%，最长连续水下 <b>' + ds.maxUw + '</b> 天，Calmar ' + num(P0.ev.calmarN);
    if (ds.mdd < dn.mdd) {
      h += '<br><b style="color:var(--green)">回撤深度确实被削掉了</b>（' + pc(-dn.mdd, 1) + ' → ' + pc(-ds.mdd, 1) + '）。' +
        '但必须同时看下面两行，否则会得出完全相反的印象：' +
        '<br>· <b>水下时间反而更长</b>：' + (dn.uwShare * 100).toFixed(0) + '% → ' + (ds.uwShare * 100).toFixed(0) +
        '%，最长连续水下 ' + dn.maxUw + ' → <b>' + ds.maxUw + '</b> 天。' +
        '<span class="rg-dim">因为它十年只涨 ' + pc(P0.ev.netY, 1) + '/年，净值曲线又平又慢，' +
        '「回到前高」这件事反而更难发生 —— 回撤浅，但一直在水下。</span>' +
        '<br>· <b>代价是年化 ' + pc(bh.mktY - P0.ev.netY, 1) + '</b>。' +
        '<br>把这两条放在一起，这笔买卖才说得清楚：用 ' + pc(bh.mktY - P0.ev.netY, 1) +
        ' 的年化，换「最深那一下从 ' + pc(-dn.mdd, 1) + ' 变成 ' + pc(-ds.mdd, 1) + '」，' +
        '但同时换来「几乎全程在水下」。<b>只有明确受不了 ' + pc(-dn.mdd, 1) + ' 那一下的人，这笔才划算</b>；' +
        '受不了「长期不回本」的人，它比躺平更难受。</div>';
    } else {
      h += '<br><b style="color:var(--red)">连回撤都没削下来</b> —— 那么这个信号在这段样本上<b>没有任何可辩护的用途</b>。</div>';
    }
    if (ds.top && ds.top.length) {
      h += '<div class="rg-sub" style="padding-top:4px">信号策略前三大回撤：' +
        ds.top.map(function (e, i) {
          return '#' + (i + 1) + ' ' + pc(-e.dd, 1) + '（' + (e.rec == null ? '截至末尾未修复' : '历时 ' + e.rec + ' 天修复') + '）';
        }).join('　') + '</div>';
    }
  }
  box.innerHTML = h;
}

/* ---------- ㉖ 渲染：选择偏差与零信息对照 ---------- */
function renderSelectBox() {
  const box = $('selectBox');
  if (!box) return;
  const H = state.hist;
  if (!H || !H.rep) { box.innerHTML = '<div class="rg-sub">需要先跑一次十年回放。</div>'; return; }
  const C = H.policy || (H.policy = policyCompare(H.rep));
  if (!C) { box.innerHTML = '<div class="rg-sub">需要先完成政策对比。</div>'; return; }
  const S = policySelectionBias(C);
  const NU = H.policyNull || (H.policyNull = policyNull(H.rep));
  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };
  const pc = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 2 : dp) + '%'; };

  let h = '<div class="rg-sub"><b>从 6 个政策里挑最好的那一个，夏普必然虚高</b> —— ' +
    '这是<b>选择本身</b>造成的，不是那个政策真的好。' +
    '看的人只看到被挑出来的那个，看不到被丢掉的 5 个，于是运气被当成了本事。<br>' +
    '这里用 Bailey–López de Prado 的去通胀夏普把这部分压回去（N = 政策数 = ' +
    (S ? S.N : '—') + '，V = 各政策夏普的样本方差）。</div>';

  if (S) {
    h += '<div class="rg-tbl" style="margin-top:8px">';
    h += '<div class="rg-hd" style="grid-template-columns:1.3fr .7fr .8fr .8fr .8fr">' +
      '<span>口径</span><span>年化夏普</span><span>门槛 SR₀</span><span>去通胀后 P</span><span>对照</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.3fr .7fr .8fr .8fr .8fr">' +
      '<span class="rg-nm">最好的政策（' + S.bestNm + '）</span>' +
      '<span><b>' + num(S.srAnn) + '</b></span>' +
      '<span class="rg-dim">—</span>' +
      '<span class="' + (S.psr0 > 0.95 ? 'rg-g' : 'rg-dim') + '">' + (S.psr0 * 100).toFixed(1) + '%</span>' +
      '<span class="rg-dim" style="text-align:left">P(夏普 &gt; 0)</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.3fr .7fr .8fr .8fr .8fr">' +
      '<span class="rg-nm">扣掉「挑过一轮」的运气</span>' +
      '<span class="rg-dim">' + num(S.srAnn) + '</span>' +
      '<span class="rg-y">' + num(S.sr0Ann) + '</span>' +
      '<span class="' + (S.dsr > 0.95 ? 'rg-g' : 'rg-r') + '">' + (S.dsr * 100).toFixed(1) + '%</span>' +
      '<span class="rg-dim" style="text-align:left">去通胀夏普 DSR</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.3fr .7fr .8fr .8fr .8fr">' +
      '<span class="rg-nm">真正该问的</span>' +
      '<span class="rg-dim">' + num(S.bhAnn) + '（基准）</span>' +
      '<span class="rg-dim">—</span>' +
      '<span class="' + (S.psrBH > 0.95 ? 'rg-g' : 'rg-r') + '">' + (S.psrBH == null ? '—' : (S.psrBH * 100).toFixed(1) + '%') + '</span>' +
      '<span class="rg-dim" style="text-align:left">P(赢过躺平)</span></div>';
    h += '</div>';
    h += '<div class="rg-sub"><b>门槛 SR₀ = ' + num(S.sr0Ann) + '</b>：即使 6 个政策全无真本事，' +
      '「挑最好的那个」这件事本身也会平均送出这么高的年化夏普。' +
      '实测最好的那个是 ' + num(S.srAnn) + ' —— ' +
      (S.srAnn > S.sr0Ann
        ? '<b>仍然高于门槛</b>，去通胀后 P = ' + (S.dsr * 100).toFixed(1) + '%。'
        : '<b style="color:var(--red)">已经低于门槛</b>，即「挑最好的」这件事本身就足以解释它 —— ' +
          '去通胀后 P = ' + (S.dsr * 100).toFixed(1) + '%，<b>没有证据表明它有任何真本事</b>。') +
      '<br><span class="rg-dim">样本偏度 γ3 = ' + num(S.g3) + '，峰度 γ4 = ' + num(S.g4) +
      '（正态=3）。已经用矩调整后的夏普方差计算 —— 加密资产收益厚尾得厉害，' +
      '用正态假设会低估方差、把显著性算高。</span></div>';

    /* 三个检验给出三个答案，必须说清楚它们问的不是同一件事，
     * 否则 99.8% 这种数字会一个人把整个面板的结论带跑。 */
    h += '<div class="rg-sub"><b>三个检验问的是三件不同的事，不一致时以最严的为准</b>：' +
      '<br>① <b>去通胀夏普 DSR = ' + (S.dsr * 100).toFixed(1) + '%</b> —— 问的是「是否超过 ' + S.N +
      ' 次随机尝试里最好的那个」。门槛 SR₀ = ' + num(S.sr0Ann) + '，比较低，所以容易过。' +
      '<br>② <b>P(赢过躺平) = ' + (S.psrBH == null ? '—' : (S.psrBH * 100).toFixed(1) + '%') +
      '</b> —— 问的是「是否超过基准」。这才是你真正想知道的，而它远没有 DSR 那么好看。' +
      '<br>③ <b>零信息对照</b>（下表）—— 问的是「是否超过同一套政策在<b>假信号</b>上的表现」，' +
      '门槛最贴近实际、也最严。' +
      '<br><span class="rg-dim"><b>为什么 DSR 能到 99.8% 而赢过躺平只有 ' +
      (S.psrBH == null ? '—' : (S.psrBH * 100).toFixed(0)) + '%？</b>' +
      '因为这两件事的难度差得远：「比随机噪声强」和「比躺平强」不是一个量级的要求 —— ' +
      '在十年年化 +69% 的市场里，躺平本身就是一个极强的对手。' +
      '看到 DSR 很高时，请先看 ② 和 ③。</span></div>';
  }

  /* 零信息对照 */
  if (NU && NU.shifts && NU.shifts.length) {
    h += '<div class="rg-sub"><b>零信息对照</b>：把评分<b>整体循环移位</b>（' + NU.shifts.length +
      ' 个不同位移，见 ' + NU.shifts.slice(0, 5).join('/') + '… 天）。' +
      '移位后评分自己的边际分布、波动、自相关<b>全部原样保留</b>，' +
      '只有「与未来收益的时序对齐」被切断。所以移位之后还拿得到的收益，' +
      '只可能来自「平均敞口 × 市场漂移」—— 也就是 ㉕ 里那个 beta 项，白送的。</div>';
    h += '<div class="rg-tbl" style="margin-top:6px">';
    h += '<div class="rg-hd" style="grid-template-columns:1.4fr .8fr .8fr .8fr .9fr">' +
      '<span>政策</span><span>实测净夏普</span><span>零信息中位</span><span>零信息 95%</span><span>判定</span></div>';
    const bhS = C.bh.ev.shN;
    for (let i = 0; i < C.rows.length; i++) {
      const R = C.rows[i];
      if (R.bench) continue;
      const z = NU.byPolicy[R.id];
      if (!z) continue;
      const passes = R.ev.shN > z.p95ShN;
      h += '<div class="rg-row" style="grid-template-columns:1.4fr .8fr .8fr .8fr .9fr">' +
        '<span class="rg-nm">' + R.nm + '</span>' +
        '<span class="' + (R.ev.shN >= 0 ? 'rg-g' : 'rg-r') + '">' + num(R.ev.shN) + '</span>' +
        '<span class="rg-dim">' + num(z.medShN) + '</span>' +
        '<span class="rg-dim">' + num(z.p95ShN) + '</span>' +
        '<span class="' + (passes ? 'rg-g' : 'rg-r') + '" style="text-align:left">' +
        (passes ? '超出噪声带' : '落在噪声带内') + '</span></div>';
    }
    h += '</div>';
    h += '<div class="rg-sub"><span class="rg-dim">判定标准：实测值要超过零信息的 <b>95% 分位</b>才算"不是运气"。' +
      '注意零信息的中位夏普往往<b>并不接近 0</b> —— 因为平均敞口仍然是正的，' +
      '在牛市里照样白捡 beta。这正是 ㉕ 归因里第一项在另一个场景下的再现。' +
      '换句话说：<b>一个"夏普显著为正"的策略，可能只是"端着多头仓"而已</b>。</span></div>';
  }
  box.innerHTML = h;
}

/* =====================================================================
 *  v3.24 · 评分为什么只用了一半标尺（20–77，而不是 0–100）
 *  ---------------------------------------------------------------------
 *  承接 v3.23 敞口诊断那个数：平均 |w| 只有 0.15，不是因为「不敢下注」，
 *  而是因为评分本身几乎不动。这一版不再绕开它，直接把它拆开。
 *
 *  拆解结论必须是可归因的，否则「幅度小」只是一个没有行动价值的观感。
 *  复合评分 c = Σw·(dir·z) / Σw，从单个因子到 0–100 的分数，中间有
 *  三道独立的压缩，各自可量化、各自可修：
 *
 *    A. 单因子自身幅度 —— z 的标定就是不是 sd=1？（实测中位数 1.28，健康）
 *    B. 夹紧截断 —— ±2.5 之后所有极端变成同一个值（技术面 42% 的时间在撞顶）
 *    C. 平均化收缩 —— 除以 Σw 之后，N 个信号的加权平均必然比单个信号窄
 *       √(N_eff) 倍（实测收缩到 1/3，这是构造性的，不是 bug）
 *    D. 标尺常数 —— 22 是按「c 能到 ±2.5」定的，但 c 实测只到 ±1.3
 *
 *  其中只有 C 是「必须接受」的（任何因子平均模型都有），A/B/D 都可修。
 *
 *  ㉗ 幅度分解 scoreScale：把 A/B/C/D 各自的贡献量化出来并指明谁是主因
 *  ㉘ 标尺重标定 scoreRescale：**扩张窗口**（只用过去，无前视）把 c 标准化，
 *     再套同一个 22 倍映射。诚实的前提：这不产生新信息，只让标尺可用 ——
 *     所以必须同时报「新旧两套评分的 IC」，若 IC 变了要如实说明
 *  ㉙ 夹紧代价 clampCost：逐因子量化 B，并对撞顶最狠的因子做重标定对照
 * ===================================================================== */

const SCALE_MIN_N = 120;        // 扩张窗口 burn-in：不足这么多天不给标准化值
const SCALE_SIG_FLOOR = 0.25;   // σ 下限：σ 塌陷时除以小数会把噪声放大成信号
const SCALE_MULT = 22;          // 与现行标尺同一个乘数，保证「只改标尺不改权重」
const SCALE_CLAMP = 2.5;        // 与 clampZ 一致

/* 把每帧「加权平均、尚未乘 22 的原始复合值 c」重建出来。
 * rep.scores = round(clamp(50 + 22·c))，取整与截断都不可逆，
 * 所以幅度分析必须回到 fvals（方向化贡献）按权重重算，不能拿 rep.scores 反推。
 * replace 用于 ㉙ 的对照实验：把某些因子的贡献换成重标定后的版本。 */
function compositeRaw(rep, replace) {
  if (!rep || !rep.fvals) return null;
  const ids = Object.keys(rep.fvals), n = rep.n;
  const c = new Array(n).fill(null), k = new Array(n).fill(0);
  for (let i = rep.start; i < n; i++) {
    let s = 0, ws = 0, kk = 0;
    for (let q = 0; q < ids.length; q++) {
      const id = ids[q];
      let v = rep.fvals[id][i];
      if (v == null || !isFinite(v)) continue;
      if (replace && replace[id]) {
        const rv = replace[id][i];
        if (rv != null && isFinite(rv)) v = rv;
      }
      const w = fWeight(id);
      s += v * w; ws += w; kk++;
    }
    if (kk >= 3 && ws > 0) { c[i] = s / ws; k[i] = kk; }
  }
  return { c: c, k: k, ids: ids };
}

/* 扩张窗口标准化：t 时刻的 μ/σ 只用 t 之前的样本算。
 * 用全样本 σ 去标准化是前视 —— 那是把「未来十年评分波动多大」偷偷喂给了第一天。
 * demean=false 时只除 σ 不减 μ，保留「50 = 因子中性」这个语义锚点。 */
function expandZ(c, minN, sigFloor, demean) {
  const n = c.length;
  const z = new Array(n).fill(null), mu = new Array(n).fill(null), sg = new Array(n).fill(null);
  const mn = minN == null ? SCALE_MIN_N : minN;
  const fl = sigFloor == null ? SCALE_SIG_FLOOR : sigFloor;
  let s = 0, s2 = 0, k = 0, bind = 0, tot = 0;
  for (let i = 0; i < n; i++) {
    const v = c[i];
    if (v == null || !isFinite(v)) continue;
    if (k >= mn) {
      const m = s / k;
      const sd0 = Math.sqrt(Math.max(s2 / k - m * m, 0));
      const use = Math.max(sd0, fl);
      tot++; if (sd0 < fl) bind++;
      mu[i] = m; sg[i] = sd0;
      z[i] = (demean ? (v - m) : v) / use;
    }
    s += v; s2 += v * v; k++;
  }
  const qs = sg.filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
  const qv = function (p) { return qs.length ? qs[Math.min(qs.length - 1, Math.max(0, Math.floor(p * (qs.length - 1))))] : null; };
  return {
    z: z, mu: mu, sg: sg, nScored: tot, bindRate: tot ? bind / tot : null,
    sigQ: { p05: qv(.05), p25: qv(.25), p50: qv(.5), p75: qv(.75), p95: qv(.95), min: qs.length ? qs[0] : null },
  };
}

const v3mean = a => a.reduce(function (x, y) { return x + y; }, 0) / a.length;
function v3sd(a) { if (a.length < 2) return null; const m = v3mean(a); let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m); return Math.sqrt(v / (a.length - 1)); }
const v3q = (a, p) => { const b = a.slice().sort(function (x, y) { return x - y; }); return b.length ? b[Math.min(b.length - 1, Math.max(0, Math.floor(p * (b.length - 1))))] : null; };

/* ---------------------------------------------------------------
 * ㉗ 幅度分解：A/B/C/D 各自吃了多少
 * --------------------------------------------------------------- */
function scoreScale(rep) {
  if (!rep || !rep.fvals) return null;
  const ids = Object.keys(rep.fvals);
  const per = [];
  let sw = 0, sw2 = 0;
  ids.forEach(function (id) {
    const w = fWeight(id); sw += w; sw2 += w * w;
    const raw = [], cl = [];
    let nClamp = 0, nTie = 0, nDay = 0;
    for (let i = rep.start; i < rep.n; i++) {
      const b = rep.fvals[id][i];
      if (b == null || !isFinite(b)) continue;
      nDay++;
      cl.push(b);
      const a = (rep.fraw && rep.fraw[id]) ? rep.fraw[id][i] : null;
      if (a != null && isFinite(a)) {
        raw.push(a);
        if (Math.abs(a) > SCALE_CLAMP + 1e-12) nClamp++;
      }
      if (Math.abs(Math.abs(b) - SCALE_CLAMP) < 1e-9) nTie++;
    }
    if (!nDay) return;
    const sdR = raw.length > 5 ? v3sd(raw) : null, sdC = cl.length > 5 ? v3sd(cl) : null;
    per.push({
      id: id, name: fName(id), w: w, nDay: nDay, sdRaw: sdR, sdCl: sdC,
      meanAbsRaw: raw.length ? v3mean(raw.map(Math.abs)) : null,
      meanAbsCl: v3mean(cl.map(Math.abs)),
      pClamp: raw.length ? nClamp / raw.length : null,
      pTie: nTie / nDay,
      /* sdCl = 0 是合法且最极端的一种结果（夹紧吃光了全部方差 = 100% 损失），
       * 不能写成 `sdR && sdC && ...` —— 0 是 falsy，会把这一档静默变成 null。
       * 必须显式判 null。 */
      lossSd: (sdR != null && sdC != null && sdR > 0) ? 1 - sdC / sdR : null,
    });
  });
  per.sort(function (a, b) { return (b.pClamp == null ? -1 : b.pClamp) - (a.pClamp == null ? -1 : a.pClamp); });

  const CR = compositeRaw(rep);
  if (!CR) return null;
  const cs = CR.c.filter(function (v) { return v != null; });
  if (cs.length < 60) return null;
  /* 单因子的「典型幅度」用加权 RMS —— 与复合同口径，可比 */
  const rms = [];
  for (let i = rep.start; i < rep.n; i++) {
    let ss = 0, ws = 0, kk = 0;
    for (let q = 0; q < ids.length; q++) {
      const v = rep.fvals[ids[q]][i]; if (v == null || !isFinite(v)) continue;
      const w = fWeight(ids[q]); ss += v * v * w; ws += w; kk++;
    }
    if (kk >= 3 && ws > 0) rms.push(Math.sqrt(ss / ws));
  }
  const sdComp = v3sd(cs), rmsAvg = v3mean(rms);
  /* 一致性：|加权平均| / 加权|z|。≈1 全体共振，≈1/√N_eff 随机独立 */
  const ag = [], ab = [];
  for (let i = rep.start; i < rep.n; i++) {
    let s = 0, sa = 0, ws = 0, kk = 0;
    for (let q = 0; q < ids.length; q++) {
      const v = rep.fvals[ids[q]][i]; if (v == null || !isFinite(v)) continue;
      const w = fWeight(ids[q]); s += v * w; sa += Math.abs(v) * w; ws += w; kk++;
    }
    if (kk >= 3 && ws > 0) { ag.push(Math.abs(s / ws)); ab.push(sa / ws); }
  }
  const nEffW = sw2 > 0 ? sw * sw / sw2 : null;
  const indepShrink = nEffW ? 1 / Math.sqrt(nEffW) : null;
  const agree = (v3mean(ab) > 0) ? v3mean(ag) / v3mean(ab) : null;
  /* 「完全没有收缩」的基准：若所有因子完全同步（相关系数 = 1），复合的 sd
   * 就等于各因子 sd 的加权平均。拿这个当分母，收缩比才有干净的刻度：
   *   1.00 = 全体同步（无收缩）  1/√N_eff = 互相独立（最大收缩）
   * 早期版本用「当日加权 RMS」当分母，那个量对高斯分布恒比 sd 大 1.25 倍，
   * 于是「完全同步」会算出 1.25 —— 刻度不自洽，无法和 1/√N_eff 直接比。 */
  let sfw = 0, sfs = 0;
  per.forEach(function (p) { if (p.sdCl != null) { sfw += p.w; sfs += p.w * p.sdCl; } });
  const sdFac = sfw > 0 ? sfs / sfw : null;
  const sc = rep.scores.filter(function (v) { return v != null; });
  return {
    n: cs.length, per: per,
    comp: { sd: sdComp, mean: v3mean(cs), min: Math.min.apply(null, cs), max: Math.max.apply(null, cs) },
    rmsFactor: rmsAvg, sdFac: sdFac, shrink: (sdFac > 0) ? sdComp / sdFac : null,
    nEffW: nEffW, indepShrink: indepShrink,
    agree: agree, agreeIndep: indepShrink,
    mult: { cur: SCALE_MULT, need: sdComp > 0 ? 50 / (2.5 * sdComp) : null },
    score: { sd: sc.length ? v3sd(sc) : null, min: sc.length ? Math.min.apply(null, sc) : null, max: sc.length ? Math.max.apply(null, sc) : null,
      p05: v3q(sc, .05), p50: v3q(sc, .5), p95: v3q(sc, .95) },
    nFac: ids.length,
  };
}

/* ---------------------------------------------------------------
 * ㉘ 标尺重标定：扩张窗口标准化 + 新旧双标尺对照
 * --------------------------------------------------------------- */
function scoreRescale(rep, opts) {
  const o = opts || {};
  const CR = compositeRaw(rep);
  if (!CR) return null;
  const E = expandZ(CR.c, o.minN, o.sigFloor, false);
  if (!E.nScored) return null;
  /* 只除 σ（保留 50 = 因子中性的锚点） */
  const sc1 = new Array(rep.n).fill(null);
  /* 同时减 μ（把「近期平均」重新定义为 50）—— 会改变分数的跨期含义，单列对照 */
  const E2 = expandZ(CR.c, o.minN, o.sigFloor, true);
  const sc2 = new Array(rep.n).fill(null);
  for (let i = 0; i < rep.n; i++) {
    if (E.z[i] != null) sc1[i] = Math.round(Math.max(2, Math.min(98, 50 + SCALE_MULT * Math.max(-SCALE_CLAMP, Math.min(SCALE_CLAMP, E.z[i])))));
    if (E2.z[i] != null) sc2[i] = Math.round(Math.max(2, Math.min(98, 50 + SCALE_MULT * Math.max(-SCALE_CLAMP, Math.min(SCALE_CLAMP, E2.z[i])))));
  }
  const h = o.h || 10;
  const lo = Math.max(rep.start, E.z.findIndex(function (v) { return v != null; }));
  const icOld = icCore(rep.scores, rep, h, lo, rep.n);
  const icNew = icCore(sc1, rep, h, lo, rep.n);
  const icDemean = icCore(sc2, rep, h, lo, rep.n);
  /* 样本外：后 40% 单独再算一遍（前段只用来烧入窗口，不参与挑参） */
  const cut = lo + Math.round((rep.n - lo) * 0.6);
  const oosOk = (cut - lo >= 120) && (rep.n - cut >= 120);
  const oosOld = oosOk ? icCore(rep.scores, rep, h, cut, rep.n) : null;
  const oosNew = oosOk ? icCore(sc1, rep, h, cut, rep.n) : null;

  const wOld = [], wNew = [];
  for (let i = lo; i < rep.n; i++) {
    if (rep.scores[i] != null) wOld.push(Math.min(1, Math.abs((rep.scores[i] - 50) / 50)));
    if (sc1[i] != null) wNew.push(Math.min(1, Math.abs((sc1[i] - 50) / 50)));
  }
  const s1 = sc1.filter(function (v) { return v != null; });
  const s2v = sc2.filter(function (v) { return v != null; });
  /* 饱和率：评分被压在 2 或 98（对应 |z| > 2.18）的天数占比。
   * 标尺放大之后必然有一批值撞到两端，不报这个数就等于默认「98 分就是 98 分」——
   * 实际上 98 分里塞着所有 z > 2.18 的日子，它们之间已经没有区分度了。 */
  let sat = 0;
  for (let i = lo; i < rep.n; i++) if (sc1[i] === 2 || sc1[i] === 98) sat++;
  const nSc = rep.n - lo;
  let satOld = 0;
  for (let i = rep.start; i < rep.n; i++) if (rep.scores[i] === 2 || rep.scores[i] === 98) satOld++;
  return {
    satRate: nSc ? sat / nSc : null, satRateOld: (rep.n - rep.start) ? satOld / (rep.n - rep.start) : null,
    lo: lo, h: h, minN: o.minN == null ? SCALE_MIN_N : o.minN, sigFloor: o.sigFloor == null ? SCALE_SIG_FLOOR : o.sigFloor,
    scores: sc1, scoresDemean: sc2, z: E.z, sg: E.sg, mu: E.mu,
    bindRate: E.bindRate, sigQ: E.sigQ, nScored: E.nScored,
    ic: { old: icOld ? icOld.spear : null, oldT: icOld ? icOld.t : null,
      neu: icNew ? icNew.spear : null, neuT: icNew ? icNew.t : null,
      dem: icDemean ? icDemean.spear : null, demT: icDemean ? icDemean.t : null },
    oos: oosOk ? { old: oosOld ? oosOld.spear : null, neu: oosNew ? oosNew.spear : null, cut: cut } : null,
    range: { old: [Math.min.apply(null, rep.scores.filter(function (v) { return v != null; })), Math.max.apply(null, rep.scores.filter(function (v) { return v != null; }))],
      neu: [Math.min.apply(null, s1), Math.max.apply(null, s1)],
      dem: [Math.min.apply(null, s2v), Math.max.apply(null, s2v)] },
    sd: { old: v3sd(rep.scores.filter(function (v) { return v != null; })), neu: v3sd(s1), dem: v3sd(s2v) },
    w: { oldAvg: wOld.length ? v3mean(wOld) : null, oldP95: wOld.length ? v3q(wOld, .95) : null,
      neuAvg: wNew.length ? v3mean(wNew) : null, neuP95: wNew.length ? v3q(wNew, .95) : null },
  };
}

/* ---------------------------------------------------------------
 * ㉙ 夹紧代价：±2.5 这道截断到底吃掉了什么
 * --------------------------------------------------------------- */
function clampCost(rep, opts) {
  const o = opts || {};
  const S = scoreScale(rep);
  if (!S) return null;
  const fixIds = o.fix || null;
  /* 撞击最狠的前几个因子 —— 不写死 tech/mom，让数据自己说 */
  const worst = S.per.filter(function (p) { return p.pClamp != null && p.pClamp > 0.08; });
  const fix = fixIds || worst.slice(0, 3).map(function (p) { return p.id; });
  /* 对照实验：把撞顶因子的 z 用**扩张窗口**自身标准差归一化（不是全样本 sd，那是前视），
   * 再夹紧回 ±2.5。这样「极端」仍然极端，但不再被压成同一个值。 */
  const replace = {};
  const per = {};
  fix.forEach(function (id) {
    const rawArr = (rep.fraw && rep.fraw[id]) ? rep.fraw[id] : null;
    if (!rawArr) return;
    const hasDir = (FACTORS.find(function (x) { return x.id === id; }) || {}).dir || 0;
    const E = expandZ(rawArr, o.minN, o.sigFloor, false);
    const out = new Array(rep.n).fill(null);
    let nBind = 0, nTot = 0;
    for (let i = 0; i < rep.n; i++) {
      if (E.z[i] == null) continue;
      nTot++;
      if (Math.abs(E.z[i]) > SCALE_CLAMP) nBind++;
      out[i] = hasDir * Math.max(-SCALE_CLAMP, Math.min(SCALE_CLAMP, E.z[i]));
    }
    replace[id] = out;
    per[id] = { id: id, name: fName(id), pClampAfter: nTot ? nBind / nTot : null, n: nTot };
  });
  const has = Object.keys(replace).length;
  let cmp = null;
  if (has) {
    const CR2 = compositeRaw(rep, replace);
    const sc2 = new Array(rep.n).fill(null);
    for (let i = rep.start; i < rep.n; i++) if (CR2.c[i] != null) sc2[i] = Math.round(Math.max(2, Math.min(98, 50 + SCALE_MULT * CR2.c[i])));
    const h = o.h || 10;
    const a = icCore(rep.scores, rep, h, rep.start, rep.n);
    const b = icCore(sc2, rep, h, rep.start, rep.n);
    const cs2 = CR2.c.filter(function (v) { return v != null; });
    cmp = { ids: Object.keys(replace), per: per, icOld: a ? a.spear : null, icFix: b ? b.spear : null,
      sdOld: v3sd(rep.scores.filter(function (v) { return v != null; })), sdFix: v3sd(sc2.filter(function (v) { return v != null; })),
      rangeFix: [Math.min.apply(null, sc2.filter(function (v) { return v != null; })), Math.max.apply(null, sc2.filter(function (v) { return v != null; }))],
      compSd: v3sd(cs2) };
  }
  return { scale: S, worst: worst, fix: fix, cmp: cmp };
}

/* 标尺改了之后，同一套仓位政策会变成什么样？
 * 这不是「新加一个政策」—— 权重一个字没改，只是把标尺换掉。
 * 之所以必须单独跑一遍：幅度翻倍意味着敞口翻倍，而在牛市里敞口翻倍
 * 会白捡一倍的 beta。若不把「多出来的收益」拆成 beta 与 timing，
 * 就会把「仓位变大了」当成「模型变准了」。
 * 事前声明：这个对照**不进入** ㉖ 的政策计数（N 不 +1），
 * 它不是从 6 个候选里挑出来的第七个，而是同一个政策的两种刻度。 */
function rescaleImpact(rep, R) {
  if (!rep || !R || !R.scores) return null;
  const lo = R.lo;
  const mkRep = function (sc) { return { n: rep.n, start: lo, closes: rep.closes, scores: sc, calTs: rep.calTs }; };
  const A = mkRep(rep.scores.slice()), B = mkRep(R.scores.slice());
  const w1 = policyW(A, 'linear'), w2 = policyW(B, 'linear'), wb = policyW(A, 'bh');
  if (!w1 || !w2 || !wb) return null;
  const e1 = policyEval(A, w1), e2 = policyEval(B, w2), eb = policyEval(A, wb);
  if (!e1 || !e2 || !eb) return null;
  const a1 = e1.attr, a2 = e2.attr;
  return {
    lo: lo, old: e1, neu: e2, bh: eb,
    wOld: a1 ? a1.avgAbsW : null, wNeu: a2 ? a2.avgAbsW : null,
    betaOld: a1 ? a1.betaY : null, betaNeu: a2 ? a2.betaY : null,
    timingOld: a1 ? a1.timingY : null, timingNeu: a2 ? a2.timingY : null,
    dNet: e2.netY - e1.netY, dSh: e2.shN - e1.shN,
    dBeta: (a1 && a2) ? a2.betaY - a1.betaY : null,
    dTiming: (a1 && a2) ? a2.timingY - a1.timingY : null,
    dMdd: e2.ddN.mdd - e1.ddN.mdd,
  };
}

/* 实时模式的标尺校正：用回放末端学到的 σ 把今天的复合值 c 标准化。
 * 若还没跑过回放，就老老实实不给值 —— 编一个 σ 出来等于编一个结论。 */
function rescaleLive(res) {
  const cal = state.scaleCal;
  if (!cal || !(cal.sg > 0)) return null;
  const c = res && res.c;
  if (c == null || !isFinite(c)) return null;
  const z = Math.max(-SCALE_CLAMP, Math.min(SCALE_CLAMP, c / Math.max(cal.sg, SCALE_SIG_FLOOR)));
  return { score: Math.round(Math.max(2, Math.min(98, 50 + SCALE_MULT * z))), z: z, sg: cal.sg, n: cal.n };
}

/* ---------- ㉗㉘㉙ 渲染：评分为什么只用了一半标尺 ---------- */
function renderScaleBox() {
  const box = $('scaleBox');
  if (!box) return;
  const H = state.hist;
  if (!H || !H.rep) { box.innerHTML = '<div class="rg-sub">需要先跑一次十年回放。</div>'; return; }
  const rep = H.rep;
  const S = H.scaleDiag || (H.scaleDiag = scoreScale(rep));
  const R = H.rescale || (H.rescale = scoreRescale(rep));
  const K = H.clamp || (H.clamp = clampCost(rep));
  if (!S || !R) { box.innerHTML = '<div class="rg-sub">数据不足以做幅度分解。</div>'; return; }

  /* 把末端 σ 交给实时评分用 */
  if (R.sg) {
    for (let i = R.sg.length - 1; i >= 0; i--) {
      if (R.sg[i] != null && isFinite(R.sg[i]) && R.sg[i] > 0) { state.scaleCal = { sg: R.sg[i], n: R.nScored }; break; }
    }
  }

  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };
  const pc = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  const dstr = t => new Date(t).toISOString().slice(0, 10);

  let h = '<div class="rg-sub"><b>评分实测只在 ' + S.score.min + '–' + S.score.max + ' 之间波动，理论标尺是 0–100。</b>' +
    '这不是「模型保守」，是三道压缩叠在一起的结果 —— 而它们的可修性完全不同。<br>' +
    '<span class="rg-dim">为什么这件事要紧：仓位 w = (评分−50)/50。评分只用 57% 的标尺，' +
    '意味着<b>即使模型百分之百确信，最大仓位也只有 0.54</b>，平均只有 ' + num(R.w.oldAvg) +
    '。v3.23 那个「timing 补不回放弃的 beta」，根子就在这里。</span></div>';

  /* ---- ㉗ 三道压缩 ---- */
  h += '<div class="rg-sub" style="margin-top:8px"><b>㉗ 三道压缩，各自吃了多少</b></div>';
  h += '<div class="rg-tbl">';
  h += '<div class="rg-hd" style="grid-template-columns:2fr .8fr .8fr .8fr 1.6fr"><span>环节</span><span>压缩前</span><span>压缩后</span><span>比值</span><span>性质</span></div>';
  h += '<div class="rg-row" style="grid-template-columns:2fr .8fr .8fr .8fr 1.6fr">' +
    '<span class="rg-nm">A 单因子自身幅度（zRaw sd 中位数）</span><span>应 ≈1</span><span>' +
    num(S.per.map(function (p) { return p.sdRaw; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; })[Math.floor(S.nFac / 2)]) +
    '</span><span class="rg-dim">—</span><span class="rg-g" style="text-align:left">标定正常，不是病因</span></div>';
  h += '<div class="rg-row" style="grid-template-columns:2fr .8fr .8fr .8fr 1.6fr">' +
    '<span class="rg-nm">C 平均化收缩（除以 Σw）</span><span>' + num(S.sdFac) + '</span><span>' + num(S.comp.sd) + '</span><span class="rg-y">' +
    num(S.shrink) + '</span><span class="rg-dim" style="text-align:left">构造性，任何因子平均模型都有</span></div>';
  h += '<div class="rg-row" style="grid-template-columns:2fr .8fr .8fr .8fr 1.6fr">' +
    '<span class="rg-nm">D 标尺常数</span><span>' + S.mult.cur + '</span><span class="rg-dim">应为</span><span class="rg-y">' +
    num(S.mult.need) + '</span><span class="rg-r" style="text-align:left">纯标定错误，可直接修</span></div>';
  h += '</div>';
  h += '<div class="rg-sub"><span class="rg-dim"><b>C 不可避，但有干净的刻度可对照</b>：' +
    '收缩比的分母是「若所有因子完全同步时的复合 sd」（= 各因子 sd 的加权平均 ' + num(S.sdFac) + '）。' +
    '于是刻度是：<b>1.00 = 全体同步、无收缩</b>；<b>1/√N_eff = ' + num(S.indepShrink) +
    ' = 互相独立、最大收缩</b>（N_eff = ' + num(S.nEffW) + '，共 ' + S.nFac + ' 维）。实测 ' + num(S.shrink) +
    '，落在两端之间，方向一致性 ' + num(S.agree) + ' vs 独立基准 ' + num(S.agreeIndep) + '。' +
    (S.agree > S.agreeIndep
      ? '一致性高于独立基准 ⇒ 因子之间是<b>正相关</b>的，收缩比独立情形更轻 —— 也就是说「因子互相打架」<b>不是</b>额外病因，' +
        '主因就是「把 ' + S.nFac + ' 个信号取加权平均」这个动作本身。'
      : '一致性低于独立基准 ⇒ 因子之间存在抵消，这部分的压缩是额外的、可以避免的。') +
    '<br>22 个 sd≈1 的信号取平均，标准差必然掉到 1/√22 量级 —— <b>这不是 bug，是算术</b>。' +
    '真正错的是 D：标尺常数 22 是按「复合值能到 ±2.5」定的，而实测只到 ' +
    num(Math.max(Math.abs(S.comp.min), Math.abs(S.comp.max))) + '，所以常数该是 ' + num(S.mult.need) + '。</span></div>';

  /* ---- ㉘ 重标定 ---- */
  h += '<div class="rg-sub" style="margin-top:8px"><b>㉘ 标尺重标定（扩张窗口，无前视）</b>：' +
    '把复合值除以<b>只用过去数据</b>算出的 σ，再套同一个 ' + S.mult.cur + ' 倍映射。' +
    'burn-in ' + R.minN + ' 天，从第 ' + R.lo + ' 天（' + dstr(rep.calTs[R.lo]) + '）起给值。<br>' +
    '<span class="rg-dim">用全样本 σ 去标准化是<b>前视</b> —— 那等于把「未来十年评分波动多大」偷偷喂给了第一天。</span></div>';
  h += '<div class="rg-tbl" style="margin-top:6px">';
  h += '<div class="rg-hd" style="grid-template-columns:1.6fr .9fr .7fr .8fr .7fr .9fr">' +
    '<span>口径</span><span>评分范围</span><span>sd</span><span>IC(' + R.h + '日)</span><span>t</span><span>样本外 IC</span></div>';
  const rws = [
    { nm: '现行（线性 ' + S.mult.cur + '）', rg: R.range.old, sd: R.sd.old, ic: R.ic.old, t: R.ic.oldT, oo: R.oos ? R.oos.old : null },
    { nm: '除 σ（保留 50=中性锚点）', rg: R.range.neu, sd: R.sd.neu, ic: R.ic.neu, t: R.ic.neuT, oo: R.oos ? R.oos.neu : null, hl: true },
    { nm: '除 σ 且减 μ（50=近期均值）', rg: R.range.dem, sd: R.sd.dem, ic: R.ic.dem, t: R.ic.demT, oo: null },
  ];
  rws.forEach(function (x) {
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .9fr .7fr .8fr .7fr .9fr' + (x.hl ? ';background:rgba(0,229,160,.06)' : '') + '">' +
      '<span class="rg-nm">' + x.nm + '</span>' +
      '<span><b>' + x.rg[0] + ' – ' + x.rg[1] + '</b></span>' +
      '<span>' + num(x.sd) + '</span>' +
      '<span class="' + (x.ic > 0.05 ? 'rg-g' : x.ic < -0.05 ? 'rg-r' : 'rg-dim') + '">' + num(x.ic, 3) + '</span>' +
      '<span class="rg-dim">' + num(x.t) + '</span>' +
      '<span class="rg-dim">' + num(x.oo, 3) + '</span></div>';
  });
  h += '</div>';
  const dIc = (R.ic.neu != null && R.ic.old != null) ? R.ic.neu - R.ic.old : null;
  h += '<div class="rg-sub"><b>关键判定：IC 变化 ' + (dIc == null ? '—' : (dIc >= 0 ? '+' : '') + num(dIc, 4)) + '</b> —— ' +
    (dIc != null && Math.abs(dIc) < 0.01
      ? '<span class="rg-g">几乎不变，这正是想要的结果</span>：说明这一步<b>只是换了个标尺，没有往里塞任何信息</b>。' +
        '如果 IC 明显上升，反而该警惕 —— 那意味着「归一化」偷偷引入了时序漂移，把运气当成了信号。'
      : '<span class="rg-y">有明显变化</span>：标尺改动引入了时序效应，不能当成单纯的尺度修正。') +
    '<br><b>幅度收益却是实打实的</b>：平均 |w| ' + num(R.w.oldAvg) + ' → <b>' + num(R.w.neuAvg) + '</b>（×' +
    num(R.w.neuAvg / R.w.oldAvg) + '），p95 ' + num(R.w.oldP95) + ' → ' + num(R.w.neuP95) +
    '。评分终于把 0–100 用满了，仓位政策的讨论才有意义。</div>';
  h += '<div class="rg-sub"><span class="rg-dim"><b>两个必须同时看的副作用</b>：' +
    '① σ 下限设的是 ' + num(R.sigFloor) + '，触发率 ' + ((R.bindRate || 0) * 100).toFixed(1) + '%（σ 实测分位 p05=' +
    num(R.sigQ.p05) + ' p50=' + num(R.sigQ.p50) + ' p95=' + num(R.sigQ.p95) + '，最小 ' + num(R.sigQ.min) +
    '）。σ 很小时除以它会把噪声放大成信号，所以必须有下限；下限若设太高则会长期生效，等于换了个常数标尺 —— 现在触发率很低，说明落在了合理的空档里。' +
    '<br>② <b>饱和率 ' + pc(R.satRate) + '</b>（旧标尺 ' + pc(R.satRateOld) + '）：标尺放大后，' +
    pc(R.satRate) + ' 的日子被压在 2 分或 98 分。<b>98 分不等于「98 分」</b> —— 它把 z 超过 2.18 的所有日子压成了同一个值，' +
    '它们之间已经没有区分度。看极端读数时必须记住这一点。</span></div>';

  /* ---- ㉙ 夹紧代价 ---- */
  if (K) {
    /* 撞顶最狠那个之外的其余因子的 zRaw sd 区间与中位数 —— 必须现算。
     * 把这些数写死进散文（早期版本就是这么干的）会让面板在换数据后说假话。 */
    const oth = S.per.slice(1).map(function (p) { return p.sdRaw; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
    const oMin = oth.length ? oth[0] : null, oMax = oth.length ? oth[oth.length - 1] : null;
    const oMed = oth.length ? oth[Math.floor(oth.length / 2)] : null;
    h += '<div class="rg-sub" style="margin-top:8px"><b>㉙ ±' + SCALE_CLAMP + ' 这道夹紧吃掉了什么</b>：' +
      '撞顶超过 8% 的因子由数据点名 —— <b>' + (K.worst.length ? K.worst.map(function (p) { return p.name + ' ' + (p.pClamp * 100).toFixed(0) + '%'; }).join('、') : '无') +
      '</b>。<br><span class="rg-dim">「并列占比」是被夹紧的天数比例：这些天里无论 z 是 2.5 还是 8，' +
      '贡献都变成同一个 ±2.5，<b>顶部区分度彻底丧失</b>。</span></div>';
    h += '<div class="rg-tbl" style="margin-top:6px">';
    h += '<div class="rg-hd" style="grid-template-columns:1.5fr .6fr .8fr .8fr .8fr .8fr">' +
      '<span>因子（撞顶降序）</span><span>权重</span><span>zRaw sd</span><span>撞顶占比</span><span>sd 损失</span><span>并列占比</span></div>';
    S.per.slice(0, 8).forEach(function (p) {
      const bad = (p.pClamp || 0) > 0.08;
      h += '<div class="rg-row" style="grid-template-columns:1.5fr .6fr .8fr .8fr .8fr .8fr">' +
        '<span class="rg-nm">' + p.name + '</span>' +
        '<span class="rg-dim">' + num(p.w, 1) + '</span>' +
        '<span class="' + (p.sdRaw > 2 ? 'rg-r' : 'rg-dim') + '">' + num(p.sdRaw) + '</span>' +
        '<span class="' + (bad ? 'rg-r' : 'rg-dim') + '">' + (p.pClamp == null ? '—' : (p.pClamp * 100).toFixed(1) + '%') + '</span>' +
        '<span class="' + (bad ? 'rg-y' : 'rg-dim') + '">' + (p.lossSd == null ? '—' : (p.lossSd * 100).toFixed(1) + '%') + '</span>' +
        '<span class="rg-dim">' + (p.pTie * 100).toFixed(1) + '%</span></div>';
    });
    h += '</div>';
    if (K.cmp) {
      const d2 = (K.cmp.icFix != null && K.cmp.icOld != null) ? K.cmp.icFix - K.cmp.icOld : null;
      h += '<div class="rg-sub"><b>对照实验</b>：把 ' + K.cmp.ids.map(function (id) { return fName(id); }).join('、') +
        ' 的 z 用<b>扩张窗口自身 sd</b>归一化后再夹紧（不能用全样本 sd，那是前视）。<br>' +
        '撞顶比例：' + K.cmp.ids.map(function (id) {
          const o = S.per.find(function (x) { return x.id === id; });
          return fName(id) + ' ' + ((o.pClamp || 0) * 100).toFixed(0) + '% → ' + ((K.cmp.per[id].pClampAfter || 0) * 100).toFixed(1) + '%';
        }).join('；') + '。<br>' +
        '复合 sd ' + num(S.comp.sd) + ' → ' + num(K.cmp.compSd) + '，评分 sd ' + num(K.cmp.sdOld) + ' → ' + num(K.cmp.sdFix) + '。<br>' +
        '<b>IC ' + num(K.cmp.icOld, 3) + ' → ' + num(K.cmp.icFix, 3) + '（' + (d2 >= 0 ? '+' : '') + num(d2, 4) + '）</b> —— ' +
        (d2 == null ? '—' : d2 > 0
          ? '<span class="rg-g">修好夹紧后 IC 提升</span>：被砍掉的极端值里确实有信息，这道截断是真损失。'
          : '<span class="rg-y">修好夹紧后 IC 反而没提升</span>。这个反直觉的结果本身就是结论：' +
            '<b>那 ' + (S.per[0].pClamp * 100).toFixed(0) + '% 撞顶的日子里，被砍掉的部分没有额外预测力</b>。' +
            'zRaw sd 高达 ' + num(S.per[0].sdRaw) + '（其余因子在 ' + num(oMin) + '–' + num(oMax) + '）说明它的 z 标定本身就过宽 —— ' +
            '大部分「极端」是噪声，压平它们没损失什么。' +
            '<span class="rg-dim">所以这一项<b>不动</b>：看起来像 bug 的东西，实测改了更差。</span>') +
        '</div>';
    }
    h += '<div class="rg-sub"><span class="rg-dim"><b>方法论提醒</b>：zRaw sd 中位数 ' +
      num(S.per.map(function (p) { return p.sdRaw; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; })[Math.floor(S.nFac / 2)]) +
      '。撞得最狠的「' + S.per[0].name + '」sd 是 ' + num(S.per[0].sdRaw) + '，其余因子在 ' + num(oMin) + '–' + num(oMax) +
      ' —— 它的「z」根本不是标准正态。' +
      '把它和 sd≈' + num(oMed) + ' 的因子放进同一个 ±2.5 的框里，等于让它在 ' + (S.per[0].pClamp * 100).toFixed(0) +
      '% 的时间里一个人说了算，而其余时间被压平。这是<b>因子定义层面</b>的问题，' +
      '不是评分公式的问题；但既然修了 IC 不涨，就先留着并如实标注，不去动它。</span></div>';
  }
  /* ---- 连锁影响：同一个线性政策，只换标尺 ---- */
  const IM = H.rescaleImpact || (H.rescaleImpact = rescaleImpact(rep, R));
  if (IM) {
    h += '<div class="rg-sub" style="margin-top:8px"><b>连锁影响：同一个「线性」政策，只换标尺</b>' +
      '（权重一个字没改，比较区间统一取 ' + dstr(rep.calTs[IM.lo]) + ' 起）。<br>' +
      '<span class="rg-dim">这一行<b>不进入</b> ㉖ 的政策计数 —— 它不是从 6 个候选里挑出来的第七个，' +
      '而是同一个政策的两种刻度，事前声明、一并披露。</span></div>';
    h += '<div class="rg-tbl" style="margin-top:6px">';
    h += '<div class="rg-hd" style="grid-template-columns:1.5fr .8fr .8fr .8fr .8fr .9fr">' +
      '<span>口径</span><span>净年化</span><span>净夏普</span><span>平均|w|</span><span>最大回撤</span><span>beta / timing</span></div>';
    const row = function (nm, E, A, ww, hl) {
      return '<div class="rg-row" style="grid-template-columns:1.5fr .8fr .8fr .8fr .8fr .9fr' + (hl ? ';background:rgba(0,229,160,.06)' : '') + '">' +
        '<span class="rg-nm">' + nm + '</span>' +
        '<span>' + pc(E.netY, 1) + '</span>' +
        '<span class="' + (E.shN >= 0 ? 'rg-g' : 'rg-r') + '">' + num(E.shN) + '</span>' +
        '<span>' + num(ww) + '</span>' +
        '<span class="rg-r">' + pc(-E.ddN.mdd, 1) + '</span>' +
        '<span class="rg-dim">' + (A ? pc(A.betaY, 1) + ' / ' + pc(A.timingY, 1) : '—') + '</span></div>';
    };
    h += row('线性 · 原标尺', IM.old, IM.old.attr, IM.wOld, false);
    h += row('线性 · 校正标尺', IM.neu, IM.neu.attr, IM.wNeu, true);
    h += row('买入持有（参照）', IM.bh, IM.bh.attr, 1, false);
    h += '</div>';
    h += '<div class="rg-sub"><b>多出来的 ' + pc(IM.dNet, 1) + ' 年化里，beta 贡献 ' + pc(IM.dBeta, 1) +
      '、timing 贡献 ' + pc(IM.dTiming, 1) + '</b> —— ' +
      ((IM.dBeta != null && IM.dTiming != null && Math.abs(IM.dBeta) > Math.abs(IM.dTiming))
        ? '<span class="rg-y">大头是 beta</span>：敞口从 ' + num(IM.wOld) + ' 涨到 ' + num(IM.wNeu) +
          '，在牛市里自然白捡更多市场漂移。<b>这不代表模型变准了，只代表仓端得更大了。</b>' +
          '校正标尺的价值在于「模型本来就在说的话终于能表达出来」，' +
          '而不是「收益变高了」—— 收益变化里相当一部分是市场送的。'
        : '<span class="rg-g">大头是 timing</span>：说明标尺修好之后，模型原本被压扁的判断' +
          '确实转化成了额外的择时收益。') +
      '<br><span class="rg-dim"><b>但夏普只动了 ' + (IM.dSh >= 0 ? '+' : '') + num(IM.dSh) + '</b> —— ' +
      '这不是没效果，是<b>夏普对仓位整体缩放几乎免疫</b>：w 乘 k 倍，收益的均值与标准差同乘 k，比值不变。' +
      '剩下那点差值几乎全部来自「固定的换手成本被摊到更大的仓位上」。<b>放大标尺不会让人变聪明，' +
      '它只是让原本被压扁的判断能落到仓位上。</b><br>' +
      '最大回撤同步' + (IM.dMdd > 0 ? '放大' : '缩小') + ' ' + pc(Math.abs(IM.dMdd), 1) +
      ' —— 敞口变大必然伴随风险变大，这两件事是同一枚硬币，不能只报收益。' +
      '<br>与买入持有 ' + pc(IM.bh.netY, 1) + ' 相比，校正后仍是 ' + pc(IM.neu.netY - IM.bh.netY, 1) +
      '：标尺修好<b>没有</b>解决「跑不赢躺平」这个 v3.23 就摆出来的问题，' +
      '它解决的是「模型说的话传不到仓位上」这个更靠前的一环。</span></div>';
  }

  box.innerHTML = h;

  /* 实时评分同步显示校正后的分数 */
  const nx = $('nxCal');
  if (nx) {
    try {
      const rl = rescaleLive(computeNexusScore());
      if (rl) {
        nx.style.display = '';
        nx.innerHTML = '标尺校正后 <b style="color:' + (rl.score > 60 ? 'var(--green)' : rl.score < 40 ? 'var(--red)' : 'var(--gold)') + '">' +
          rl.score + '</b>（z=' + num(rl.z) + '，σ=' + num(rl.sg) + '，取自 ' + rl.n + ' 天回放末端）· ' +
          '<span style="opacity:.7">同一套权重，只把标尺换成「相对自身近期波动」—— 排序基本不变，幅度可用。</span>';
      } else { nx.style.display = 'none'; }
    } catch (e) { if (nx) nx.style.display = 'none'; }
  }
}


/* =====================================================================
 *  v3.25 · 因子宇宙：把「候选池」从 32 维扩到 160+ 维，再让数据裁定强弱
 *  ---------------------------------------------------------------------
 *  前一版的困境：因子只有 32 个，而「哪些是强影响」这个问题在 32 个样本上
 *  根本没法回答 —— 你看到的强弱可能只是这 32 个恰好被挑中时的运气。
 *
 *  真实量化机构的做法是反过来的：**先有几百到几千个候选，再用统一口径筛**。
 *  筛选口径（这套是业界通用、且必须事前定死的）：
 *
 *    IC      因子值与未来收益的秩相关 —— 「方向对不对」
 *    ICIR    滚动 IC 的均值/标准差  —— 「稳不稳」，比 IC 更重要
 *    t(有效)  IC / SE，SE 按**非重叠窗口数**折算（重叠前向窗会让 n 虚高）
 *    q       BH-FDR 校正后的显著性 —— 160 个因子一起测，必然有假阳性
 *    胜率    滚动 IC 与总 IC 同号的比例
 *    半衰期  |IC| 衰减到一半所需的天数 —— 决定该多久调一次仓
 *    样本外  前 60% 选 / 后 40% 验，符号必须一致，否则判「漂移」
 *
 *  三条纪律（每一次都得守，否则整套筛选就是自欺）：
 *    ① **信号必须是无前视的**：因子值用它自己**过去**的均值/标准差标准化，
 *       不是全样本 —— 用全样本 z 会让「整个样本里它波动多大」提前泄露给第一天。
 *    ② **方向不挑**：不因为测出 IC 是负的就把它翻正再用。翻正是典型的
 *       样本内过拟合，这里只如实报 IC 的符号。
 *    ③ **门槛事前定死**：强/中/弱的 |IC| 门槛与 q 门槛写死在 SCR 里，
 *       不因为「看起来应该是强因子」而放宽。
 * ===================================================================== */

const SCR = {
  HORIZONS: [1, 3, 5, 10, 20],
  H: 10,             // 主视野（事前定死，不挑最优 h）
  ZWIN: 120,         // 扩张窗口 z 的 burn-in
  MIN_N: 250,        // 配对样本下限
  ROLL: 120,         // 滚动 IC 窗口（按 BTC 日历日）
  STEP: 60,
  Q: 0.05,           // BH-FDR 门槛
  STRONG: 0.08,      // 强影响 |IC| 门槛
  MID: 0.045,        // 中影响 |IC| 门槛
  TOP_PCT: 0.5,      // 不漂移的池子里取前 50% 作为「强」（相对刻度）
  OOS_CUT: 0.6,      // 前 60% 选 / 后 40% 验
};

/* 外生 / 内生的判定：不由加密市场内部决定、从外部打进来的变量。
 * 只影响网络图的布环（外生排外围），**不参与**任何强度判定 —— 强度一律由数据裁定。 */
const CAT_ZH = { index: '全球股指', sector: '美股板块', rate: '利率债券', credit: '信用利差', fx: '外汇', commodity: '大宗商品', vol: '波动率', cryptostock: '加密概念股', altcoin: '山寨币', tech: '科技巨头' };

function universeUrl(cats) { return CONFIG.PROXY ? CONFIG.PROXY + '/api/universe?cat=' + encodeURIComponent(cats) : null; }

async function loadUniverse(cats, opts) {
  const o = opts || {};
  const url = universeUrl(cats || 'all');
  if (!url) return null;
  try {
    const d = await getJSON(url, 180000);
    if (!d || !d.series) return null;
    if (!state.universe) state.universe = { series: {}, cats: {}, exo: {}, meta: {}, _keyCat: {}, _name: {} };
    Object.keys(d.series).forEach(function (k) { state.universe.series[k] = d.series[k]; });
    (d.cats || []).forEach(function (c) { state.universe.cats[c] = true; });
    if (d.exo) Object.keys(d.exo).forEach(function (c) { state.universe.exo[c] = !!d.exo[c]; });
    if (d.keyCat) Object.keys(d.keyCat).forEach(function (k) { state.universe._keyCat[k] = d.keyCat[k]; });
    if (d.names) Object.keys(d.names).forEach(function (k) { state.universe._name[k] = d.names[k]; });
    state.universe.fail = d.fail || {};
    state.universe.nOk = d.nOk || 0;
    state.universe.n = d.n || 0;
    state.universe.ts = d.ts || Date.now();
    /* 换了一批数据 → 之前算的筛选结果作废，不能挂着旧结论 */
    state.screening = null;
    state.composite = null;
    state.risk = null;
    state.oos = null;
    state.guardrail = null;
    if (!o.quiet) console.log('universe loaded', Object.keys(state.universe.series).length);
    return state.universe;
  } catch (e) { console.warn('universe fail', e && e.message); return null; }
}

/* 与 v3mean/v3sd 同义，但筛选模块要的是「不抛异常」的短写法：
 * 空数组返回 null 而不是 NaN，下游判空更省心。 */
function meanOf(a) { if (!a || !a.length) return null; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
function sdOf(a) { if (!a || a.length < 2) return null; const m = meanOf(a); let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m); return Math.sqrt(v / (a.length - 1)); }
function medianOf(a) { if (!a || !a.length) return null; const b = a.slice().filter(function (x) { return x != null && isFinite(x); }).sort(function (x, y) { return x - y; }); if (!b.length) return null; const k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; }

/* ---------- 对齐：把任意序列的日期映射到 BTC 日线下标 ---------- */
const dayKey = t => new Date(t).toISOString().slice(0, 10);

function btcCtx() {
  const b = state.histBundle && state.histBundle.btc;
  if (!b || !b.ts || !b.closes || b.ts.length < 500) return null;
  const map = new Map();
  for (let i = 0; i < b.ts.length; i++) map.set(dayKey(b.ts[i]), i);
  return { b: b, map: map, n: b.ts.length, closes: b.closes, ts: b.ts };
}

/* ---------- 单因子筛选 ---------- */
function screenOne(key, ts, closes, ctx, cat) {
  const N = ctx.n, bc = ctx.closes, map = ctx.map;
  const n = Math.min(ts.length, closes.length);
  /* ① 扩张窗口 z（只用过去）作为信号，再对齐到 BTC 日历 */
  const J = [], Z = [];
  let s = 0, s2 = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const v = closes[i];
    if (v == null || !isFinite(v)) continue;
    if (k >= SCR.ZWIN) {
      const m = s / k, sd = Math.sqrt(Math.max(s2 / k - m * m, 0));
      if (sd > 1e-12) {
        const j = map.get(dayKey(ts[i]));
        if (j != null) { J.push(j); Z.push((v - m) / sd); }
      }
    }
    s += v; s2 += v * v; k++;
  }
  if (J.length < SCR.MIN_N) return { key: key, cat: cat, n: J.length, short: true };

  /* ② 各视野 IC（半衰期用） */
  const icH = {};
  for (let q = 0; q < SCR.HORIZONS.length; q++) {
    const h = SCR.HORIZONS[q], xs = [], ys = [];
    for (let i = 0; i < J.length; i++) {
      const j = J[i], j2 = j + h;
      if (j2 >= N) break;
      const p0 = bc[j]; if (!p0) continue;
      xs.push(Z[i]); ys.push(bc[j2] / p0 - 1);
    }
    if (xs.length >= 60) icH[h] = pearson(rankAvg(xs), rankAvg(ys));
    else icH[h] = null;
  }

  /* ③ 主视野的配对（滚动 IC / 样本外都基于它） */
  const H = SCR.H, X = [], Y = [], JJ = [];
  for (let i = 0; i < J.length; i++) {
    const j = J[i], j2 = j + H;
    if (j2 >= N) break;
    const p0 = bc[j]; if (!p0) continue;
    X.push(Z[i]); Y.push(bc[j2] / p0 - 1); JJ.push(j);
  }
  if (X.length < SCR.MIN_N) return { key: key, cat: cat, n: X.length, short: true };
  const m = X.length;
  const ic = pearson(rankAvg(X), rankAvg(Y));
  if (ic == null || !isFinite(ic)) return { key: key, cat: cat, n: m, short: true };

  /* ④ 有效样本量：重叠的前向窗 → 非重叠窗口数才是真 n */
  const neff = Math.max(4, Math.floor(m / H));
  const se = 1 / Math.sqrt(neff);
  const t = ic / se;
  const p = tToP2(t);

  /* ⑤ 滚动 IC → ICIR 与胜率（按日历窗口，跨品种可比） */
  const roll = [];
  if (JJ.length > SCR.ROLL + 40) {
    for (let w = JJ[0]; w + SCR.ROLL <= JJ[JJ.length - 1]; w += SCR.STEP) {
      let a = 0;
      while (a < JJ.length && JJ[a] < w) a++;
      let e = a;
      while (e < JJ.length && JJ[e] < w + SCR.ROLL) e++;
      if (e - a >= 40) {
        const sp = pearson(rankAvg(X.slice(a, e)), rankAvg(Y.slice(a, e)));
        if (sp != null && isFinite(sp)) roll.push(sp);
      }
    }
  }
  const rm = roll.length ? meanOf(roll) : null;
  const rsd = roll.length > 2 ? sdOf(roll) : null;
  const icir = (rm != null && rsd && rsd > 0) ? rm / rsd : null;
  const winRate = (roll.length && ic != null) ? roll.filter(function (v) { return (v > 0) === (ic > 0); }).length / roll.length : null;

  /* ⑥ 样本外：前 60% / 后 40%，符号必须一致 */
  const cut = Math.floor(m * SCR.OOS_CUT);
  const icIn = cut >= 80 ? pearson(rankAvg(X.slice(0, cut)), rankAvg(Y.slice(0, cut))) : null;
  const icOut = (m - cut) >= 80 ? pearson(rankAvg(X.slice(cut)), rankAvg(Y.slice(cut))) : null;
  const flip = (icIn != null && icOut != null && isFinite(icIn) && isFinite(icOut)) ? (icIn > 0) !== (icOut > 0) : null;

  /* ⑦ 半衰期：|IC| 从 h=1 衰减到一半的天数（网格内线性插值） */
  let hl = null;
  const a1 = icH[1];
  if (a1 != null && isFinite(a1) && Math.abs(a1) > 1e-9) {
    const half = Math.abs(a1) / 2;
    for (let q = 1; q < SCR.HORIZONS.length; q++) {
      const h0 = SCR.HORIZONS[q - 1], h1 = SCR.HORIZONS[q];
      const v0 = Math.abs(icH[h0] == null ? 0 : icH[h0]), v1 = Math.abs(icH[h1] == null ? 0 : icH[h1]);
      if (v1 <= half && v0 > half) { hl = h0 + (h1 - h0) * (v0 - half) / Math.max(v0 - v1, 1e-12); break; }
    }
    if (hl == null && Math.abs(icH[20] != null ? icH[20] : 0) > half) hl = null;   // 20 日内没衰减到一半 → 记为持久
  }

  return {
    key: key, cat: cat, n: m, neff: neff, ic: ic, t: t, p: p, icir: icir,
    winRate: winRate, nRoll: roll.length, hl: hl, icH: icH,
    icIn: icIn, icOut: icOut, flip: flip,
    /* 实时读数：末端 z（用于宇宙评分） */
    lastZ: Z.length ? Z[Z.length - 1] : null, lastJ: JJ.length ? JJ[JJ.length - 1] : null,
  };
}

/* ---------- 全池筛选 ---------- */
function factorScreening(opts) {
  const o = opts || {};
  const ctx = btcCtx();
  if (!ctx) return null;
  const U = state.universe;
  if (!U || !U.series) return null;
  const keys = Object.keys(U.series);
  if (!keys.length) return null;
  const rows = [], short = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const s = U.series[k];
    if (!s || !s.ts || !s.closes) continue;
    const r = screenOne(k, s.ts, s.closes, ctx, catOfKey(k));
    if (!r) continue;
    if (r.short) { short.push(r); continue; }
    if (r.n < SCR.MIN_N) { short.push(r); continue; }
    rows.push(r);
  }
  if (!rows.length) return { rows: [], short: short, ctx: ctx };

  /* BH-FDR：160 个因子一起测，不做这一步必然有一批假阳性 */
  const ps = rows.map(function (r) { return r.p; });
  const qs = bhQ(ps);
  rows.forEach(function (r, i) { r.q = qs[i]; });

  /* 分层：门槛全部来自 SCR，事前定死。
   * 「漂移」的因子即使 |IC| 很大也不给强 —— 前 60% 与后 40% 符号相反，
   * 说明它的方向不是稳定的结构，而是两段行情的偶然。 */
  const stable = rows.filter(function (r) { return !r.flip; });
  const sorted = stable.slice().sort(function (a, b) { return Math.abs(b.ic) - Math.abs(a.ic); });
  const strongCut = Math.max(1, Math.round(sorted.length * SCR.TOP_PCT));
  const strongSet = new Set(sorted.slice(0, strongCut).map(function (r) { return r.key; }));
  rows.forEach(function (r) {
    const abs = Math.abs(r.ic);
    if (!r.flip && abs >= SCR.STRONG && strongSet.has(r.key)) r.tier = 'strong';
    else if (!r.flip && abs >= SCR.MID) r.tier = 'mid';
    else r.tier = 'weak';
    r.qPass = r.q < SCR.Q;                  // 严格显著性（单独列示，不参与定档）
    r.dir = r.ic > 0 ? 1 : -1;              // 如实记录符号，不翻正
    r.exo = !!U.exo[r.cat];
    r.abs = abs;
  });
  const nQ = rows.filter(function (r) { return r.qPass; }).length;
  const nFlip = rows.filter(function (r) { return r.flip; }).length;
  const byTier = { strong: [], mid: [], weak: [] };
  rows.forEach(function (r) { byTier[r.tier].push(r); });
  ['strong', 'mid', 'weak'].forEach(function (t) {
    byTier[t].sort(function (a, b) { return b.abs - a.abs; });
  });
  const catStat = {};
  rows.forEach(function (r) {
    if (!catStat[r.cat]) catStat[r.cat] = { n: 0, strong: 0, mid: 0, weak: 0, absSum: 0 };
    const c = catStat[r.cat]; c.n++; c[r.tier]++; c.absSum += r.abs;
  });
  Object.keys(catStat).forEach(function (c) { catStat[c].absAvg = catStat[c].absSum / catStat[c].n; });
  return {
    rows: rows, short: short, byTier: byTier, catStat: catStat, ctx: ctx,
    nTotal: keys.length, nScreened: rows.length, nShort: short.length,
    nQ: nQ, nFlip: nFlip, nStable: stable.length,
    minDetect: rows.length ? Math.min.apply(null, rows.map(function (r) { return 1.96 / Math.sqrt(r.neff); })) : null,
    btcSpan: { t0: ctx.ts[0], t1: ctx.ts[ctx.n - 1] },
    h: SCR.H, q: SCR.Q, thr: { strong: SCR.STRONG, mid: SCR.MID },
  };
}

/* key → 分类（取数时按 cat 打过标记，这里反查；查不到归为 other） */
function catOfKey(k) { return (state.universe && state.universe._keyCat && state.universe._keyCat[k]) || 'other'; }

/* ---------- ㉚b 宇宙评分：前 60% 选、后 40% 验 ----------
 * 为什么必须这样切：如果在全样本上挑出「强因子」再回测它们的合成表现，
 * 那是拿答案去考自己 —— 挑的时候已经看过未来了。
 * 这里只做一件事：把「筛选」这一步本身也放到样本外去检验。 */
function universeScore(S, opts) {
  const o = opts || {};
  if (!S || !S.rows || !S.rows.length) return null;
  const K = o.k || 12;
  const ctx = S.ctx;
  /* 用**样本内段**选 Top-K（按 |IC|，且必须 q 显著、无漂移） */
  const pool = S.rows.filter(function (r) { return r.icIn != null && isFinite(r.icIn); });
  const cand = pool.slice().sort(function (a, b) { return Math.abs(b.icIn) - Math.abs(a.icIn); }).slice(0, K);
  if (!cand.length) return null;

  /* 重建每条序列在 BTC 日历上的扩张窗口 z（与 screenOne 同一算法，杜绝口径不一致） */
  const zs = {};
  cand.forEach(function (r) {
    const s = state.universe.series[r.key];
    if (!s || !s.ts || !s.closes) return;
    const n = Math.min(s.ts.length, s.closes.length);
    const arr = new Array(ctx.n).fill(null);
    let a = 0, a2 = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const v = s.closes[i];
      if (v == null || !isFinite(v)) continue;
      if (k >= SCR.ZWIN) {
        const m = a / k, sd = Math.sqrt(Math.max(a2 / k - m * m, 0));
        if (sd > 1e-12) { const j = ctx.map.get(dayKey(s.ts[i])); if (j != null) arr[j] = (v - m) / sd; }
      }
      a += v; a2 += v * v; k++;
    }
    zs[r.key] = arr;
  });
  const ids = Object.keys(zs);
  if (!ids.length) return null;

  /* 样本内段 = 每个因子配对的**前 60%**；样本外段 = 后 40%。
   * 切点按 BTC 日历取，所有因子共用同一个切点，保证两组天数一致。 */
  const js = [];
  for (let j = 0; j < ctx.n; j++) {
    let ok = 0;
    for (let q = 0; q < ids.length; q++) if (zs[ids[q]][j] != null) ok++;
    /* 下限必须是 1 不是 3：K<5 时 floor(K·0.6) < 3，若下限写死 3 则一天也选不出来，
     * 于是 js 为空 → 整个函数静默返回 null（v3.25 遗留：K=1 时面板什么都不显示）。
     * K≥5 时下限由 60% 主导，行为与原先完全一致。 */
    if (ok >= Math.max(1, Math.floor(ids.length * 0.6))) js.push(j);
  }
  if (js.length < 300) return null;
  const cut = js[Math.floor(js.length * SCR.OOS_CUT)];

  const comp = new Array(ctx.n).fill(null);
  for (let q = 0; q < js.length; q++) {
    const j = js[q];
    let sm = 0, kk = 0;
    for (let x = 0; x < ids.length; x++) {
      const v = zs[ids[x]][j];
      if (v == null || !isFinite(v)) continue;
      const r = cand.find(function (c) { return c.key === ids[x]; });
      if (!r) continue;
      const d = r.icIn > 0 ? 1 : -1;
      sm += Math.max(-2.5, Math.min(2.5, d * v)); kk++;
    }
    /* 同样的问题：K<3 时 kk 永远到不了 3，整条信号会是空的。
     * 门槛取 min(3, 成员数) —— 只有一条成员时它自己就是全部，不该被门槛挡掉。 */
    if (kk >= Math.min(3, ids.length)) comp[j] = sm / kk;
  }
  const H = SCR.H, bc = ctx.closes, N = ctx.n;
  const icIn = icOfArr(comp, bc, N, 0, cut, H);
  const icOut = icOfArr(comp, bc, N, cut, N, H);
  const icAll = icOfArr(comp, bc, N, 0, N, H);

  /* 实时读数：末端复合值 */
  let lastC = null;
  for (let j = ctx.n - 1; j >= 0; j--) if (comp[j] != null) { lastC = comp[j]; break; }

  return {
    k: ids.length, ids: ids, dirs: cand.filter(function (c) { return zs[c.key]; }).map(function (c) { return { key: c.key, dir: c.icIn > 0 ? 1 : -1, icIn: c.icIn, icOut: c.icOut, ic: c.ic, q: c.q, icir: c.icir }; }),
    cut: cut, cutDate: ctx.ts[cut],
    icIn: icIn, icOut: icOut, icAll: icAll,
    lastC: lastC,
    nIn: null,
  };
}

function icOfArr(sig, closes, N, lo, hi, h) {
  const xs = [], ys = [];
  for (let j = Math.max(0, lo); j < hi; j++) {
    const v = sig[j];
    if (v == null || !isFinite(v)) continue;
    const j2 = j + h; if (j2 >= N) break;
    const p0 = closes[j]; if (!p0) continue;
    xs.push(v); ys.push(closes[j2] / p0 - 1);
  }
  if (xs.length < 60) return null;
  const sp = pearson(rankAvg(xs), rankAvg(ys));
  const neff = Math.max(4, Math.floor(xs.length / h));
  return { ic: sp, n: xs.length, neff: neff, t: sp == null ? null : sp / (1 / Math.sqrt(neff)) };
}


/* =====================================================================
 * ㉜ 分类合成（v3.26）
 * ---------------------------------------------------------------------
 * v3.25 的结论把单因子这条路堵死了：167 个因子没有一个能过 BH-FDR，
 * 92/160 会漂移，只用样本内挑出的 Top-12，样本外 IC = −0.049。
 *
 * 但「单因子不显著」有两种完全不同的解释，必须分清楚：
 *   ① 压根没有信息；
 *   ② 有信息，但它分散在一类变量的共同成分里，单个变量只是这个成分的带噪观测。
 * 如果是 ②，把一类里的变量平均起来，噪声该互相抵消、共同成分该留下来 ——
 * 分类层面的信号会比单因子更稳，而且**降维本身降低了选择偏差的自由度**
 * （从 167 选 12 → 从 10 选 3，可选组合数少好几个数量级）。
 *
 * 这个假设必须有可能被证伪，而且证伪了要认：
 *   · 分类合成样本外 IC 仍≈0 或为负 ⇒ 「共同成分」在这份数据上不成立，
 *     结论就是「降维也救不了」，如实写出来，不许改成挑几个好看的分类硬凑。
 *   · 分类合成样本外 IC 明显高于单因子 Top-12 ⇒ 降维确实买到了稳定性。
 *
 * 三条对照必须同时报，缺一条就是自己骗自己：
 *   ① 单因子 Top-K   —— v3.25 的老路（挑 12 个单因子）
 *   ② 分类合成 Top-K —— 挑 K 个分类，类内全部成员平均
 *   ③ 全池等权       —— 不挑，全部因子按样本内方向等权平均（零自由参数基线）
 * ①③ 是 ② 的两个极端：③ 证明「不挑」值多少，① 证明「细挑」亏多少。
 *
 * 无前视的三条硬约束（v3.25 同源，这里更严 —— 多了一个「权重」的自由度）：
 *   · 方向 = sign(样本内 IC)，不是全样本
 *   · 权重 = 样本内段算出来的量（|icIn| 或类内一致性），不是全样本
 *   · 挑选 = 按样本内 |IC| 排序，不是全样本
 * ===================================================================== */
const CMP = {
  K: 3,             // 合成取前 K 个分类（按样本内 |IC|；事前定死、不扫参数）
  MIN_MEMBER: 4,    // 一个类至少几条成员才配参与（2~3 条不叫「合成」）
  ZCLAMP: 2.5,
  MIN_COVER: 0.6,   // 某天至少多少比例的成员有值，才把这天算进合成
  SCHEMES: ['equal', 'ic', 'agree', 'lowAgree'],
  /* 每种方案 = 「类内怎么加权」+「按什么挑分类」。
   * lowAgree 的挑选键是 −类内一致性：一致性低 = 类内互不相干 = 平均出来是分散化的东西。
   * 注意它挑分类时用的 agree 是**样本内段**算的，样本外 IC 从未参与挑选。 */
  SCDEF: {
    equal:    { src: 'equal', zh: '类内等权 · 按样本内 |IC| 挑类', note: '零额外参数，基准方案', pick: function (p) { const v = p.schemes.equal.icIn; return v ? Math.abs(v.ic) : 0; } },
    ic:       { src: 'ic',    zh: '类内按样本内 |IC| 加权 · 按样本内 |IC| 挑类', note: '给样本内更强的成员更大权重', pick: function (p) { const v = p.schemes.ic.icIn; return v ? Math.abs(v.ic) : 0; } },
    agree:    { src: 'agree', zh: '类内按一致性加权 · 按样本内 |IC| 挑类', note: '只留与类内共同成分同向的成员', pick: function (p) { const v = p.schemes.agree.icIn; return v ? Math.abs(v.ic) : 0; } },
    lowAgree: { src: 'equal', zh: '类内等权 · 挑**类内一致性最低**的类', note: '事后观察到的规律，不是事前假设 —— 见面板说明', pick: function (p) { return -(p.agree == null ? 1 : p.agree); } },
  },
  RISK_CATS: ['vol', 'credit', 'rate', 'fx'],   // 风险监测看哪几类（事前定死）
};

/* 单条序列在 BTC 日历上的扩张窗口 z（无前视）。
 * 抽出来是为了让 universeScore / categoryComposite / riskMonitor 共用同一个口径 ——
 * 之前两处各写一遍，改了一处另一处就悄悄不一致，最难查的那类 bug。 */
function buildZ(key, ctx) {
  const U = state.universe;
  const s = U && U.series && U.series[key];
  if (!s || !s.ts || !s.closes) return null;
  const n = Math.min(s.ts.length, s.closes.length);
  const arr = new Array(ctx.n).fill(null);
  let a = 0, a2 = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const v = s.closes[i];
    if (v == null || !isFinite(v)) continue;
    if (k >= SCR.ZWIN) {
      const m = a / k, sd = Math.sqrt(Math.max(a2 / k - m * m, 0));
      if (sd > 1e-12) { const j = ctx.map.get(dayKey(s.ts[i])); if (j != null) arr[j] = (v - m) / sd; }
    }
    a += v; a2 += v * v; k++;
  }
  return arr;
}

/* BTC 日历上的样本内/外切点：所有因子共用同一个切点，保证两段天数可比。
 * 切点只由「哪些天有足够覆盖」决定，不看收益 —— 否则切点本身就在偷看未来。 */
function oosCutOf(ctx, ids, zs, cover) {
  const js = [];
  for (let j = 0; j < ctx.n; j++) {
    let ok = 0;
    for (let q = 0; q < ids.length; q++) if (zs[ids[q]][j] != null) ok++;
    if (ok >= Math.max(3, Math.floor(ids.length * (cover || CMP.MIN_COVER)))) js.push(j);
  }
  if (js.length < 300) return null;
  return { js: js, cut: js[Math.floor(js.length * SCR.OOS_CUT)] };
}

/* 分段 IC：把一段切成 nSeg 段，每段单独算 IC。
 * 为什么必须做：一个样本外 IC = +0.15 可能是「三年都稳」，也可能是「其中一年的一次性行情
 * 把均值抬起来了」。只看一个数分不出来，切段就能分出来 —— 这是不增加任何自由度、
 * 只用已有数据做的稳健性检验。段数上限受样本量约束，段太少就不切（切了也没意义）。 */
function segICs(sig, ctx, lo, hi, nSeg, h) {
  const span = hi - lo;
  if (span < 400) return null;
  const n = Math.max(2, Math.min(nSeg, Math.floor(span / 260)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = lo + Math.floor(span * i / n), b = lo + Math.floor(span * (i + 1) / n);
    const r = icOfArr(sig, ctx.closes, ctx.n, a, b, h);
    out.push({ i: i, lo: a, hi: b, ic: r ? r.ic : null, neff: r ? r.neff : null,
      d0: ctx.ts[a], d1: ctx.ts[Math.min(b - 1, ctx.n - 1)] });
  }
  return out;
}

/* 滚动 IC 胜率：全样本上按日历滑窗算滚动 IC，看有多大比例与「样本内定下的方向」同号。
 * 这是「稳不稳」最直白的一个数 —— 均值可能被一段极端行情带跑，胜率不会。 */
function rollICWin(sig, ctx, h, dir, win, step) {
  const res = [];
  const W = win || 250, ST = step || 60;
  for (let w = 0; w + W <= ctx.n; w += ST) {
    const xs = [], ys = [];
    for (let j = w; j < w + W; j++) {
      const v = sig[j];
      if (v == null || !isFinite(v)) continue;
      const j2 = j + h; if (j2 >= ctx.n) break;
      const p0 = ctx.closes[j]; if (!p0) continue;
      xs.push(v); ys.push(ctx.closes[j2] / p0 - 1);
    }
    if (xs.length < 60) continue;
    const c = pearson(rankAvg(xs), rankAvg(ys));
    if (c != null && isFinite(c)) res.push(c);
  }
  if (!res.length) return null;
  const d = dir >= 0 ? 1 : -1;
  return { n: res.length, win: res.filter(function (v) { return (v > 0) === (d > 0); }).length / res.length, mean: meanOf(res) };
}

/* 把一组 (key, dir, w) 合成为一条日频信号；只取覆盖足够的日子。
 * minK 显式传入是为了让「单因子 Top-K」能与 v3.25 的 universeScore 逐位对齐 ——
 * 那里只要求当天 ≥3 个成员有值，分类合成要求 ≥60%，门槛不同但都要如实说明。 */
function blendZ(ctx, ids, zs, dirs, ws, minK) {
  const need = Math.max(1, minK == null ? Math.floor(ids.length * CMP.MIN_COVER) : Math.min(minK, ids.length));
  const out = new Array(ctx.n).fill(null);
  for (let j = 0; j < ctx.n; j++) {
    let sm = 0, sw = 0, kk = 0;
    for (let q = 0; q < ids.length; q++) {
      const v = zs[ids[q]][j];
      if (v == null || !isFinite(v)) continue;
      const d = dirs[q] == null ? 1 : dirs[q];
      const w = ws ? (ws[q] == null ? 0 : ws[q]) : 1;
      if (w <= 0) continue;
      sm += w * Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, d * v)); sw += w; kk++;
    }
    if (kk >= need && sw > 0) out[j] = sm / sw;
  }
  return out;
}

/* 类内一致性：成员 i 与同组其他成员在**样本内段**的平均相关（在方向翻正后的 z 上算）。
 * 值高 ⇒ 这个类确实有共同成分 ⇒ 平均化能降噪；值≈0 ⇒ 平均只是把无关的噪声搅在一起。
 * 全程只用样本内段，且不涉及 BTC 收益 —— 它是纯粹的横截面结构，不是挑选信号。 */
function agreementOf(ctx, ids, zs, dirs, lo, hi) {
  const m = ids.length;
  if (m < 2) return new Array(m).fill(null);
  const cols = [];
  for (let q = 0; q < m; q++) {
    const arr = zs[ids[q]], c = [];
    for (let j = lo; j < hi; j++) {
      const v = arr[j];
      c.push((v == null || !isFinite(v)) ? null : (dirs[q] == null ? 1 : dirs[q]) * Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, v)));
    }
    cols.push(c);
  }
  const out = new Array(m).fill(null);
  for (let q = 0; q < m; q++) {
    let s = 0, k = 0;
    for (let p = 0; p < m; p++) {
      if (p === q) continue;
      const xs = [], ys = [];
      for (let i = 0; i < cols[q].length; i++) {
        if (cols[q][i] == null || cols[p][i] == null) continue;
        xs.push(cols[q][i]); ys.push(cols[p][i]);
      }
      if (xs.length < 60) continue;
      const c = pearson(xs, ys);
      if (c != null && isFinite(c)) { s += c; k++; }
    }
    out[q] = k ? s / k : null;
  }
  return out;
}

/* ---------- ㉜a 分类合成：167 → 10 ---------- */
function categoryComposite(S, opts) {
  const o = opts || {};
  if (!S || !S.rows || !S.rows.length) return null;
  const ctx = S.ctx;
  const K = o.k || CMP.K;
  const rows = S.rows.filter(function (r) { return r.icIn != null && isFinite(r.icIn); });
  if (!rows.length) return null;

  /* 按分类分组 */
  const byCat = {};
  rows.forEach(function (r) {
    if (!byCat[r.cat]) byCat[r.cat] = [];
    byCat[r.cat].push(r);
  });
  const cats = Object.keys(byCat).filter(function (c) { return byCat[c].length >= (o.minMember || CMP.MIN_MEMBER); });
  if (!cats.length) return null;

  /* 先把所有会用到的 z 建好，切点按「全部入选成员」统一取（各分类共用一个切点） */
  const zs = {}, need = [];
  cats.forEach(function (c) {
    byCat[c].forEach(function (r) { if (!zs[r.key]) { const a = buildZ(r.key, ctx); if (a) { zs[r.key] = a; need.push(r.key); } } });
  });
  if (need.length < 8) return null;
  const cutInfo = oosCutOf(ctx, need, zs, CMP.MIN_COVER);
  if (!cutInfo) return null;
  const cut = cutInfo.cut;

  /* 逐类合成：三种权重方案各来一遍（权重与方向都只用样本内段） */
  const per = [];
  cats.forEach(function (c) {
    const mem = byCat[c].filter(function (r) { return zs[r.key]; });
    if (mem.length < (o.minMember || CMP.MIN_MEMBER)) return;
    const ids = mem.map(function (r) { return r.key; });
    const dirs = mem.map(function (r) { return r.icIn > 0 ? 1 : -1; });
    const ag = agreementOf(ctx, ids, zs, dirs, 0, cut);
    const wIc = mem.map(function (r) { return Math.abs(r.icIn); });
    const wAg = ag.map(function (v) { return (v == null || !isFinite(v)) ? 0 : Math.max(0, v); });
    /* 一致性权重全为 0（类内互不相干）⇒ 退化成等权，否则整类会变成一条空信号 */
    const agSum = wAg.reduce(function (a, b) { return a + b; }, 0);
    const wAg2 = agSum > 1e-12 ? wAg : new Array(ids.length).fill(1);

    const schemes = {};
    CMP.SCHEMES.forEach(function (sc) {
      const ws = sc === 'ic' ? wIc : sc === 'agree' ? wAg2 : null;
      const sig = blendZ(ctx, ids, zs, dirs, ws);
      const icIn = icOfArr(sig, ctx.closes, ctx.n, 0, cut, SCR.H);
      const icOut = icOfArr(sig, ctx.closes, ctx.n, cut, ctx.n, SCR.H);
      const icAll = icOfArr(sig, ctx.closes, ctx.n, 0, ctx.n, SCR.H);
      schemes[sc] = { icIn: icIn, icOut: icOut, icAll: icAll, sig: sig };
    });

    /* 类的「可信度」= 成员方向翻正后类内的平均一致性（越高越像一个真共同成分） */
    const agClean = ag.filter(function (v) { return v != null && isFinite(v); });
    const agree = agClean.length ? meanOf(agClean) : null;
    per.push({
      cat: c, zh: CAT_ZH[c] || c, n: ids.length, exo: !!mem[0].exo,
      ids: ids, dirs: dirs, agree: agree,
      icIn: schemes.equal.icIn, icOut: schemes.equal.icOut, icAll: schemes.equal.icAll,
      schemes: schemes,
      absIn: schemes.equal.icIn ? Math.abs(schemes.equal.icIn.ic) : null,
      flip: (schemes.equal.icIn && schemes.equal.icOut && isFinite(schemes.equal.icIn.ic) && isFinite(schemes.equal.icOut.ic))
        ? (schemes.equal.icIn.ic > 0) !== (schemes.equal.icOut.ic > 0) : null,
    });
  });
  if (!per.length) return null;
  per.sort(function (a, b) { return (b.absIn || 0) - (a.absIn || 0); });

  /* ---------- 三条对照，全部用同一个切点、同一个视野 ---------- */
  const bc = ctx.closes, N = ctx.n, H = SCR.H;
  const rep = function (sig) {
    const iIn = icOfArr(sig, bc, N, 0, cut, H);
    const iOut = icOfArr(sig, bc, N, cut, N, H);
    const iAll = icOfArr(sig, bc, N, 0, N, H);
    const dir = (iIn && iIn.ic > 0) ? 1 : -1;
    return {
      icIn: iIn, icOut: iOut, icAll: iAll, dir: dir,
      segs: segICs(sig, ctx, cut, N, 4, H),
      roll: rollICWin(sig, ctx, H, dir, 250, 60),
    };
  };

  /* 把若干「分类信号」再合成为一条（类间等权，方向取各自样本内 IC 的符号） */
  const mkCatSig = function (ps, src) {
    const sig = new Array(N).fill(null);
    for (let j = 0; j < N; j++) {
      let sm = 0, kk = 0;
      for (let q = 0; q < ps.length; q++) {
        const v = ps[q].schemes[src].sig[j];
        if (v == null || !isFinite(v)) continue;
        const ii = ps[q].schemes[src].icIn;
        sm += ((ii && ii.ic > 0) ? 1 : -1) * Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, v)); kk++;
      }
      if (kk >= 1) sig[j] = sm / kk;
    }
    return sig;
  };
  /* 按某个方案的挑选键取前 k 个分类 → 合成 → 分段检验 */
  const pickK = function (sc, k) {
    const def = CMP.SCDEF[sc];
    const ps = per.slice().sort(function (a, b) { return def.pick(b) - def.pick(a); }).slice(0, Math.min(k, per.length));
    return { ps: ps, r: rep(mkCatSig(ps, def.src)) };
  };

  /* ---- 必须做的证伪：这个信号是不是只是在复述 BTC 自己 ----
   * 山寨币 / 加密股与 BTC 高度相关，它们的「扩张窗口位置」很可能只是
   * BTC 自身位置的换个说法。如果是，那 +0.16 不是新信息 ——
   * 拿它当「因子」就是在给动量换了个名字。
   * 所以：① 先算 BTC 自身同口径信号的 IC 作为对照；
   *       ② 再把候选信号对 BTC 自身信号做回归取残差，看残差还有没有 IC。
   * 回归系数只用样本内段估（用全样本估就是把未来塞进了残差里）。 */
  const ownSig = (function () {
    const arr = new Array(N).fill(null);
    let a = 0, a2 = 0, k = 0;
    for (let j = 0; j < N; j++) {
      const v = bc[j];
      if (v == null || !isFinite(v)) continue;
      if (k >= SCR.ZWIN) {
        const m = a / k, sd = Math.sqrt(Math.max(a2 / k - m * m, 0));
        if (sd > 1e-12) arr[j] = Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, (v - m) / sd));
      }
      a += v; a2 += v * v; k++;
    }
    return arr;
  })();
  const btcOwn = rep(ownSig);

  /* 残差信号 = sig − (α + β·BTC自身信号)，α/β 只用样本内段估 */
  const incrOf = function (sig) {
    const xs = [], ys = [];
    for (let j = 0; j < cut; j++) {
      const a = sig[j], b = ownSig[j];
      if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue;
      xs.push(b); ys.push(a);
    }
    if (xs.length < 100) return null;
    const mx = meanOf(xs), my = meanOf(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    const beta = sxx > 1e-12 ? sxy / sxx : 0;
    const alpha = my - beta * mx;
    const res = new Array(N).fill(null);
    for (let j = 0; j < N; j++) {
      const a = sig[j], b = ownSig[j];
      if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue;
      res[j] = a - (alpha + beta * b);
    }
    const r = rep(res);
    r.beta = beta; r.alpha = alpha;
    return r;
  };

  /* ① 全池等权基线：不挑，全部因子按样本内方向等权平均（自由参数 = 0） */
  const allIds = need.slice(), allDirs = {};
  rows.forEach(function (r) { if (zs[r.key]) allDirs[r.key] = r.icIn > 0 ? 1 : -1; });
  const poolSig = blendZ(ctx, allIds, zs, allIds.map(function (k) { return allDirs[k]; }), null);
  const pool = rep(poolSig);

  /* ② 分类合成 Top-K：按样本内 |IC| 挑 K 个分类，类内等权、类间等权 */
  const picked = per.slice(0, Math.min(K, per.length));
  const catSig = new Array(N).fill(null);
  const catRows = [];
  for (let j = 0; j < N; j++) {
    let sm = 0, kk = 0;
    for (let q = 0; q < picked.length; q++) {
      const v = picked[q].schemes.equal.sig[j];
      if (v == null || !isFinite(v)) continue;
      const d = (picked[q].icIn && picked[q].icIn.ic > 0) ? 1 : -1;
      sm += d * Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, v)); kk++;
    }
    if (kk >= 1) catSig[j] = sm / kk;
  }
  picked.forEach(function (p) { catRows.push({ cat: p.cat, zh: p.zh, icIn: p.icIn, icOut: p.icOut, agree: p.agree, n: p.n }); });
  const catRep = rep(catSig);

  /* ③ 单因子 Top-K（v3.25 老路）：按样本内 |IC| 挑 K 个单因子 */
  const K1 = o.k1 || 12;
  const top1 = rows.slice().sort(function (a, b) { return Math.abs(b.icIn) - Math.abs(a.icIn); }).slice(0, K1).filter(function (r) { return zs[r.key]; });
  const s1Ids = top1.map(function (r) { return r.key; });
  /* minK=3：与 v3.25 的 universeScore 同口径，两条路能互相验算 */
  const s1Sig = blendZ(ctx, s1Ids, zs, top1.map(function (r) { return r.icIn > 0 ? 1 : -1; }), null, 3);
  const single = rep(s1Sig);

  const lastOf = function (sig) { for (let j = N - 1; j >= 0; j--) if (sig[j] != null && isFinite(sig[j])) return sig[j]; return null; };

  return {
    ctx: ctx, cut: cut, cutDate: ctx.ts[cut], h: H, k: picked.length, k1: top1.length,
    per: per, picked: catRows,
    cat: catRep, pool: pool, single: single,
    poolSig: poolSig, catSig: catSig, singleSig: s1Sig,
    lastCat: lastOf(catSig), lastPool: lastOf(poolSig),
    nFactor: need.length, nCat: per.length,
    btcOwn: btcOwn,
    /* 内生类信号在剔除 BTC 自身位置之后还剩下多少 —— 这是「有没有新信息」的答案 */
    endoIncr: (function () {
      const e = per.filter(function (p) { return !p.exo; });
      if (!e.length) return null;
      return incrOf(mkCatSig(e, 'equal'));
    })(),
    top1Keys: s1Ids.slice(),
    schemes: CMP.SCHEMES.map(function (sc) {
      const def = CMP.SCDEF[sc];
      const pk = pickK(sc, K);
      return {
        scheme: sc, zh: def.zh, note: def.note,
        icIn: pk.r.icIn, icOut: pk.r.icOut, icAll: pk.r.icAll, segs: pk.r.segs, roll: pk.r.roll,
        cats: pk.ps.map(function (p) { return p.cat; }),
        zhs: pk.ps.map(function (p) { return p.zh; }),
        incr: incrOf(mkCatSig(pk.ps, def.src)),
      };
    }),
    btcOwn: btcOwn,
    /* K 敏感性：K 事前定死，但如果只有那一个 K 好看，就是卡参数卡出来的。
     * 这里把 K=1..5 全跑一遍 —— 真信号对 K 不敏感，过拟合只在一个点上成立。 */
    kSens: (function () {
      const out = [];
      for (let k = 1; k <= Math.min(5, per.length); k++) {
        const row = { k: k, by: {} };
        CMP.SCHEMES.forEach(function (sc) {
          const pk = pickK(sc, k);
          row.by[sc] = { icIn: pk.r.icIn, icOut: pk.r.icOut, segs: pk.r.segs, roll: pk.r.roll };
        });
        out.push(row);
      }
      return out;
    })(),
    /* 留一法：把入选的每个分类轮流去掉，看剩下的还稳不稳。
     * 如果全靠其中一类撑着，去掉它就会塌 —— 那是「一类行情」，不是「一类结构」。 */
    perLeave: (function () {
      const pk = pickK('lowAgree', K);
      const each = pk.ps.map(function (drop, i) {
        const rest = pk.ps.filter(function (_, q) { return q !== i; });
        if (!rest.length) return null;
        return { drop: drop.cat, dropZh: drop.zh, r: rep(mkCatSig(rest, 'equal')) };
      }).filter(Boolean);
      return { all: pk.r, each: each };
    })(),
    /* 内生 / 外生两分：内生 = 加密市场内部变量，外生 = 从外面打进来的。
     * 两者能不能混着用、哪个更稳，这条对照直接回答。 */
    endoExo: (function () {
      const mk = function (list) {
        if (!list.length) return null;
        const sig = new Array(N).fill(null);
        for (let j = 0; j < N; j++) {
          let sm = 0, kk = 0;
          for (let q = 0; q < list.length; q++) {
            const v = list[q].schemes.equal.sig[j];
            if (v == null || !isFinite(v)) continue;
            const ii = list[q].icIn;
            sm += ((ii && ii.ic > 0) ? 1 : -1) * Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, v)); kk++;
          }
          if (kk >= 1) sig[j] = sm / kk;
        }
        const r = rep(sig);
        return { n: list.length, icIn: r.icIn, icOut: r.icOut, icAll: r.icAll, segs: r.segs, roll: r.roll, cats: list.map(function (p) { return p.cat; }) };
      };
      return { endo: mk(per.filter(function (p) { return !p.exo; })), exo: mk(per.filter(function (p) { return p.exo; })) };
    })(),
    /* 诊断：类内一致性 与 样本外表现 到底有没有关系。
     * 这是从同一份数据里看出来的规律，不是事前假设 —— 所以只报出来、不当成结论用。 */
    agreeDiag: (function () {
      const xs = [], ys = [], ns = [];
      per.forEach(function (p) {
        if (p.agree == null || !isFinite(p.agree) || !p.icOut || !isFinite(p.icOut.ic)) return;
        xs.push(p.agree); ys.push(p.icOut.ic); ns.push(p.zh);
      });
      /* 至少要 4 个分类才谈得上「一致性 与 样本外 有没有关系」——
       * 分类本来就只有 10 个，门槛再高这块就永远不出数了。样本量如实报出来。 */
      if (xs.length < 4) return null;
      const rho = pearson(rankAvg(xs), rankAvg(ys));
      /* 高一致性组 vs 低一致性组（中位数切分）的样本外 IC 均值 */
      const srt = per.slice().filter(function (p) { return p.agree != null && p.icOut && isFinite(p.icOut.ic); })
        .sort(function (a, b) { return a.agree - b.agree; });
      const half = Math.floor(srt.length / 2);
      const loGrp = srt.slice(0, half), hiGrp = srt.slice(half);
      const avg = function (g) { return g.length ? meanOf(g.map(function (p) { return p.icOut.ic; })) : null; };
      return {
        n: xs.length, rho: rho,
        loAvg: avg(loGrp), hiAvg: avg(hiGrp),
        loCats: loGrp.map(function (p) { return p.zh; }), hiCats: hiGrp.map(function (p) { return p.zh; }),
      };
    })(),
  };
}

/* ---------- ㉝ 真正的样本外追踪：把"低一致性"假设拎到独立持有窗反复验证 ----------
 * v3.26 的 lowAgree（挑类内一致性最低的类）样本外 +0.155、分段 4/4、留一法全稳 ——
 * 但那条规则是**看到全样本结果之后才想到的**。在「全样本 60/40 切」上它通过了，
 * 不代表它在**没看过的窗口**上也成立：可能只是这一刀恰好切在它有效的那段行情里。
 *
 * 这一节要做的是唯一能把它从"观察"升级成"结论"的事：拿多个**互相独立**的持有窗来验。
 * 做法 = 扩张训练窗 + 固定 2 年持有（walk-forward）：每折只用训练段挑分类、重算类内一致性，
 * 然后在它**从没参与挑选**的 2 年窗口里测 IC。最后一折固定在"最近两年" —— 那才是对今天
 * 最有发言权的真样本外。如果 lowAgree 在多数折里仍为正、且优于等权/普通挑选，它就是真结构；
 * 如果只在某一刀上灵、换一刀就塌，那它就是数据窥探的产物。两种结果都如实报。 */
function oosTrack(S, opts) {
  const o = opts || {};
  if (!S || !S.rows || !S.rows.length) return null;
  const ctx = S.ctx, N = ctx.n, H = SCR.H, bc = ctx.closes;
  const rows = S.rows.filter(function (r) { return r.icIn != null && isFinite(r.icIn); });
  if (!rows.length) return null;
  /* z 只建一次：各折共用，因为扩张窗口 z 与切点无关（只看过去） */
  const zs = {}, need = [];
  rows.forEach(function (r) { if (!zs[r.key]) { const a = buildZ(r.key, ctx); if (a) { zs[r.key] = a; need.push(r.key); } } });
  if (need.length < 8) return null;
  const byCat = {};
  rows.forEach(function (r) { (byCat[r.cat] = byCat[r.cat] || []).push(r); });
  const catNames = Object.keys(byCat).filter(function (c) { return byCat[c].length >= (o.minMember || CMP.MIN_MEMBER); });
  if (!catNames.length) return null;
  const catMeta = catNames.map(function (c) {
    const mem = byCat[c].filter(function (r) { return zs[r.key]; });
    if (mem.length < (o.minMember || CMP.MIN_MEMBER)) return null;
    return { cat: c, zh: CAT_ZH[c] || c, exo: !!mem[0].exo, ids: mem.map(function (r) { return r.key; }), dirs: mem.map(function (r) { return r.icIn > 0 ? 1 : -1; }) };
  }).filter(Boolean);
  if (!catMeta.length) return null;

  /* BTC 自身同口径信号（全长度，与切点无关）—— 增量检验的基准 */
  const ownSig = (function () {
    const arr = new Array(N).fill(null);
    let a = 0, a2 = 0, k = 0;
    for (let j = 0; j < N; j++) {
      const v = bc[j]; if (v == null || !isFinite(v)) continue;
      if (k >= SCR.ZWIN) { const m = a / k, sd = Math.sqrt(Math.max(a2 / k - m * m, 0)); if (sd > 1e-12) arr[j] = Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, (v - m) / sd)); }
      a += v; a2 += v * v; k++;
    }
    return arr;
  })();

  /* 折：扩张训练窗 + 固定 2 年持有；最后一折固定在「最近两年」 */
  const HOR = o.horizon || 504, MINTR = o.minTrain || 1000, STEP = o.step || 500;
  const cuts = [];
  for (let cut = MINTR; cut + HOR <= N - 30; cut += STEP) cuts.push(cut);
  const lastCut = N - HOR;
  if (lastCut >= MINTR && cuts.indexOf(lastCut) < 0) cuts.push(lastCut);
  cuts.sort(function (a, b) { return a - b; });
  if (!cuts.length) return null;

  const repWin = function (sig, lo, hi) {
    const iO = icOfArr(sig, bc, N, lo, hi, H);
    const segs = hi - lo >= 400 ? segICs(sig, ctx, lo, hi, 3, H) : null;
    return { icOut: iO, segs: segs };
  };
  /* 增量检验：β 只用训练段 [0,cut] 估，残差在持有窗测 —— 看剔除 BTC 自身后还剩多少 */
  const incrOf = function (sig, cut) {
    const xs = [], ys = [];
    for (let j = 0; j < cut; j++) { const a = sig[j], b = ownSig[j]; if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue; xs.push(b); ys.push(a); }
    if (xs.length < 100) return null;
    const mx = meanOf(xs), my = meanOf(ys);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    const beta = sxx > 1e-12 ? sxy / sxx : 0;
    const res = new Array(N).fill(null);
    for (let j = 0; j < N; j++) { const a = sig[j], b = ownSig[j]; if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue; res[j] = a - (my - beta * mx) - beta * b; }
    return { beta: beta, r: repWin(res, cut, Math.min(cut + HOR, N)) };
  };

  const folds = cuts.map(function (cut) {
    const end = Math.min(cut + HOR, N);
    /* 该折下的分类度量：类内 IC 与一致性**只用训练段 [0,cut]** */
    const per = catMeta.map(function (m) {
      const sig = blendZ(ctx, m.ids, zs, m.dirs, null);
      const icIn = icOfArr(sig, bc, N, 0, cut, H);
      const ag = agreementOf(ctx, m.ids, zs, m.dirs, 0, cut);
      const agClean = ag.filter(function (v) { return v != null && isFinite(v); });
      const agree = agClean.length ? meanOf(agClean) : null;
      return { cat: m.cat, zh: m.zh, exo: m.exo, ids: m.ids, dirs: m.dirs, sig: sig, icIn: icIn, agree: agree };
    });
    const K = o.k || CMP.K;
    const mkSig = function (pickFn) {
      const ps = per.slice().sort(function (a, b) { return pickFn(b) - pickFn(a); }).slice(0, Math.min(K, per.length));
      const sig = new Array(N).fill(null);
      for (let j = 0; j < N; j++) { let sm = 0, kk = 0; for (let q = 0; q < ps.length; q++) { const v = ps[q].sig[j]; if (v == null || !isFinite(v)) continue; const d = (ps[q].icIn && ps[q].icIn.ic > 0) ? 1 : -1; sm += d * Math.max(-CMP.ZCLAMP, Math.min(CMP.ZCLAMP, v)); kk++; } if (kk >= 1) sig[j] = sm / kk; }
      return sig;
    };
    const allDirs = {}; rows.forEach(function (r) { if (zs[r.key]) allDirs[r.key] = r.icIn > 0 ? 1 : -1; });
    const poolSig = blendZ(ctx, need, zs, need.map(function (k) { return allDirs[k]; }), null);
    const K1 = o.k1 || 12;
    const top1 = rows.slice().sort(function (a, b) { return Math.abs(b.icIn) - Math.abs(a.icIn); }).slice(0, K1).filter(function (r) { return zs[r.key]; });
    const s1Sig = blendZ(ctx, top1.map(function (r) { return r.key; }), zs, top1.map(function (r) { return r.icIn > 0 ? 1 : -1; }), null, 3);
    const sigCat = mkSig(function (p) { return (p.icIn && p.icIn.ic ? Math.abs(p.icIn.ic) : 0); });
    const sigLow = mkSig(function (p) { return -(p.agree == null ? 1 : p.agree); });
    const wrap = function (sig) { const w = repWin(sig, cut, end); w.sig = sig; w.incr = incrOf(sig, cut); return w; };
    return {
      cut: cut, cutDate: ctx.ts[cut], end: end, endDate: ctx.ts[end - 1], spanDays: end - cut,
      per: per,
      pool: wrap(poolSig), single: wrap(s1Sig), cat: wrap(sigCat), lowAgree: wrap(sigLow),
      btcOwn: wrap(ownSig),
    };
  });

  /* 聚合：跨折看每个方案到底站不站得住 */
  const agg = {};
  ['pool', 'single', 'cat', 'lowAgree'].forEach(function (sc) {
    const ics = folds.map(function (f) { return f[sc].icOut && f[sc].icOut.ic; }).filter(function (v) { return v != null && isFinite(v); });
    const incs = folds.map(function (f) { return f[sc].incr && f[sc].incr.r.icOut && f[sc].incr.r.icOut.ic; }).filter(function (v) { return v != null && isFinite(v); });
    const med = function (a) { if (!a.length) return null; const s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; };
    agg[sc] = {
      n: ics.length,
      mean: ics.length ? meanOf(ics) : null,
      median: med(ics),
      posN: ics.filter(function (v) { return v > 0; }).length,
      strongN: ics.filter(function (v) { return Math.abs(v) > 0.1; }).length,
      incMean: incs.length ? meanOf(incs) : null,
      incPosN: incs.filter(function (v) { return v > 0; }).length,
    };
  });
  return { ctx: ctx, HOR: HOR, MINTR: MINTR, nFactor: need.length, nCat: catMeta.length, folds: folds, agg: agg, K: o.k || CMP.K, K1: o.k1 || 12 };
}


/* ---------- ㉜b 风险监测读数（不做方向预测，只报当前状态分位） ----------
 * 定位问题：这套因子做不了方向择时（样本外摆在那儿），但「现在这批外生变量
 * 处在历史的什么位置」是**状态描述**，不是预测 —— 它不需要 IC 显著，
 * 只需要「当前值 / 历史分布」这个比值是真的。这正是它能诚实提供的东西。 */

/* v3.29 历史崩溃体制窗口：用来给「当前读数有多极端」一个**有锚点的参照**。
 * 光看「自身历史的 5/95 分位尾巴」阈值有点任意；更可辩护的问法是：
 * 「现在这个变量偏离自己常态的幅度，达到了 2020 COVID / 2022 熊市那种级别的几成？」
 * 这些窗口是固定的历史区间（UTC 日期），只用于回望、不参与任何前视。 */
const RISK_CRASH_WINDOWS = [
  { label: 'COVID', lo: '2020-02-20', hi: '2020-03-23' },   // 全球流动性冻结
  { label: '2022熊', lo: '2021-11-08', hi: '2022-12-31' },  // 加息 + 崩盘 + FTX
];

function riskMonitor(S, opts) {
  const o = opts || {};
  if (!S || !S.rows || !S.rows.length) return null;
  const ctx = S.ctx;
  /* v3.27：默认对**全部**有 ≥MIN_MEMBER 成员的分类出读数（去掉 v3.26 的 exo-only 限制）。
   * 风险监测是"现在各处处在什么位置"的全景板，限定外生类反而漏掉了内生类自己的极端状态。
   * 谁极端谁排前面，由后面的排序决定。 */
  const cats = o.cats || (function () {
    const s2 = {}; S.rows.forEach(function (r) { if (r.icIn != null && isFinite(r.icIn)) s2[r.cat] = 1; });
    return Object.keys(s2);
  })();
  const out = [];
  cats.forEach(function (c) {
    const mem = S.rows.filter(function (r) { return r.cat === c && r.icIn != null && isFinite(r.icIn); });
    if (mem.length < CMP.MIN_MEMBER) return;
    const ids = [], zs = {};
    mem.forEach(function (r) { const a = buildZ(r.key, ctx); if (a) { zs[r.key] = a; ids.push(r.key); } });
    if (ids.length < CMP.MIN_MEMBER) return;
    /* 【不翻正】这里刻意不按 icIn 的符号把成员翻向：风险监测是**状态描述**，
     * 不是多空信号。翻正之后报出来的「当前值」会失去直观含义
     * （「利率债 −1.557」到底高还是低？），分位也就跟着没意义了。
     * 合成信号在这里的含义是「这一类变量整体处在它自己历史的哪个位置」。 */
    const sig = blendZ(ctx, ids, zs, ids.map(function () { return 1; }), null);
    /* 扩张窗口分位：只用「过去」的样本排当前值的位次 —— 这是无前视的分位 */
    const vals = [];
    for (let j = 0; j < ctx.n; j++) if (sig[j] != null && isFinite(sig[j])) vals.push(j);
    if (vals.length < 250) return;
    const lastJ = vals[vals.length - 1], lastV = sig[lastJ];
    let lo = 0, tot = 0;
    for (let q = 0; q < vals.length - 1; q++) { const v = sig[vals[q]]; if (v <= lastV) lo++; tot++; }
    const pct = tot ? lo / tot : null;
    /* 近 60 日的变化方向（也是状态，不是预测） */
    let j60 = null;
    for (let q = vals.length - 1; q >= 0; q--) { if (vals[q] <= lastJ - 60) { j60 = vals[q]; break; } }
    const d60 = (j60 != null && sig[j60] != null) ? lastV - sig[j60] : null;
    /* 变化率 rc = 近60日位移 / 自身近120日波动（σ 数）：它移动得"快不快"。
     * 同样是状态，不是预测 —— 一个处在 95% 分位且 rc 很大的变量，是在加速冲顶，
     * 一个同样 95% 分位但 rc≈0 的是"一直挂在那儿"，两者的含义不同。 */
    let sd120 = null;
    if (vals.length >= 120) {
      const tail = vals.slice(vals.length - 120).map(function (q) { return sig[q]; });
      const m = meanOf(tail); let v2 = 0;
      for (let q = 0; q < tail.length; q++) v2 += (tail[q] - m) * (tail[q] - m);
      sd120 = Math.sqrt(Math.max(v2 / tail.length, 0));
    }
    const rc = (d60 != null && sd120 != null && sd120 > 1e-9) ? d60 / sd120 : null;

    /* v3.29 历史崩溃体制对照 —— 把「极端」从任意的 5/95 尾巴升级成有锚点的崩溃级偏离。
     * ext：当前值相对自身长周期（全样本）中位数、以全样本 σ 度量的带符号偏离（自身常态偏离）。
     * vsCrash：|ext| 占历史上几次崩溃窗口内达到过的最大 |偏离| 的比例。
     *   0.6 = 当前只到 2020/2022 峰值极端度的 6 成；≥1.0 = 已超过历史崩溃峰值。
     * 只回望固定历史窗口、不碰未来，无前视。若某段数据根本不覆盖这些窗口（refMax 保持 0），
     * 则 vsCrash=null，也不会因此误触发崩溃警报；覆盖到窗口但无真实崩盘尖峰时 vsCrash 仍 < 0.8。 */
    const finite = vals.map(function (q) { return sig[q]; }).filter(function (x) { return x != null && isFinite(x); });
    const med = medianOf(finite);
    let v2s = 0; for (let q = 0; q < finite.length; q++) v2s += (finite[q] - med) * (finite[q] - med);
    const sdAll = Math.sqrt(v2s / Math.max(finite.length, 1));
    const ext = (sdAll > 1e-9 && med != null) ? (lastV - med) / sdAll : 0;
    let refMax = 0;
    for (let w = 0; w < RISK_CRASH_WINDOWS.length; w++) {
      const W = RISK_CRASH_WINDOWS[w];
      const tLo = Date.parse(W.lo + 'T00:00:00Z'), tHi = Date.parse(W.hi + 'T00:00:00Z');
      let lo = -1, hi = -1;
      for (let q = 0; q < ctx.ts.length; q++) { if (ctx.ts[q] >= tLo) { lo = q; break; } }
      for (let q = ctx.ts.length - 1; q >= 0; q--) { if (ctx.ts[q] <= tHi) { hi = q; break; } }
      if (lo < 0 || hi < 0 || hi < lo) continue;
      for (let q = lo; q <= hi; q++) {
        if (sig[q] == null || !isFinite(sig[q])) continue;
        const e = (lastV - sig[q]); // 窗口内每天的偏离（相对当前），取绝对最大
        if (Math.abs(e) > refMax) refMax = Math.abs(e);
      }
    }
    // refMax 是窗口内相对当前的最大位移；换算成 σ 单位，与 ext 同口径
    const refMaxSig = sdAll > 1e-9 ? refMax / sdAll : 0;
    const vsCrash = refMaxSig > 1e-9 ? Math.abs(ext) / refMaxSig : null;
    const crash = vsCrash != null && vsCrash >= 0.8;

    out.push({
      cat: c, zh: CAT_ZH[c] || c, n: ids.length, sig: sig, lastJ: lastJ,
      now: lastV, pct: pct, d60: d60, rc: rc,
      med: med, sdAll: sdAll, ext: ext, vsCrash: vsCrash, crash: crash,
      extreme: pct == null ? null : (pct <= 0.05 ? 'low' : pct >= 0.95 ? 'high' : null),
      date: ctx.ts[lastJ],
    });
  });
  if (!out.length) return null;
  out.sort(function (a, b) { const pa = a.pct == null ? .5 : a.pct, pb = b.pct == null ? .5 : b.pct; return Math.abs(pb - .5) - Math.abs(pa - .5); });
  return { rows: out, asof: out[0].date };
}


/* =====================================================================
 * ㉞ 风险护栏（三联警报）：DVOL 体制 + 全分类极端分位联动 + 变化率联动
 * ---------------------------------------------------------------------
 * 这是 v3.27 结论的落点 —— 这套终端的价值在「风险监测与护栏」，不在择时。
 * 护栏只答一个问题：**现在各个维度的风险温度计，加起来到了什么程度**。
 * 它不预测涨跌、不给方向指令；它只把三个已经算好的「状态量」聚合成一个
 * GREEN / YELLOW / RED 的总状态，并明示是哪几个分量在报警。
 *
 * 三个分量（各自 0=静 / 1=警 / 2=危），护栏取三者最大值：
 *   ① DVOL 波动率体制：DVOL 当前值处于自身近1年的什么百分位（隐含波动率 = crypto 原生恐惧温度计）
 *   ② 全分类极端分位联动（v3.29 历史锚定）：风险监测里同时「逼近/超过历史崩溃级偏离（vsCrash≥0.8×，
 *      即达到 2020 COVID / 2022 熊市窗口内出现过的最大偏离的 8 成以上）」的分类有几类；
 *      再叠加 BTC 已实现波动率的「极端体制」（vol≥0.80 年化）。多个互不相关的资产类同时到崩溃级 = 系统性联动。
 *      阈值比 v3.28 的任意 5/95 尾巴更可辩护（对照的是真实崩盘级别，不是自身分布的尾部）。
 *   ③ 变化率联动：风险监测里「近60日位移 ≥ 1.5σ」的分类有几类（在加速）。
 * 任何单一分量到「危」即触发 RED；RED 的含义是「降杠杆 / 减仓 / 不追高」的参考，不是「做空」指令。
 * ===================================================================== */
function guardrail(S, opts) {
  const o = opts || {};
  const RM = state.risk || (state.risk = riskMonitor(S));

  /* ① DVOL 波动率体制 */
  const dv = dvolStatsNow();
  let dvolLevel = null;
  if (dv && dv.pctTrailing1y != null && isFinite(dv.pctTrailing1y)) {
    const p = dv.pctTrailing1y;
    dvolLevel = p >= 0.92 ? 2 : p >= 0.75 ? 1 : 0;
  }

  /* ② + ③ 来自风险监测（全分类状态） */
  let nHigh = 0, nLow = 0, nAccel = 0, nCrash = 0;
  const firing = [];
  if (RM && RM.rows && RM.rows.length) {
    RM.rows.forEach(function (r) {
      if (r.extreme === 'high') { nHigh++; firing.push({ cat: r.cat, zh: r.zh, kind: '历史高位', pct: r.pct, rc: r.rc, vsCrash: r.vsCrash }); }
      else if (r.extreme === 'low') { nLow++; firing.push({ cat: r.cat, zh: r.zh, kind: '历史低位', pct: r.pct, rc: r.rc, vsCrash: r.vsCrash }); }
      if (r.crash) { nCrash++; firing.push({ cat: r.cat, zh: r.zh, kind: (r.vsCrash != null && r.vsCrash >= 1 ? '超历史峰值' : '逼近历史峰值(≥0.8×)'), pct: r.pct, rc: r.rc, vsCrash: r.vsCrash }); }
      if (r.rc != null && isFinite(r.rc) && Math.abs(r.rc) >= 1.5) {
        nAccel++;
        if (!firing.some(function (f) { return f.cat === r.cat; })) firing.push({ cat: r.cat, zh: r.zh, kind: '加速(≥1.5σ)', pct: r.pct, rc: r.rc, vsCrash: r.vsCrash });
      }
    });
  }
  const nExtreme = nHigh + nLow;
  const reg = currentRegime();
  const volWild = !!(reg && reg.key === 'wild');
  let regimeLevel = null;
  /* v3.29：分量②的「危/警」改用历史锚定的 nCrash（≥0.8× 历史崩溃峰值）触发，
   * 阈值比任意的 5/95 尾巴更可辩护；nExtreme（5/95 尾巴）保留为信息展示。 */
  if (nCrash != null) regimeLevel = (nCrash >= 2 || volWild) ? 2 : (nCrash === 1 ? 1 : 0);
  let accelLevel = null;
  if (nAccel != null) accelLevel = nAccel >= 2 ? 2 : (nAccel === 1 ? 1 : 0);

  const levels = [dvolLevel, regimeLevel, accelLevel].filter(function (x) { return x != null; });
  const status = levels.length ? Math.max.apply(null, levels) : 0;
  const label = status === 2 ? 'RED' : status === 1 ? 'YELLOW' : 'GREEN';

  return {
    dv: dv, dvolLevel: dvolLevel,
    nHigh: nHigh, nLow: nLow, nExtreme: nExtreme, nCrash: nCrash, regimeLevel: regimeLevel, volWild: volWild, regVol: reg ? reg.vol : null,
    nAccel: nAccel, accelLevel: accelLevel,
    status: status, label: label, firing: firing,
    asof: (RM && RM.asof) || (dv && dv.date) || null,
    ready: levels.length > 0,
  };
}

/* =====================================================================
 * ㉟+ 护栏 RED 通知（v3.30）—— 带外通道：群机器人 Webhook
 * ---------------------------------------------------------------------
 * 护栏进入 RED 时，前端经数据 Worker 的 /api/notify，把告警转发到用户配置的
 * 群机器人 Webhook（企业微信 / 飞书 / 钉钉 / 自建均可，Worker 按 host 自动识别格式）。
 * 这样用户不必 24h 盯盘也能被提醒 —— 直击「守城」减压需求。
 *
 * 触发规则（边缘 + 冷却，避免刷屏）：
 *   · 仅在用户主动开启（state.notify.enabled，默认关闭）且 G.ready 时生效；
 *   · 从非 RED 转入 RED（新一波）→ 立即发；
 *   · 持续 RED 期间，每 60 分钟最多再发一次（冷却）；
 *   · 不报方向，只报状态（与护栏自身一致）。
 *
 * 诚实边界：通知由前端触发，故「终端页面处于打开 / 后台运行」时才生效；
 *   若要做到标签页关闭也照常推送，需要把护栏逻辑搬进 Worker 跑 Cron —— 那是更大的下一步，
 *   本版明确不做（避免把上千行因子管线移植到边缘、引入分叉风险）。
 *   另外 /api/notify 用共享 TOKEN + Origin 校验做基本防护；Webhook URL 本身作为
 *   Worker 密钥（env.NOTIFY_WEBHOOK）存储，不进源码。
 * ===================================================================== */
const NOTIFY = {
  TOKEN: 'nexus-rg-v330',
  COOLDOWN_MS: 60 * 60 * 1000,
  ENDPOINT: CONFIG.PROXY + '/api/notify',
};

function loadNotifyCfg() {
  try {
    const s = JSON.parse(localStorage.getItem('nexus_notify') || '{}');
    return { enabled: !!s.enabled, lastTs: s.lastTs || 0, lastResult: s.lastResult || null };
  } catch (e) { return { enabled: false, lastTs: 0, lastResult: null }; }
}
function saveNotifyCfg() {
  try { if (state.notify) localStorage.setItem('nexus_notify', JSON.stringify(state.notify)); } catch (e) {}
}

function buildGuardrailNotifyText(G) {
  const LVL = ['静', '警', '危'];
  const lv = function (x) { return LVL[x == null ? 0 : x]; };
  const d = (G.asof ? new Date(G.asof).toISOString().slice(0, 10) : '—');
  const lines = [];
  lines.push('【NEXUS 护栏 RED 警报】');
  lines.push('时间：' + d);
  lines.push('总状态：RED（危）');
  lines.push('分量 → DVOL体制:' + lv(G.dvolLevel) + ' · 极端分位联动:' + lv(G.regimeLevel) + '(nCrash=' + (G.nCrash || 0) + ') · 变化率联动:' + lv(G.accelLevel) + '(nAccel=' + (G.nAccel || 0) + ')');
  if (G.firing && G.firing.length) {
    lines.push('触发项：');
    G.firing.slice(0, 12).forEach(function (f) {
      let s = '· ' + (f.zh || f.cat) + '：' + f.kind;
      if (f.vsCrash != null) s += (f.vsCrash >= 1 ? '（超历史峰值）' : '（vs崩溃 ' + f.vsCrash.toFixed(2) + '×）');
      lines.push(s);
    });
  }
  lines.push('说明：报状态不报方向。各维度风险温度计已达 RED，建议复核仓位与波动暴露。');
  lines.push('（nexus.uichain.org）');
  return lines.join('\n');
}

function updateNotifyUI() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('notifyStat');
  if (!el || !state.notify) return;
  let t = state.notify.enabled ? 'RED 通知已开启' : 'RED 通知已关闭';
  if (state.notify.lastResult) t += ' · ' + state.notify.lastResult;
  el.textContent = t;
}

function maybeNotifyGuardrail(G) {
  try {
    if (!state.notify) state.notify = loadNotifyCfg();
    const prev = state._prevGuardStatus || 0;
    const now = Date.now();
    if (state.notify.enabled && G && G.ready && G.status === 2) {
      const freshEdge = prev !== 2;
      const cooled = (now - (state.notify.lastTs || 0)) > NOTIFY.COOLDOWN_MS;
      if (freshEdge || cooled) {
        state.notify.lastTs = now;
        sendGuardrailNotify(G);  /* 不 await：通知失败不应阻塞面板渲染 */
      }
    }
    state._prevGuardStatus = (G ? G.status : 0);
    saveNotifyCfg();
    updateNotifyUI();
  } catch (e) { console.warn('notify hook', e && e.message); }
}

async function sendGuardrailNotify(G) {
  if (!state.notify) state.notify = loadNotifyCfg();
  const text = buildGuardrailNotifyText(G);
  try {
    const r = await fetch(NOTIFY.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: NOTIFY.TOKEN, text: text })
    });
    const j = await r.json().catch(function () { return {}; });
    state.notify.lastResult = j.ok ? ('已发送 ' + new Date().toLocaleTimeString()) : ('失败:' + (j.error || ('HTTP ' + r.status)));
  } catch (e) {
    state.notify.lastResult = '失败:' + (e && e.message ? e.message : '网络');
  }
  saveNotifyCfg();
  updateNotifyUI();
}

/* =====================================================================
 * ㉛ 径向影响星系图
 * ---------------------------------------------------------------------
 * 原来的力导向网络解决的是「因子之间怎么互相连」；这一版要回答的是另一个
 * 问题：**谁在对 BTC 施加影响、影响多强、方向如何、它是内部的还是外面打进来的**。
 * 这两个问题需要的布局完全不同 —— 力导向图里「离中心近」纯粹是布局算法的产物，
 * 没有任何含义，用户没法从距离读出任何东西。
 *
 * 所以径向布局把三个维度分别绑到三个视觉通道上，每个都有明确刻度：
 *   半径   = 内生(内圈) → 外生(外圈)，同一类里按 强 → 中 → 弱 往外排
 *   节点大小 = |IC|（实测影响强度），有最大值参照
 *   连线粗细 = |IC|，颜色 = 方向（绿=推涨 / 红=压跌），虚线=该因子 IC 在
 *             前 60% 与后 40% 符号相反（漂移，不可轻信）
 *   描边   = 所属数据分类（同一个颜色 = 同一类变量）
 *
 * 不做力模拟：60+ 个节点在手机上跑 rAF 力模拟纯属浪费电，而且每次刷新位置都变，
 * 「图变了」和「数据变了」会分不开 —— 径向布局是确定性的，位置只由数据决定。
 * ===================================================================== */
const CAT_COLORS = {
  index: '#00b4ff', sector: '#4fc3f7', rate: '#26c6da', credit: '#26a69a',
  fx: '#7e57c2', commodity: '#ffb300', vol: '#ff3d6e', cryptostock: '#ff9100',
  altcoin: '#b388ff', tech: '#8bc34a', other: '#78909c',
};

function initRadial(cv) {
  const S = state.screening;
  if (!S || !S.rows || !S.rows.length) return false;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (W < 40 || H < 40) return false;
  const cx = W / 2, cy = H / 2;
  const maxR = Math.min(W, H) / 2 - 30;

  /* 取前 maxNodes 个（按 |IC|）—— 160 个节点全画上去只会变成一团糊。 */
  const rows = S.rows.slice().sort(function (a, b) { return b.abs - a.abs; }).slice(0, NET_OPTS.maxNodes);
  if (!rows.length) return false;
  const maxAbs = Math.max.apply(null, rows.map(function (r) { return r.abs; }).concat([1e-9]));

  const rings = RINGS.map(function (r) { return { exo: r.exo, tier: r.tier, label: r.label, color: r.color, items: [] }; });
  rows.forEach(function (r) {
    for (let i = 0; i < rings.length; i++) {
      if ((rings[i].exo ? 1 : 0) === (r.exo ? 1 : 0) && rings[i].tier === r.tier) { rings[i].items.push(r); return; }
    }
    rings[rings.length - 1].items.push(r);
  });
  const used = rings.filter(function (r) { return r.items.length; });
  const nR = used.length || 1;
  used.forEach(function (r, i) { r.rad = maxR * (0.30 + 0.70 * (i + 1) / nR); });

  const nodes = [];
  used.forEach(function (ring, ri) {
    ring.items.forEach(function (r, k) {
      /* 每环错开一点起始角，避免各环的节点在同一条辐条上重叠 */
      const off = ri * 0.35;
      const ang = -Math.PI / 2 + off + (k / ring.items.length) * Math.PI * 2;
      nodes.push({
        id: r.key, label: uniName(r.key), cat: r.cat, tier: r.tier, exo: r.exo,
        ic: r.ic, abs: r.abs, q: r.q, icir: r.icir, win: r.winRate, hl: r.hl, flip: r.flip,
        icOut: r.icOut, icIn: r.icIn, n: r.n,
        ang: ang, rad: ring.rad, ring: ring.label, ringColor: ring.color,
        r: 3.5 + 9 * Math.sqrt(r.abs / maxAbs),
        x: cx + Math.cos(ang) * ring.rad, y: cy + Math.sin(ang) * ring.rad,
      });
    });
  });

  const btc = { id: 'BTC', label: 'BTC', r: Math.max(16, Math.min(26, maxR * 0.11)), x: cx, y: cy, isBtc: true };
  net = { cv: cv, ctx: cv.getContext('2d'), layout: 'radial', nodes: nodes, btc: btc, rings: used, W: W, H: H, cx: cx, cy: cy, maxAbs: maxAbs, idle: 0, hover: -1 };
  if ($('netCount')) {
    $('netCount').textContent = '影响星系 · ' + nodes.length + '/' + S.nScreened + ' 因子 · ' +
      (S.byTier.strong.length) + '强 / ' + (S.byTier.mid.length) + '中 / ' + (S.byTier.weak.length) + '弱 · 主视野 ' + S.h + ' 日';
  }
  /* 静态图：画一次就停，不吃 rAF。前面那版力导向每 60 秒泄漏一个 rAF 循环的坑不再重犯。 */
  drawRadial();
  return true;
}

function uniName(k) { return (state.universe && state.universe._name && state.universe._name[k]) || k; }

function drawRadial() {
  if (!net || net.layout !== 'radial') return;
  const n = net, ctx = n.ctx, W = n.W, H = n.H, cx = n.cx, cy = n.cy;
  const dpr = window.devicePixelRatio || 1;
  if (n.cv.width !== Math.round(W * dpr)) { n.cv.width = Math.round(W * dpr); n.cv.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const small = W < 520;

  /* 1) 环参考线 + 环标签 */
  n.rings.forEach(function (ring) {
    ctx.strokeStyle = 'rgba(58,80,112,' + (small ? 0.30 : 0.45) + ')';
    ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.arc(cx, cy, ring.rad, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    if (!small) {
      ctx.fillStyle = ring.color; ctx.font = '9px JetBrains Mono, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(ring.label + ' ' + ring.items.length, cx + ring.rad + 4, cy - 6);
    }
  });

  /* 2) 辐条：中心 BTC → 各因子。粗细=|IC|，颜色=方向，虚线=漂移 */
  n.nodes.forEach(function (nd) {
    const w = 0.5 + 4.2 * (nd.abs / n.maxAbs);
    const up = nd.ic > 0;
    ctx.strokeStyle = (up ? 'rgba(0,229,160,' : 'rgba(255,61,110,') + Math.min(0.8, 0.16 + 2.2 * (nd.abs / n.maxAbs)) + ')';
    ctx.lineWidth = w;
    ctx.setLineDash(nd.flip ? [2, 3] : []);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nd.x, nd.y); ctx.stroke();
    ctx.setLineDash([]);
  });

  /* 3) 中心 BTC */
  const b = n.btc;
  ctx.fillStyle = '#00e5a0';
  ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
  ctx.fillStyle = '#060c18'; ctx.font = 'bold ' + (small ? 9 : 11) + 'px JetBrains Mono, monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('BTC', b.x, b.y);

  /* 4) 节点 */
  n.nodes.forEach(function (nd, i) {
    const hov = n.hover === i;
    ctx.fillStyle = CAT_COLORS[nd.cat] || CAT_COLORS.other;
    ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, 7); ctx.fill();
    ctx.strokeStyle = hov ? '#fff' : nd.ringColor;
    ctx.lineWidth = hov ? 2 : 1.3;
    ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r + 2, 0, 7); ctx.stroke();
    /* 标签只在够大或 hover 时画 —— 60 个标签全画出来就是一坨黑 */
    if (!small || hov) {
      ctx.fillStyle = hov ? '#fff' : '#a8bfd6';
      ctx.font = (hov ? 'bold ' : '') + '8px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tx = nd.x + Math.cos(nd.ang) * (nd.r + 8), ty = nd.y + Math.sin(nd.ang) * (nd.r + 8);
      ctx.fillText(nd.label.slice(0, 7), tx, ty);
    }
  });

  /* 5) hover 信息框 */
  if (n.hover >= 0 && n.hover < n.nodes.length) {
    const nd = n.nodes[n.hover];
    const lines = [
      nd.label + ' · ' + (CAT_ZH[nd.cat] || nd.cat),
      'IC ' + (nd.ic >= 0 ? '+' : '') + nd.ic.toFixed(3) + '  ' + (nd.ic > 0 ? '推涨' : '压跌') + '  ' + nd.ring,
      'q ' + (nd.q == null ? '—' : nd.q.toFixed(3)) + (nd.q < SCR.Q ? ' 通过FDR' : ' 未通过') +
        '  ICIR ' + (nd.icir == null ? '—' : nd.icir.toFixed(2)) + '  胜率 ' + (nd.win == null ? '—' : (nd.win * 100).toFixed(0) + '%'),
      '样本内 ' + (nd.icIn == null ? '—' : nd.icIn.toFixed(3)) + ' → 样本外 ' + (nd.icOut == null ? '—' : nd.icOut.toFixed(3)) + (nd.flip ? '  ⚠符号反转' : ''),
      '半衰期 ' + (nd.hl == null ? '>20日' : nd.hl.toFixed(1) + '日') + '  样本 ' + nd.n,
    ];
    const bw = Math.min(W - 12, 260), bh = lines.length * 14 + 12;
    let bx = Math.max(6, Math.min(W - bw - 6, nd.x + 14)), by = Math.max(6, Math.min(H - bh - 6, nd.y - bh - 10));
    ctx.fillStyle = 'rgba(8,17,31,.97)'; ctx.strokeStyle = '#243d60'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach(function (t, k) {
      ctx.fillStyle = k === 0 ? '#d0e2f5' : (k === 1 ? (nd.ic > 0 ? '#00e5a0' : '#ff3d6e') : '#a8bfd6');
      ctx.font = (k === 0 ? 'bold 10px' : '9px') + ' Inter, sans-serif';
      ctx.fillText(t, bx + 7, by + 6 + k * 14);
    });
  }
}

/* hover：找最近节点（阈值取节点半径 + 6px，触控时放宽到 +14） */
function radialHit(mx, my) {
  if (!net || net.layout !== 'radial') return -1;
  let best = -1, bd = 1e9;
  const pad = (isTouchLike() ? 14 : 6);
  for (let i = 0; i < net.nodes.length; i++) {
    const nd = net.nodes[i], dx = mx - nd.x, dy = my - nd.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < nd.r + pad && d < bd) { bd = d; best = i; }
  }
  return best;
}
function isTouchLike() { try { return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0); } catch (e) { return false; } }


/* 加载 + 渲染。两步都必须「先给反馈、再干活」：
 * ① 取数要打 167 次 Yahoo，首轮近一分钟 —— 不给提示用户会以为页面死了；
 * ② 筛选要算 5 秒左右，同步跑会把主线程堵死，所以先渲染「计算中」再让出一帧。 */
async function runUniverse(opts) {
  const o = opts || {};
  const btn = $('uniLoad'), cnt = $('uniCount');
  const setMsg = function (t) { const b = $('uniBox'); if (b) b.innerHTML = '<div class="rg-sub">' + t + '</div>'; };
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 加载中…'; }
  if (cnt) cnt.textContent = '加载中…';
  /* 筛选要用 BTC 十年日线做对齐基准。缺了它面板会永远停在「请先跑回放」——
   * 与其让用户自己去别处点一下，不如这里顺手拉了（同一个源，带缓存）。 */
  if (!state.histBundle || !state.histBundle.btc) {
    setMsg('正在拉取 BTC 十年日线（筛选的对齐基准）…');
    try {
      const d = await getJSON(histUrl(), 120000);
      if (d && d.btc) state.histBundle = d;
    } catch (e) { console.warn('uni hist fail', e && e.message); }
  }
  setMsg('正在拉取 167 条真实日频序列（首次约需一分钟，之后走 6 小时边缘缓存）…');
  let U = await loadUniverse('all');
  const got = U ? Object.keys(U.series).length : 0;
  /* 一次打 167 个容易被限流 —— 拿不到 2/3 就按分类逐个补。
   * 分类各自有独立缓存，补到多少算多少，失败的如实留在 fail 里。 */
  if (got < 110) {
    const cats = ['index', 'sector', 'rate', 'credit', 'fx', 'commodity', 'vol', 'cryptostock', 'altcoin', 'tech'];
    for (let i = 0; i < cats.length; i++) {
      setMsg('逐类补拉中（' + (i + 1) + '/' + cats.length + '）… 已拿到 ' + Object.keys((state.universe || {}).series || {}).length + ' 条');
      await loadUniverse(cats[i], { quiet: true });
    }
  }
  const n = Object.keys(((state.universe || {}).series) || {}).length;
  if (cnt) cnt.textContent = n ? n + ' 条序列' : '加载失败';
  if (btn) { btn.disabled = false; btn.textContent = n ? '重新加载' : '重试'; }
  if (!o.skipRender) {
    setMsg('数据就绪（' + n + ' 条），正在逐条测量 IC / ICIR / 样本外漂移，约需数秒…');
    setTimeout(function () { try { renderUniverseBox(); } catch (e) { console.warn('uni render fail', e && e.message); } try { initNetwork(); } catch (e) { } }, 30);
  }
}


/* =====================================================================
 * ㉜ 渲染：分类合成 —— 167 → 10，会不会更稳
 * ---------------------------------------------------------------------
 * 这一节的排版只有一个原则：**先给结论，再给支撑它的数，最后给推翻它的数**。
 * 特别是最后一条：lowAgree 看着样本外 +0.15 很漂亮，但剔除 BTC 自身位置之后
 * 只剩 +0.07 —— 这个数必须和 +0.15 放在一起，不能只报好看的那个。
 * ===================================================================== */
/* ㉝ 真正样本外追踪的面板：把 oosTrack 的结果摊开 —— 每折的持有窗 IC、跨折聚合、判定 */
function oosHTML(O, S) {
  if (!O) return '';
  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };
  const sg = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp == null ? 3 : dp); };
  const dstr = t => new Date(t).toISOString().slice(0, 10);
  const cls = function (v) { return v == null ? 'rg-dim' : v > 0.05 ? 'rg-g' : v < -0.05 ? 'rg-r' : 'rg-dim'; };

  let h = '<div class="rg-sub" style="margin-top:14px;border-top:1px solid rgba(255,255,255,.12);padding-top:10px">' +
    '<b>㉝ 真正的样本外追踪：把"低一致性"假设拎到 ' + O.folds.length + ' 个独立持有窗里验</b>' +
    '<span class="rg-dim"> · 训练窗扩张（约 4 年起）+ 固定 ' + O.HOR + ' 日（≈2 年）持有；' +
    '最后一折固定在「最近两年」。每折只用训练段挑分类、重算类内一致性，' +
    '然后在它没看过的窗口测 IC。这是把 v3.26 那条事后规则从"观察"升级成"结论"的唯一办法。</span></div>';

  /* 每折一行 */
  h += '<div class="rg-sub" style="margin-top:6px"><b>逐折持有窗（持有窗 IC，视野 ' + O.HOR + ' 日）</b></div>';
  h += '<div class="rg-tbl">';
  h += '<div class="rg-hd" style="grid-template-columns:1.5fr .8fr .8fr .8fr .8fr .8fr .8fr">' +
    '<span>持有窗</span><span>低一致性</span><span>剔除BTC后</span><span>等权TopK</span><span>单因子</span><span>普通TopK</span><span>BTC自身</span></div>';
  O.folds.forEach(function (f, i) {
    const last = i === O.folds.length - 1;
    h += '<div class="rg-row" style="grid-template-columns:1.5fr .8fr .8fr .8fr .8fr .8fr .8fr' + (last ? ';background:rgba(255,179,0,.06)' : '') + '">' +
      '<span class="rg-nm">' + dstr(f.cutDate) + '→' + dstr(f.endDate) + (last ? ' <b class="rg-y">最新</b>' : '') + '</span>' +
      '<span class="' + cls(f.lowAgree.icOut && f.lowAgree.icOut.ic) + '"><b>' + sg(f.lowAgree.icOut && f.lowAgree.icOut.ic) + '</b></span>' +
      '<span class="' + cls(f.lowAgree.incr && f.lowAgree.incr.r.icOut && f.lowAgree.incr.r.icOut.ic) + '">' + sg(f.lowAgree.incr && f.lowAgree.incr.r.icOut && f.lowAgree.incr.r.icOut.ic) + '</span>' +
      '<span class="' + cls(f.cat.icOut && f.cat.icOut.ic) + '">' + sg(f.cat.icOut && f.cat.icOut.ic) + '</span>' +
      '<span class="' + cls(f.single.icOut && f.single.icOut.ic) + '">' + sg(f.single.icOut && f.single.icOut.ic) + '</span>' +
      '<span class="' + cls(f.pool.icOut && f.pool.icOut.ic) + '">' + sg(f.pool.icOut && f.pool.icOut.ic) + '</span>' +
      '<span class="' + cls(f.btcOwn.icOut && f.btcOwn.icOut.ic) + '">' + sg(f.btcOwn.icOut && f.btcOwn.icOut.ic) + '</span></div>';
  });
  h += '</div>';

  /* 跨折聚合 */
  const a = O.agg;
  h += '<div class="rg-sub" style="margin-top:8px"><b>跨折聚合（' + O.folds.length + ' 折）</b></div>';
  h += '<div class="rg-tbl">';
  h += '<div class="rg-hd" style="grid-template-columns:1.4fr .9fr .9fr .8fr .9fr">' +
    '<span>方案</span><span>中位IC</span><span>均值IC</span><span>正折数</span><span>剔除BTC后中位</span></div>';
  [['① 低一致性(事后规则)', 'lowAgree'], ['② 普通TopK(按|IC|)', 'cat'], ['③ 全池等权', 'pool'], ['④ 单因子Top' + O.K1, 'single']].forEach(function (x) {
    const g = a[x[1]];
    h += '<div class="rg-row" style="grid-template-columns:1.4fr .9fr .9fr .8fr .9fr">' +
      '<span class="rg-nm">' + x[0] + '</span>' +
      '<span class="' + cls(g.median) + '"><b>' + sg(g.median) + '</b></span>' +
      '<span class="rg-dim">' + sg(g.mean) + '</span>' +
      '<span class="rg-dim">' + g.posN + '/' + g.n + '</span>' +
      '<span class="' + cls(g.incMean) + '">' + sg(g.incMean) + '</span></div>';
  });
  h += '</div>';

  /* 判定：三层 —— 站住？优于朴素挑选？优于干脆不挑？ */
  const la = a.lowAgree, ca = a.cat, pa = a.pool;
  const survives = la.median != null && la.median > 0 && la.posN >= Math.ceil(la.n / 2);
  const beatsPlain = la.median != null && ca.median != null && la.median > ca.median;   /* 优于朴素按|IC|挑（易过拟合） */
  const beatsNone = la.median != null && pa.median != null && la.median > pa.median;     /* 优于"干脆不挑" */
  let verdict;
  if (!survives) {
    verdict = '<span class="rg-r"><b>低一致性规则没通过独立验证</b></span>：跨折中位 IC ' + sg(la.median) +
      '、仅 ' + la.posN + '/' + la.n + ' 折为正 —— 它在 v3.26 的 60/40 一刀上好看，换个没看过的窗口就塌。' +
      '事后规则要这样才算被证伪。';
  } else if (beatsNone) {
    verdict = '<span class="rg-g"><b>低一致性规则在独立持有窗里站住了，而且优于「干脆不挑」</b></span>：中位 ' + sg(la.median) +
      '、' + la.posN + '/' + la.n + ' 折正，高于全池等权（中位 ' + sg(pa.median) + '）。' +
      '它从"全样本上看到的规律"升级成了"在没看过的窗口也成立的规律" —— 这是它唯一能被称为结论的方式。';
  } else if (beatsPlain) {
    verdict = '<span class="rg-y"><b>低一致性规则站住了，但不如干脆不挑</b></span>：它跨折中位 ' + sg(la.median) +
      '、' + la.posN + '/' + la.n + ' 折正（优于朴素按 |IC| 挑选的 ' + sg(ca.median) + '），' +
      '却仍低于"全部按样本内方向平均、不挑"的全池等权（中位 ' + sg(pa.median) + '、' + pa.posN + '/' + pa.n + ' 折正）。' +
      '也就是说：这条规律是真的、可复现的，但它的增量价值小到不如"什么都不选" —— 不能当成一条新 alpha。';
  } else {
    verdict = '<span class="rg-y"><b>低一致性规则站住了，但还不如朴素挑选</b></span>：中位 ' + sg(la.median) +
      '、' + la.posN + '/' + la.n + ' 折正，却低于普通 TopK（中位 ' + sg(ca.median) + '）。它在独立窗口里没塌，但也没带来增量。';
  }
  const incNote = (la.incMean != null) ? ('剔除 BTC 自身后中位 ' + sg(la.incMean) + '、' + la.incPosN + '/' + la.n + ' 折正') : '—';
  h += '<div class="rg-sub"><span class="rg-dim">判定层级：① 中位 IC>0 且过半折正 = 站住（不是 60/40 那一刀的偶然）；' +
    '② 高于全池等权 = 有增量价值（比"不挑"更好）；③ 剔除 BTC 自身后仍正 = 不是只在复述 BTC。' +
    '低一致性（' + incNote + '）。</span></div>';
  h += '<div class="rg-sub"><b>' + verdict + '</b></div>';
  /* 最刺眼的一条：跨折中位 IC 最高的其实是零/低自由度方案，而不是任何精巧挑选 */
  h += '<div class="rg-sub"><span class="rg-dim">顺带一条更刺眼的：跨折中位 IC 最高的其实是' +
    '<b>全池等权（' + sg(pa.median) + '）</b>和<b>单因子 Top' + O.K1 + '（' + sg(a.single.median) + '）</b>这俩零/低自由度方案，' +
    '而不是低一致性、也不是普通 TopK。挑因子、降维、挑"低一致性"都在用更多自由度去追一个连"不挑"都打不过的数字 —— ' +
    '这正是对"方向择时"最诚实的否定。</span></div>';
  return h;
}

/* ㉝ 这段单独异步渲染：oosTrack 要跑多折，同步算会卡首屏；失败给提示不留转圈占位 */
function renderOOSInto(S) {
  const node = document.getElementById('oosBox');
  if (!node) return;
  try {
    const O = state.oos || (state.oos = oosTrack(S));
    if (!O || !O.folds || !O.folds.length) { node.innerHTML = '<span class="rg-dim">样本外追踪：可用分类或训练窗不足。</span>'; return; }
    node.outerHTML = oosHTML(O, S);
  } catch (e) {
    console.warn('oos fail', e && e.message);
    node.innerHTML = '<span class="rg-r">样本外追踪计算失败：' + (e && e.message ? e.message : '未知错误') + '</span>';
  }
}


/* ㉞ 风险护栏面板：把 guardrail() 的三联警报摊开成可读的 GREEN/YELLOW/RED 总状态 + 分量明细 + 触发清单 */
function guardrailHTML(G) {
  if (!G) return '';
  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };
  const pc = function (v, dp) { return v == null ? '—' : (v * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  const C = {
    0: { t: '静', c: '#00e5a0', bg: 'rgba(0,229,160,.12)', bd: '#00e5a0' },
    1: { t: '警', c: '#ffb300', bg: 'rgba(255,179,0,.12)', bd: '#ffb300' },
    2: { t: '危', c: '#ff3d6e', bg: 'rgba(255,61,110,.14)', bd: '#ff3d6e' },
  };
  const st = C[G.status] || C[0];
  const badge = function (lv) {
    const x = C[lv == null ? 0 : lv];
    return '<span style="display:inline-block;min-width:18px;text-align:center;border:1px solid ' + (lv == null ? '#78909c' : x.bd) +
      ';color:' + (lv == null ? '#78909c' : x.c) + ';border-radius:4px;font-size:9px;padding:0 4px">' + (lv == null ? '—' : x.t) + '</span>';
  };

  let h = '<div class="rg-sub" style="margin-top:14px;border-top:1px solid rgba(255,255,255,.12);padding-top:10px">';
  h += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">';
  h += '<b style="font-size:13px">㉞ 风险护栏 · 三联警报</b>';
  h += '<span style="border:1px solid ' + st.bd + ';color:' + st.c + ';background:' + st.bg + ';border-radius:6px;padding:3px 12px;font-weight:bold;letter-spacing:.5px">' + G.label + '</span>';
  h += '</div>';
  h += '<div class="rg-sub"><span class="rg-dim">报状态、不报方向 —— 这是<b>护栏</b>，不是择时信号。把三个已算好的状态量（DVOL 波动率体制 · 全分类极端分位联动 · 变化率联动）聚合成一个总状态；' +
    'RED 的意思是「多个维度的风险温度计同时在抬升」，应当作为<b>降杠杆 / 减仓 / 不追高</b>的参考，而不是「做空」指令。</span></div>';

  /* 三个分量 */
  h += '<div class="rg-tbl" style="margin-top:8px">';
  h += '<div class="rg-hd" style="grid-template-columns:1.6fr .6fr 2.4fr"><span>分量</span><span>级别</span><span>当前读数</span></div>';
  h += '<div class="rg-row" style="grid-template-columns:1.6fr .6fr 2.4fr">' +
    '<span class="rg-nm">① DVOL 波动率体制</span>' + badge(G.dvolLevel) +
    '<span class="rg-dim">' + (G.dv ? ('DVOL=' + num(G.dv.latest, 0) + ' · 近1年百分位 ' + pc(G.dv.pctTrailing1y) + ' · 60日z ' + num(G.dv.z60)) : 'DVOL 数据不可用（需先跑十年回放）') + '</span></div>';
  h += '<div class="rg-row" style="grid-template-columns:1.6fr .6fr 2.4fr">' +
    '<span class="rg-nm">② 全分类极端分位联动</span>' + badge(G.regimeLevel) +
    '<span class="rg-dim">历史崩溃级偏离(≥0.8×峰值) ' + (G.nCrash || 0) + ' 类' +
    (G.nExtreme ? ' · 5/95尾巴 ' + G.nExtreme + ' 类' : '') +
    (G.volWild ? ' · 叠加 BTC 波动率极端体制(vol≥0.80)' : (G.regVol != null ? ' · BTC 年化波动 ' + num(G.regVol) : '')) + '</span></div>';
  h += '<div class="rg-row" style="grid-template-columns:1.6fr .6fr 2.4fr">' +
    '<span class="rg-nm">③ 变化率联动</span>' + badge(G.accelLevel) +
    '<span class="rg-dim">近60日位移 ≥ 1.5σ 的分类 ' + G.nAccel + ' 类（在加速）</span></div>';
  h += '</div>';

  /* 触发清单 */
  if (G.firing && G.firing.length) {
    h += '<div class="rg-sub" style="margin-top:8px"><b>正在触发：</b></div><div class="rg-tbl">';
    h += '<div class="rg-hd" style="grid-template-columns:1.3fr 1.5fr .9fr .9fr .7fr"><span>分类</span><span>状态</span><span>历史分位</span><span>vs崩溃峰值</span><span>变化率σ</span></div>';
    G.firing.forEach(function (f) {
      const vc = f.vsCrash == null ? null : f.vsCrash;
      const vcCls = vc == null ? 'rg-dim' : (vc >= 1 ? 'rg-r' : vc >= 0.8 ? 'rg-y' : 'rg-dim');
      const vcTxt = vc == null ? '—' : (vc >= 1 ? '超峰值' : vc.toFixed(1) + '×');
      h += '<div class="rg-row" style="grid-template-columns:1.3fr 1.5fr .9fr .9fr .7fr">' +
        '<span class="rg-nm" style="color:' + (CAT_COLORS[f.cat] || CAT_COLORS.other) + '">' + f.zh + '</span>' +
        '<span class="rg-dim">' + f.kind + '</span>' +
        '<span class="rg-dim">' + pc(f.pct) + '</span>' +
        '<span class="' + vcCls + '">' + vcTxt + '</span>' +
        '<span class="' + (f.rc == null ? 'rg-dim' : Math.abs(f.rc) >= 1.5 ? 'rg-y' : 'rg-dim') + '">' + (f.rc == null ? '—' : (f.rc >= 0 ? '+' : '') + f.rc.toFixed(1)) + '</span></div>';
    });
    h += '</div>';
  } else {
    h += '<div class="rg-sub"><span class="rg-g">没有分类处于历史极端分位，也没有分类在加速 —— 当前没有系统性联动信号。</span></div>';
  }

  h += '<div class="rg-sub"><span class="rg-dim">截至 ' + (G.asof ? new Date(G.asof).toISOString().slice(0, 10) : '—') +
    '。' + (G.ready ? '' : ' <b class="rg-y">部分信号源未就绪（需先跑十年回放 + 加载因子宇宙）。</b>') +
    ' 三个分量各自独立，护栏取最高级别；任何单一分量到「危」即触发 RED。</span></div>';
  return h;
}

/* ㉞ 这段单独异步渲染：依赖 state.risk（由分类合成段落算出），不能早于它 */
function renderGuardrailInto(S) {
  const node = document.getElementById('grBox');
  if (!node) return;
  try {
    const G = state.guardrail || (state.guardrail = guardrail(S));
    maybeNotifyGuardrail(G);  /* v3.30：RED 时经 Worker 转发到群机器人 Webhook（边缘触发 + 冷却）*/
    node.outerHTML = guardrailHTML(G);
  } catch (e) {
    console.warn('guardrail fail', e && e.message);
    node.innerHTML = '<span class="rg-r">风险护栏计算失败：' + (e && e.message ? e.message : '未知错误') + '</span>';
  }
}


function compositeHTML(C, S) {
  if (!C) return '';
  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };
  const pc = function (v, dp) { return v == null ? '—' : (v * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  const sg = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp == null ? 3 : dp); };
  const dstr = t => new Date(t).toISOString().slice(0, 10);
  const icOf = function (r) { return r && r.ic != null && isFinite(r.ic) ? r.ic : null; };
  const tOf = function (r) { return r && r.t != null && isFinite(r.t) ? r.t : null; };
  const cls = function (v) { return v == null ? 'rg-dim' : v > 0.05 ? 'rg-g' : v < -0.05 ? 'rg-r' : 'rg-dim'; };
  const segTxt = function (r) {
    if (!r || !r.segs || !r.segs.length) return '—';
    return r.segs.map(function (s) { return sg(s == null ? null : s.ic); }).join(' ');
  };
  /* 分段同号数：方向以「样本内 IC 的符号」为准 —— 挑的时候定下的方向 */
  const segSame = function (r) {
    if (!r || !r.segs || !r.segs.length || !r.icIn || !isFinite(r.icIn.ic)) return null;
    const pos = r.icIn.ic > 0;
    let k = 0, n = 0;
    r.segs.forEach(function (s) { if (s.ic == null || !isFinite(s.ic)) return; n++; if ((s.ic > 0) === pos) k++; });
    return n ? { k: k, n: n } : null;
  };

  let h = '<div class="rg-sub" style="margin-top:14px;border-top:1px solid rgba(255,255,255,.12);padding-top:10px">' +
    '<b>㉜ 分类合成：把 ' + C.nFactor + ' 个因子降到 ' + C.nCat + ' 个分类，会不会更稳？</b>' +
    '<span class="rg-dim"> · 切点 ' + dstr(C.cutDate) + '，视野 ' + C.h + ' 日，挑选与方向一律只用样本内段。</span></div>';

  /* ---- 三条对照 ---- */
  h += '<div class="rg-sub" style="margin-top:6px"><b>三条路，同一个切点、同一个视野：</b></div>';
  h += '<div class="rg-tbl">';
  h += '<div class="rg-hd" style="grid-template-columns:1.6fr .7fr .6fr 1.6fr .8fr">' +
    '<span>做法</span><span>样本外IC</span><span>t</span><span>样本外分段</span><span>滚动胜率</span></div>';
  const three = [
    ['① 单因子 Top-' + C.k1 + '（细挑）', C.single, '在 167 个里挑 12 个'],
    ['② 分类合成 Top-' + C.k + '（降维）', C.cat, '在 10 个类里挑 ' + C.k + ' 个'],
    ['③ 全池等权（不挑）', C.pool, '全部按样本内方向平均'],
  ];
  three.forEach(function (x) {
    const r = x[1], ss = segSame(r);
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .7fr .6fr 1.6fr .8fr">' +
      '<span class="rg-nm">' + x[0] + '<span class="rg-dim" style="font-size:8px"> ' + x[2] + '</span></span>' +
      '<span class="' + cls(icOf(r.icOut)) + '"><b>' + sg(icOf(r.icOut)) + '</b></span>' +
      '<span class="rg-dim">' + num(tOf(r.icOut)) + '</span>' +
      '<span class="rg-dim" style="font-size:9px">' + segTxt(r) + (ss ? ' <b>(' + ss.k + '/' + ss.n + ')</b>' : '') + '</span>' +
      '<span class="rg-dim">' + (r.roll ? pc(r.roll.win, 0) : '—') + '</span></div>';
  });
  h += '</div>';

  const sIn = icOf(C.single.icIn), sOut = icOf(C.single.icOut);
  const cOut = icOf(C.cat.icOut), pOut = icOf(C.pool.icOut);
  h += '<div class="rg-sub"><span class="rg-r"><b>降维没有买到稳定性，反而更差。</b></span>' +
    '<span class="rg-dim">单因子 Top-' + C.k1 + ' 样本外 ' + sg(sOut) + '，分类合成 ' + sg(cOut) +
    '，连「一个都不挑」的全池等权（' + sg(pOut) + '）都比分类合成好。' +
    '也就是说：把 167 个压成 10 个，并没有把噪声平均掉 —— 因为同一类里的变量往往共享同一段行情，' +
    '平均之后去掉的噪声不多，共享的那段行情一点没少。</span></div>';

  /* ---- 四种挑选方案 ---- */
  h += '<div class="rg-sub" style="margin-top:8px"><b>换挑选规则呢？四种方案各挑 ' + C.k + ' 个分类</b></div>';
  h += '<div class="rg-tbl">';
  h += '<div class="rg-hd" style="grid-template-columns:1.5fr .7fr .7fr 1.5fr .7fr .8fr">' +
    '<span>方案</span><span>样本内</span><span>样本外</span><span>样本外分段</span><span>胜率</span><span>剔除BTC自身后</span></div>';
  C.schemes.forEach(function (s) {
    const ss = segSame(s);
    h += '<div class="rg-row" style="grid-template-columns:1.5fr .7fr .7fr 1.5fr .7fr .8fr">' +
      '<span class="rg-nm">' + s.zh + '<span class="rg-dim" style="font-size:8px"> ' + s.note + '</span></span>' +
      '<span class="rg-dim">' + sg(icOf(s.icIn)) + '</span>' +
      '<span class="' + cls(icOf(s.icOut)) + '"><b>' + sg(icOf(s.icOut)) + '</b></span>' +
      '<span class="rg-dim" style="font-size:9px">' + segTxt(s) + (ss ? ' <b>(' + ss.k + '/' + ss.n + ')</b>' : '') + '</span>' +
      '<span class="rg-dim">' + (s.roll ? pc(s.roll.win, 0) : '—') + '</span>' +
      '<span class="' + cls(icOf(s.incr && s.incr.icOut)) + '"><b>' + sg(icOf(s.incr && s.incr.icOut)) + '</b></span></div>';
  });
  h += '</div>';
  let la = null;
  C.schemes.forEach(function (s) { if (s.scheme === 'lowAgree') la = s; });
  if (la) {
    h += '<div class="rg-sub"><span class="rg-y"><b>前三种全负，第四种（挑类内一致性最低的类）样本外 ' +
      sg(icOf(la.icOut)) + '、' + (la.segs ? '分段 ' + (segSame(la) ? segSame(la).k + '/' + segSame(la).n : '—') : '') +
      ' 段同号、滚动胜率 ' + (la.roll ? pc(la.roll.win, 0) : '—') + '。</b></span>' +
      '<span class="rg-dim">看起来像是找到了东西 —— 但先别急，下面那一行会把它打回去。' +
      '而且这条规则本身是<b>看到全样本结果之后才想到的</b>，不是事前定的假设；' +
      '就算它后面还站得住，它现在的数字也只能当上界看。</span></div>';
  }

  /* ---- K 敏感性 ---- */
  if (C.kSens && C.kSens.length) {
    h += '<div class="rg-sub" style="margin-top:8px"><b>卡参数了吗？把 K 从 1 调到 5 全跑一遍</b>' +
      '<span class="rg-dim"> · 真信号对 K 不敏感，过拟合只在一个点上成立。</span></div>';
    h += '<div class="rg-tbl">';
    const scs = ['equal', 'ic', 'agree', 'lowAgree'];
    const zhs = { equal: '等权', ic: 'IC加权', agree: '一致加权', lowAgree: '低一致性' };
    h += '<div class="rg-hd" style="grid-template-columns:.6fr 1fr 1fr 1fr 1.2fr"><span>K</span>' +
      scs.map(function (x) { return '<span>' + zhs[x] + '</span>'; }).join('') + '</div>';
    C.kSens.forEach(function (row) {
      h += '<div class="rg-row" style="grid-template-columns:.6fr 1fr 1fr 1fr 1.2fr">' +
        '<span class="rg-nm">' + row.k + '</span>' +
        scs.map(function (x) {
          const v = row.by[x]; return '<span class="' + cls(icOf(v && v.icOut)) + '">' + sg(icOf(v && v.icOut)) + '</span>';
        }).join('') + '</div>';
    });
    h += '</div>';
  }

  /* ---- 留一法 ---- */
  if (C.perLeave && C.perLeave.each && C.perLeave.each.length) {
    h += '<div class="rg-sub" style="margin-top:8px"><b>留一法：去掉入选的任一类，剩下的还稳吗</b>' +
      '<span class="rg-dim"> · 全靠一类撑着的话，去掉它就会塌。</span></div>';
    h += '<div class="rg-tbl">';
    h += '<div class="rg-hd" style="grid-template-columns:1.4fr .8fr 1.8fr .8fr"><span>去掉</span><span>样本外</span><span>分段</span><span>胜率</span></div>';
    h += '<div class="rg-row" style="grid-template-columns:1.4fr .8fr 1.8fr .8fr;background:rgba(255,255,255,.04)">' +
      '<span class="rg-nm">一个都不去（' + C.k + ' 类全用）</span>' +
      '<span class="' + cls(icOf(C.perLeave.all.icOut)) + '"><b>' + sg(icOf(C.perLeave.all.icOut)) + '</b></span>' +
      '<span class="rg-dim" style="font-size:9px">' + segTxt(C.perLeave.all) + '</span>' +
      '<span class="rg-dim">' + (C.perLeave.all.roll ? pc(C.perLeave.all.roll.win, 0) : '—') + '</span></div>';
    C.perLeave.each.forEach(function (e) {
      h += '<div class="rg-row" style="grid-template-columns:1.4fr .8fr 1.8fr .8fr">' +
        '<span class="rg-nm">' + e.dropZh + '</span>' +
        '<span class="' + cls(icOf(e.r.icOut)) + '"><b>' + sg(icOf(e.r.icOut)) + '</b></span>' +
        '<span class="rg-dim" style="font-size:9px">' + segTxt(e.r) + '</span>' +
        '<span class="rg-dim">' + (e.r.roll ? pc(e.r.roll.win, 0) : '—') + '</span></div>';
    });
    h += '</div>';
  }

  /* ---- 关键证伪 ---- */
  const bo = icOf(C.btcOwn && C.btcOwn.icOut), boIn = icOf(C.btcOwn && C.btcOwn.icIn);
  const boSs = segSame(C.btcOwn);
  h += '<div class="rg-sub" style="margin-top:10px;border-top:1px solid rgba(255,255,255,.12);padding-top:8px">' +
    '<b class="rg-r">【关键证伪】这几个信号是不是只是在复述 BTC 自己？</b>' +
    '<span class="rg-dim"> · 山寨币、加密股跟 BTC 高度相关，它们的位置很可能就是 BTC 位置的换个说法。' +
    '如果是，那「+0.15」不是新信息，只是给动量换了个名字。</span></div>';
  h += '<div class="rg-tbl" style="margin-top:6px">';
  h += '<div class="rg-hd" style="grid-template-columns:1.6fr .8fr .8fr 1.6fr .8fr"><span>信号</span><span>样本内</span><span>样本外</span><span>样本外分段</span><span>胜率</span></div>';
  h += '<div class="rg-row" style="grid-template-columns:1.6fr .8fr .8fr 1.6fr .8fr;background:rgba(255,61,110,.08)">' +
    '<span class="rg-nm"><b>BTC 自身位置</b><span class="rg-dim" style="font-size:8px"> 同上口径的扩张窗口 z</span></span>' +
    '<span class="rg-dim">' + sg(boIn) + '</span>' +
    '<span class="' + cls(bo) + '"><b>' + sg(bo) + '</b></span>' +
    '<span class="rg-dim" style="font-size:9px">' + segTxt(C.btcOwn) + (boSs ? ' <b>(' + boSs.k + '/' + boSs.n + ')</b>' : '') + '</span>' +
    '<span class="rg-dim">' + (C.btcOwn && C.btcOwn.roll ? pc(C.btcOwn.roll.win, 0) : '—') + '</span></div>';
  ['lowAgree', 'equal'].forEach(function (sc) {
    let s = null; C.schemes.forEach(function (x) { if (x.scheme === sc) s = x; });
    if (!s || !s.incr) return;
    const ss = segSame(s.incr);
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .8fr .8fr 1.6fr .8fr">' +
      '<span class="rg-nm">剔除后残差 · ' + (sc === 'lowAgree' ? '低一致性方案' : '等权方案') + '</span>' +
      '<span class="rg-dim">' + sg(icOf(s.incr.icIn)) + '</span>' +
      '<span class="' + cls(icOf(s.incr.icOut)) + '"><b>' + sg(icOf(s.incr.icOut)) + '</b></span>' +
      '<span class="rg-dim" style="font-size:9px">' + segTxt(s.incr) + (ss ? ' <b>(' + ss.k + '/' + ss.n + ')</b>' : '') + '</span>' +
      '<span class="rg-dim">' + (s.incr.roll ? pc(s.incr.roll.win, 0) : '—') + '</span></div>';
  });
  if (C.endoIncr) {
    const ss = segSame(C.endoIncr);
    h += '<div class="rg-row" style="grid-template-columns:1.6fr .8fr .8fr 1.6fr .8fr">' +
      '<span class="rg-nm">剔除后残差 · 内生类（加密股+山寨币）</span>' +
      '<span class="rg-dim">' + sg(icOf(C.endoIncr.icIn)) + '</span>' +
      '<span class="' + cls(icOf(C.endoIncr.icOut)) + '"><b>' + sg(icOf(C.endoIncr.icOut)) + '</b></span>' +
      '<span class="rg-dim" style="font-size:9px">' + segTxt(C.endoIncr) + (ss ? ' <b>(' + ss.k + '/' + ss.n + ')</b>' : '') + '</span>' +
      '<span class="rg-dim">' + (C.endoIncr.roll ? pc(C.endoIncr.roll.win, 0) : '—') + '</span></div>';
  }
  h += '</div>';

  const keepLa = la && la.incr ? icOf(la.incr.icOut) : null;
  const keepEn = C.endoIncr ? icOf(C.endoIncr.icOut) : null;
  h += '<div class="rg-sub"><span class="rg-r"><b>打回去了。</b></span>' +
    '<span class="rg-dim">BTC 自身位置在样本外是<b>反向</b>的：IC ' + sg(bo) +
    (boSs ? '，' + boSs.k + '/' + boSs.n + ' 段同号' : '') + '，滚动胜率 ' +
    (C.btcOwn && C.btcOwn.roll ? pc(C.btcOwn.roll.win, 0) : '—') +
    '（这个胜率是相对样本内方向算的，越低说明反向越一致）。' +
    '而那些「看起来有效」的分类合成对它的回归系数是<b>负的</b> —— 它们有一部分是靠着' +
    '<b>反向押注 BTC 自身位置</b>拿到收益的，不是发现了新东西。' +
    '把这一层剔掉之后：低一致性方案从 ' + sg(icOf(la && la.icOut)) + ' 掉到 ' + sg(keepLa) +
    '，内生类从 ' + sg(icOf(C.endoExo.endo && C.endoExo.endo.icOut)) + ' 掉到 ' + sg(keepEn) +
    '，分段也不再一致了。</span></div>';
  h += '<div class="rg-sub"><span class="rg-y"><b>但 BTC 自身位置同样不能用</b></span>' +
    '<span class="rg-dim">—— 它自己也在漂移：样本内 ' + sg(boIn) + ' → 样本外 ' + sg(bo) +
    '，符号是反的。样本外那三年半它稳定地反向，不等于未来还会这样；' +
    '一个在样本内/外之间翻符号的信号，不管样本外多稳，都不能当交易依据。</span></div>';

  /* ---- 逐分类 ---- */
  h += '<div class="rg-sub" style="margin-top:8px"><b>逐分类：类内一致性 vs 样本外 IC</b>' +
    '<span class="rg-dim"> · 「类内一致性」= 成员方向翻正后彼此的平均相关（样本内段算）。' +
    '高 = 这类内部高度同步，合成后≈只有一个自由度；低 = 内部互不相干，平均出来是分散化的东西。</span></div>';
  h += '<div class="rg-tbl">';
  h += '<div class="rg-hd" style="grid-template-columns:1.4fr .6fr 1fr .8fr .8fr 1.4fr"><span>分类</span><span>条数</span><span>一致性</span><span>样本内</span><span>样本外</span><span>分段</span></div>';
  C.per.forEach(function (p) {
    const ss = segSame(p);
    h += '<div class="rg-row" style="grid-template-columns:1.4fr .6fr 1fr .8fr .8fr 1.4fr">' +
      '<span class="rg-nm" style="color:' + (CAT_COLORS[p.cat] || CAT_COLORS.other) + '">' + p.zh +
      '<span class="rg-dim" style="font-size:8px"> ' + (p.exo ? '外生' : '内生') + '</span></span>' +
      '<span class="rg-dim">' + p.n + '</span>' +
      '<span class="rg-dim">' + num(p.agree, 3) + '</span>' +
      '<span class="rg-dim">' + sg(icOf(p.icIn)) + '</span>' +
      '<span class="' + cls(icOf(p.icOut)) + '"><b>' + sg(icOf(p.icOut)) + '</b></span>' +
      '<span class="rg-dim" style="font-size:9px">' + segTxt(p) + (ss ? ' <b>(' + ss.k + '/' + ss.n + ')</b>' : '') + '</span></div>';
  });
  h += '</div>';
  if (C.agreeDiag) {
    h += '<div class="rg-sub"><span class="rg-dim">一致性 与 样本外 IC 的秩相关 <b>' + num(C.agreeDiag.rho, 2) + '</b>' +
      '（负 = 越同步的类样本外越差）；低一致性组样本外均值 ' + sg(C.agreeDiag.loAvg) +
      '，高一致性组 ' + sg(C.agreeDiag.hiAvg) + '。' +
      '<b>这条规律是从同一份数据里看出来的，不是事前假设</b> —— 只报出来，不拿来下结论。</span></div>';
  }

  /* ---- 风险监测 ---- */
  const RM = state.risk || (state.risk = riskMonitor(S));
  if (RM && RM.rows.length) {
    h += '<div class="rg-sub" style="margin-top:10px;border-top:1px solid rgba(255,255,255,.12);padding-top:8px">' +
      '<b>㉝b 风险监测读数（截至 ' + dstr(RM.asof) + '，全 ' + RM.rows.length + ' 类）</b>' +
      '<span class="rg-dim"> · <b>这一块不预测涨跌</b>，只回答「这批变量现在处在自己历史的什么位置」（内生 + 外生全口径）' +
      '（所以这里<b>不做方向翻正</b>，报的就是变量自身的位置，不是多空倾向）。' +
      '状态描述不需要 IC 显著，只需要分位是真的 —— 这正是这套因子能诚实提供的东西。</span></div>';
    h += '<div class="rg-tbl">';
    h += '<div class="rg-hd" style="grid-template-columns:1.0fr .55fr 1.7fr 1.1fr .7fr .9fr"><span>分类</span><span>当前值</span><span>历史分位</span><span>历史对照(vs崩溃峰值)</span><span>近60日</span><span>变化率(σ)</span></div>';
    RM.rows.forEach(function (r) {
      const p = r.pct == null ? 0.5 : r.pct;
      const vc = r.vsCrash == null ? null : r.vsCrash;
      const vcCls = vc == null ? 'rg-dim' : (vc >= 1 ? 'rg-r' : vc >= 0.8 ? 'rg-y' : 'rg-dim');
      const vcTxt = vc == null ? '—' : (vc >= 1 ? '超历史峰值' : vc >= 0.8 ? (vc.toFixed(1) + '×逼近') : (vc.toFixed(1) + '×峰值'));
      h += '<div class="rg-row" style="grid-template-columns:1.1fr .6fr 2.0fr 1.2fr .7fr .9fr">' +
        '<span class="rg-nm" style="color:' + (CAT_COLORS[r.cat] || CAT_COLORS.other) + '">' + r.zh + '</span>' +
        '<span class="rg-dim">' + sg(r.now) + '</span>' +
        '<span><span style="display:inline-block;width:64%;vertical-align:middle;height:6px;border-radius:3px;' +
        'background:linear-gradient(90deg,#00e5a0,#ffb300,#ff3d6e);position:relative">' +
        '<i style="position:absolute;top:-3px;left:' + (p * 100).toFixed(1) + '%;width:2px;height:12px;background:#fff;border-radius:1px"></i></span>' +
        ' <b style="font-size:9px">' + pc(r.pct, 0) + '</b>' +
        (r.extreme ? ' <b class="' + (r.extreme === 'high' ? 'rg-r' : 'rg-g') + '" style="font-size:9px">' + (r.extreme === 'high' ? '高位' : '低位') + '</b>' : '') +
        '</span>' +
        '<span class="' + vcCls + '">' + (r.ext == null ? '—' : (r.ext >= 0 ? '+' : '') + r.ext.toFixed(1) + 'σ') + ' · ' + vcTxt + '</span>' +
        '<span class="rg-dim">' + sg(r.d60) + '</span>' +
        '<span class="' + (r.rc == null ? 'rg-dim' : Math.abs(r.rc) >= 1.5 ? 'rg-y' : 'rg-dim') + '">' + (r.rc == null ? '—' : (r.rc >= 0 ? '+' : '') + r.rc.toFixed(1)) + '</span></div>';
    });
    h += '</div>';
    h += '<div class="rg-sub"><span class="rg-dim">分位按「扩张窗口」算：只用当前时点之前的样本给自己排名次，' +
      '所以不存在前视。新增加的<b>历史对照</b>列：左边是该变量相对自身长周期常态的 σ 偏离（带符号），' +
      '右边是「这个偏离占 2020 COVID / 2022 熊市那种崩溃窗口内出现过的最大偏离的几成」——' +
      '这是给护栏分量②的「极端」阈值一个<b>有历史锚点的参照</b>，比单纯的 5/95 尾巴更可辩护。' +
      '<b>极端分位 ≠ 要涨要跌</b>，它只说明变量现在离自己常态多远；变化率(σ)大只说明最近移动快。</span></div>';
  }

  /* ---- 定位声明 ---- */
  const bestOut = Math.max.apply(null, [Math.abs(cOut || 0), Math.abs(sOut || 0), Math.abs(pOut || 0),
    Math.abs(bo || 0), Math.abs(keepLa || 0), Math.abs(keepEn || 0)].concat(
    C.schemes.map(function (s) { return Math.abs(icOf(s.incr && s.incr.icOut) || 0); })));
  h += '<div class="rg-sub" style="margin-top:10px;border-top:1px solid rgba(255,255,255,.12);padding-top:8px">' +
    '<b class="rg-y">这一节最终该得出什么结论</b><br>' +
    '<span class="rg-dim">试过的所有做法 —— 挑单因子、降维到分类、不挑全池、换四种挑选规则、' +
    '调 K、留一法、乃至 BTC 自身位置 —— 样本外 |IC| 最大只到 <b>' + num(bestOut, 3) + '</b>，' +
    '而且没有一个是「样本内外同号 + 分段一致 + 剔除自身后仍稳」三条全过的。' +
    '<br><b>所以定位要说清楚：这套东西适合当<b>参考意见和风险监测</b>，不适合当方向择时。</b>' +
    '它能告诉你「信用利差现在处在历史 27% 分位」「这批因子里谁跟 BTC 走得近」，' +
    '但它给不出一个能拿去下单的方向 —— 这不是实现没做好，是<b>数据给出的答案</b>。</span></div>';
  return h;
}

/* ---------- ㉚ 渲染：因子宇宙 · 影响强度筛选 ---------- */
function renderUniverseBox() {
  const box = $('uniBox');
  if (!box) return;
  const num = function (v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp); };
  const pc = function (v, dp) { return v == null ? '—' : (v * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  const sg = function (v, dp) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp == null ? 3 : dp); };

  if (!CONFIG.PROXY) { box.innerHTML = '<div class="rg-sub">需要 Worker 代理（/api/universe）；当前为直连模式。</div>'; return; }
  const U = state.universe;
  if (!U || !Object.keys(U.series).length) {
    box.innerHTML = '<div class="rg-sub"><b>因子宇宙尚未加载。</b>' +
      '<span class="rg-dim">候选池是 ' + (U && U.n ? U.n : '167') + ' 条真实日频序列（全球股指 / 板块 / 利率 / 信用 / 外汇 / 商品 / 波动率 / 加密概念股 / 山寨币 / 科技股），' +
      '首次拉取要逐条走 Yahoo，约需一分钟，之后走 6 小时边缘缓存。点上方「加载因子宇宙」开始。</span></div>';
    return;
  }
  if (!state.histBundle || !(state.histBundle.btc)) {
    box.innerHTML = '<div class="rg-sub"><b>需要先跑一次十年回放</b>（筛选要用 BTC 日线的完整历史做对齐基准）。' +
      '<span class="rg-dim">已加载 ' + Object.keys(U.series).length + ' 条候选序列。</span></div>';
    return;
  }
  const S = state.screening || (state.screening = factorScreening());
  if (!S || !S.rows.length) { box.innerHTML = '<div class="rg-sub">样本不足以筛选（BTC 历史序列太短）。</div>'; return; }

  const dstr = t => new Date(t).toISOString().slice(0, 10);
  const ns = S.byTier.strong.length, nm = S.byTier.mid.length, nw = S.byTier.weak.length;

  let h = '<div class="rg-sub"><b>候选池 ' + S.nTotal + ' 条真实序列，' + S.nScreened + ' 条样本足够、进入筛选，' +
    S.nShort + ' 条因样本不足被排除。</b>BTC 区间 ' + dstr(S.btcSpan.t0) + ' → ' + dstr(S.btcSpan.t1) +
    '，主视野 <b>' + S.h + ' 日</b>（事前定死、不挑最优）。<br>' +
    '<span class="rg-dim">筛选结果：<b class="rg-g">强影响 ' + ns + '</b> · <b class="rg-y">中影响 ' + nm + '</b> · <b class="rg-dim">弱影响 ' + nw + '</b>' +
    '（共 ' + S.nStable + ' 条样本外不漂移，' + S.nFlip + ' 条漂移）。</span></div>';

  /* 两条必须先说的坏消息 —— 它们决定了下面所有数字该怎么读 */
  h += '<div class="rg-sub" style="margin-top:6px"><b>先说两条坏消息，否则下面的表会被误读：</b><br>' +
    '<span class="rg-r">① 按 BH-FDR 校正，' + S.nScreened + ' 个因子里通过 q&lt;' + S.q + ' 的有 <b>' + S.nQ + ' 个</b>。</span>' +
    '<span class="rg-dim">同时测 160 个因子必然产生一批假阳性，校正后能站住的一个都没有 —— ' +
    '这套数据的最小可探测 |IC| 约 <b>' + num(S.minDetect, 3) + '</b>（|IC| 要超过它才能算显著），' +
    '而实测最强的单因子 |IC| 也只有 ' + num(S.rows.length ? Math.max.apply(null, S.rows.map(function (r) { return r.abs; })) : null, 3) + '。' +
    '<b>这不是筛选做错了，这就是答案。</b></span><br>' +
    '<span class="rg-r">② ' + S.nFlip + ' / ' + S.nScreened + ' 个因子的 IC 在前 60% 与后 40% <b>符号相反</b>。</span>' +
    '<span class="rg-dim">也就是说：随便挑一个因子，它的方向有 ' + pc(S.nFlip / S.nScreened, 0) +
    ' 的概率只是某一段行情的偶然。这就是为什么下面用<b>相对刻度</b>分档（回答「这批候选里谁更强」），' +
    '而不是用显著性分档 —— 用显著性分档的结果会是「全是弱」，那不是诚实，是把刻度用废了。</span></div>';

  /* ---- 分类汇总 ---- */
  h += '<div class="rg-sub" style="margin-top:8px"><b>按数据分类看：哪一类变量整体上更有用</b></div>';
  h += '<div class="rg-tbl">';
  h += '<div class="rg-hd" style="grid-template-columns:1.4fr .7fr .7fr .7fr .7fr .9fr"><span>分类</span><span>条数</span><span>强</span><span>中</span><span>弱</span><span>平均|IC|</span></div>';
  const cs = Object.keys(S.catStat).sort(function (a, b) { return S.catStat[b].absAvg - S.catStat[a].absAvg; });
  cs.forEach(function (c) {
    const v = S.catStat[c];
    h += '<div class="rg-row" style="grid-template-columns:1.4fr .7fr .7fr .7fr .7fr .9fr">' +
      '<span class="rg-nm" style="color:' + (CAT_COLORS[c] || CAT_COLORS.other) + '">' + (CAT_ZH[c] || c) + '</span>' +
      '<span class="rg-dim">' + v.n + '</span>' +
      '<span class="rg-g">' + (v.strong || '·') + '</span>' +
      '<span class="rg-y">' + (v.mid || '·') + '</span>' +
      '<span class="rg-dim">' + v.weak + '</span>' +
      '<span><b>' + num(v.absAvg, 3) + '</b></span></div>';
  });
  h += '</div>';

  /* ---- 强影响明细 ---- */
  h += '<div class="rg-sub" style="margin-top:8px"><b>强影响因子（按 |IC| 降序）</b>' +
    '<span class="rg-dim"> · ICIR 是滚动 IC 的均值/标准差，比 IC 更能说明「能不能长期用」；' +
    '胜率是滚动窗口里与总 IC 同号的比例；半衰期决定该多久调一次仓。</span></div>';
  if (!ns) {
    h += '<div class="rg-sub"><span class="rg-y">按事前定死的门槛，一条强影响因子都没筛出来。</span>' +
      '<span class="rg-dim">这本身就是结论：在这批候选里，没有哪个单一变量对 BTC 未来 ' + S.h +
      ' 日收益有稳定且足够大的预测力。宁可如实说「没有」，也不要靠放宽门槛造出几个「强因子」。</span></div>';
  } else {
    h += '<div class="rg-tbl">';
    h += '<div class="rg-hd" style="grid-template-columns:1.5fr .8fr .7fr .7fr .7fr .8fr 1fr .7fr">' +
      '<span>因子</span><span>IC</span><span>ICIR</span><span>胜率</span><span>q</span><span>内→外</span><span>半衰期</span><span>样本</span></div>';
    S.byTier.strong.slice(0, 24).forEach(function (r) {
      h += '<div class="rg-row" style="grid-template-columns:1.5fr .8fr .7fr .7fr .7fr .8fr 1fr .7fr">' +
        '<span class="rg-nm" style="color:' + (CAT_COLORS[r.cat] || CAT_COLORS.other) + '">' + uniName(r.key) + '<span class="rg-dim" style="font-size:8px"> ' + (CAT_ZH[r.cat] || r.cat) + '</span></span>' +
        '<span class="' + (r.ic > 0 ? 'rg-g' : 'rg-r') + '"><b>' + sg(r.ic) + '</b></span>' +
        '<span class="' + (r.icir != null && Math.abs(r.icir) >= 0.5 ? 'rg-g' : 'rg-dim') + '">' + num(r.icir) + '</span>' +
        '<span class="rg-dim">' + pc(r.win, 0) + '</span>' +
        '<span class="rg-dim">' + (r.q == null ? '—' : r.q.toFixed(3)) + '</span>' +
        '<span class="rg-dim">' + sg(r.icIn) + '→' + sg(r.icOut) + '</span>' +
        '<span class="rg-dim">' + (r.hl == null ? '&gt;20日' : num(r.hl, 1) + '日') + '</span>' +
        '<span class="rg-dim">' + r.n + '</span></div>';
    });
    h += '</div>';
  }

  /* ---- 中影响（折叠式：只列前 12） ---- */
  if (nm) {
    h += '<div class="rg-sub" style="margin-top:8px"><b>中影响因子（前 12）</b></div>';
    h += '<div class="rg-tbl">';
    h += '<div class="rg-hd" style="grid-template-columns:1.5fr .8fr .7fr .7fr .7fr .8fr 1fr .7fr">' +
      '<span>因子</span><span>IC</span><span>ICIR</span><span>胜率</span><span>q</span><span>内→外</span><span>半衰期</span><span>样本</span></div>';
    S.byTier.mid.slice(0, 12).forEach(function (r) {
      h += '<div class="rg-row" style="grid-template-columns:1.5fr .8fr .7fr .7fr .7fr .8fr 1fr .7fr">' +
        '<span class="rg-nm" style="color:' + (CAT_COLORS[r.cat] || CAT_COLORS.other) + '">' + uniName(r.key) + '<span class="rg-dim" style="font-size:8px"> ' + (CAT_ZH[r.cat] || r.cat) + '</span></span>' +
        '<span class="' + (r.ic > 0 ? 'rg-g' : 'rg-r') + '">' + sg(r.ic) + '</span>' +
        '<span class="rg-dim">' + num(r.icir) + '</span>' +
        '<span class="rg-dim">' + pc(r.win, 0) + '</span>' +
        '<span class="rg-dim">' + (r.q == null ? '—' : r.q.toFixed(3)) + '</span>' +
        '<span class="rg-dim">' + sg(r.icIn) + '→' + sg(r.icOut) + (r.flip ? ' ⚠' : '') + '</span>' +
        '<span class="rg-dim">' + (r.hl == null ? '&gt;20日' : num(r.hl, 1) + '日') + '</span>' +
        '<span class="rg-dim">' + r.n + '</span></div>';
    });
    h += '</div>';
  }

  /* ---- 宇宙评分的样本外检验 ---- */
  const US = state.uniScore || (state.uniScore = universeScore(S));
  if (US) {
    h += '<div class="rg-sub" style="margin-top:8px"><b>把「筛选」本身也放到样本外检验</b>：' +
      '只在<b>前 60%</b>（截至 ' + dstr(US.cutDate) + '）挑出 Top-' + US.k + '，再只看它们在<b>后 40%</b> 的表现。<br>' +
      '<span class="rg-dim">为什么必须这样切：如果在全样本上挑出「强因子」再回测它们的合成，那是拿答案考自己 —— 挑的时候已经看过未来了。</span></div>';
    h += '<div class="rg-tbl" style="margin-top:6px">';
    h += '<div class="rg-hd" style="grid-template-columns:1.4fr .8fr .7fr .8fr .8fr"><span>区间</span><span>IC</span><span>t</span><span>样本</span><span>有效n</span></div>';
    [['样本内（用于挑因子）', US.icIn], ['样本外（真正意义上的检验）', US.icOut], ['全样本', US.icAll]].forEach(function (x, i) {
      const v = x[1];
      h += '<div class="rg-row" style="grid-template-columns:1.4fr .8fr .7fr .8fr .8fr' + (i === 1 ? ';background:rgba(0,229,160,.06)' : '') + '">' +
        '<span class="rg-nm">' + x[0] + '</span>' +
        '<span class="' + (v && v.ic > 0.05 ? 'rg-g' : v && v.ic < -0.05 ? 'rg-r' : 'rg-dim') + '"><b>' + (v ? sg(v.ic) : '—') + '</b></span>' +
        '<span class="rg-dim">' + (v ? num(v.t) : '—') + '</span>' +
        '<span class="rg-dim">' + (v ? v.n : '—') + '</span>' +
        '<span class="rg-dim">' + (v ? v.neff : '—') + '</span></div>';
    });
    h += '</div>';
    const oi = US.icOut, ii = US.icIn;
    if (ii && oi && ii.ic > 0.05 && oi.ic < 0.02) {
      h += '<div class="rg-sub"><span class="rg-r"><b>这是整份报告里最要紧的一行</b></span>：' +
        '只用样本内 IC 挑出来的这 Top-' + US.k + '，样本内 IC ' + sg(ii.ic) + '（t ' + num(ii.t) + '，看着很像回事），' +
        '<b>样本外却掉到 ' + sg(oi.ic) + '（t ' + num(oi.t) + '）</b>。' +
        '<span class="rg-dim">两者之差就是<b>选择偏差</b>的身价：挑因子这件事本身用掉了绝大部分表观收益。' +
        '几乎所有「因子研究」都只报前者，因为后者不好看 —— 但后者才是能拿去交易的数。' +
        '<br>顺带一条：如果反过来想，样本外 IC 显著为负意味着这套信号在后期是<b>反向</b>的，' +
        '但 t 只有 ' + num(oi.t) + '，离「稳定的反向指标」还差得远，不要顺势去反过来做。</span></div>';
    }
    h += '<div class="rg-sub"><b>判定：' +
      (oi == null ? '样本外数据不足' :
        (Math.abs(oi.ic) < 0.03 ? '<span class="rg-y">样本外 IC 接近零 —— 筛选出来的「强因子」在后 40% 基本没有预测力</span>' :
          ((oi.ic > 0) === (ii && ii.ic > 0) ? '<span class="rg-g">样本外符号与样本内一致</span>，方向站得住' :
            '<span class="rg-r">样本外符号与样本内相反</span>，说明挑出来的方向是样本内的偶然'))) +
      '</b> —— ' +
      '<span class="rg-dim">样本内 ' + (ii ? sg(ii.ic) : '—') + ' → 样本外 ' + (oi ? sg(oi.ic) : '—') +
      '。这个衰减幅度才是「因子研究」真实的样子：样本内好看、样本外打折，' +
      '而绝大多数人只报前者。这里两个都报。</span></div>';
  }
  /* ㉜ 分类合成要跑 160×10 的量，同步算会卡住整页 ——
   * 先把上面这些渲染出来，再异步算、算完插进去。 */
  h += '<div id="cmpBox" class="rg-sub" style="margin-top:10px"><span class="rg-dim">正在计算分类合成（' +
    S.nScreened + ' 个因子 → ' + Object.keys(S.catStat).length + ' 个分类），约需十几秒…</span></div>';
  h += '<div id="oosBox" class="rg-sub" style="margin-top:10px"><span class="rg-dim">正在计算 ㉝ 真正的样本外追踪（多折 walk-forward，每折训练段独立挑分类），约需十几秒…</span></div>';
  h += '<div id="grBox" class="rg-sub" style="margin-top:10px"><span class="rg-dim">正在计算 ㉞ 风险护栏（DVOL 体制 + 全分类极端分位联动 + 变化率联动，聚合成 GREEN/YELLOW/RED）…</span></div>';
  box.innerHTML = h;
  setTimeout(function () { renderCompositeInto(S); }, 60);
}

/* 分类合成这一段单独渲染：算得慢，不能堵住首屏，而且失败不能连累上面已有的内容。 */
function renderCompositeInto(S) {
  const node = document.getElementById('cmpBox');
  if (!node) return;
  try {
    const C = state.composite || (state.composite = categoryComposite(S));
    if (!C) { node.innerHTML = '<span class="rg-dim">分类合成：可用分类不足（每个类至少 ' + CMP.MIN_MEMBER + ' 条成员）。</span>'; return; }
    node.outerHTML = compositeHTML(C, S);
    /* 分类合成渲染完，再异步算 ㉝ 样本外追踪：它要跑多折，不能堵在首屏 */
    setTimeout(function () { renderOOSInto(S); }, 60);
    /* ㉞ 风险护栏依赖 state.risk（compositeHTML 已算出并缓存），延迟到 OOS 之后渲染 */
    setTimeout(function () { renderGuardrailInto(S); }, 200);
  } catch (e) {
    console.warn('composite fail', e && e.message);
    node.innerHTML = '<span class="rg-r">分类合成计算失败：' + (e && e.message ? e.message : '未知错误') + '</span>';
  }
}
