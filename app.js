/* =====================================================================
 * NEXUS TERMINAL v3 — 加密货币实时监测与因子关系终端
 * 纯前端 / 无后端 / 无构建步骤。可直接 file:// 打开，也可部署到 GitHub Pages。
 *
 * 数据源（浏览器直连，已验证 CORS）:
 *   - Binance  public API   : 行情 / K线 / 合约资金费率 / 持仓 / 多空比
 *   - CryptoCompare         : 备用行情 / 链上历史 (hashrate, n_tx, totalbc ...)
 *   - CoinGecko             : 全球市值 / BTC 占比 / 稳定币占比
 *   - alternative.me        : 恐惧贪婪指数
 *   - Cloudflare Worker     : 宏观序列 (DXY/US10Y/黄金/标普/VIX) — 见 worker/
 *
 * 配置: 部署 Cloudflare Worker 后，把下方 PROXY 改成你的 Worker 地址即可解锁
 *       宏观数据与完整「因子关系网络」。
 * ===================================================================== */

const CONFIG = {
  PROXY: '',                     // 例: 'https://nexus-proxy.xxx.workers.dev'
  REFRESH_MS: 60000,             // 自动刷新间隔
  COINS: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA'],
  SYMBOL_MAP: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT', XRP: 'XRPUSDT', ADA: 'ADAUSDT' },
};

const ENDPOINTS = {
  binPrice: s => `https://api.binance.com/api/v3/ticker/24hr?symbols=["${s}"]`,
  binKline: (s, i, l) => `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${i}&limit=${l}`,
  binFunding: s => `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}`,
  binOI: s => `https://fapi.binance.com/futures/data/openInterestHist?symbol=${s}&period=5m&limit=96`,
  binLS: s => `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${s}&period=5m&limit=96`,
  ccPrice: fs => `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${fs}&tsyms=USD&e=Binance`,
  ccChainDay: 'https://min-api.cryptocompare.com/data/blockchain/histo/day?fsym=BTC&limit=120',
  ggGlobal: 'https://api.coingecko.com/api/v3/global',
  fg: 'https://api.alternative.me/fng/?limit=90',
};

const state = {
  prices: {}, klines: {}, fg: null, fgSeries: [], global: null,
  chain: null, chainSeries: {}, deriv: {}, macro: null, macroSeries: null,
  series: {}, lastUpdate: null, lang: 'zh', interval: '1h',
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
function zscore(a) { if (!a || a.length < 2) return 0; const m = a.reduce((s, v) => s + v, 0) / a.length; const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) || 1; return (a[a.length - 1] - m) / sd; }

/* =====================================================================
 *  数据拉取
 * ===================================================================== */
async function fetchPrices() {
  try {
    const syms = CONFIG.COINS.map(c => CONFIG.SYMBOL_MAP[c]).map(s => `"${s}"`).join(',');
    const d = await getJSON(ENDPOINTS.binPrice(syms));
    d.forEach(t => { const c = CONFIG.COINS.find(k => CONFIG.SYMBOL_MAP[k] === t.symbol); if (c) state.prices[c] = { price: +t.lastPrice, chg: +t.priceChangePercent, high: +t.highPrice, low: +t.lowPrice, vol: +t.quoteVolume }; });
    return true;
  } catch (e) { console.warn('prices fail', e); return false; }
}
async function fetchKlines(coin, interval) {
  try {
    const d = await getJSON(ENDPOINTS.binKline(CONFIG.SYMBOL_MAP[coin], interval, 220));
    const kl = d.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    state.klines[coin + interval] = kl; return true;
  } catch (e) { console.warn('kline fail', e); return false; }
}
async function fetchFG() {
  try { const d = await getJSON(ENDPOINTS.fg); state.fg = d.data[0]; state.fgSeries = d.data.map(x => +x.value).reverse(); return true; }
  catch (e) { console.warn('fg fail', e); return false; }
}
async function fetchGlobal() {
  try { const d = await getJSON(ENDPOINTS.ggGlobal); state.global = d.data; return true; }
  catch (e) { console.warn('global fail', e); return false; }
}
async function fetchChain() {
  try { const d = await getJSON(ENDPOINTS.ccChainDay); const b = d.BTC; const mk = k => (b[k] || []).map(x => x.value); state.chain = b; state.chainSeries = { hashrate: mk('hashrate'), n_tx: mk('n_tx'), totalbc: mk('totalbc'), vol_usd: mk('estimated_transaction_volume_usd') }; return true; }
  catch (e) { console.warn('chain fail', e); return false; }
}
async function fetchDeriv() {
  try {
    const f = await getJSON(ENDPOINTS.binFunding('BTCUSDT'));
    const oi = await getJSON(ENDPOINTS.binOI('BTCUSDT'));
    const ls = await getJSON(ENDPOINTS.binLS('BTCUSDT'));
    state.deriv = {
      funding: +f.fundingRate * 100,
      oi: oi.length ? +oi[oi.length - 1].sumOpenInterest : null,
      oiSeries: oi.map(x => +x.sumOpenInterest),
      ls: ls.length ? +ls[ls.length - 1].longAccount : null,
      lsSeries: ls.map(x => +x.longAccount),
    };
    return true;
  } catch (e) { console.warn('deriv fail', e); return false; }
}
async function fetchMacro() {
  if (!CONFIG.PROXY) { state.macro = null; state.macroSeries = null; return false; }
  try {
    const d = await getJSON(CONFIG.PROXY + '/api/snapshot');
    state.macro = d.macro; state.macroSeries = d.series; return true;
  } catch (e) { console.warn('macro fail', e); return false; }
}

