/* =====================================================================
 * NEXUS PROXY — Cloudflare Worker  v3.4
 * 服务端数据聚合 + 通用代理，带边缘缓存，输出 CORS 友好的 API。
 *
 * 出口:
 *   /api/snapshot  宏观 / 政策 / 通胀 / 大宗 序列（含日期 + 数据源诊断）
 *   /api/calendar  美国经济日历（非农 / 失业率 / 初请 / PCE / CPI / FOMC）
 *   /api/fetch     白名单代理（浏览器所有外部请求经此，绕 GFW + CORS）
 *   /health        健康检查
 *   /api/probe     数据源可达性诊断
 *
 * 数据源（均为 CF 边缘实测可用）:
 *   Yahoo Finance     指数/汇率/黄金/原油(WTI+布伦特)/农业 日线（主源）
 *   Stooq              同上一组（兜底；2026-10 起 CF 边缘常见 522，故降为备源）
 *   NY Fed (markets)   联邦基金有效利率 EFFR（日频，真实政策利率）
 *   U.S. Treasury      名义/实际收益率曲线 → 曲线利差 + 市场隐含通胀预期
 *   Forex Factory      美国经济日历 JSON（非农 / 失业率 / 初请 / PCE / CPI 的实际·预期·前值）
 *
 * 注 1: 官方月频 CPI/PCE 原始序列（BLS / FRED）从 CF 边缘被 WAF 拦截（403/520，实测）。
 *       通胀维度用两条互补数据：①「10Y 名义 − 10Y 实际」= 市场隐含通胀预期（日频、前瞻）
 *       ②经济日历中的 CPI/PCE 实际发布值（超预期方向）。
 * 注 2: DBnomics 上的 BLS 镜像实测数据只更新到 2025-01（滞后 20 个月），不可用于实时，已弃用。
 * ===================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300',
};

// 通用代理白名单：仅允许这些主机，避免变成开放代理
const PROXY_ALLOW = [
  'api.bybit.com',          // 行情 / K线 / 资金费率 / 持仓 / 多空比
  'api.coinpaprika.com',    // 全球市值 / BTC 占比（主源）
  'api.coingecko.com',      // 全球市值 / BTC 占比（备用）
  'api.alternative.me',     // 恐惧贪婪指数
  'mempool.space',          // 比特币算力
  'stablecoins.llama.fi',   // 稳定币总市值（稳定币占比因子）
  'api.blockchain.info',    // 链上交易笔数（链上活跃因子）
  'nfs.faireconomy.media',  // 美国经济日历（非农/PCE/CPI/失业率/初请）
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
];

// 简单序列：按顺序尝试多个源（yahoo 主源 / stooq 兜底）
const SIMPLE = {
  DXY:   ['yahoo:DX-Y.NYB', 'stooq:^dxy'],
  US10Y: ['yahoo:^TNX',     'stooq:us10y'],
  GOLD:  ['yahoo:GC=F',     'stooq:xauusd'],
  SPX:   ['yahoo:^GSPC',    'stooq:^spx'],
  VIX:   ['yahoo:^VIX',     'stooq:^vix'],
  OIL:   ['yahoo:CL=F',     'stooq:cl.f'],     // WTI 原油
  BRENT: ['yahoo:BZ=F',     'stooq:brn.f'],    // 布伦特原油
  AGRI:  ['yahoo:DBA',      'stooq:dba.us'],   // 农业 ETF
};

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

function jsonResp(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
}

/* ---------- 通用代理（白名单） ---------- */
async function proxyFetch(target, cacheTtl) {
  let u;
  try { u = new URL(target); } catch { throw new Error('invalid url'); }
  if (!PROXY_ALLOW.includes(u.hostname)) throw new Error('host not allowed: ' + u.hostname);
  const cacheKey = new Request(u.toString());
  if (cacheTtl > 0) { const hit = await caches.default.match(cacheKey); if (hit) return hit; }
  const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)', 'Accept': 'application/json, text/plain, */*' } });
  const body = await r.text();
  const resp = new Response(body, { status: r.status, headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': cacheTtl > 0 ? `public, max-age=${cacheTtl}` : 'no-store' } });
  if (cacheTtl > 0 && r.ok) await caches.default.put(cacheKey, resp.clone());
  return resp;
}

/* ---------- Stooq 日线 CSV → {ts,closes} ---------- */
async function fetchStooq(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)' } });
  if (!r.ok) throw new Error('stooq ' + r.status);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  // 反爬时 Stooq 会返回 JS 验证页 / HTML，这里直接判掉
  if (lines.length < 2 || !/^Date/i.test(lines[0])) throw new Error('stooq blocked/unexpected: ' + (lines[0] || '').slice(0, 40));
  const rows = lines.slice(1).map(l => l.split(','))
    .map(row => ({ t: Date.parse(row[0]), c: parseFloat(row[4]) }))
    .filter(d => !isNaN(d.t) && !isNaN(d.c)).sort((a, b) => a.t - b.t);
  if (!rows.length) throw new Error('stooq nodata ' + symbol);
  return { ts: rows.map(d => d.t), closes: rows.map(d => d.c) };
}

