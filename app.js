/* =====================================================================
 * NEXUS TERMINAL v3.6 — 加密货币实时监测与因子关系终端
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
function pearson(x, y) {
  const n = Math.min(x.length, y.length); if (n < 5) return null;
  let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n; let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  if (dx === 0 || dy === 0) return null; return num / Math.sqrt(dx * dy);
}
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
  for (let i = arr.length - 1; i >= 0; i--) if (re.test(arr[i].title)) return arr[i];
  return null;
}
/* 事件因子: surprise = 实际 − 预期（正数=强于预期），
 * 这里只算「原始 surprise 的标准化值」，方向由因子表的 dir 决定（避免方向被应用两次）。
 * 未发布时退化为「预期 − 前值」× 0.5 权重。 */
function econFactor(cfg) {
  const e = econFind(cfg.re);
  if (!e) return { z: 0, note: '本周无发布' };
  const a = parseEconVal(e.a), f = parseEconVal(e.f), p = parseEconVal(e.p);
  if (a != null && f != null) return { z: clampZ((a - f) / cfg.std), note: `实际 ${e.a} / 预期 ${e.f}` };
  if (f != null && p != null) return { z: clampZ((f - p) / cfg.std * 0.5), note: `预期 ${e.f}（未发布·半权重）` };
  return { z: 0, note: '待发布' };
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
  { id: 'nfp', name: '👷 非农就业', group: 'event', w: 0.6, dir: -1, calc: () => econFactor({ re: /^Non-Farm Employment Change$/i, std: 60 }) },
  { id: 'urate', name: '🧑‍💼 失业率', group: 'event', w: 0.5, dir: 1, calc: () => econFactor({ re: /^Unemployment Rate$/i, std: 0.12 }) },
  { id: 'claims', name: '📋 初请失业金', group: 'event', w: 0.4, dir: 1, calc: () => econFactor({ re: /^Unemployment Claims$/i, std: 8 }) },
  { id: 'pce', name: '💵 核心PCE', group: 'event', w: 0.6, dir: -1, calc: () => econFactor({ re: /^Core PCE Price Index m\/m$/i, std: 0.08 }) },
  { id: 'cpi', name: '🔥 CPI月率', group: 'event', w: 0.5, dir: -1, calc: () => econFactor({ re: /^CPI m\/m$/i, std: 0.12 }) },
  /* —— 技术面（BTC 自身）—— */
  /* tech / mom：回放期间走预计算表（state.btcZ），实时模式走 K 线原路径 */
  { id: 'tech', name: '📐 技术面', group: 'tech', w: 1.0, dir: 1, calc: () => { const bz = state.btcZ; if (bz) { const i = state.klIdx == null ? bz.tech.length - 1 : state.klIdx; if (i < 100) return { z: 0, ok: false, note: '无数据' }; return { z: bz.tech[i], note: 'RSI ' + bz.rsi[i].toFixed(0) }; } const k = state.klines['BTC' + state.interval]; if (!k) return { z: 0, note: '—' }; const c = k.map(x => x.c); const e20 = ema(c, 20), e50 = ema(c, 50), r = rsi(c); const z = (e20[e20.length - 1] - e50[e50.length - 1]) / (e50[e50.length - 1] || 1) * 30 + (r[r.length - 1] - 50) / 12; return { z, note: 'RSI ' + r[r.length - 1].toFixed(0) }; } },
  { id: 'mom', name: '🚀 动量', group: 'tech', w: 0.8, dir: 1, calc: () => { const bz = state.btcZ; if (bz) { const i = state.klIdx == null ? bz.mom.length - 1 : state.klIdx; if (i < 100) return { z: 0, ok: false, note: '无数据' }; const pc = bz.mom[i] * 8; return { z: bz.mom[i], note: pc.toFixed(1) + '%' }; } const k = state.klines['BTC' + state.interval]; if (!k) return { z: 0, note: '—' }; const c = k.map(x => x.c); const pc = pctChange(c.slice(-30)) || 0; return { z: pc / 8, note: pc.toFixed(1) + '%' }; } },
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
      if (dep[0] === null) has = ((state.klines['BTC' + state.interval] || []).length >= dep[1]);
      else has = mLen(dep[0]) >= dep[1];
    }
    const z = clampZ(r.z);
    const contribution = Math.max(-2.5, Math.min(2.5, (f.dir || 0) * z));   // 方向化贡献
    out[f.id] = { z, contribution, dir: f.dir || 0, note: r.note, ok: has };
    if (f.dir && has) { sum += contribution * f.w; wsum += f.w; nScored++; }
    else if (f.dir && !has) nDead++;
  });
  const score = Math.round(50 + (wsum ? sum / wsum : 0) * 22);
  return { score: Math.max(2, Math.min(98, score)), out, nScored, nDead };
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
let net = null;
let netRunning = false;      // 全局唯一动画循环开关（修复每 60 秒泄漏一个 rAF 循环）
function netKeys() { return Object.keys(state.series).filter(k => META[k] && state.retMaps[k] && state.retMaps[k].size > 20); }
function initNetwork() {
  const cv = $('netCanvas'); if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  const keys = netKeys();
  const nodes = [], edges = [];
  keys.forEach(id => { const m = META[id]; nodes.push({ id, label: m.name, short: m.s, color: m.color, group: m.group, x: W / 2 + (Math.random() - .5) * 200, y: H / 2 + (Math.random() - .5) * 160, vx: 0, vy: 0, fixed: id === 'BTC' }); });
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const r = pearsonMaps(state.retMaps[keys[i]], state.retMaps[keys[j]]);
    if (r != null && Math.abs(r) > 0.08) edges.push({ a: keys[i], b: keys[j], r });
  }
  net = { cv, ctx: cv.getContext('2d'), nodes, edges, W, H, idle: 0 };
  const btc = nodes.find(n => n.id === 'BTC'); if (btc) { btc.x = W / 2; btc.y = H / 2; btc.fixed = true; }
  $('netCount') && ($('netCount').textContent = `${nodes.length} 因子 / ${edges.length} 关系 · 日收益相关性`);
  if (!netRunning) { netRunning = true; animateNetwork(); }   // 只允许一个循环
}
function animateNetwork() {
  if (!net) return; const { cv, ctx, nodes, edges, W, H } = net;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  for (let it = 0; it < 2; it++) {
    nodes.forEach(n => { if (n.fixed) return; let fx = (W / 2 - n.x) * 0.002, fy = (H / 2 - n.y) * 0.002;
      nodes.forEach(m => { if (m === n) return; const dx = n.x - m.x, dy = n.y - m.y; const d2 = dx * dx + dy * dy + 1; const f = 1400 / d2; fx += dx / Math.sqrt(d2) * f; fy += dy / Math.sqrt(d2) * f; });
      n.vx = (n.vx + fx) * 0.85; n.vy = (n.vy + fy) * 0.85; n.x += n.vx; n.y += n.vy; });
    edges.forEach(e => { const a = nodes.find(n => n.id === e.a), b = nodes.find(n => n.id === e.b); if (!a || !b) return; const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 90) * 0.01; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; });
  }
  edges.forEach(e => { const a = nodes.find(n => n.id === e.a), b = nodes.find(n => n.id === e.b); if (!a || !b) return; const col = e.r > 0 ? `rgba(0,229,160,${Math.min(.7, Math.abs(e.r))})` : `rgba(255,61,110,${Math.min(.7, Math.abs(e.r))})`; ctx.strokeStyle = col; ctx.lineWidth = 1 + Math.abs(e.r) * 3; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); });
  nodes.forEach(n => { const r = n.id === 'BTC' ? 16 : 9; ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill(); ctx.fillStyle = '#060c18'; ctx.font = 'bold 9px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n.id === 'BTC' ? 'BTC' : (n.short || n.label.slice(0, 3)), n.x, n.y); if (n.id !== 'BTC') { ctx.fillStyle = '#a8bfd6'; ctx.font = '8px Inter, sans-serif'; ctx.fillText(n.label, n.x, n.y + r + 9); } });
  // 力导向收敛后停帧省电（刷新/缩放时会重新启动）
  const ke = nodes.reduce((a, n) => a + Math.abs(n.vx) + Math.abs(n.vy), 0);
  net.idle = ke < 0.06 ? net.idle + 1 : 0;
  if (net.idle > 90) { netRunning = false; return; }
  requestAnimationFrame(animateNetwork);
}
function renderHeatmap() {
  const box = $('heatmap'); if (!box) return; const ids = netKeys();
  box.style.gridTemplateColumns = `64px repeat(${ids.length}, 1fr)`;
  let html = '<div class="hm-h"></div>' + ids.map(id => `<div class="hm-h" title="${META[id].name}">${META[id].s || META[id].name.slice(0, 2)}</div>`).join('');
  ids.forEach(ri => {
    html += `<div class="hm-h" style="text-align:left" title="${META[ri].name}">${META[ri].s || META[ri].name.slice(0, 2)}</div>`;
    ids.forEach(ci => { const r = ri === ci ? 1 : pearsonMaps(state.retMaps[ri], state.retMaps[ci]); const bg = r == null ? '#132035' : r > 0 ? `rgba(0,229,160,${Math.abs(r) * .8})` : `rgba(255,61,110,${Math.abs(r) * .8})`; html += `<div class="hm-cell" style="background:${bg};color:${Math.abs(r || 0) > .5 ? '#060c18' : '#a8bfd6'}">${r == null ? '·' : r.toFixed(2)}</div>`; });
  });
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
function renderFactors() {
  const { score, out, nScored, nDead } = computeNexusScore();
  const ring = $('nxRing'); if (ring) { ring.setAttribute('stroke-dasharray', `${score * 2.51} 251`); ring.setAttribute('stroke', score > 60 ? '#00e5a0' : score < 40 ? '#ff3d6e' : '#ffc107'); }
  if ($('nxScore')) $('nxScore').textContent = score;
  if ($('nxSig')) { const s = score > 60 ? '偏多' : score < 40 ? '偏空' : '中性'; $('nxSig').textContent = s; $('nxSig').className = 'fscore-l ' + (score > 60 ? 'up' : score < 40 ? 'dn' : 'n'); }
  const box = $('factorGrid'); if (!box) return; box.innerHTML = '';
  FACTORS.forEach(f => {
    if (f.replayOnly) return;            // 回放专用因子不出现在实时面板
    const r = out[f.id];
    const c = r.contribution;                       // dir × z：正=利多、负=利空
    const show = f.dir === 0;
    const dead = r.ok === false;
    const col = dead || show ? '#3a5070' : c > 0.25 ? '#00e5a0' : c < -0.25 ? '#ff3d6e' : '#ffc107';
    const tag = dead ? '无数据' : show ? '仅展示' : c > 0.25 ? '利多' : c < -0.25 ? '利空' : '中性';
    const dirTxt = f.dir > 0 ? 'z↑=利多' : f.dir < 0 ? 'z↑=利空' : '不参与评分';
    const card = document.createElement('div');
    card.className = 'fcard';
    card.title = `${f.name}\n权重 ${f.w} · 方向 ${f.dir > 0 ? '+1' : f.dir < 0 ? '-1' : '0'}（${dirTxt}）\n原始 z ${r.z.toFixed(2)} · 贡献 ${c.toFixed(2)}\n${r.note}`;
    card.innerHTML = `<div class="fc-name">${f.name}</div><div class="fc-z" style="color:${col}">${show || dead ? '—' : (c >= 0 ? '+' : '') + c.toFixed(1)}</div><div class="fc-str"><div class="fc-strbar" style="width:${Math.min(100, Math.abs(c) / 2.5 * 100)}%;background:${col}"></div></div><div class="fc-sig" style="color:${col}">${tag} · ${r.note}</div>`;
    box.appendChild(card);
  });
  const cnt = $('fCount'); if (cnt) cnt.textContent = FACTORS.filter(f => !f.replayOnly).length + ' 维 · ' + nScored + ' 参与评分' + (nDead ? ' · ' + nDead + ' 无数据' : '');

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
  const fvals = {}, fzs = {};
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
          if (!fvals[fid]) { fvals[fid] = new Array(n).fill(null); fzs[fid] = new Array(n).fill(null); }
          fvals[fid][i] = o.contribution;
          fzs[fid][i] = o.z;
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
  return { calTs, closes, scores, fvals, fzs, start, n, nScored, nAct,
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
function pearson(x, y) {
  const n = x.length; if (n < 5) return null;
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
    /* v3.12: Deribit 期权原生指标（分析专用参考，不入评分）—— 测真实 IC，先看有没有用 */
    const aux = {};
    ['DVOL', 'DVHV'].forEach(function (k) { const a = auxRegimeIC(rep, k); if (a) aux[k] = a; });
    /* v3.11 实践延展：极端体制子评分的回测验证（同 10 年样本，非样本外） */
    const exSeries = extremeSubSeries(rep);
    const exWildIC = icCore(regimeMasked(exSeries, rep, 'wild'), rep, 10, rep.start, rep.n);
    const exAllIC = icCore(exSeries, rep, 10, rep.start, rep.n);
    const exMainWild = reg.byRegime.wild ? reg.byRegime.wild.ic : null;
    state.hist = { rep: rep, ics: ics, facs: facs, oos: oos, roll: roll, ext: ext, reg: reg, per: per, aux: aux,
      extreme: { series: exSeries, wildIC: exWildIC, mainWildIC: exMainWild, allIC: exAllIC } };
    renderHistory();
    renderReview();
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
  { d: '2016-06-17', t: 'The DAO 被攻击', k: 'chain', n: '约 360 万 ETH 被盗，以太坊硬分叉' },
  { d: '2016-08-02', t: 'Bitfinex 被盗', k: 'chain', n: '约 12 万 BTC 失窃，交易所偿付危机' },
  { d: '2017-09-04', t: '中国 ICO/交易所禁令', k: 'reg', n: '七部委定性 ICO 非法，境内交易所关停' },
  { d: '2017-12-17', t: '上一轮周期顶部', k: 'cycle', n: 'CME 期货上线后见顶约 $19,800' },
  { d: '2018-02-05', t: '2018 崩盘', k: 'cycle', n: '从 $17,000 一路阴跌至 $6,000' },
  { d: '2018-11-14', t: 'BCH 算力战', k: 'chain', n: '分叉算力战引发抛售，BTC 腰斩至 $3,200' },
  { d: '2019-10-24', t: '中国高层表态支持区块链', k: 'policy', n: '单日急拉，情绪驱动为主' },
  { d: '2020-03-12', t: '疫情全球崩盘（312）', k: 'macro', n: '全球流动性危机，BTC 单日 -40%' },
  { d: '2020-05-11', t: '第三次减半', k: 'cycle', n: '区块奖励 12.5 → 6.25 BTC' },
  { d: '2020-08-11', t: '上市公司开始配置 BTC', k: 'flow', n: '微策略首次买入，机构叙事起点' },
  { d: '2021-02-08', t: '特斯拉买入 15 亿美元', k: 'flow', n: '企业资产负债表入场' },
  { d: '2021-05-12', t: '特斯拉暂停 BTC 支付', k: 'event', n: '马斯克一条推文，市场急挫' },
  { d: '2021-05-19', t: '中国挖矿与交易禁令', k: 'reg', n: '算力大迁移，BTC 单日一度 -30%' },
  { d: '2021-11-10', t: '通胀破 6% 见顶', k: 'macro', n: 'BTC 见顶约 $69,000' },
  { d: '2022-05-09', t: 'LUNA/UST 崩盘', k: 'chain', n: '算法稳定币死亡螺旋，传染全市场' },
  { d: '2022-06-15', t: '美联储加息 75bp', k: 'macro', n: '1994 年以来最大单次加息' },
  { d: '2022-06-30', t: '三箭资本爆雷', k: 'credit', n: 'Celsius 冻结提款，信贷链断裂' },
  { d: '2022-11-08', t: 'FTX 破产', k: 'credit', n: '交易所信用崩塌，BTC 跌至 $15,500' },
  { d: '2023-03-10', t: '硅谷银行倒闭', k: 'macro', n: 'USDC 一度脱锚，避险与宽松预期并存' },
  { d: '2023-06-05', t: 'SEC 起诉币安/Coinbase', k: 'reg', n: '监管冲击，但市场迅速消化' },
  { d: '2024-01-10', t: '现货 ETF 获批', k: 'flow', n: '11 只现货 ETF 通过，结构性资金入口打开' },
  { d: '2024-04-20', t: '第四次减半', k: 'cycle', n: '区块奖励 6.25 → 3.125 BTC' },
  { d: '2024-08-05', t: '日元套息平仓', k: 'macro', n: '日央行加息+美国就业走弱，全球风险资产同跌' },
  { d: '2024-11-05', t: '特朗普当选', k: 'policy', n: '加密友好预期，BTC 从 $68,000 急拉破 $90,000' },
  { d: '2025-02-01', t: '关税第一轮', k: 'tariff', n: '关税公告把 BTC 压回 $82,000 下方' },
  { d: '2025-04-02', t: '对等关税「解放日」', k: 'tariff', n: '48 小时内 BTC -8%，风险资产同步去杠杆' },
  { d: '2025-05-12', t: '中美关税休战', k: 'tariff', n: '风险偏好修复，BTC 重回 $100,000 上方' },
  { d: '2025-10-10', t: '100% 关税 + 史上最大清算', k: 'tariff', n: '约 190 亿美元杠杆被清算、160 万账户，BTC 数小时内 -14.5%，永续持仓量骤降 43%' },
  { d: '2025-10-10', t: '本轮周期顶部', k: 'cycle', n: 'BTC 见顶约 $126,200 后未再收复' },
  { d: '2026-02-15', t: '跌破 $60,000', k: 'cycle', n: 'ETF 持续净流出，较顶部腰斩' },
  { d: '2026-04-15', t: '关税第二轮', k: 'tariff', n: '单季 -29%，2018 年以来最差季度' },
  { d: '2026-05-20', t: '美联储换帅转鹰', k: 'policy', n: 'Warsh 接任并取消前瞻指引，实际利率高企' },
  { d: '2026-06-17', t: '美联储第四次暂停', k: 'policy', n: '维持 3.50~3.75%，多数官员预期年内还要加息' },
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
  const k = state.klines['BTC1d'];
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
  renderPaper();
  initNetwork(); renderHeatmap();
  renderStatus(ok);
  refreshDvolAlarm();   // v3.14: 实时波动率恐慌警报（异步，不阻塞主渲染）
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
  const bt = $('btRun'); if (bt) bt.addEventListener('click', renderBacktest);
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
  const refresh = $('refreshBtn'); if (refresh) refresh.addEventListener('click', refreshAll);
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
    if (state.hist) renderHistory();
    if (net) { net.W = $('netCanvas').clientWidth; net.H = $('netCanvas').clientHeight; net.idle = 0; if (!netRunning) { netRunning = true; animateNetwork(); } }
  });
});