/* 把各因子整理成可对齐的时间序列，供「因子关系网络」计算相关性 */
function buildSeries() {
  const s = {};
  // BTC 日线（用 1d kline）
  const btc1d = state.klines['BTC1d'];
  if (btc1d) s.BTC = btc1d.map(k => k.c);
  if (state.fgSeries.length) s.FNG = state.fgSeries;
  if (state.chainSeries.hashrate) s.HR = state.chainSeries.hashrate;
  if (state.chainSeries.n_tx) s.TX = state.chainSeries.n_tx;
  if (state.deriv.oiSeries) s.OI = state.deriv.oiSeries;
  if (state.deriv.lsSeries) s.LS = state.deriv.lsSeries;
  if (state.global) { /* 占比类无历史，仅当前值 */ }
  if (state.macroSeries) {
    ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX'].forEach(k => { if (state.macroSeries[k]) s[k] = state.macroSeries[k]; });
  }
  state.series = s;
}

/* =====================================================================
 *  因子模型（12 → 20+）
 *  每个因子返回 { z, sig, note }。z 为标准化分数（-3..3），sig 为方向信号。
 * ===================================================================== */
const META = {
  BTC: { name: 'BTC', color: '#00e5a0', group: 'core' },
  FNG: { name: '恐惧贪婪', color: '#ffc107', group: 'sentiment' },
  HR: { name: '算力', color: '#b388ff', group: 'onchain' },
  TX: { name: '链上交易数', color: '#b388ff', group: 'onchain' },
  OI: { name: '持仓量', color: '#ff9100', group: 'deriv' },
  LS: { name: '多空比', color: '#ff9100', group: 'deriv' },
  DXY: { name: '美元指数', color: '#00b4ff', group: 'macro' },
  US10Y: { name: '美债10Y', color: '#00b4ff', group: 'macro' },
  GOLD: { name: '黄金', color: '#ffb300', group: 'macro' },
  SPX: { name: '标普500', color: '#00b4ff', group: 'macro' },
  VIX: { name: 'VIX恐慌', color: '#ff3d6e', group: 'macro' },
  DOM: { name: 'BTC占比', color: '#00e5a0', group: 'market' },
  STABLE: { name: '稳定币占比', color: '#00e5a0', group: 'market' },
  FUND: { name: '资金费率', color: '#ff9100', group: 'deriv' },
};

