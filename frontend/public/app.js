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
  asof: null, histBundle: null, hist: null,
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
 * state.asof === null 表示用最新值 —— 即正常实时模式。 */
function asofCut(a, key) {
  if (!a) return a;
  if (!state.asof || state.asof[key] == null) return a;
  const i = Math.min(state.asof[key], a.length - 1);
  return i < 0 ? [] : a.slice(0, i + 1);
}
const mZ = (key, n = 120) => { const a = asofCut(state.macroSeries && state.macroSeries[key], key); return a ? rollZ(a, n) : 0; };
const mChgZ = (key, days = 60, n = 120) => { const a = asofCut(state.macroSeries && state.macroSeries[key], key); return a ? chgZ(a, days, n) : 0; };
const mV = key => { const a = asofCut(state.macroSeries && state.macroSeries[key], key); return a && a.length ? a[a.length - 1] : null; };
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
  { id: 'fng', name: '😱 恐惧贪婪', group: 'sentiment', w: 1.0, dir: -1, calc: () => { const v = state.fg ? +state.fg.value : 50; return { z: (v - 50) / 18, note: 'F&G ' + v + ' · 反向' }; } },
  { id: 'fund', name: '💸 资金费率', group: 'deriv', w: 0.9, dir: -1, calc: () => { const f = state.deriv.funding; if (f == null) return { z: 0, note: '—' }; return { z: f / 0.03, note: f.toFixed(4) + '% · 反向' }; } },
  { id: 'ls', name: '⚖️ 多空比', group: 'deriv', w: 0.7, dir: -1, calc: () => { const l = state.deriv.ls; if (l == null) return { z: 0, note: '—' }; return { z: (l - 50) / 10, note: l.toFixed(1) + '%多 · 反向' }; } },
  { id: 'oi', name: '📊 合约持仓', group: 'deriv', w: 0.6, dir: -1, calc: () => { const a = state.deriv.oiSeries; if (!a || !a.length) return { z: 0, note: '—' }; return { z: rollZ(a, 120), note: fmtBig(state.deriv.oi) + ' BTC' }; } },
  /* —— 结构 / 流动性 —— */
  { id: 'dom', name: '👑 BTC占比', group: 'market', w: 0.6, dir: -1, calc: () => { const d = state.global && state.global.market_cap_percentage.btc; if (d == null) return { z: 0, ok: false, note: '无数据' }; return { z: (d - 56) / 5, note: d.toFixed(1) + '%' }; } },
  { id: 'stable', name: '🪙 稳定币占比', group: 'market', w: 0.5, dir: 1, calc: () => { const st = state.stableMcap, tot = state.global && state.global.total_market_cap.usd; if (!st || !tot) return { z: 0, ok: false, note: '无数据' }; const r = st / tot * 100; return { z: (r - 11) / 3, note: r.toFixed(1) + '% · 场外购买力' }; } },
  { id: 'hr', name: '⛏ 算力趋势', group: 'onchain', w: 0.6, dir: 1, calc: () => { const a = asofCut(state.chainSeries.hashrate, 'HR'); if (!a || a.length < 120) return { z: 0, ok: false, note: '无数据' }; const z = chgZ(a, 90, 120); return { z, note: '近90日' + (z >= 0 ? '加速' : '放缓') }; } },
  { id: 'tx', name: '🔗 链上活跃', group: 'onchain', w: 0.5, dir: 1, calc: () => { const a = asofCut(state.chainSeries.n_tx, 'TX'); if (!a || !a.length) return { z: 0, ok: false, note: '无数据' }; return { z: rollZ(a, 90), note: fmtBig(a[a.length - 1]) + '笔/日' }; } },
  /* —— 美元 / 风险资产 —— */
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
  { id: 'tech', name: '📐 技术面', group: 'tech', w: 1.0, dir: 1, calc: () => { const k = state.klines['BTC' + state.interval]; if (!k) return { z: 0, note: '—' }; const c = k.map(x => x.c); const e20 = ema(c, 20), e50 = ema(c, 50), r = rsi(c); const z = (e20[e20.length - 1] - e50[e50.length - 1]) / (e50[e50.length - 1] || 1) * 30 + (r[r.length - 1] - 50) / 12; return { z, note: 'RSI ' + r[r.length - 1].toFixed(0) }; } },
  { id: 'mom', name: '🚀 动量', group: 'tech', w: 0.8, dir: 1, calc: () => { const k = state.klines['BTC' + state.interval]; if (!k) return { z: 0, note: '—' }; const c = k.map(x => x.c); const pc = pctChange(c.slice(-30)) || 0; return { z: pc / 8, note: pc.toFixed(1) + '%' }; } },
];

