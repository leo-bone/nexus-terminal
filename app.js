/* =====================================================================
 * NEXUS TERMINAL v3.3 — 加密货币实时监测与因子关系终端
 * 纯前端 / 无后端 / 无构建步骤。可直接 file:// 打开，也可部署到 Cloudflare。
 *
 * 数据源（全经 Cloudflare Worker 代理，解决中国大陆无法直连 + 浏览器 CORS）:
 *   - Bybit                 : 行情 / K线 / 合约资金费率 / 持仓 / 多空比
 *   - CoinPaprika           : 全球市值 / BTC 占比
 *   - DefiLlama             : 稳定币总市值（稳定币占比因子）
 *   - blockchain.info       : 链上日交易笔数（链上活跃因子）
 *   - alternative.me        : 恐惧贪婪指数 (F&G)
 *   - mempool.space         : 比特币全网算力
 *   - Cloudflare Worker     : 宏观/政策/通胀/大宗序列
 *                             (Stooq/Yahoo + NY Fed 利率 + 美财政部收益率曲线)
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
  ggGlobal: px('https://api.coinpaprika.com/v1/global'),
  stable: px('https://stablecoins.llama.fi/stablecoins?includePrices=false'),
  ntx: px('https://api.blockchain.info/charts/n-transactions?timespan=180days&format=json'),
  fg: px('https://api.alternative.me/fng/?limit=90'),
  mempoolHR: px('https://mempool.space/api/v1/mining/hashrate/1y'),
};

const state = {
  prices: {}, klines: {},
  fg: null, fgSeries: [], fgDates: [],
  global: null, stableMcap: null,
  chainSeries: {}, chainDates: {},
  deriv: {}, macro: null, macroSeries: null, macroDates: null,
  series: {}, seriesDates: {}, retMaps: {},
  lastUpdate: null, interval: '1h',
  positions: loadPositions(), equity: 10000,
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
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw 0; return await r.json(); }
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
const mZ = (key, n = 120) => (state.macroSeries && state.macroSeries[key]) ? rollZ(state.macroSeries[key], n) : 0;
const mV = key => last(state.macroSeries && state.macroSeries[key]);
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
    const d = await getJSON(ENDPOINTS.ggGlobal);
    state.global = { total_market_cap: { usd: d.market_cap_usd }, market_cap_percentage: { btc: d.bitcoin_dominance_percentage } };
    return true;
  } catch (e) { console.warn('global fail', e); return false; }
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
  try {
    const d = await getJSON(ENDPOINTS.mempoolHR);
    const hrs = (d && d.hashrates) || [];
    state.chainSeries.hashrate = hrs.map(x => x.avgHashrate);
    state.chainDates.hashrate = hrs.map(x => x.timestamp * 1000);
    ok = true;
  } catch (e) { console.warn('hashrate fail', e); }
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
    const d = await getJSON(CONFIG.PROXY + '/api/snapshot');
    state.macro = d.macro; state.macroSeries = d.series; state.macroDates = d.dates; return true;
  } catch (e) { console.warn('macro fail', e); return false; }
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
  BTC: { name: 'BTC', color: '#00e5a0', group: 'core' },
  FNG: { name: '恐惧贪婪', color: '#ffc107', group: 'sentiment' },
  HR: { name: '算力', color: '#b388ff', group: 'onchain' },
  TX: { name: '链上活跃', color: '#b388ff', group: 'onchain' },
  OI: { name: '持仓量', color: '#ff9100', group: 'deriv' },
  LS: { name: '多空比', color: '#ff9100', group: 'deriv' },
  DXY: { name: '美元指数', color: '#00b4ff', group: 'macro' },
  US10Y: { name: '美债10Y', color: '#00b4ff', group: 'macro' },
  GOLD: { name: '黄金', color: '#ffb300', group: 'macro' },
  SPX: { name: '标普500', color: '#00b4ff', group: 'macro' },
  VIX: { name: 'VIX恐慌', color: '#ff3d6e', group: 'macro' },
  OIL: { name: 'WTI原油', color: '#8d6e63', group: 'macro' },
  AGRI: { name: '农业', color: '#8bc34a', group: 'macro' },
  EFFR: { name: '联邦利率', color: '#26c6da', group: 'policy' },
  BEI10: { name: '通胀预期', color: '#ef5350', group: 'policy' },
  T10Y2Y: { name: '期限利差', color: '#7e57c2', group: 'policy' },
  STABLE: { name: '稳定币占比', color: '#00e5a0', group: 'market' },
  FUND: { name: '资金费率', color: '#ff9100', group: 'deriv' },
};

const FACTORS = [
  { id: 'fng', name: '😱 市场情绪', group: 'sentiment', w: 1.2, calc: () => { const v = state.fg ? +state.fg.value : 50; return { z: (v - 50) / 18, sig: v > 70 ? 'over' : v < 30 ? 'under' : 'neu', note: `F&G ${v}` }; } },
  { id: 'fund', name: '💸 资金费率', group: 'deriv', w: 1.0, calc: () => { const f = state.deriv.funding; if (f == null) return { z: 0, sig: 'neu', note: '—' }; return { z: f / 0.05, sig: f > 0.05 ? 'over' : f < -0.02 ? 'under' : 'neu', note: `${f.toFixed(4)}%` }; } },
  { id: 'ls', name: '⚖️ 多空比', group: 'deriv', w: 0.8, calc: () => { const l = state.deriv.ls; if (l == null) return { z: 0, sig: 'neu', note: '—' }; return { z: (l - 50) / 12, sig: l > 62 ? 'over' : l < 38 ? 'under' : 'neu', note: `${l.toFixed(1)}%多` }; } },
  { id: 'oi', name: '📊 合约持仓', group: 'deriv', w: 0.7, calc: () => { const s = state.deriv.oiSeries; if (!s || !s.length) return { z: 0, sig: 'neu', note: '—' }; const z = rollZ(s, 96); return { z, sig: z > 1 ? 'over' : z < -1 ? 'under' : 'neu', note: fmtBig(state.deriv.oi) + ' BTC' }; } },
  { id: 'dom', name: '👑 BTC占比', group: 'market', w: 0.8, calc: () => { const d = state.global ? state.global.market_cap_percentage.btc : 50; return { z: (d - 50) / 8, sig: d > 56 ? 'over' : d < 44 ? 'under' : 'neu', note: `${d.toFixed(1)}%` }; } },
  { id: 'stable', name: '🏦 稳定币占比', group: 'market', w: 0.7, calc: () => {
      const st = state.stableMcap, tot = state.global && state.global.total_market_cap.usd;
      if (!st || !tot) return { z: 0, sig: 'neu', note: '—' };
      const r = st / tot * 100;
      return { z: (r - 11) / 3, sig: r > 13 ? 'over' : r < 8 ? 'under' : 'neu', note: `${r.toFixed(1)}%` };
    } },
  { id: 'hr', name: '⛏ 算力趋势', group: 'onchain', w: 0.7, calc: () => { const s = state.chainSeries.hashrate; if (!s || !s.length) return { z: 0, sig: 'neu', note: '—' }; const z = rollZ(s, 90); return { z, sig: z > 0.8 ? 'over' : z < -0.8 ? 'under' : 'neu', note: z > 0 ? '升' : '降' }; } },
  { id: 'tx', name: '🔗 链上活跃', group: 'onchain', w: 0.6, calc: () => { const s = state.chainSeries.n_tx; if (!s || !s.length) return { z: 0, sig: 'neu', note: '—' }; const z = rollZ(s, 90); return { z, sig: z > 0.8 ? 'over' : z < -0.8 ? 'under' : 'neu', note: fmtBig(last(s)) + '笔/日' }; } },
  { id: 'dxy', name: '🇺🇸 美元指数', group: 'macro', w: 1.0, calc: () => { const v = mV('DXY'); if (v == null) return { z: 0, sig: 'neu', note: CONFIG.PROXY ? '—' : '需Worker' }; const z = mZ('DXY'); return { z, sig: z > 1 ? 'over' : z < -1 ? 'under' : 'neu', note: v.toFixed(1) }; } },
  { id: 'us10y', name: '🏦 美债10Y', group: 'macro', w: 1.0, calc: () => { const v = mV('US10Y'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('US10Y'); return { z, sig: z > 1 ? 'over' : z < -1 ? 'under' : 'neu', note: v.toFixed(2) + '%' }; } },
  { id: 'gold', name: '🥇 黄金', group: 'macro', w: 0.6, calc: () => { const v = mV('GOLD'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('GOLD'); return { z, sig: z > 1.5 ? 'over' : z < -1.5 ? 'under' : 'neu', note: '$' + v.toFixed(0) }; } },
  { id: 'spx', name: '📈 标普500', group: 'macro', w: 0.9, calc: () => { const v = mV('SPX'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('SPX'); return { z, sig: z > 1.5 ? 'over' : z < -1.5 ? 'under' : 'neu', note: v.toFixed(0) }; } },
  { id: 'vix', name: '😰 VIX恐慌', group: 'macro', w: 0.9, calc: () => { const v = mV('VIX'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('VIX'); return { z, sig: v > 24 ? 'over' : v < 13 ? 'under' : 'neu', note: v.toFixed(1) }; } },
  { id: 'fed', name: '🏛 美联储利率', group: 'policy', w: 1.0, calc: () => { const v = mV('EFFR'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('EFFR', 120); return { z, sig: v >= 4.5 ? 'over' : v <= 2.5 ? 'under' : 'neu', note: v.toFixed(2) + '%' }; } },
  { id: 'bei', name: '🔥 通胀预期', group: 'policy', w: 0.9, calc: () => { const v = mV('BEI10'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('BEI10'); return { z, sig: v > 2.6 ? 'over' : v < 1.8 ? 'under' : 'neu', note: v.toFixed(2) + '%' }; } },
  { id: 'curve', name: '📉 期限利差', group: 'policy', w: 0.8, calc: () => { const v = mV('T10Y2Y'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('T10Y2Y'); return { z, sig: v < 0 ? 'over' : v > 1.2 ? 'under' : 'neu', note: (v >= 0 ? '+' : '') + v.toFixed(2) }; } },
  { id: 'oil', name: '🛢 WTI原油', group: 'macro', w: 0.6, calc: () => { const v = mV('OIL'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('OIL'); return { z, sig: z > 1.5 ? 'over' : z < -1.5 ? 'under' : 'neu', note: '$' + v.toFixed(0) }; } },
  { id: 'agri', name: '🌾 农业指数', group: 'macro', w: 0.4, calc: () => { const v = mV('AGRI'); if (v == null) return { z: 0, sig: 'neu', note: '—' }; const z = mZ('AGRI'); return { z, sig: z > 1.5 ? 'over' : z < -1.5 ? 'under' : 'neu', note: '$' + v.toFixed(2) }; } },
  { id: 'geo', name: '🌍 地缘风险(代理)', group: 'macro', w: 0.8, calc: () => {
      const zs = [];
      ['VIX', 'GOLD', 'OIL'].forEach(k => { const s = state.macroSeries && state.macroSeries[k]; if (s && s.length > 20) zs.push(rollZ(s, 120)); });
      if (!zs.length) return { z: 0, sig: 'neu', note: '—' };
      const z = zs.reduce((a, b) => a + b, 0) / zs.length;
      return { z, sig: z > 1 ? 'over' : z < -1 ? 'under' : 'neu', note: 'VIX+金+油' };
    } },
  { id: 'tech', name: '📐 技术面', group: 'tech', w: 1.1, calc: () => { const k = state.klines['BTC' + state.interval]; if (!k) return { z: 0, sig: 'neu', note: '—' }; const c = k.map(x => x.c); const ema20 = ema(c, 20), ema50 = ema(c, 50); const r = rsi(c); const z = (ema20[ema20.length - 1] - ema50[ema50.length - 1]) / (ema50[ema50.length - 1] || 1) * 30 + (r[r.length - 1] - 50) / 12; return { z, sig: z > 0.6 ? 'over' : z < -0.6 ? 'under' : 'neu', note: `RSI ${r[r.length - 1].toFixed(0)}` }; } },
  { id: 'mom', name: '🚀 动量', group: 'tech', w: 0.9, calc: () => { const k = state.klines['BTC' + state.interval]; if (!k) return { z: 0, sig: 'neu', note: '—' }; const c = k.map(x => x.c); const z = pctChange(c.slice(-30)) / 8; return { z, sig: z > 1 ? 'over' : z < -1 ? 'under' : 'neu', note: `${(pctChange(c.slice(-30)) || 0).toFixed(1)}%` }; } },
];

function computeNexusScore() {
  let sum = 0, wsum = 0; const out = {};
  FACTORS.forEach(f => { const r = f.calc(); out[f.id] = r; const clamped = Math.max(-2.5, Math.min(2.5, r.z)); sum += clamped * f.w; wsum += f.w; });
  const score = Math.round(50 + (sum / wsum) * 22);
  return { score: Math.max(2, Math.min(98, score)), out };
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
function netKeys() { return Object.keys(state.series).filter(k => META[k] && state.retMaps[k] && state.retMaps[k].size > 20); }
function initNetwork() {
  const cv = $('netCanvas'); if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  const keys = netKeys();
  const nodes = [], edges = [];
  keys.forEach(id => { const m = META[id]; nodes.push({ id, label: m.name, color: m.color, group: m.group, x: W / 2 + (Math.random() - .5) * 200, y: H / 2 + (Math.random() - .5) * 160, vx: 0, vy: 0, fixed: id === 'BTC' }); });
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const r = pearsonMaps(state.retMaps[keys[i]], state.retMaps[keys[j]]);
    if (r != null && Math.abs(r) > 0.08) edges.push({ a: keys[i], b: keys[j], r });
  }
  net = { cv, ctx: cv.getContext('2d'), nodes, edges, W, H };
  const btc = nodes.find(n => n.id === 'BTC'); if (btc) { btc.x = W / 2; btc.y = H / 2; btc.fixed = true; }
  $('netCount') && ($('netCount').textContent = `${nodes.length} 因子 / ${edges.length} 关系 · 日收益相关性`);
  animateNetwork();
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
  nodes.forEach(n => { const r = n.id === 'BTC' ? 16 : 9; ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill(); ctx.fillStyle = '#060c18'; ctx.font = 'bold 9px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n.id === 'BTC' ? 'BTC' : n.label.slice(0, 3), n.x, n.y); if (n.id !== 'BTC') { ctx.fillStyle = '#a8bfd6'; ctx.font = '8px Inter, sans-serif'; ctx.fillText(n.label, n.x, n.y + r + 9); } });
  requestAnimationFrame(animateNetwork);
}
function renderHeatmap() {
  const box = $('heatmap'); if (!box) return; const ids = netKeys();
  box.style.gridTemplateColumns = `64px repeat(${ids.length}, 1fr)`;
  let html = '<div class="hm-h"></div>' + ids.map(id => `<div class="hm-h">${META[id].name.slice(0, 4)}</div>`).join('');
  ids.forEach(ri => {
    html += `<div class="hm-h" style="text-align:left">${META[ri].name}</div>`;
    ids.forEach(ci => { const r = ri === ci ? 1 : pearsonMaps(state.retMaps[ri], state.retMaps[ci]); const bg = r == null ? '#132035' : r > 0 ? `rgba(0,229,160,${Math.abs(r) * .8})` : `rgba(255,61,110,${Math.abs(r) * .8})`; html += `<div class="hm-cell" style="background:${bg};color:${Math.abs(r || 0) > .5 ? '#060c18' : '#a8bfd6'}">${r == null ? '·' : r.toFixed(2)}</div>`; });
  });
  box.innerHTML = html;
}

/* =====================================================================
 *  回测（均线交叉 / RSI / 突破）
 * ===================================================================== */