/* ---------- Yahoo Finance → {ts,closes} ---------- */
async function fetchYahoo(symbol) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('yahoo ' + r.status);
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error('no result');
      const tsRaw = res.timestamp || [];
      const clRaw = (res.indicators.quote[0].close) || [];
      const ts = [], closes = [];
      for (let i = 0; i < clRaw.length; i++) { if (clRaw[i] != null) { ts.push(tsRaw[i] * 1000); closes.push(clRaw[i]); } }
      if (!closes.length) throw new Error('empty');
      return { ts, closes };
    } catch (e) { lastErr = e; console.warn('fetchYahoo fail', host, symbol, e.message); }
  }
  throw lastErr || new Error('yahoo failed ' + symbol);
}

/* ---------- NY Fed 联邦基金有效利率 EFFR → {ts,closes} ---------- */
async function fetchEFFR() {
  const url = 'https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=2024-01-01&endDate=2030-01-01';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)', 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('nyfed ' + r.status);
  const j = await r.json();
  const arr = (j.refRates || []).map(x => ({ t: Date.parse(x.effectiveDate), c: x.percentRate }))
    .filter(d => !isNaN(d.t) && typeof d.c === 'number').sort((a, b) => a.t - b.t);
  if (!arr.length) throw new Error('effr empty');
  return { ts: arr.map(d => d.t), closes: arr.map(d => d.c) };
}

/* ---------- 美国财政部收益率曲线 CSV ---------- */
function parseTreasuryCsv(text, wantCols) {
  const lines = text.trim().split(/\r?\n/);
  const hdr = lines[0].split(',').map(h => h.replace(/"/g, '').toUpperCase().replace(/\s+/g, ''));
  const idx = {};
  wantCols.forEach(w => { idx[w] = hdr.indexOf(w.toUpperCase().replace(/\s+/g, '')); });
  const ts = []; const cols = {}; wantCols.forEach(w => cols[w] = []);
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const t = Date.parse(cells[0]);
    if (isNaN(t)) continue;
    const vals = {}; let ok = true;
    for (const w of wantCols) { const c = parseFloat(cells[idx[w]]); if (isNaN(c)) { ok = false; break; } vals[w] = c; }
    if (!ok) continue;
    ts.push(t); wantCols.forEach(w => cols[w].push(vals[w]));
  }
  // 升序
  const order = ts.map((t, i) => i).sort((a, b) => ts[a] - ts[b]);
  const ots = order.map(i => ts[i]);
  const ocols = {}; wantCols.forEach(w => ocols[w] = order.map(i => cols[w][i]));
  return { ts: ots, cols: ocols };
}
async function fetchTreasuryNominal() {
  const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&_format=csv';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)' } });
  if (!r.ok) throw new Error('treasury nominal ' + r.status);
  return parseTreasuryCsv(await r.text(), ['2 Yr', '10 Yr']);
}
async function fetchTreasuryReal() {
  const url = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_real_yield_curve&field_tdr_date_value=2026&_format=csv';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)' } });
  if (!r.ok) throw new Error('treasury real ' + r.status);
  return parseTreasuryCsv(await r.text(), ['10 YR']);
}

/* 两个 {ts,cols} 按日期对齐相减 */
function alignSubtract(aTs, aV, bTs, bV) {
  const m = new Map(); bTs.forEach((t, i) => m.set(t, bV[i]));
  const ts = [], v = [];
  aTs.forEach((t, i) => { if (m.has(t)) { ts.push(t); v.push(aV[i] - m.get(t)); } });
  return { ts, v };
}