const FACTORS = [
  { id: 'fng', name: '😱 市场情绪', group: 'sentiment', w: 1.2, calc: () => { const v = state.fg ? +state.fg.value : 50; return { z: (v - 50) / 18, sig: v > 70 ? 'over' : v < 30 ? 'under' : 'neu', note: `F&G ${v}` }; } },
  { id: 'fund', name: '💸 资金费率', group: 'deriv', w: 1.0, calc: () => { const f = state.deriv.funding; if (f == null) return { z: 0, sig: 'neu', note: '—' }; return { z: f / 0.05, sig: f > 0.05 ? 'over' : f < -0.02 ? 'under' : 'neu', note: `${f.toFixed(4)}%` }; } },
  { id: 'ls', name: '⚖️ 多空比', group: 'deriv', w: 0.8, calc: () => { const l = state.deriv.ls; if (l == null) return { z: 0, sig: 'neu', note: '—' }; return { z: (l - 50) / 12, sig: l > 62 ? 'over' : l < 38 ? 'under' : 'neu', note: `${l.toFixed(1)}%多` }; } },
  { id: 'oi', name: '📊 合约持仓', group: 'deriv', w: 0.7, calc: () => { const z = zscore(state.deriv.oiSeries); return { z, sig: z > 1 ? 'over' : z < -1 ? 'under' : 'neu', note: fmtBig(state.deriv.oi) + ' BTC' }; } },
  { id: 'dom', name: '👑 BTC占比', group: 'market', w: 0.8, calc: () => { const d = state.global ? state.global.market_cap_percentage.btc : 50; return { z: (d - 50) / 8, sig: d > 56 ? 'over' : d < 44 ? 'under' : 'neu', note: `${d.toFixed(1)}%` }; } },
  { id: 'stable', name: '🏦 稳定币占比', group: 'market', w: 0.7, calc: () => { const g = state.global; const st = g && g.total_market_cap.stablecoin; if (!st) return { z: 0, sig: 'neu', note: '需额外API' }; const r = st / g.total_market_cap.usd * 100; return { z: (r - 7) / 2, sig: r > 8 ? 'over' : 'neu', note: `${r.toFixed(1)}%` }; } },
  { id: 'hr', name: '⛏ 算力趋势', group: 'onchain', w: 0.7, calc: () => { const z = zscore(state.chainSeries.hashrate); return { z, sig: z > 0.8 ? 'over' : z < -0.8 ? 'under' : 'neu', note: z > 0 ? '升' : '降' }; } },
  { id: 'tx', name: '🔗 链上活跃', group: 'onchain', w: 0.6, calc: () => { const z = zscore(state.chainSeries.n_tx); return { z, sig: z > 0.8 ? 'over' : z < -0.8 ? 'under' : 'neu', note: z > 0 ? '活跃' : '低迷' }; } },
  { id: 'dxy', name: '🇺🇸 美元指数', group: 'macro', w: 1.0, calc: () => { const v = state.macro && state.macro.DXY; if (v == null) return { z: 0, sig: 'neu', note: CONFIG.PROXY ? '—' : '需Worker' }; return { z: (v - 103) / 4, sig: v > 105 ? 'over' : v < 100 ? 'under' : 'neu', note: v.toFixed(1) }; } },
  { id: 'us10y', name: '🏦 美债10Y', group: 'macro', w: 1.0, calc: () => { const v = state.macro && state.macro.US10Y; if (v == null) return { z: 0, sig: 'neu', note: CONFIG.PROXY ? '—' : '需Worker' }; return { z: (v - 4.2) / 0.6, sig: v > 4.5 ? 'over' : v < 3.8 ? 'under' : 'neu', note: v.toFixed(2) + '%' }; } },
  { id: 'gold', name: '🥇 黄金', group: 'macro', w: 0.6, calc: () => { const v = state.macro && state.macro.GOLD; if (v == null) return { z: 0, sig: 'neu', note: CONFIG.PROXY ? '—' : '需Worker' }; return { z: (v - 2300) / 150, sig: 'neu', note: '$' + v.toFixed(0) }; } },
  { id: 'spx', name: '📈 标普500', group: 'macro', w: 0.9, calc: () => { const v = state.macro && state.macro.SPX; if (v == null) return { z: 0, sig: 'neu', note: CONFIG.PROXY ? '—' : '需Worker' }; return { z: (v - 5200) / 300, sig: 'neu', note: v.toFixed(0) }; } },
  { id: 'vix', name: '😰 VIX恐慌', group: 'macro', w: 0.9, calc: () => { const v = state.macro && state.macro.VIX; if (v == null) return { z: 0, sig: 'neu', note: CONFIG.PROXY ? '—' : '需Worker' }; return { z: (v - 16) / 6, sig: v > 24 ? 'over' : v < 13 ? 'under' : 'neu', note: v.toFixed(1) }; } },
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
  // grid
  ctx.strokeStyle = 'rgba(26,46,80,.5)'; ctx.fillStyle = '#3a5070'; ctx.font = '9px JetBrains Mono, monospace'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const yy = padT + priceH * i / 4; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.fillText(fmt(hi - (hi - lo) * i / 4, 0), W - padR + 4, yy + 3); }
  // candles
  const bw = (W - padL - padR) / cl * 0.62;
  k.forEach((d, i) => {
    const up = d.c >= d.o; ctx.strokeStyle = ctx.fillStyle = up ? '#00e5a0' : '#ff3d6e';
    ctx.beginPath(); ctx.moveTo(x(i), y(d.h)); ctx.lineTo(x(i), y(d.l)); ctx.stroke();
    ctx.fillRect(x(i) - bw / 2, Math.min(y(d.o), y(d.c)), bw, Math.max(1, Math.abs(y(d.o) - y(d.c))));
    ctx.fillStyle = up ? 'rgba(0,229,160,.25)' : 'rgba(255,61,110,.25)';
    ctx.fillRect(x(i) - bw / 2, yv(d.v), bw, H - padB - yv(d.v));
  });
  // MA lines
  const drawMA = (arr, col) => { ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath(); let started = false; arr.forEach((m, i) => { if (m == null) return; if (!started) { ctx.moveTo(x(i), y(m)); started = true; } else ctx.lineTo(x(i), y(m)); }); ctx.stroke(); };
  drawMA(ma20, '#ffc107'); drawMA(ma50, '#00b4ff');
  // hover tooltip
  if (chartState.hover >= 0 && chartState.hover < cl) {
    const i = chartState.hover; ctx.strokeStyle = 'rgba(168,191,214,.4)'; ctx.beginPath(); ctx.moveTo(x(i), padT); ctx.lineTo(x(i), H - padB); ctx.stroke();
    const d = k[i]; const tt = $('chartTip'); if (tt) { tt.style.display = 'block'; tt.style.left = Math.min(x(i) + 10, W - 170) + 'px'; tt.style.top = padT + 'px'; tt.innerHTML = `<div class="ctt-time">${new Date(d.t).toLocaleString('zh-CN')}</div><div class="ctt-row"><span class="ctt-lbl">开</span>${fmt(d.o)}</div><div class="ctt-row"><span class="ctt-lbl">高</span>${fmt(d.h)}</div><div class="ctt-row"><span class="ctt-lbl">低</span>${fmt(d.l)}</div><div class="ctt-row"><span class="ctt-lbl">收</span>${fmt(d.c)}</div><div class="ctt-row"><span class="ctt-lbl">量</span>${fmtBig(d.v)}</div>`; }
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
 *  因子关系网络（力导向图）+ 相关性热力图
 * ===================================================================== */
let net = null;
function initNetwork() {
  const cv = $('netCanvas'); if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  const nodes = [], edges = [];
  Object.keys(state.series).forEach(id => { const m = META[id]; if (m) nodes.push({ id, label: m.name, color: m.color, group: m.group, x: W / 2 + (Math.random() - .5) * 200, y: H / 2 + (Math.random() - .5) * 160, vx: 0, vy: 0, fixed: id === 'BTC' }); });
  const ids = nodes.map(n => n.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const r = pearson(state.series[ids[i]], state.series[ids[j]]);
    if (r != null && Math.abs(r) > 0.05) edges.push({ a: ids[i], b: ids[j], r });
  }
  net = { cv, ctx: cv.getContext('2d'), nodes, edges, W, H };
  // 先把 BTC 放中心
  const btc = nodes.find(n => n.id === 'BTC'); if (btc) { btc.x = W / 2; btc.y = H / 2; btc.fixed = true; }
  $('netCount') && ($('netCount').textContent = `${nodes.length} 因子 / ${edges.length} 关系`);
  animateNetwork();
}
function animateNetwork() {
  if (!net) return; const { cv, ctx, nodes, edges, W, H } = net;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  // 力模拟
  for (let it = 0; it < 2; it++) {
    nodes.forEach(n => { if (n.fixed) return; let fx = (W / 2 - n.x) * 0.002, fy = (H / 2 - n.y) * 0.002;
      nodes.forEach(m => { if (m === n) return; const dx = n.x - m.x, dy = n.y - m.y; const d2 = dx * dx + dy * dy + 1; const f = 1200 / d2; fx += dx / Math.sqrt(d2) * f; fy += dy / Math.sqrt(d2) * f; });
      n.vx = (n.vx + fx) * 0.85; n.vy = (n.vy + fy) * 0.85; n.x += n.vx; n.y += n.vy; });
    edges.forEach(e => { const a = nodes.find(n => n.id === e.a), b = nodes.find(n => n.id === e.b); if (!a || !b) return; const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 90) * 0.01; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; });
  }
  // 边
  edges.forEach(e => { const a = nodes.find(n => n.id === e.a), b = nodes.find(n => n.id === e.b); if (!a || !b) return; const col = e.r > 0 ? `rgba(0,229,160,${Math.min(.7, Math.abs(e.r))})` : `rgba(255,61,110,${Math.min(.7, Math.abs(e.r))})`; ctx.strokeStyle = col; ctx.lineWidth = 1 + Math.abs(e.r) * 3; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); });
  // 节点
  nodes.forEach(n => { const r = (n.id === 'BTC' ? 16 : 9) + (n.id === 'BTC' ? 0 : 0); ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill(); ctx.fillStyle = '#060c18'; ctx.font = 'bold 9px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n.id === 'BTC' ? 'BTC' : n.label.slice(0, 3), n.x, n.y); if (n.id !== 'BTC') { ctx.fillStyle = '#a8bfd6'; ctx.font = '8px Inter, sans-serif'; ctx.fillText(n.label, n.x, n.y + r + 9); } });
  requestAnimationFrame(animateNetwork);
}
function renderHeatmap() {
  const box = $('heatmap'); if (!box) return; const ids = Object.keys(state.series);
  const max = Math.max(8, ids.length * 64);
  box.style.gridTemplateColumns = `64px repeat(${ids.length}, 1fr)`;
  let html = '<div class="hm-h"></div>' + ids.map(id => `<div class="hm-h">${META[id] ? META[id].name.slice(0, 4) : id}</div>`).join('');
  ids.forEach(ri => { html += `<div class="hm-h" style="text-align:left">${META[ri] ? META[ri].name : ri}</div>`; ids.forEach(ci => { const r = ri === ci ? 1 : pearson(state.series[ri], state.series[ci]); const bg = r == null ? '#132035' : r > 0 ? `rgba(0,229,160,${Math.abs(r) * .8})` : `rgba(255,61,110,${Math.abs(r) * .8})`; html += `<div class="hm-cell" style="background:${bg};color:${Math.abs(r || 0) > .5 ? '#060c18' : '#a8bfd6'}">${r == null ? '·' : r.toFixed(2)}</div>`; }); });
  box.style.maxHeight = max + 'px'; box.innerHTML = html;
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
function paperBuy() { const sym = $('ptSym') ? $('ptSym').value : 'BTC'; const amt = +($('ptAmt') ? $('ptAmt').value : 1000); const px = state.prices[sym] ? state.prices[sym].price : null; if (!px) return; state.positions.push({ sym, amt, px, t: Date.now() }); savePositions(); renderPaper(); }
function paperSell(i) { const p = state.positions[i]; if (!p) return; state.positions.splice(i, 1); savePositions(); renderPaper(); }
function renderPaper() {
  let invested = 0, nowv = 0; const list = $('ptList'); if (!list) return; list.innerHTML = '';
  state.positions.forEach((p, i) => { const px = state.prices[p.sym] ? state.prices[p.sym].price : p.px; const qty = p.amt / p.px; const v = qty * px; invested += p.amt; nowv += v; const pl = v - p.amt; const row = document.createElement('div'); row.className = 'pt-pos'; row.innerHTML = `<div class="pt-pos-row"><span class="pt-pos-lbl">${p.sym}</span><span class="pt-pos-val">${fmt(v, 0)}</span></div><div class="pt-pos-row"><span class="pt-pos-lbl">PL</span><span class="pt-pos-val" style="color:${pl >= 0 ? '#00e5a0' : '#ff3d6e'}">${pl >= 0 ? '+' : ''}${fmt(pl, 0)} (${pl >= 0 ? '+' : ''}${(pl / p.amt * 100).toFixed(1)}%)</span></div><div class="pt-pos-row"><span class="pt-pos-lbl">成本</span><span class="pt-pos-val">${fmt(p.px)}</span></div><button class="qt-btn" style="margin-top:6px;padding:5px;font-size:11px" onclick="paperSell(${i})">平仓</button>`; list.appendChild(row); });
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
function renderMacro() {
  const m = state.macro; const set = (id, v, d) => { const e = $(id); if (e) { e.textContent = v; const s = $(id + '_d'); if (s && d != null) { s.textContent = (d >= 0 ? '▲' : '▼') + ' ' + Math.abs(d).toFixed(2); s.className = 'mval ' + (d >= 0 ? 'up' : 'dn'); } } };
  if (!m) { ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX'].forEach(k => set('m_' + k, CONFIG.PROXY ? '—' : '需Worker')); $('macroHint') && ($('macroHint').style.display = CONFIG.PROXY ? 'none' : 'block'); return; }
  $('macroHint') && ($('macroHint').style.display = 'none');
  const prev = state.macroSeries && state.macroSeries._prev;
  set('m_DXY', fmt(m.DXY, 2), m.DXY - (prev && prev.DXY || m.DXY));
  set('m_US10Y', fmt(m.US10Y, 2) + '%', m.US10Y - (prev && prev.US10Y || m.US10Y));
  set('m_GOLD', fmt(m.GOLD, 0), m.GOLD - (prev && prev.GOLD || m.GOLD));
  set('m_SPX', fmt(m.SPX, 0), m.SPX - (prev && prev.SPX || m.SPX));
  set('m_VIX', fmt(m.VIX, 1), m.VIX - (prev && prev.VIX || m.VIX));
}
function renderOnChain() {
  const cs = state.chainSeries; const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set('oc_hr', fmtBig(cs.hashrate && cs.hashrate[cs.hashrate.length - 1]) + ' TH/s');
  set('oc_tx', fmtBig(cs.n_tx && cs.n_tx[cs.n_tx.length - 1]));
  set('oc_mc', state.global ? '$' + fmtBig(state.global.total_market_cap.usd) : '—');
  set('oc_dom', state.global ? state.global.market_cap_percentage.btc.toFixed(1) + '%' : '—');
  set('oc_stable', state.global && state.global.total_market_cap.stablecoin ? '$' + fmtBig(state.global.total_market_cap.stablecoin) : '—');
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
  if ($('nxScore')) $('nxScore').textContent = score; if ($('nxSig')) { const s = score > 60 ? '偏多' : score < 40 ? '偏空' : '中性'; $('nxSig').textContent = s; $('nxSig').className = 'fscore-l ' + (score > 60 ? 'up' : score < 40 ? 'dn' : 'n'); }
  const box = $('factorGrid'); if (!box) return; box.innerHTML = '';
  FACTORS.forEach(f => { const r = out[f.id]; const clamped = Math.max(-2.5, Math.min(2.5, r.z)); const col = r.sig === 'over' ? '#ff3d6e' : r.sig === 'under' ? '#00e5a0' : '#ffc107'; const card = document.createElement('div'); card.className = 'fcard'; card.innerHTML = `<div class="fc-name">${f.name}</div><div class="fc-z" style="color:${col}">${clamped >= 0 ? '+' : ''}${clamped.toFixed(1)}</div><div class="fc-str"><div class="fc-strbar" style="width:${Math.min(100, Math.abs(clamped) / 2.5 * 100)}%;background:${col}"></div></div><div class="fc-sig" style="color:${col}">${r.note}</div>`; box.appendChild(card); });
}
function renderStatus(ok) {
  const dot = $('netDot'); if (dot) { dot.className = 'net-dot ' + (ok ? 'ok' : ''); }
  if ($('lastUpd')) $('lastUpd').textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN');
}

/* =====================================================================
 *  刷新主流程
 * ===================================================================== */
async function refreshAll() {
  let ok = true;
  const tasks = [fetchPrices(), fetchKlines('BTC', state.interval), fetchFG(), fetchGlobal(), fetchChain(), fetchDeriv(), fetchMacro()];
  const res = await Promise.allSettled(tasks); ok = res.every(r => r.status === 'fulfilled' && r.value !== false);
  // 1d kline 用于相关性
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
function setInterval_(i) { state.interval = i; document.querySelectorAll('.tbtn').forEach(b => b.classList.remove('active')); event.target.classList.add('active'); fetchKlines('BTC', i).then(() => { renderChart(); renderTA(); renderFactors(); }); }
function bindUI() {
  document.querySelectorAll('[data-i18n]'); // reserved
  const ibtns = document.querySelectorAll('.ibtn'); ibtns.forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.ibtn').forEach(x => x.classList.remove('active')); b.classList.add('active'); state.interval = b.dataset.i; fetchKlines('BTC', b.dataset.i).then(() => { renderChart(); renderTA(); renderFactors(); }); }));
  const cv = $('mainCanvas'); if (cv) cv.addEventListener('mousemove', e => { const rect = cv.getBoundingClientRect(); const k = state.klines['BTC' + state.interval]; if (!k) return; const i = Math.round((e.clientX - rect.left) / (rect.width) * (k.length - 1)); chartState.hover = Math.max(0, Math.min(k.length - 1, i)); renderChart(); }); 
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