function runBacktest(strat, p) {
  const k = state.klines['BTC' + state.interval]; if (!k) return null;
  const c = k.map(x => x.c); let cash = 10000, pos = 0, trades = 0, wins = 0; const eq = [10000];
  const sig = (i) => {
    if (strat === 'ma') { const f = sma(c, p.f), s = sma(c, p.s); if (i < p.s) return 0; return f[i] > s[i] ? 1 : -1; }
    if (strat === 'rsi') { const r = rsi(c, p.p); if (i < p.p) return 0; return r[i] < p.b ? 1 : (r[i] > p.sell ? -1 : 0); }
    if (strat === 'brk') { const hi = Math.max(...c.slice(Math.max(0, i - p.n), i)); return c[i] > hi * (1 + p.e / 100) ? 1 : 0; }
    return 0;
  };
  let prev = 0;
  for (let i = 1; i < c.length; i++) {
    const s = sig(i); if (s !== prev) { if (s > 0 && pos === 0) { pos = cash / c[i]; cash = 0; trades++; } else if (s < 0 && pos > 0) { cash = pos * c[i]; if (c[i] > c[i - 1]) wins++; pos = 0; } } prev = s;
    eq.push(cash + pos * c[i]);
  }
  const ret = (eq[eq.length - 1] - 10000) / 10000 * 100;
  const peak = Math.max(...eq), dd = (peak - Math.min(...eq)) / peak * 100;
  const rets = eq.slice(1).map((v, i) => (v - eq[i]) / eq[i]); const mean = rets.reduce((a, b) => a + b, 0) / rets.length; const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length); const sharpe = sd ? mean / sd * Math.sqrt(252) : 0;
  return { ret, dd, sharpe, trades, win: trades ? wins / trades * 100 : 0, eq };
}
function renderBacktest() {
  const strat = $('btStrat') ? $('btStrat').value : 'ma';
  const p = strat === 'ma' ? { f: 10, s: 30 } : strat === 'rsi' ? { p: 14, b: 35, sell: 70 } : { n: 20, e: 1.5 };
  if (strat === 'ma') { p.f = +$('btF').value || 10; p.s = +$('btS').value || 30; }
  if (strat === 'rsi') { p.p = +$('btP').value || 14; p.b = +$('btB').value || 35; p.sell = +$('btSell').value || 70; }
  if (strat === 'brk') { p.n = +$('btN').value || 20; p.e = +$('btE').value || 1.5; }
  const r = runBacktest(strat, p); if (!r) return;
  $('btRet').textContent = r.ret.toFixed(1) + '%'; $('btRet').className = 'btmet-val ' + (r.ret >= 0 ? 'up' : 'dn');
  $('btSharpe').textContent = r.sharpe.toFixed(2); $('btSharpe').className = 'btmet-val ' + (r.sharpe >= 0 ? 'up' : 'dn');
  $('btDD').textContent = '-' + r.dd.toFixed(1) + '%'; $('btDD').className = 'btmet-val dn';
  $('btWin').textContent = r.win.toFixed(0) + '%'; $('btWin').className = 'btmet-val n';
  $('btTrades').textContent = r.trades; $('btTrades').className = 'btmet-val';
  const cv = $('btCanvas'); if (cv) { const W = cv.clientWidth, H = cv.clientHeight; cv.width = W; cv.height = H; const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, W, H); const mn = Math.min(...r.eq), mx = Math.max(...r.eq); ctx.strokeStyle = '#00e5a0'; ctx.lineWidth = 1.6; ctx.beginPath(); r.eq.forEach((v, i) => { const x = i / (r.eq.length - 1) * W, y = H - (v - mn) / (mx - mn || 1) * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
  $('btRes').classList.add('show');
}

/* =====================================================================
 *  模拟交易（localStorage）
 * ===================================================================== */
function loadPositions() { try { return JSON.parse(localStorage.getItem('nexus_pos') || '[]'); } catch (e) { return []; } }
function savePositions() { localStorage.setItem('nexus_pos', JSON.stringify(state.positions)); }
function paperBuy() { const sym = $('ptSym') ? $('ptSym').value : 'BTC'; const amt = +($('ptAmt') ? $('ptAmt').value : 1000); const pr = state.prices[sym] ? state.prices[sym].price : null; if (!pr) return; state.positions.push({ sym, amt, px: pr, t: Date.now() }); savePositions(); renderPaper(); }
function paperSell(i) { const p = state.positions[i]; if (!p) return; state.positions.splice(i, 1); savePositions(); renderPaper(); }
function renderPaper() {
  let invested = 0, nowv = 0; const list = $('ptList'); if (!list) return; list.innerHTML = '';
  state.positions.forEach((p, i) => { const pr = state.prices[p.sym] ? state.prices[p.sym].price : p.px; const qty = p.amt / p.px; const v = qty * pr; invested += p.amt; nowv += v; const pl = v - p.amt; const row = document.createElement('div'); row.className = 'pt-pos'; row.innerHTML = `<div class="pt-pos-row"><span class="pt-pos-lbl">${p.sym}</span><span class="pt-pos-val">${fmt(v, 0)}</span></div><div class="pt-pos-row"><span class="pt-pos-lbl">PL</span><span class="pt-pos-val" style="color:${pl >= 0 ? '#00e5a0' : '#ff3d6e'}">${pl >= 0 ? '+' : ''}${fmt(pl, 0)} (${pl >= 0 ? '+' : ''}${(pl / p.amt * 100).toFixed(1)}%)</span></div><div class="pt-pos-row"><span class="pt-pos-lbl">成本</span><span class="pt-pos-val">${fmt(p.px)}</span></div><button class="qt-btn" style="margin-top:6px;padding:5px;font-size:11px" onclick="paperSell(${i})">平仓</button>`; list.appendChild(row); });
  const pnl = nowv - invested; $('ptEquity') && ($('ptEquity').textContent = fmt(state.equity + nowv, 0)); $('ptPL') && ($('ptPL').textContent = (pnl >= 0 ? '+' : '') + fmt(pnl, 0)); if ($('ptPL')) $('ptPL').style.color = pnl >= 0 ? '#00e5a0' : '#ff3d6e';
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
  ['SPX', '标普500', 0, ''], ['VIX', 'VIX 恐慌', 1, ''], ['OIL', 'WTI 原油', 2, ''],
  ['AGRI', '农业 ETF', 2, ''], ['EFFR', '联邦基金利率', 2, '%'], ['BEI10', '通胀预期(隐含)', 2, '%'],
  ['T10Y2Y', '10Y-2Y 利差', 2, ''],
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
  if (hint) hint.style.display = 'none';
  const prev = state.macro && state.macro._prev;
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
  const { score, out } = computeNexusScore();
  const ring = $('nxRing'); if (ring) { ring.setAttribute('stroke-dasharray', `${score * 2.51} 251`); ring.setAttribute('stroke', score > 60 ? '#00e5a0' : score < 40 ? '#ff3d6e' : '#ffc107'); }
  if ($('nxScore')) $('nxScore').textContent = score;
  if ($('nxSig')) { const s = score > 60 ? '偏多' : score < 40 ? '偏空' : '中性'; $('nxSig').textContent = s; $('nxSig').className = 'fscore-l ' + (score > 60 ? 'up' : score < 40 ? 'dn' : 'n'); }
  const box = $('factorGrid'); if (!box) return; box.innerHTML = '';
  FACTORS.forEach(f => { const r = out[f.id]; const clamped = Math.max(-2.5, Math.min(2.5, r.z)); const col = r.sig === 'over' ? '#ff3d6e' : r.sig === 'under' ? '#00e5a0' : '#ffc107'; const card = document.createElement('div'); card.className = 'fcard'; card.title = `${f.name} (权重 ${f.w})`; card.innerHTML = `<div class="fc-name">${f.name}</div><div class="fc-z" style="color:${col}">${clamped >= 0 ? '+' : ''}${clamped.toFixed(1)}</div><div class="fc-str"><div class="fc-strbar" style="width:${Math.min(100, Math.abs(clamped) / 2.5 * 100)}%;background:${col}"></div></div><div class="fc-sig" style="color:${col}">${r.note}</div>`; box.appendChild(card); });
  const cnt = $('fCount'); if (cnt) cnt.textContent = FACTORS.length + ' 维';
}
function renderStatus(ok) {
  const dot = $('netDot'); if (dot) { dot.className = 'net-dot ' + (ok ? 'ok' : ''); }
  if ($('lastUpd')) $('lastUpd').textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN');
}

/* =====================================================================
 *  刷新主流程
 * ===================================================================== */
async function refreshAll() {
  const tasks = [fetchPrices(), fetchKlines('BTC', state.interval), fetchFG(), fetchGlobal(), fetchStable(), fetchChain(), fetchDeriv(), fetchMacro()];
  const res = await Promise.allSettled(tasks);
  const ok = res.every(r => r.status === 'fulfilled' && r.value !== false);
  if (!state.klines['BTC1d']) await fetchKlines('BTC', '1d');
  buildSeries();
  renderTicker(); renderChart(); renderTA(); renderFG(); renderMacro(); renderOnChain(); renderDeriv(); renderFactors();
  renderPaper();
  initNetwork(); renderHeatmap();
  renderStatus(ok);
}

/* =====================================================================
 *  UI 事件
 * ===================================================================== */
function bindUI() {
  document.querySelectorAll('.ibtn').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.ibtn').forEach(x => x.classList.remove('active')); b.classList.add('active'); state.interval = b.dataset.i; fetchKlines('BTC', b.dataset.i).then(() => { renderChart(); renderTA(); renderFactors(); }); }));
  const cv = $('mainCanvas');
  if (cv) cv.addEventListener('mousemove', e => { const rect = cv.getBoundingClientRect(); const k = state.klines['BTC' + state.interval]; if (!k) return; const i = Math.round((e.clientX - rect.left) / (rect.width) * (k.length - 1)); chartState.hover = Math.max(0, Math.min(k.length - 1, i)); renderChart(); });
  if (cv) cv.addEventListener('mouseleave', () => { chartState.hover = -1; const tt = $('chartTip'); if (tt) tt.style.display = 'none'; renderChart(); });
  const bt = $('btRun'); if (bt) bt.addEventListener('click', renderBacktest);
  const bts = $('btStrat'); if (bts) bts.addEventListener('change', () => { document.querySelectorAll('.bt-param').forEach(p => p.style.display = p.dataset.s === bts.value ? 'block' : 'none'); });
  const buy = $('ptBuy'); if (buy) buy.addEventListener('click', paperBuy);
  const refresh = $('refreshBtn'); if (refresh) refresh.addEventListener('click', refreshAll);
}

/* =====================================================================
 *  初始化
 * ===================================================================== */
window.addEventListener('load', async () => {
  bindUI();
  await refreshAll();
  setInterval(refreshAll, CONFIG.REFRESH_MS);
  window.addEventListener('resize', () => { renderChart(); net && (net.W = $('netCanvas').clientWidth, net.H = $('netCanvas').clientHeight); });
});