async function loadSimple(key) {
  const list = SIMPLE[key]; let lastErr;
  for (const src of list) {
    const [prov, sym] = src.split(':');
    try {
      const data = prov === 'stooq' ? await fetchStooq(sym) : await fetchYahoo(sym);
      return { data, src };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all sources failed ' + key);
}

/* ---------- 美国经济日历（Forex Factory 周历 JSON） ---------- */
async function fetchCalendar() {
  const r = await fetch(FF_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)', 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('ff ' + r.status);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error('ff shape');
  return arr
    .filter(e => e && e.country === 'USD' && e.title)
    .map(e => ({ t: e.date, title: e.title, impact: e.impact || '', f: e.forecast || '', p: e.previous || '', a: e.actual || '' }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

async function buildSnapshot() {
  const macro = {}; const series = {}; const dates = {}; const srcMap = {};
  const put = (k, s, src) => {
    if (s && s.closes && s.closes.length) { series[k] = s.closes; dates[k] = s.ts; macro[k] = s.closes[s.closes.length - 1]; srcMap[k] = src; }
    else { series[k] = []; dates[k] = []; macro[k] = null; srcMap[k] = 'failed'; }
  };

  await Promise.all(Object.keys(SIMPLE).map(async (k) => {
    try { const { data, src } = await loadSimple(k); put(k, data, src); }
    catch (e) { put(k, null); console.warn('simple fail', k, e.message); }
  }));

  const [effr, nom, real] = await Promise.allSettled([fetchEFFR(), fetchTreasuryNominal(), fetchTreasuryReal()]);
  if (effr.status === 'fulfilled') put('EFFR', effr.value, 'nyfed'); else { put('EFFR', null); console.warn('effr fail'); }

  if (nom.status === 'fulfilled') {
    const n = nom.value;
    put('UST2Y', { ts: n.ts, closes: n.cols['2 Yr'] }, 'treasury');
    // 10Y-2Y 期限利差
    put('T10Y2Y', { ts: n.ts, closes: n.ts.map((_, i) => n.cols['10 Yr'][i] - n.cols['2 Yr'][i]) }, 'treasury');
    if (real.status === 'fulfilled') {
      const rr = real.value;
      put('REAL10Y', { ts: rr.ts, closes: rr.cols['10 YR'] }, 'treasury');
      // 市场隐含通胀预期 = 名义10Y − 实际10Y
      const bei = alignSubtract(n.ts, n.cols['10 Yr'], rr.ts, rr.cols['10 YR']);
      put('BEI10', { ts: bei.ts, closes: bei.v }, 'treasury');
    } else { put('REAL10Y', null); put('BEI10', null); console.warn('treasury real fail'); }
  } else { put('UST2Y', null); put('T10Y2Y', null); put('REAL10Y', null); put('BEI10', null); console.warn('treasury nominal fail'); }

  const prev = {};
  Object.keys(series).forEach(k => { const a = series[k]; if (a && a.length >= 2) prev[k] = a[a.length - 2]; });
  return { macro, series, dates, _prev: prev, _src: srcMap, ts: Date.now() };
}

const PROBE_URLS = [
  'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=1y&interval=1d',
  'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=1y&interval=1d',
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://stooq.com/q/d/l/?s=cl.f&i=d',
  'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json',
  'https://stablecoins.llama.fi/stablecoins?includePrices=false',
  'https://api.blockchain.info/charts/n-transactions?timespan=30days&format=json',
];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/api/probe') {
      const out = {};
      await Promise.all(PROBE_URLS.map(async (u) => {
        const key = u.replace(/^https:\/\//, '').slice(0, 72);
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)' } });
          const t = await r.text();
          out[key] = { status: r.status, len: t.length, head: t.slice(0, 240).replace(/\s+/g, ' ') };
        } catch (e) { out[key] = { error: String(e.message || e) }; }
      }));
      return jsonResp(out, 200, { 'Cache-Control': 'no-store' });
    }

    if (url.pathname === '/api/snapshot') {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      let resp = await cache.match(cacheKey);
      if (!resp) {
        try {
          const data = await buildSnapshot();
          resp = jsonResp(data);
          const core = ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX'];
          if (core.every(k => data.macro[k] != null)) await cache.put(cacheKey, resp.clone());
        } catch (e) { resp = jsonResp({ error: e.message }, 502); }
      }
      return resp;
    }

    if (url.pathname === '/api/calendar') {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      let resp = await cache.match(cacheKey);
      if (!resp) {
        try {
          const events = await fetchCalendar();
          resp = jsonResp({ events, ts: Date.now() }, 200, { 'Cache-Control': 'public, max-age=900' });
          if (events.length) await cache.put(cacheKey, resp.clone());
        } catch (e) { resp = jsonResp({ error: e.message, events: [] }, 502); }
      }
      return resp;
    }

    if (url.pathname === '/api/fetch') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('missing url param', { status: 400, headers: CORS });
      const cacheTtl = /api\.coingecko\.com|stablecoins\.llama\.fi|api\.blockchain\.info|nfs\.faireconomy\.media/.test(target) ? 600 : 0;
      try { return await proxyFetch(target, cacheTtl); }
      catch (e) { return jsonResp({ error: e.message }, 502); }
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResp({ name: 'nexus-proxy', version: '3.4', status: 'ok', source: 'yahoo+stooq+nyfed+treasury+finforexfactory+proxy', symbols: Object.keys(SIMPLE).concat(['EFFR', 'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10']) });
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