function computeNexusScore(ids) {
  const set = ids ? new Set(ids) : null;      // ids 非空 → 只算这个子集（历史回放用）
  let sum = 0, wsum = 0, nScored = 0, nDead = 0; const out = {};
  FACTORS.forEach(f => {
    if (set && !set.has(f.id)) return;
    const r = f.calc();
    const has = r.ok !== false;                     // 无数据的因子不进分母，避免把评分拉向 50
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
  const cnt = $('fCount'); if (cnt) cnt.textContent = FACTORS.length + ' 维 · ' + nScored + ' 参与评分' + (nDead ? ' · ' + nDead + ' 无数据' : '');
}
/* =====================================================================
 *  历史回放 · IC 有效性检验（v3.8）
 *
 *  为什么不需要数据库：Nexus Score 的每一个输入本身就是历史序列，所以只要把
 *  长历史序列取回来，就能用**同一套因子代码**逐日重放，算出历史上每一天的评分。
 *  没有 KV / cron / D1，永远不会和线上因子代码脱节（脱节是双份实现的经典坑）。
 *
 *  代价：只有「有历史序列」的因子能回放。以下三类无法回放 →
 *    ① 事件类（非农/CPI/失业率/初请/PCE）：周历没有历史发布值
 *    ② 衍生品快照（资金费率 / 多空比）：Bybit 只给当日值
 *    ③ BTC占比 / 稳定币占比：需要「历史全网总市值」，免费源都没有
 *  因此回放用 17 维子集并**重新归一化**，与实时 28 维的绝对值不可直接比较。
 * ===================================================================== */
const REPLAY_IDS = ['fng', 'hr', 'tx', 'dxy', 'us10y', 'spx', 'vix', 'gold', 'oil', 'geo', 'fed', 'bei', 'curve', 'jpy', 'jgb', 'tech', 'mom'];
const REPLAY_MIN_LOOKBACK = 130;   // 每条序列至少要有这么多回看点（rollZ(120) 与 chgZ(90) 都够）
const IC_HORIZONS = [1, 5, 10, 20];

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

  let start = -1;
  for (let i = 0; i < n; i++) { if (keys.every(k => asof[k][i] >= REPLAY_MIN_LOOKBACK)) { start = i; break; } }
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
  };
  const hs = {};
  for (let q = 0; q < mk.length; q++) hs[mk[q]] = ser[mk[q]].v;
  state.macroSeries = hs;
  const scores = new Array(n).fill(null);
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
      state.klines['BTC1d'] = klFull.slice(0, i + 1);
      const r = computeNexusScore(REPLAY_IDS);
      scores[i] = r.score;
      nScored = r.nScored;
    }
  } finally {
    state.interval = keep.interval; state.klines['BTC1d'] = keep.kl;
    state.asof = keep.asof; state.fg = keep.fg;
    state.chainSeries.hashrate = keep.hr; state.chainSeries.n_tx = keep.tx;
    state.macroSeries = keep.series;
  }
  return { calTs, closes, scores, start, n, nScored, srcs: H.srcs || {} };
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

function icFor(rep, h) {
  const s = [], r = [];
  for (let i = rep.start; i < rep.n; i++) {
    if (rep.scores[i] == null) continue;
    const j = i + h;
    if (j >= rep.n) break;
    const p0 = rep.closes[i];
    if (!p0) continue;
    s.push(rep.scores[i]); r.push(rep.closes[j] / p0 - 1);
  }
  if (s.length < 20) return null;
  const buckets = [[-1e9, 40], [40, 60], [60, 1e9]].map(function (rg) {
    const sel = [];
    for (let i = 0; i < s.length; i++) if (s[i] >= rg[0] && s[i] < rg[1]) sel.push(r[i]);
    const mean = sel.length ? sel.reduce(function (a, b) { return a + b; }, 0) / sel.length : null;
    const win = sel.length ? sel.filter(function (v) { return v > 0; }).length / sel.length : null;
    return { n: sel.length, mean: mean, win: win };
  });
  const base = r.reduce(function (a, b) { return a + b; }, 0) / r.length;
  const spear = pearson(rankAvg(s), rankAvg(r));
  /* 重叠的前向窗口 → 相邻样本高度相关，n 不是有效样本量。
   * 按「非重叠窗口数」n/h 折算，SE(IC) ≈ 1/√(n/h)，t = IC/SE。
   * 不做这一步会把纯噪声读成「显著信号」，这是因子研究最常见的自欺。 */
  const neff = Math.max(4, Math.floor(s.length / h));
  const se = 1 / Math.sqrt(neff);
  return {
    h: h, n: s.length, base: base, buckets: buckets,
    neff: neff, se: se, t: spear == null ? null : spear / se,
    pear: pearson(s, r), spear: spear,
  };
}

/* ---------- 拉数据 + 跑检验 ---------- */
async function runHistoryCheck() {
  const btn = $('histRun'), note = $('histNote');
  if (!histUrl()) { if (note) note.textContent = '此功能需要 Worker 代理（/api/history）；当前为直连模式。'; return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 回放中…'; }
  if (note) { note.textContent = '正在拉取 2 年历史序列（约 250KB）并用同一套因子代码逐日重放…'; note.style.color = 'var(--dim)'; }
  try {
    if (!state.histBundle) {
      const d = await getJSON(histUrl(), 60000);
      if (d.error || !d.btc) throw new Error(d.error || 'history empty');
      state.histBundle = d;
    }
    const rep = replayHistory();
    if (!rep) throw new Error('历史窗口不足（各序列公共区间太短）');
    const ics = [];
    for (let i = 0; i < IC_HORIZONS.length; i++) { const x = icFor(rep, IC_HORIZONS[i]); if (x) ics.push(x); }
    if (!ics.length) throw new Error('样本不足以计算 IC');
    state.hist = { rep: rep, ics: ics };
    renderHistory();
    if (note) note.textContent = '';
  } catch (e) {
    if (note) { note.textContent = '回放失败：' + ((e && e.message) || e); note.style.color = 'var(--red)'; }
    console.warn('history check fail', (e && e.message) || e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ 重新回放'; }
  }
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
    src.textContent = covTxt + '回放因子子集（17 维）：情绪 / 算力 / 链上活跃 / 美元 / 美债10Y / 标普 / VIX / 黄金 / 原油 / 地缘代理 / 美联储2Y / 通胀预期 / 期限利差 / 美元日元 / 日债10Y / 技术面 / 动量。' +
      '不含：5 个事件因子（无历史发布值）、资金费率与多空比（仅当日值）、BTC占比与稳定币占比（无历史总市值）。价格用 ' + (s.BTC || 'yahoo:BTC-USD') + '。';
  }

  drawHistChart($('histCanvas'), rep);
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
