/* =====================================================================
 * NEXUS PROXY — Cloudflare Worker  v3.6
 * 服务端数据聚合 + 通用代理，带边缘缓存，输出 CORS 友好的 API。
 *
 * 出口:
 *   /api/snapshot  宏观 / 政策 / 通胀 / 大宗 / 日元 序列（含日期 + 数据源诊断）
 *   /api/calendar  美国经济日历（非农 / 失业率 / 初请 / PCE / CPI / FOMC）
 *   /api/history   10 年+ 日频历史包（供前端回放历史 Nexus Score + IC 检验；BTC 经 v3.14 延至 ~2014）
 *   /api/dvol      Deribit DVOL 实时恐慌统计（当前值 + 近1年百分位 + 60日 z，供实时波动率警报）
 *   /api/fetch     白名单代理（浏览器所有外部请求经此，绕 GFW + CORS）
 *   /health        健康检查
 *   /api/probe     数据源可达性诊断
 *   /api/notify    护栏 RED 通知转发（把告警 POST 到用户配置的群机器人 Webhook；Webhook URL 存于 env.NOTIFY_WEBHOOK，不进源码）
 *
 * 数据源（均为 CF 边缘实测可用）:
 *   Yahoo Finance     指数/汇率(含美元日元)/黄金/原油(WTI+布伦特)/农业 日线（主源）
 *   Stooq              同上一组（兜底；2026-10 起 CF 边缘返回 JS 反爬页，实际已不可用）
 *   NY Fed (markets)   联邦基金有效利率 EFFR（日频，真实政策利率）
 *   U.S. Treasury      名义/实际收益率曲线 → 曲线利差 + 市场隐含通胀预期
 *   Japan MOF          国债金利情报 CSV → 日本 10 年期国债收益率（日频，1974 至今）
 *   Forex Factory      美国经济日历 JSON（非农 / 失业率 / 初请 / PCE / CPI 的实际·预期·前值）
 *
 * 注 1: 官方月频 CPI/PCE 原始序列（BLS / FRED）从 CF 边缘被 WAF 拦截（403/520，实测）。
 *       通胀维度用两条互补数据：①「10Y 名义 − 10Y 实际」= 市场隐含通胀预期（日频、前瞻）
 *       ②经济日历中的 CPI/PCE 实际发布值（超预期方向）。
 * 注 2: DBnomics 上的 BLS 镜像实测数据只更新到 2025-01（滞后 20 个月），不可用于实时，已弃用。
 * 注 3: 日本财务省 CSV 为 Shift-JIS，而 Workers 的 TextDecoder 不支持该编码；
 *       但除表头外的数据行全为 ASCII（日期 R8.8.31 + 数字），故按 UTF-8 读取后只解析数据行。
 * 注 4: Forex Factory 的 nfs CDN 会对高频请求返回 429（Rate Limited HTML 页）。
 *       /api/calendar、/api/global、/api/history 均采用「成功长缓存 + 失败退避 + 陈旧兜底」，日历并对 XML 端点做自动降级，
 *       避免被限流后持续重试导致「锁死」。
 * ===================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300',
};

// 通用代理白名单：仅允许这些主机，避免变成开放代理
const PROXY_ALLOW = [
  'api.bybit.com',          // 行情 / K线 / 资金费率 / 持仓 / 多空比
  'api.coinpaprika.com',    // 全球市值 / BTC 占比（主源）
  'api.coingecko.com',      // 全球市值 / BTC 占比（备用2）
  'api.coinlore.net',       // 全球市值 / BTC 占比（主源·免费无key最稳）
  'api.alternative.me',     // 恐惧贪婪指数
  'mempool.space',          // 比特币算力
  'stablecoins.llama.fi',   // 稳定币总市值（稳定币占比因子）
  'api.blockchain.info',    // 链上交易笔数（链上活跃因子）
  'nfs.faireconomy.media',  // 美国经济日历（非农/PCE/CPI/失业率/初请）
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'www.mof.go.jp',          // 日本财务省 国债金利情报（日债利率）
  'bitcoin-data.com',       // BGeometrics 免费 BTC 链上指标 API（MVRV/活跃地址，无 key，免费档 8 次/小时）
  'fapi.binance.com',       // Binance USDT 本位永续历史（资金费率/持仓量/多空比，供 /api/history 用）
  'futures-data.binance.com', // Binance 衍生品统计备用域
  'www.deribit.com',          // Deribit 期权 DVOL/IV/持仓（crypto 原生恐惧温度计）
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
  USDJPY:['yahoo:JPY=X',    'stooq:usdjpy'],   // 美元/日元（套息交易风向标）
};

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
/* range 用 'max' 会对部分标的退化为月频采样（BTC-USD 实测只返回 145 个月点），
 * 故 BTC 这类「要日频长历史」的标的改用 period1/period2 + interval=1d 精确取日频。 */
async function fetchYahoo(sahoo, range = '10y', period1 = null) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const base = `https://${host}/v8/finance/chart/${encodeURIComponent(sahoo)}`;
      const url = period1 != null
        ? `${base}?period1=${period1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`
        : `${base}?range=${range}&interval=1d`;
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
  /* v3.11: start pulled back from 2024-01-01 to 2015-01-01.
   * NY Fed only has official EFFR from 2017-04 onward; earlier dates simply come
   * back empty -> the frontend treats "series not yet started" as ok:false and
   * drops the factor from the denominator instead of polluting the score. */
  const url = 'https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=2015-01-01&endDate=2030-01-01';
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
async function fetchTreasuryCsvYear(year, type, cols, tries) {
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=${type}&field_tdr_date_value=${year}&_format=csv`;
  const n = tries || 3;
  let lastErr;
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.8)' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const p = parseTreasuryCsv(await r.text(), cols);
      if (!p.ts.length) throw new Error('empty');
      return p;
    } catch (e) { lastErr = e; if (i < n - 1) await new Promise(r => setTimeout(r, 500 * (i + 1))); }
  }
  throw new Error('treasury ' + type + ' ' + year + ': ' + lastErr.message);
}

/* 合并多个年份的 {ts,cols}，按日期去重升序 */
function mergeTreasury(parts) {
  const ts = [], cols = {};
  Object.keys(parts[0].cols).forEach(k => (cols[k] = []));
  const seen = new Set();
  parts.forEach(p => p.ts.forEach((t, i) => {
    if (seen.has(t)) return;
    seen.add(t); ts.push(t);
    Object.keys(cols).forEach(k => cols[k].push(p.cols[k][i]));
  }));
  const ord = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b]);
  const outTs = ord.map(i => ts[i]);
  Object.keys(cols).forEach(k => { const c = cols[k]; cols[k] = ord.map(i => c[i]); });
  return { ts: outTs, cols };
}

/* ---------- US Treasury yields covering the 10y window (v3.11) ----------
 * Only the per-year CSV entry point works:
 *   - the "all" endpoint (/csv/all/all?field_tdr_date_value=all) is WAF-blocked (403)
 *   - FRED's keyless fredgraph.csv multi-series endpoint is unreachable from here
 *   - Stooq answers non-browser requests with a JS challenge page
 * So it is per-year: 2016..now = 11y x 2 series = 22 subrequests.
 *
 * Those 22 must be lifted OUT of "rebuild the history bundle" path: the free tier
 * caps a single invocation at 50 subrequests, and adding Yahoo/on-chain/sentiment/
 * Bybit (~20 more) blows straight through it (measured error:
 * "Too many subrequests by single Worker invocation").
 * Same shape as bitdataWithCache -- the data updates daily, so cache it daily
 * (success 12h / failure 30min cooldown).
 *
 * Retries are disabled for the batch (tries=1): 11 concurrent years x 3 attempts
 * = up to 33 subrequests on a bad day, which would hit the cap again. Transient
 * failures are absorbed by the 30-minute cooldown retry instead.
 */
const TS_CACHE_KEY = 'https://nexus-cache.internal/treasury-v1';
function histYears() {
  const now = new Date().getUTCFullYear(); const ys = [];
  for (let y = HIST_START_YEAR; y <= now; y++) ys.push(y);
  return ys;
}
async function fetchTreasuryNominal(years) {
  const ys = years || [new Date().getUTCFullYear()];
  const parts = (await Promise.all(ys.map(y => fetchTreasuryCsvYear(y, 'daily_treasury_yield_curve', ['2 Yr', '10 Yr'], 1).catch(() => null)))).filter(Boolean);
  if (!parts.length) throw new Error('treasury nominal empty');
  return parts.length === 1 ? parts[0] : mergeTreasury(parts);
}
async function fetchTreasuryReal(years) {
  const ys = years || [new Date().getUTCFullYear()];
  const parts = (await Promise.all(ys.map(y => fetchTreasuryCsvYear(y, 'daily_treasury_real_yield_curve', ['10 YR'], 1).catch(() => null)))).filter(Boolean);
  if (!parts.length) throw new Error('treasury real empty');
  return parts.length === 1 ? parts[0] : mergeTreasury(parts);
}
async function fetchTreasuryLong() {
  const ys = histYears();
  const nom = await fetchTreasuryNominal(ys);
  if (nom.ts.length < 1500) throw new Error('treasury long short: ' + nom.ts.length);
  const real = await fetchTreasuryReal(ys).catch(e => { console.warn('treasury real long fail', e.message); return null; });
  return { nom: nom, real: real };
}
async function treasuryWithCache() {
  const cache = caches.default, key = new Request(TS_CACHE_KEY);
  try {
    const hit = await cache.match(key);
    if (hit) { const j = await hit.json(); return j.failed ? null : j; }
  } catch (e) { /* cache read failure -> treat as miss */ }
  try {
    const val = await fetchTreasuryLong();
    await cache.put(key, new Response(JSON.stringify(val), { headers: { 'Cache-Control': 'public, max-age=43200' } }));
    return val;
  } catch (e) {
    console.warn('treasury long fail, cooldown 30min:', e.message);
    await cache.put(key, new Response(JSON.stringify({ failed: true, err: e.message, t: Date.now() }), { headers: { 'Cache-Control': 'public, max-age=1800' } }));
    return null;
  }
}
/* keep the last n points (snapshot only needs ~3y, history wants everything) */
function tailCols(p, n) {
  if (!p || !p.ts) return null;
  const k = Math.max(0, p.ts.length - n);
  const cols = {}; Object.keys(p.cols).forEach(c => cols[c] = p.cols[c].slice(k));
  return { ts: p.ts.slice(k), cols: cols };
}

/* 两个 {ts,cols} 按日期对齐相减 */
function alignSubtract(aTs, aV, bTs, bV) {
  const m = new Map(); bTs.forEach((t, i) => m.set(t, bV[i]));
  const ts = [], v = [];
  aTs.forEach((t, i) => { if (m.has(t)) { ts.push(t); v.push(aV[i] - m.get(t)); } });
  return { ts, v };
}

/* ---------- 日本财务省 国债金利情报（JGB 10年） ----------
 * 文件是 Shift-JIS，但「表头以外的数据行」全部是纯 ASCII（日期形如 R8.8.31 + 数字），
 * 而 Cloudflare Workers 的 TextDecoder 不支持 shift_jis，所以这里按 UTF-8 读进来后
 * 只解析 ASCII 数据行，绕开编码问题。
 * 列顺序固定：種類,1年,2年,3年,4年,5年,6年,7年,8年,9年,10年,15年,20年,25年,30年,40年
 *  → cells[0]=日期, cells[10]=10年
 * 日期用日本年号：R(令和)=2018+N, H(平成)=1988+N, S(昭和)=1925+N
 */
const JGB_ERA = { R: 2018, H: 1988, S: 1925 };
const JGB_URL_ALL = 'https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv';
const JGB_URL_MONTH = 'https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv';

function parseJgbLine(line) {
  const cells = line.split(',');
  const m = (cells[0] || '').trim().match(/^([RHS])(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const y = JGB_ERA[m[1]] + parseInt(m[2], 10);
  const mo = parseInt(m[3], 10), da = parseInt(m[4], 10);
  if (!(y > 1970 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null;
  const v = parseFloat(cells[10]);
  if (!isFinite(v) || v <= -10 || v > 30) return null;   // 10年日债收益率合理区间
  return { t: Date.UTC(y, mo - 1, da), c: v };
}
async function fetchJgbCsv(url, cacheTtl) {
  const key = new Request(url);
  if (cacheTtl > 0) { const hit = await caches.default.match(key); if (hit) return await hit.text(); }
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.5)' } });
  if (!r.ok) throw new Error('jgb ' + r.status);
  const txt = await r.text();
  if (cacheTtl > 0) await caches.default.put(key, new Response(txt, { headers: { 'Cache-Control': `public, max-age=${cacheTtl}` } }));
  return txt;
}
/* v3.11 optimisation: jgbcm_all.csv is 1.2MB / ~10k lines and regex-parsing it
 * line by line is a CPU hog. The old code cached the raw TEXT, so every rebuild of
 * the history bundle re-parsed all 10k lines. Cache the parsed result instead --
 * only one real parse per 6 hours. */
const JGB_PARSED_KEY = 'https://nexus-cache.internal/jgb-parsed-v1';
async function fetchJGB() {
  const cache = caches.default;
  try {
    const hit = await cache.match(new Request(JGB_PARSED_KEY));
    if (hit) { const j = await hit.json(); if (j && j.ts && j.ts.length >= 60) return j; }
  } catch (e) { /* treat as miss */ }

  const rows = [];
  const push = txt => txt.split(/\r?\n/).forEach(l => { const p = parseJgbLine(l); if (p) rows.push(p); });
  const [hist, mon] = await Promise.allSettled([
    fetchJgbCsv(JGB_URL_ALL, 21600),
    fetchJgbCsv(JGB_URL_MONTH, 0),
  ]);
  if (hist.status === 'fulfilled') push(hist.value);
  if (mon.status === 'fulfilled') push(mon.value);
  const map = new Map(); rows.forEach(r => map.set(r.t, r.c));
  const ts = [...map.keys()].sort((a, b) => a - b);
  if (ts.length < 60) throw new Error('jgb insufficient (' + ts.length + ')');
  const kt = ts.slice(-HIST_KEEP);
  const out = { ts: kt, closes: kt.map(t => map.get(t)) };
  try { await cache.put(new Request(JGB_PARSED_KEY), new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'public, max-age=21600' } })); } catch (e) { }
  return out;
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

/* ---------- 美国经济日历（Forex Factory 周历）----------
 * 坑：FF 的 nfs CDN 会对高频请求返回 429（Rate Limited 的 HTML 页）。
 * 原实现只在成功时缓存 15 分钟，一旦被限流就每次请求都再去打 FF → 持续 429「锁死」。
 * 现在改为「成功长缓存 + 失败退避 + 陈旧兜底」：
 *   - 成功结果缓存 6 小时
 *   - 任何一次尝试（无论成败）记录时间戳；距上次尝试 < CAL_MIN_RETRY 秒则直接吃缓存，不再打 FF
 *   - 打 FF 失败时，若存在陈旧缓存则返回陈旧数据（标注 X-Calendar-Source: stale），而非 502
 */
const CAL_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
];
const CAL_DATA_KEY = 'https://nexus-cache.internal/calendar-v2';
const CAL_META_KEY = 'https://nexus-cache.internal/calendar-meta-v2';
const CAL_TTL = 21600;        // 成功结果在缓存里保留 6 小时
const CAL_MIN_RETRY = 1800;   // 距上次尝试不足 30 分钟 → 不再打 FF（退避）
const CAL_MIN_RETRY_HOT = 300; // 重大事件发布窗口内：压到 5 分钟
const BIG_WINDOW_SEC = 7200;   // 发布时刻 ±2 小时算「窗口内」
/* 这几项一旦发布，BTC 常在数分钟内反应；30 分钟的退避会把整段行情错过。 */
const BIG_EVENT_RE = /Non-Farm Employment Change|Unemployment Rate|Core PCE Price Index|CPI |Consumer Price Index|Federal Funds Rate|FOMC|Initial Jobless Claims/i;

/* FF 的 <date> 是 MM-DD-YYYY、<time> 是 '08:30am'（美东）。
 * 老实现只取 <date>，于是降级到 XML 时发布时刻被整个丢掉 —— 前端无法区分
 * 「还没到点」和「该发了但数据没来」两种情况，这正是这次要修的根。
 * 夏令时由 Intl 按该时刻实时求解，不用硬编码 -4/-5。 */
/* FF XML 的 <date> 是 MM-DD-YYYY、<time> 是 '08:30am'。
 * 【时区实测】<time> 已经是 UTC，不是美东。实证办法：把同一批事件在两个端点上逐条对齐——
 *   JSON  2026-09-28T08:15:00-04:00  <->  XML  09-28-2026 12:15pm
 *   JSON  2026-09-28T13:30:00-04:00  <->  XML  09-28-2026  5:30pm
 *   JSON  2026-09-29T10:00:00-04:00  <->  XML  09-29-2026  2:00pm
 *   左边 -04:00 是夏令时 ET，折算成 UTC 正好等于右边的钟点。
 * 曾按 America/New_York 做过换算，结果把发布时间推晚 4 小时，
 * 令「发布已过时而数据没到」的报警迟到整整一下午。不要再加偏移。 */
function ffXmlTimeToIso(dateStr, timeStr) {
  const ds = String(dateStr || '').trim();
  const dm = /^(\d{2})-(\d{2})-(\d{4})$/.exec(ds);
  if (!dm) return ds;
  const yy = +dm[3], mo = +dm[1], dd = +dm[2];
  let hh = 0, mi = 0;
  const tm = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(String(timeStr || '').trim());
  if (tm) {
    hh = +tm[1]; mi = +tm[2];
    const ap = (tm[3] || '').toLowerCase();
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
  }
  const d = new Date(Date.UTC(yy, mo - 1, dd, hh, mi));
  return isFinite(d.getTime()) ? d.toISOString() : ds;
}
/* 缓存内容里是否有重大事件正处在发布窗口 —— 是则不走长退避 */
async function calendarHotWindow(text) {
  try {
    const j = JSON.parse(text);
    const arr = (j && j.events) || [];
    const now = Date.now();
    for (let i = 0; i < arr.length; i++) {
      if (!BIG_EVENT_RE.test(arr[i].title || '')) continue;
      const t = Date.parse(arr[i].t);
      if (!isFinite(t)) continue;
      /* 单位：t-now 是毫秒，BIG_WINDOW_SEC 是秒 —— 不换算的话窗口只有 7.2 秒，等于功能整个失效 */
      const d = (t - now) / 1000;
      if (d < BIG_WINDOW_SEC && d > -BIG_WINDOW_SEC) return true;
    }
  } catch (e) { }
  return false;
}

/* 把 FF 的 XML 日历也解析成同一结构（JSON 端点 429 时的备用出口） */
function parseFfXml(text) {
  const out = [];
  const blocks = text.split(/<event>/i).slice(1);
  const get = (b, tag) => { const m = b.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i')); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
  blocks.forEach(b => {
    const country = get(b, 'country');
    const title = get(b, 'title');
    if (country !== 'USD' || !title) return;
    out.push({ t: ffXmlTimeToIso(get(b, 'date'), get(b, 'time')), td: get(b, 'date'), tm: get(b, 'time'), title, impact: get(b, 'impact'), f: get(b, 'forecast'), p: get(b, 'previous'), a: get(b, 'actual') });
  });
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

async function fetchCalendar() {
  let lastErr;
  for (const url of CAL_URLS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json, text/xml, */*' } });
      if (!r.ok) throw new Error('ff ' + r.status);
      const text = await r.text();
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        const arr = JSON.parse(text);
        if (!Array.isArray(arr)) throw new Error('ff shape');
        const ev = arr.filter(e => e && e.country === 'USD' && e.title)
          .map(e => ({ t: e.date, td: e.date, tm: '', title: e.title, impact: e.impact || '', f: e.forecast || '', p: e.previous || '', a: e.actual || '' }))
          .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
        if (!ev.length) throw new Error('ff empty');
        return ev;
      }
      const ev = parseFfXml(text);
      if (!ev.length) throw new Error('ff xml empty');
      return ev;
    } catch (e) { lastErr = e; console.warn('calendar src fail', url.slice(-28), e.message); }
  }
  throw lastErr || new Error('calendar all sources failed');
}

async function calendarWithFallback() {
  const cache = caches.default;
  const dataKey = new Request(CAL_DATA_KEY), metaKey = new Request(CAL_META_KEY);
  const [hit, meta] = await Promise.all([cache.match(dataKey), cache.match(metaKey)]);
  let lastTry = 0;
  if (meta) { try { lastTry = (await meta.json()).t || 0; } catch (e) { } }
  const ageSec = (Date.now() - lastTry) / 1000;
  const wrap = (body, src) => new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900', 'X-Calendar-Source': src } });

  if (hit) {
    const cached = await hit.clone().text();
    const minAge = (await calendarHotWindow(cached)) ? CAL_MIN_RETRY_HOT : CAL_MIN_RETRY;
    if (ageSec < minAge) return wrap(cached, 'edge-cache');
  }
  try {
    const events = await fetchCalendar();
    const payload = JSON.stringify({ events, ts: Date.now() });
    await cache.put(dataKey, new Response(payload, { headers: { 'Cache-Control': `public, max-age=${CAL_TTL}` } }));
    await cache.put(metaKey, new Response(JSON.stringify({ t: Date.now(), ok: true }), { headers: { 'Cache-Control': `public, max-age=${CAL_TTL}` } }));
    return wrap(payload, 'live');
  } catch (e) {
    await cache.put(metaKey, new Response(JSON.stringify({ t: Date.now(), ok: false, err: String(e.message || e) }), { headers: { 'Cache-Control': `public, max-age=${CAL_MIN_RETRY}` } }));
    if (hit) return wrap(await hit.text(), 'stale');
    return jsonResp({ error: e.message, events: [], ts: Date.now() }, 502);
  }
}


/* =====================================================================
 *  全球市值 / BTC 占比 —— 多源 + 陈旧兜底（模式同 /api/calendar）
 *  背景：coinpaprika 免费档 60 次/小时，超限返回 402 并封 1 小时；
 *        coingecko 免费档也常 429。coinlore 免费、无 key、限额宽松 → 主源。
 *  注意：不同源的 BTC 占比口径不同（coinlore 约 +3~5pp 偏高于 coinpaprika），
 *        前端因子中枢按 coinlore 口径校准，切换源时必须同步校准。
 * ===================================================================== */
const GLOBAL_SOURCES = [
  { name: 'coinlore', url: 'https://api.coinlore.net/api/global/',
    parse: d => { const g = d[0]; return { mcap: +g.total_mcap, btcD: +g.btc_d, ethD: +g.eth_d }; } },
  { name: 'coinpaprika', url: 'https://api.coinpaprika.com/v1/global',
    parse: d => ({ mcap: +d.market_cap_usd, btcD: +d.bitcoin_dominance_percentage, ethD: null }) },
  { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/global',
    parse: d => ({ mcap: +d.data.total_market_cap.usd, btcD: +d.data.market_cap_percentage.btc, ethD: +d.data.market_cap_percentage.eth }) },
];
const GLOBAL_DATA_KEY = 'https://nexus-cache.internal/global-v1';
const GLOBAL_META_KEY = 'https://nexus-cache.internal/global-meta-v1';
const GLOBAL_TTL = 600;       // 成功结果缓存 10 分钟
const GLOBAL_MIN_RETRY = 300; // 距上次尝试不足 5 分钟 → 直接吃缓存（退避）

async function fetchGlobalMcap() {
  let lastErr;
  for (const s of GLOBAL_SOURCES) {
    try {
      const r = await fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.7)', 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const v = s.parse(JSON.parse(await r.text()));
      if (!isFinite(v.mcap) || v.mcap <= 0 || !isFinite(v.btcD) || v.btcD <= 0 || v.btcD >= 100) throw new Error('bad shape');
      return { mcap: v.mcap, btcD: v.btcD, ethD: isFinite(v.ethD) ? v.ethD : null, src: s.name };
    } catch (e) { lastErr = e; console.warn('global src fail', s.name, e.message); }
  }
  throw lastErr || new Error('global all sources failed');
}

async function globalWithFallback() {
  const cache = caches.default;
  const dataKey = new Request(GLOBAL_DATA_KEY), metaKey = new Request(GLOBAL_META_KEY);
  const [hit, meta] = await Promise.all([cache.match(dataKey), cache.match(metaKey)]);
  let lastTry = 0;
  if (meta) { try { lastTry = (await meta.json()).t || 0; } catch (e) { } }
  const ageSec = (Date.now() - lastTry) / 1000;
  const wrap = (body, src) => new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'X-Global-Source': src } });

  if (hit && ageSec < GLOBAL_MIN_RETRY) return wrap(await hit.text(), 'edge-cache');
  try {
    const g = await fetchGlobalMcap();
    const payload = JSON.stringify({ mcap: g.mcap, btcD: g.btcD, ethD: g.ethD, src: g.src, ts: Date.now() });
    await cache.put(dataKey, new Response(payload, { headers: { 'Cache-Control': `public, max-age=${GLOBAL_TTL}` } }));
    await cache.put(metaKey, new Response(JSON.stringify({ t: Date.now(), ok: true }), { headers: { 'Cache-Control': `public, max-age=${GLOBAL_TTL}` } }));
    return wrap(payload, g.src);
  } catch (e) {
    await cache.put(metaKey, new Response(JSON.stringify({ t: Date.now(), ok: false, err: String(e.message || e) }), { headers: { 'Cache-Control': `public, max-age=${GLOBAL_MIN_RETRY}` } }));
    if (hit) return wrap(await hit.text(), 'stale');
    return jsonResp({ error: e.message, mcap: null, btcD: null, ts: Date.now() }, 502);
  }
}


/* =====================================================================
 *  /api/history —— 长历史日频数据包（供前端「评分历史 + IC 检验」回放）
 *
 *  设计要点：评分历史**不需要数据库**。所有因子输入本身就是历史序列，
 *  所以只要把这些序列原样发给前端，前端就能用**同一套因子代码**逐日
 *  回放算出历史 Nexus Score。没有 KV、没有 cron、永远和代码同步。
 *
 *  覆盖度：只能回放「有历史序列」的因子。事件类因子（非农/CPI 等，周历
 *  无历史）、衍生品快照（fund/ls 只有当日值）、BTC占比 / 稳定币占比
 *  （需要历史总市值，免费源无）无法回放 → 由前端按其子集重新归一化。
 * ===================================================================== */
const HIST_YAHOO = {
  DXY: 'DX-Y.NYB', US10Y: '^TNX', GOLD: 'GC=F', SPX: '^GSPC', VIX: '^VIX',
  OIL: 'CL=F', BRENT: 'BZ=F', USDJPY: 'JPY=X', BTC: 'BTC-USD',
};
/* v3.11: window 2y -> 10y (from 2016-10).
 * Yahoo's range=max returns MONTHLY sampling for indices (^GSPC gives only 169
 * points), so range=10y must be explicit -- measured: BTC 3653 / DXY 3037 /
 * other macro 2500+ points, exactly covering the target window. */
const HIST_RANGE = '10y';
/* v3.14: BTC 用 period1 显式取日频长历史（2014-09-01 起，BTC-USD 诞生附近），避开 range=max 的月频退化 */
const BTC_PERIOD1 = Math.floor(Date.UTC(2014, 8, 1) / 1000);
const HIST_START_YEAR = 2016;   // first year for the per-year Treasury fetch
const HIST_KEEP = 3900;         // max ~10.7y of daily points per series
const HIST_TTL = 3600;          // success cache 1h
const HIST_MIN_RETRY = 900;     // failure backoff 15min
/* NOTE: bump vN whenever this endpoint's payload shape or semantics change,
 * otherwise the previous edge cache masks the change and it looks like the new
 * code never shipped (hit this twice in practice). */
const HIST_DATA_KEY = 'https://nexus-cache.internal/history-v12';
const HIST_META_KEY = 'https://nexus-cache.internal/history-meta-v12';

const trimS = (s, n = HIST_KEEP) => {
  if (!s || !s.ts || !s.ts.length) return null;
  const k = s.ts.length > n ? s.ts.length - n : 0;
  return { ts: s.ts.slice(k), closes: s.closes.slice(k) };
};

/* ---------- v3.10: 本质输入 —— 链上估值/使用量/需求 + 衍生品结构 ----------
 * v3.9 的样本外验证证明：调 17 个宏观序列的权重是死路，要换更本质的输入。
 * 新增 5 条有历史深度的序列（全部免费、无需 key、CF 边缘实测可达）：
 *   MRV  MVRV  市值/实现市值 —— bitcoin-data.com（BGeometrics）免费 API，
 *        数据滞后约 1 周，免费档限 8 次/小时，每次构建只打 2 个请求
 *   ADR  活跃地址 —— 同上（滞后约 1 天）
 *   FEE  链上手续费 USD —— blockchain.info charts transaction-fees-usd
 *        （CoinMetrics 社区 API 已下线 404，GitHub CSV 已冻结 4 个月，全部弃用）
 *   PREM 永续溢价指数日频 —— Bybit premium-index-price-kline，1000 天深；
 *        history-funding-rate 从 CF 出口实测超时，弃用
 *   OIH  永续持仓量日频 —— Bybit open-interest，**intervalTime 必须用 1d
 *        （用 D 会静默返回空列表，实测踩过）**，必须带 startTime，翻页 200 点/次
 * Binance fapi 从 CF 出口被 WAF 拦（403 Request blocked，实测），全部弃用。
 * ===================================================================== */
/* bitcoin-data 免费档 8 次/小时，但数据日更 → 每源独立长缓存：
 *   成功 → 缓存 12h；失败（429 限速等）→ 缓存失败标记 30min，期间不再打它。
 * 不做这一层的话，/api/history 每 15 分钟的重建会烧光小时配额，429 永远清不空（实测踩过）。 */
const BITDATA_KEY = 'https://nexus-cache.internal/bitdata-v1';
async function bitDataWithCache() {
  const cache = caches.default;
  const key = new Request(BITDATA_KEY);
  try {
    const hit = await cache.match(key);
    if (hit) {
      const j = await hit.json();
      return j.failed ? null : j;
    }
  } catch (e) { /* 缓存读失败按无缓存处理 */ }
  try {
    const val = await fetchBitDataAll();
    await cache.put(key, new Response(JSON.stringify(val), { headers: { 'Cache-Control': 'public, max-age=43200' } }));
    return val;
  } catch (e) {
    console.warn('bitdata fail, cooldown 30min:', e.message);
    await cache.put(key, new Response(JSON.stringify({ failed: true, err: e.message, t: Date.now() }), { headers: { 'Cache-Control': 'public, max-age=1800' } }));
    return null;
  }
}

async function fetchBitDataAll() {
  const mk = arr => {
    const rows = arr.map(x => ({ t: (+x.unixTs) * 1000, c: x.mvrv != null ? +x.mvrv : x.activeAddresses != null ? +x.activeAddresses : NaN }))
      .filter(x => isFinite(x.t) && isFinite(x.c)).sort((a, b) => a.t - b.t);
    if (rows.length < 400) throw new Error('bitdata short: ' + rows.length);
    return { ts: rows.map(x => x.t), closes: rows.map(x => x.c) };
  };
  const get = ep => fetch('https://bitcoin-data.com/v1/' + ep, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.11)' } })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  /* 串行两个请求，尊重免费档限速（8 次/小时）；429 时直接失败走降级 */
  const mrv = await get('mvrv');
  const adr = await get('active-addresses');
  return { MRV: mk(mrv), ADR: mk(adr) };
}

async function fetchFeeHist() {
  // v3.11: same as Tx/HR, switch to all (2009-now) to cover the 10y window
  const r = await fetch('https://api.blockchain.info/charts/transaction-fees-usd?timespan=all&sampled=false&format=json',
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.11)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const vals = (await r.json()).values || [];
  const rows = vals.map(x => ({ t: +x.x * 1000, c: +x.y })).filter(x => isFinite(x.t) && isFinite(x.c)).sort((a, b) => a.t - b.t);
  if (rows.length < 380) throw new Error('fee short: ' + rows.length);
  return { ts: rows.map(x => x.t), closes: rows.map(x => x.c) };
}

/* Bybit premium / open-interest history: daily data, naturally shallow depth
 * (1000d / 600d). No reason to re-hit them on every bundle rebuild -- a 6h cache
 * removes those 4 subrequests from the steady-state path too. */
const BYBIT_CACHE_KEY = 'https://nexus-cache.internal/bybit-hist-v1';
async function bybitHistWithCache() {
  const cache = caches.default, key = new Request(BYBIT_CACHE_KEY);
  try {
    const hit = await cache.match(key);
    if (hit) { const j = await hit.json(); return j.failed ? null : j; }
  } catch (e) { }
  try {
    const val = await Promise.all([fetchPremiumHist(), fetchOIHist()]);
    const out = { PREM: val[0], OIH: val[1] };
    await cache.put(key, new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'public, max-age=21600' } }));
    return out;
  } catch (e) {
    console.warn('bybit hist fail, cooldown 30min:', e.message);
    await cache.put(key, new Response(JSON.stringify({ failed: true, err: e.message, t: Date.now() }), { headers: { 'Cache-Control': 'public, max-age=1800' } }));
    return null;
  }
}

async function fetchPremiumHist() {
  const r = await fetch('https://api.bybit.com/v5/market/premium-index-price-kline?category=linear&symbol=BTCUSDT&interval=D&limit=1000',
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.11)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  if (d.retCode !== 0) throw new Error('bybit ' + d.retMsg);
  const list = (d.result && d.result.list) || [];   // [ts, premium, ...] 最新在前
  const rows = list.map(x => ({ t: +x[0], c: +x[1] })).filter(x => isFinite(x.t) && isFinite(x.c)).sort((a, b) => a.t - b.t);
  if (rows.length < 400) throw new Error('premium short: ' + rows.length);
  return { ts: rows.map(x => x.t), closes: rows.map(x => x.c) };
}

async function fetchOIHist() {
  /* 实测：intervalTime 用 D 会静默返回空列表，必须用 1d；必须带 startTime/endTime。
   * 每页 200 点，end 往前挪，翻 3 页 ≈ 600 天。 */
  const day = 86400000;
  let end = Date.now();
  const seen = {}, rows = [];
  for (let p = 0; p < 3; p++) {
    const start = end - 200 * day;
    const r = await fetch('https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=1d&limit=200&startTime=' + start + '&endTime=' + end,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.11)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.retCode !== 0) throw new Error('bybit ' + d.retMsg);
    const list = (d.result && d.result.list) || [];
    if (!list.length) break;
    list.forEach(x => {
      let t = +x.timestamp; if (t && t < 1e12) t *= 1000;
      const c = +x.openInterest;
      if (isFinite(t) && isFinite(c) && !seen[t]) { seen[t] = 1; rows.push({ t: t, c: c }); }
    });
    end = start;
  }
  rows.sort((a, b) => a.t - b.t);
  if (rows.length < 380) throw new Error('oi short: ' + rows.length);
  return { ts: rows.map(x => x.t), closes: rows.map(x => x.c) };
}

/* ---------- v3.12: Deribit 期权原生指标（crypto 恐惧温度计）----------
 * 本地沙箱出口受限，Deribit 必须由 CF Worker 抓取（与 Yahoo/Bybit 同路径）。
 *   DVOL  Deribit 波动率指数（VIX 同款，隐含波动率预期），日频，~2020 起
 *   DVHV  Deribit 历史已实现波动率（BTC 30d realized vol），日频，~2019 起
 * 这俩是 crypto 原生的「恐惧/波动」量度，比 DXY/美债等宏观代理更贴近 BTC。
 * 单独长缓存（成功 12h / 失败 30min 冷却），从稳态重建路径剥出，避免烧请求。 */
const DERIBIT_KEY = 'https://nexus-cache.internal/deribit-v1';
async function deribitWithCache() {
  const cache = caches.default, key = new Request(DERIBIT_KEY);
  try {
    const hit = await cache.match(key);
    if (hit) { const j = await hit.json(); return j.failed ? null : j; }
  } catch (e) { /* 缓存读失败按无缓存处理 */ }
  try {
    const val = await fetchDeribitAll();
    await cache.put(key, new Response(JSON.stringify(val), { headers: { 'Cache-Control': 'public, max-age=43200' } }));
    return val;
  } catch (e) {
    console.warn('deribit hist fail, cooldown 30min:', e.message);
    await cache.put(key, new Response(JSON.stringify({ failed: true, err: e.message, t: Date.now() }), { headers: { 'Cache-Control': 'public, max-age=1800' } }));
    return null;
  }
}
async function fetchDeribitAll() {
  const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.12)' } };
  // DVOL：按年翻页（resolution=1D），2020 起；每根 [ts,o,h,l,c]
  const dvol = [];
  const now = new Date().getUTCFullYear();
  for (let y = 2020; y <= now; y++) {
    const s = Date.UTC(y, 0, 1), e = (y < now) ? Date.UTC(y + 1, 0, 1) : Date.now();
    const u = 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=' + s + '&end_timestamp=' + e + '&resolution=1D';
    const r = await fetch(u, UA);
    if (!r.ok) throw new Error('deribit dvol HTTP ' + r.status);
    const d = await r.json();
    const arr = (d.result && d.result.data) || [];
    arr.forEach(x => { if (x[0] && isFinite(x[4])) dvol.push({ t: x[0], c: x[4] }); });
  }
  dvol.sort((a, b) => a.t - b.t);
  if (dvol.length < 300) throw new Error('dvol short: ' + dvol.length);
  /* DVHV（Deribit 历史已实现波动率）本想一并抓，但 get_historical_volatility 不带时间范围参数、
   * 只返回最近 ~16 天滚动窗口，无历史深度；且已实现波动率回放里本来就自己从 BTC 价格算，冗余 —— 砍掉。 */
  return { DVOL: { ts: dvol.map(x => x.t), closes: dvol.map(x => x.c) } };
}

/* v3.14: DVOL 实时恐慌统计 —— 从 deribitWithCache 的 DVOL 序列算「当前值处在历史什么位置」，
 * 供前端实时面板做波动率恐慌警报（风险护栏，不是预测）。deribitWithCache 自带 12h 缓存，这里调用几乎零成本。 */
async function dvolStat() {
  const drb = await deribitWithCache();
  if (!drb || !drb.DVOL || !drb.DVOL.closes || drb.DVOL.closes.length < 60) return null;
  const closes = drb.DVOL.closes, ts = drb.DVOL.ts, n = closes.length;
  const last = closes[n - 1], lastTs = ts[n - 1];
  // 近 1 年（~365 点）分位：当前值在这段历史里的百分位（越高越恐慌）
  const w = Math.min(365, n);
  const win = closes.slice(n - w);
  const pctTrailing1y = win.filter(x => x <= last).length / win.length;
  // 近 60 日 z 分数（滚动均值 / 标准差）：捕捉近期相对自身的飙升
  const zwin = closes.slice(Math.max(0, n - 60));
  const mean = zwin.reduce((a, b) => a + b, 0) / zwin.length;
  const sd = Math.sqrt(zwin.reduce((a, b) => a + (b - mean) * (b - mean), 0) / zwin.length);
  const z60 = sd > 1e-9 ? (last - mean) / sd : 0;
  return { latest: last, ts: lastTs, pctTrailing1y, z60, n, src: 'deribit:dvol' };
}

async function fetchHistoryBundle() {
  const out = { macro: {}, fng: null, tx: null, hr: null, btc: null, srcs: {} };

  // —— Yahoo 2 年日频 ——
  await Promise.all(Object.keys(HIST_YAHOO).map(async (k) => {
    try {
      // v3.14: BTC 用 period1 显式取日频长历史（2014-09 起），把 IC 窗口从 2016-10 真正往前推到「10 年甚至更早」；
      // 其余宏观序列仍用 10y（range=max 对部分标的会退化为月频采样，且会撑大包体）。BTC 单独放宽 keep 上限到 4600（~12.6y）。
      const isBtc = (k === 'BTC');
      const d = await fetchYahoo(HIST_YAHOO[k], HIST_RANGE, isBtc ? BTC_PERIOD1 : null);
      const t = trimS(d, isBtc ? 4600 : HIST_KEEP);
      if (!t) throw new Error('empty');
      if (isBtc) { out.btc = t; out.srcs.BTC = 'yahoo:BTC-USD'; }
      else { out.macro[k] = t; out.srcs[k] = 'yahoo:' + HIST_YAHOO[k]; }
    } catch (e) { console.warn('hist yahoo fail', k, e.message); }
  }));

  // ---- rates: Treasury goes through its own long-lived cache (22 subrequests) ----
  const [effr, jgb, tsr] = await Promise.allSettled([fetchEFFR(), fetchJGB(), treasuryWithCache()]);
  const putM = (k, v, src) => { const t = trimS(v); if (t) { out.macro[k] = t; out.srcs[k] = src; } };

  if (effr.status === 'fulfilled') putM('EFFR', effr.value, 'nyfed');
  else console.warn('hist effr fail', effr.reason && effr.reason.message);
  if (jgb.status === 'fulfilled') putM('JGB10Y', jgb.value, 'mof');
  else console.warn('hist jgb fail', jgb.reason && jgb.reason.message);
  if (tsr.status === 'fulfilled' && tsr.value) {
    const n = tsr.value.nom, rr = tsr.value.real;
    putM('UST2Y', { ts: n.ts, closes: n.cols['2 Yr'] }, 'treasury');
    putM('T10Y2Y', { ts: n.ts, closes: n.ts.map((_, i) => n.cols['10 Yr'][i] - n.cols['2 Yr'][i]) }, 'treasury');
    if (rr) {
      putM('REAL10Y', { ts: rr.ts, closes: rr.cols['10 YR'] }, 'treasury');
      const bei = alignSubtract(n.ts, n.cols['10 Yr'], rr.ts, rr.cols['10 YR']);
      putM('BEI10', { ts: bei.ts, closes: bei.v }, 'treasury');
    }
  } else console.warn('hist treasury unavailable (cooldown or fail)');

  // —— v3.10: 本质输入（链上估值/使用量/需求 + 衍生品结构）——
  /* 与宏观源分开 allSettled：这 5 条缺了不该拖垮整个历史包，
   * 前端对缺失因子的处理是 ok:false 退出分母（v3.7 已有此机制）。 */
  const [bd, fee, bb] = await Promise.allSettled([bitDataWithCache(), fetchFeeHist(), bybitHistWithCache()]);
  if (bd.status === 'fulfilled' && bd.value) { putM('MRV', bd.value.MRV, 'bitcoin-data'); putM('ADR', bd.value.ADR, 'bitcoin-data'); }
  else console.warn('hist bitdata unavailable (rate-limit cooldown or fail)');
  if (fee.status === 'fulfilled') putM('FEE', fee.value, 'blockchain.info:fees-usd');
  else console.warn('hist fee fail', fee.reason && fee.reason.message);
  if (bb.status === 'fulfilled' && bb.value) {
    if (bb.value.PREM) putM('PREM', bb.value.PREM, 'bybit:premium');
    if (bb.value.OIH) putM('OIH', bb.value.OIH, 'bybit:oi');
  } else console.warn('hist bybit unavailable (cooldown or fail)');

  // —— v3.12: Deribit 期权原生指标（crypto 恐惧温度计，分析用，不入评分）——
  const drb = await deribitWithCache();
  if (drb && drb.DVOL) putM('DVOL', drb.DVOL, 'deribit:dvol');
  else console.warn('hist deribit DVOL unavailable (cooldown or fail)');

  // —— 链上 / 情绪 ——
  await Promise.all([
    (async () => {
      try {
        const r = await fetch('https://api.alternative.me/fng/?limit=0', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.8)' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const arr = (await r.json()).data || [];
        const rows = arr.map(x => ({ t: +x.timestamp * 1000, c: +x.value })).filter(x => isFinite(x.t) && isFinite(x.c)).sort((a, b) => a.t - b.t);
        if (rows.length < 100) throw new Error('fng short');
        out.fng = trimS({ ts: rows.map(x => x.t), closes: rows.map(x => x.c) });
        out.srcs.FNG = 'alternative.me';
      } catch (e) { console.warn('hist fng fail', e.message); }
    })(),
    (async () => {
      try {
        // v3.11: blockchain.info supports timespan=all (2009-now, ~6455 points) which
        // covers the 10y window; the old 2years locked on-chain factors to the tail
        const r = await fetch('https://api.blockchain.info/charts/n-transactions?timespan=all&sampled=false&format=json', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.11)' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const vals = (await r.json()).values || [];
        const rows = vals.map(x => ({ t: +x.x * 1000, c: +x.y })).filter(x => isFinite(x.t) && isFinite(x.c)).sort((a, b) => a.t - b.t);
        if (rows.length < 100) throw new Error('tx short');
        out.tx = trimS({ ts: rows.map(x => x.t), closes: rows.map(x => x.c) });
        out.srcs.TX = 'blockchain.info';
      } catch (e) { console.warn('hist tx fail', e.message); }
    })(),
    (async () => {
      try {
        // mempool only serves 1y of hashrate (would bottleneck the replay window),
        // so the history bundle uses blockchain.info's all-range hashrate
        const r = await fetch('https://api.blockchain.info/charts/hash-rate?timespan=all&sampled=false&format=json', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.11)' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const vals = (await r.json()).values || [];
        const rows = vals.map(x => ({ t: +x.x * 1000, c: +x.y })).filter(x => isFinite(x.t) && isFinite(x.c)).sort((a, b) => a.t - b.t);
        if (rows.length < 100) throw new Error('hr short');
        out.hr = trimS({ ts: rows.map(x => x.t), closes: rows.map(x => x.c) });
        out.srcs.HR = 'blockchain.info';
      } catch (e) { console.warn('hist hr fail', e.message); }
    })(),
  ]);

  const nKeys = Object.keys(out.macro).length;
  if (nKeys < 10 || !out.btc) throw new Error('history insufficient (macro=' + nKeys + ', btc=' + !!out.btc + ')');

  /* Layered coverage (v3.11).
   *
   * The old version looked only at "shortest series" (threshold 380), which was
   * designed for a 2y window. In a 10y window Bybit OI naturally has only 600
   * points and MVRV only ~4 years -- they would ALWAYS be the shortest, so coverage
   * would be permanently flagged degraded -> TTL degrades to 5 minutes -> every
   * rebuild re-hits every external source.
   *
   * So: core = long-history series that form the replay backbone;
   *     aux  = reinforcement series whose depth is naturally limited.
   * Only a core collapse counts as real degradation. */
  const CORE = new Set(['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX', 'OIL', 'BRENT', 'USDJPY',
    'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10', 'JGB10Y', 'EFFR']);
  const core = [], aux = [];
  Object.keys(out.macro).forEach(k => (CORE.has(k) ? core : aux).push({ k: k, n: out.macro[k].ts.length }));
  ['fng', 'tx', 'hr', 'btc'].forEach(k => { if (out[k]) core.push({ k: k.toUpperCase(), n: out[k].ts.length }); });
  const byLen = (a, b) => a.n - b.n;
  core.sort(byLen); aux.sort(byLen);
  const c0 = core[0] || { k: '-', n: 0 };
  /* A healthy 10y core should have 2500+ points (Yahoo 10y yields 2500~3653).
   * Below 1500 means a backbone source collapsed (e.g. Treasury only got 1-2 years). */
  const spans = {};
  const sp = (k, s2) => { spans[k] = { n: s2.ts.length, t0: s2.ts[0], t1: s2.ts[s2.ts.length - 1] }; };
  Object.keys(out.macro).forEach(k => sp(k, out.macro[k]));
  ['fng', 'tx', 'hr', 'btc'].forEach(k => { if (out[k]) sp(k.toUpperCase(), out[k]); });
  out.coverage = {
    minLen: c0.n, minKey: c0.k, degraded: c0.n < 1500,
    core: core.length, nSeries: core.length + aux.length,
    auxMinLen: aux.length ? aux[0].n : null, auxMinKey: aux.length ? aux[0].k : null,
    spans: spans,
  };
  if (out.coverage.degraded) console.warn('history degraded(core)', c0.k, c0.n);
  return out;
}

async function historyWithFallback() {
  const cache = caches.default;
  const dataKey = new Request(HIST_DATA_KEY), metaKey = new Request(HIST_META_KEY);
  const [hit, meta] = await Promise.all([cache.match(dataKey), cache.match(metaKey)]);
  let lastTry = 0;
  if (meta) { try { lastTry = (await meta.json()).t || 0; } catch (e) { } }
  const ageSec = (Date.now() - lastTry) / 1000;
  const wrap = (body, src) => new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800', 'X-History-Source': src } });

  if (hit && ageSec < HIST_MIN_RETRY) return wrap(await hit.text(), 'edge-cache');
  try {
    const b = await fetchHistoryBundle();
    const payload = JSON.stringify({ ...b, ts: Date.now() });
    const ttl = b.coverage && b.coverage.degraded ? 300 : HIST_TTL;   // 降级只缓存 5 分钟，尽快重试
    await cache.put(dataKey, new Response(payload, { headers: { 'Cache-Control': `public, max-age=${ttl}` } }));
    await cache.put(metaKey, new Response(JSON.stringify({ t: Date.now(), ok: true }), { headers: { 'Cache-Control': `public, max-age=${ttl}` } }));
    return wrap(payload, 'live');
  } catch (e) {
    await cache.put(metaKey, new Response(JSON.stringify({ t: Date.now(), ok: false, err: String(e.message || e) }), { headers: { 'Cache-Control': `public, max-age=${HIST_MIN_RETRY}` } }));
    if (hit) return wrap(await hit.text(), 'stale');
    return jsonResp({ error: e.message, ts: Date.now() }, 502);
  }
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

  /* v3.11: Treasury now uses the same 12h cache as /api/history (taking the tail
   * ~800 trading days = 3.2y). Two wins: the live snapshot no longer issues its own
   * subrequests, and both endpoints read the same data instead of disagreeing. */
  const [effr, tsc, jgb] = await Promise.allSettled([fetchEFFR(), treasuryWithCache(), fetchJGB()]);
  if (effr.status === 'fulfilled') put('EFFR', effr.value, 'nyfed'); else { put('EFFR', null); console.warn('effr fail'); }
  if (jgb.status === 'fulfilled') put('JGB10Y', jgb.value, 'mof'); else { put('JGB10Y', null); console.warn('jgb fail', jgb.reason && jgb.reason.message); }

  if (tsc.status === 'fulfilled' && tsc.value) {
    const n = tailCols(tsc.value.nom, 800), rr = tailCols(tsc.value.real, 800);
    put('UST2Y', { ts: n.ts, closes: n.cols['2 Yr'] }, 'treasury');
    put('T10Y2Y', { ts: n.ts, closes: n.ts.map((_, i) => n.cols['10 Yr'][i] - n.cols['2 Yr'][i]) }, 'treasury');
    if (rr) {
      put('REAL10Y', { ts: rr.ts, closes: rr.cols['10 YR'] }, 'treasury');
      const bei = alignSubtract(n.ts, n.cols['10 Yr'], rr.ts, rr.cols['10 YR']);
      put('BEI10', { ts: bei.ts, closes: bei.v }, 'treasury');
    } else { put('REAL10Y', null); put('BEI10', null); console.warn('treasury real unavailable'); }
  } else { put('UST2Y', null); put('T10Y2Y', null); put('REAL10Y', null); put('BEI10', null); console.warn('treasury unavailable (cooldown)'); }

  const prev = {};
  Object.keys(series).forEach(k => { const a = series[k]; if (a && a.length >= 2) prev[k] = a[a.length - 2]; });
  return { macro, series, dates, _prev: prev, _src: srcMap, ts: Date.now() };
}

/* =====================================================================
 *  v3.25 · 因子宇宙（UNIVERSE）
 *  v3.27 · 前端真正样本外追踪 + 风险监测全口径（数据端点不变，仅版本号同步）
 *  ---------------------------------------------------------------------
 *  原来的因子表只有 32 项、可用序列只有 22 条 —— 这个量级没法回答
 *  「哪些因子是强影响、哪些只是噪声」。真实量化机构的因子库是几百到几千维，
 *  但它们从不靠「拍脑袋给权重」，而是**先筛后加权**：用 IC / ICIR / t / 胜率
 *  把因子分成可用与不可用，再决定给多少权重。
 *
 *  所以这一版先把「候选池」扩到 160+ 条真实日频序列，把「谁强谁弱」交给
 *  前端用真实十年数据去测（见 app.js 的 factorScreening），不在后端写死任何
 *  影响强度结论 —— 后端只负责**给真实数据**，不负责**下判断**。
 *
 *  全部走 Yahoo Finance（免费、无需 key、覆盖全球股指/外汇/商品/债券/ETF）。
 *  格式：KEY: [yahooSymbol, 中文名]
 *
 *  三类元数据在前端各有用处，不要混为一谈：
 *    · cat  = 数据分类（取数用）
 *    · exo  = 是否外生（网络图布环用：外生的排到外围）
 *    · 影响强度 = **不在这里定义**，由 IC 测量裁定
 * ===================================================================== */
const UNIVERSE = {
  /* —— 全球股指：风险偏好的总开关（外生） —— */
  index: {
    SPX500: ['^GSPC', '标普500'], NDX: ['^NDX', '纳指100'], DJI: ['^DJI', '道指'],
    RUT: ['^RUT', '罗素2000'], EEM: ['EEM', '新兴市场'], EFA: ['EFA', '发达市场(非美)'],
    VTI: ['VTI', '美股总市场'], QQQ: ['QQQ', '纳指ETF'], IWM: ['IWM', '小盘ETF'],
    EZU: ['EZU', '欧元区'], EWJ: ['EWJ', '日本'], FXI: ['FXI', '中国大盘'],
    KWEB: ['KWEB', '中概互联网'], INDA: ['INDA', '印度'], EWY: ['EWY', '韩国'],
    EWG: ['EWG', '德国'], EWU: ['EWU', '英国'], EWA: ['EWA', '澳大利亚'],
    EWC: ['EWC', '加拿大'], EWZ: ['EWZ', '巴西'], EWW: ['EWW', '墨西哥'],
  },
  /* —— 美股板块：资金在风险资产内部怎么轮动（外生） —— */
  sector: {
    XLK: ['XLK', '科技'], XLF: ['XLF', '金融'], XLE: ['XLE', '能源'],
    XLV: ['XLV', '医疗'], XLI: ['XLI', '工业'], XLY: ['XLY', '可选消费'],
    XLP: ['XLP', '必选消费'], XLU: ['XLU', '公用事业'], XLB: ['XLB', '材料'],
    XLRE: ['XLRE', '房地产'], XLC: ['XLC', '通信'], XBI: ['XBI', '生物科技'],
    SMH: ['SMH', '半导体'], IGV: ['IGV', '软件'],
  },
  /* —— 利率与债券：贴现率，加密估值最上游的分母（外生） —— */
  rate: {
    BILL13W: ['^IRX', '13周美债'], NOTE5Y: ['^FVX', '5年期'], BOND30Y: ['^TYX', '30年期'],
    TLT: ['TLT', '长债ETF'], IEF: ['IEF', '中债ETF'], SHY: ['SHY', '短债ETF'],
    TIP: ['TIP', '通胀债'], EMB: ['EMB', '新兴市场债'], BND: ['BND', '总债券'],
    AGG: ['AGG', '综合债'], MUB: ['MUB', '市政债'],
  },
  /* —— 信用：风险溢价/违约恐慌（外生） —— */
  credit: {
    HYG: ['HYG', '高收益债'], LQD: ['LQD', '投资级公司债'], JNK: ['JNK', '垃圾债'],
    VCSH: ['VCSH', '短公司债'], VCIT: ['VCIT', '中公司债'], SRLN: ['SRLN', '浮动利率贷款'],
  },
  /* —— 外汇：美元流动性 + 套息风向标（外生） —— */
  fx: {
    EURUSD: ['EURUSD=X', '欧元/美元'], GBPUSD: ['GBPUSD=X', '英镑/美元'],
    USDCNY: ['USDCNY=X', '美元/离岸人民币'], USDCHF: ['USDCHF=X', '美元/瑞郎'],
    AUDUSD: ['AUDUSD=X', '澳元/美元'], USDCAD: ['USDCAD=X', '美元/加元'],
    USDSEK: ['USDSEK=X', '美元/瑞典克朗'], USDNOK: ['USDNOK=X', '美元/挪威克朗'],
    USDZAR: ['USDZAR=X', '美元/南非兰特'], USDTRY: ['USDTRY=X', '美元/土耳其里拉'],
    USDMXN: ['USDMXN=X', '美元/墨西哥比索'], USDINR: ['USDINR=X', '美元/印度卢比'],
    USDKRW: ['USDKRW=X', '美元/韩元'], USDBRL: ['USDBRL=X', '美元/巴西雷亚尔'],
    EURJPY: ['EURJPY=X', '欧元/日元'], AUDJPY: ['AUDJPY=X', '澳元/日元'],
    GBPJPY: ['GBPJPY=X', '英镑/日元'], NZDUSD: ['NZDUSD=X', '纽元/美元'],
    USDPLN: ['USDPLN=X', '美元/波兰兹罗提'], USDIDR: ['USDIDR=X', '美元/印尼盾'],
  },
  /* —— 商品：通胀预期 + 避险 + 工业需求（外生） —— */
  commodity: {
    GOLDF: ['GC=F', '黄金期货'], SILVER: ['SI=F', '白银'], PLAT: ['PL=F', '铂金'],
    COPPER: ['HG=F', '铜'], WTIF: ['CL=F', 'WTI原油'], BRENTF: ['BZ=F', '布伦特原油'],
    NATGAS: ['NG=F', '天然气'], GASOLINE: ['RB=F', '汽油'], CORN: ['ZC=F', '玉米'],
    SOYBEAN: ['ZS=F', '大豆'], WHEAT: ['ZW=F', '小麦'], COFFEE: ['KC=F', '咖啡'],
    SUGAR: ['SB=F', '糖'], COCOA: ['CC=F', '可可'], COTTON: ['CT=F', '棉花'],
    DBA: ['DBA', '农业ETF'], DBC: ['DBC', '商品指数'], USO: ['USO', '原油ETF'],
    UNG: ['UNG', '天然气ETF'], GLD: ['GLD', '黄金ETF'], SLV: ['SLV', '白银ETF'],
    GDX: ['GDX', '金矿股'], XME: ['XME', '金属矿业'], FCX: ['FCX', '自由港铜矿'],
  },
  /* —— 波动率：恐慌温度计（外生，但与加密情绪高度共振） —— */
  vol: {
    VIX9D: ['^VIX9D', 'VIX 9日'], VIX3M: ['^VIX3M', 'VIX 3个月'],
    VVIX: ['^VVIX', 'VIX的VIX'], OVX: ['^OVX', '原油波动率'],
    GVZ: ['^GVZ', '黄金波动率'], VIXY: ['VIXY', 'VIX短债ETF'],
    SKEW: ['^SKEW', '尾部偏斜'], VXN: ['^VXN', '纳指波动率'],
    VIXM: ['VIXM', 'VIX中债ETF'], VXD: ['^VXD', '道指波动率'],
  },
  /* —— 加密概念股：传统市场对加密的定价（半外生） —— */
  cryptostock: {
    MSTR: ['MSTR', 'MicroStrategy'], COIN: ['COIN', 'Coinbase'],
    MARA: ['MARA', 'Marathon'], RIOT: ['RIOT', 'Riot'],
    CLSK: ['CLSK', 'CleanSpark'], HUT: ['HUT', 'Hut 8'],
    BTDR: ['BTDR', 'Bitdeer'], IREN: ['IREN', 'IREN'],
    WULF: ['WULF', 'TeraWulf'], CORZ: ['CORZ', 'Core Scientific'],
    GLXY: ['GLXY', 'Galaxy Digital'], BTBT: ['BTBT', 'Bit Digital'],
    HIVE: ['HIVE', 'HIVE Digital'], BITO: ['BITO', '比特币期货ETF'],
    IBIT: ['IBIT', '贝莱德现货ETF'], FBTC: ['FBTC', '富达现货ETF'],
  },
  /* —— 山寨币：加密内部轮动 / 风险偏好斜率（内生，非外生） —— */
  altcoin: {
    ETH: ['ETH-USD', '以太坊'], SOL: ['SOL-USD', 'Solana'], XRP: ['XRP-USD', '瑞波'],
    DOGE: ['DOGE-USD', '狗狗币'], ADA: ['ADA-USD', 'Cardano'], BNB: ['BNB-USD', '币安币'],
    LTC: ['LTC-USD', '莱特币'], TRX: ['TRX-USD', '波场'], AVAX: ['AVAX-USD', 'Avalanche'],
    LINK: ['LINK-USD', 'Chainlink'], DOT: ['DOT-USD', 'Polkadot'], MKR: ['MKR-USD', 'Maker'],
    AAVE: ['AAVE-USD', 'Aave'], ATOM: ['ATOM-USD', 'Cosmos'], NEAR: ['NEAR-USD', 'NEAR'],
    TON: ['TON11419-USD', 'TON'], ARB: ['ARB-USD', 'Arbitrum'], OP: ['OP-USD', 'Optimism'],
    INJ: ['INJ-USD', 'Injective'], FIL: ['FIL-USD', 'Filecoin'], ICP: ['ICP-USD', 'Internet Computer'],
    ETC: ['ETC-USD', '以太经典'], BCH: ['BCH-USD', '比特现金'], XLM: ['XLM-USD', '恒星'],
    XMR: ['XMR-USD', '门罗币'], ALGO: ['ALGO-USD', 'Algorand'], VET: ['VET-USD', '唯链'],
    SEI: ['SEI-USD', 'Sei'], TIA: ['TIA-USD', 'Celestia'], SHIB: ['SHIB-USD', '柴犬币'],
  },
  /* —— 科技巨头：流动性/成长预期的代理人（外生） —— */
  tech: {
    NVDA: ['NVDA', '英伟达'], AAPL: ['AAPL', '苹果'], MSFT: ['MSFT', '微软'],
    GOOGL: ['GOOGL', '谷歌'], AMZN: ['AMZN', '亚马逊'], META: ['META', 'Meta'],
    TSLA: ['TSLA', '特斯拉'], AMD: ['AMD', 'AMD'], AVGO: ['AVGO', '博通'],
    TSM: ['TSM', '台积电'], ASML: ['ASML', '阿斯麦'], NFLX: ['NFLX', '奈飞'],
    CRM: ['CRM', 'Salesforce'], ORCL: ['ORCL', '甲骨文'], PLTR: ['PLTR', 'Palantir'],
  },
};

/* 数据分类 → 是否「外生」。外生 = 不由加密市场内部决定、从外部打进来的变量。
 * 网络图据此把外生因子排到外围环 —— 用户要的是「一眼看出哪些是外面打进来的」。
 * 注意 cryptostock 是例外：它是股票，受传统市场驱动，但也直接反映加密定价，
 * 故判为半外生（前端按 exo:false 处理，但保留 cat 标记以便查看）。 */
const UNIVERSE_EXO = { index: 1, sector: 1, rate: 1, credit: 1, fx: 1, commodity: 1, vol: 1, tech: 1, cryptostock: 0, altcoin: 0 };
const UNIVERSE_CATS = Object.keys(UNIVERSE);

/* 并发受限的批量抓取。164 个标的若一次性 Promise.all 打出去，Yahoo 会直接
 * 限流（实测并发 >10 就大面积 429），而且 CF Worker 的并发子请求也有限。
 * 这里是 6 路并发 + 单标的失败不影响其余（失败如实上报，不静默丢弃）。 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cur = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cur++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { err: String(e.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

const UNIV_CACHE_PREFIX = 'https://nexus-cache.internal/universe-v1/';
const UNIV_TTL = 21600;          // 6 小时：日频数据，一天最多真正回源两次
const UNIV_MIN_RETRY = 900;      // 失败退避 15 分钟
const UNIV_CONCURRENCY = 3;
/* 【实测教训】一开始用「3 个分类 × 6 并发 = 18 路同时打 Yahoo」，结果 10 个分类里
 * 9 个全军覆没（返回 502）—— Yahoo 对 Cloudflare 的出口 IP 限流非常凶，
 * 并发一大就是整批 429/404，而不是零星失败。改成「分类串行 + 类内 3 并发 +
 * 每个标的之间 120ms 间隔」之后才稳定拿到数据。
 * 慢一点没关系：结果是 6 小时边缘缓存，一天最多真正回源两次。 */
const UNIV_GAP_MS = 120;

async function fetchUniverseCat(cat) {
  const spec = UNIVERSE[cat];
  if (!spec) return null;
  const cache = caches.default;
  const dataKey = new Request(UNIV_CACHE_PREFIX + cat + '.data');
  const metaKey = new Request(UNIV_CACHE_PREFIX + cat + '.meta');
  const [hit, meta] = await Promise.all([cache.match(dataKey), cache.match(metaKey)]);
  let lastTry = 0;
  if (meta) { try { lastTry = (await meta.json()).t || 0; } catch (e) { } }
  const ageSec = (Date.now() - lastTry) / 1000;
  const wrap = (body, src, code) => new Response(body, { status: code || 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800', 'X-Universe-Source': src } });

  /* 命中缓存且未到退避窗口 → 直接吃缓存。
   * 与 /api/history 同一套路：失败时限流退避，别把源打死。 */
  if (hit && ageSec < UNIV_MIN_RETRY) return wrap(await hit.text(), 'edge-cache');

  const keys = Object.keys(spec);
  let lastAt = 0;
  const res = await mapPool(keys, UNIV_CONCURRENCY, async (k) => {
    const sym = spec[k][0];
    try {
      /* 节流：同一时刻最多 3 个在飞，且相邻发起间隔 >= UNIV_GAP_MS */
      const wait = UNIV_GAP_MS - (Date.now() - lastAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastAt = Date.now();
      const d = await fetchYahoo(sym, '10y');
      if (!d.closes || d.closes.length < 60) throw new Error('too short');
      return { k: k, ok: true, ts: d.ts, closes: d.closes };
    } catch (e) {
      /* 主源失败 → stooq 兜底只对少数有等价符号的标的适用，这里直接记失败。
       * 诚实上报比拿一条造出来的序列充数重要得多。 */
      return { k: k, ok: false, err: String(e.message || e) };
    }
  });

  const series = {}, ok = [], fail = {};
  let okN = 0;
  res.forEach(function (r) {
    if (r && r.ok) { series[r.k] = { ts: r.ts, closes: r.closes }; ok.push(r.k); okN++; }
    else fail[r.k] = (r && r.err) || 'unknown';
  });
  const payload = JSON.stringify({ cat: cat, series: series, ok: ok, fail: fail, n: keys.length, nOk: okN, ts: Date.now() });
  /* 只要拿到一半以上就长缓存；否则短缓存，尽快重试 */
  const good = okN >= Math.ceil(keys.length * 0.5);
  const ttl = good ? UNIV_TTL : 600;
  await cache.put(dataKey, new Response(payload, { headers: { 'Cache-Control': `public, max-age=${ttl}` } }));
  await cache.put(metaKey, new Response(JSON.stringify({ t: Date.now(), ok: good }), { headers: { 'Cache-Control': `public, max-age=${ttl}` } }));
  /* 全军覆没且无缓存 → 明确报错，不要返回一个空的 series 假装成功 */
  if (!okN && !hit) return jsonResp({ error: 'universe ' + cat + ' all failed', cat: cat, fail: fail, ts: Date.now() }, 502);
  if (!okN && hit) return wrap(await hit.text(), 'stale');
  return wrap(payload, 'live');
}

async function universeMeta() {
  const out = { cats: {}, exo: UNIVERSE_EXO, total: 0 };
  UNIVERSE_CATS.forEach(function (c) {
    const spec = UNIVERSE[c];
    out.cats[c] = { n: Object.keys(spec).length, exo: !!UNIVERSE_EXO[c], items: Object.keys(spec).map(function (k) { return { key: k, sym: spec[k][0], name: spec[k][1] }; }) };
    out.total += Object.keys(spec).length;
  });
  return out;
}

const PROBE_URLS = [
  // —— 经济日历备用源（FF JSON 会 429 限流）——
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
  'https://www.forexfactory.com/calendar?week=this',
  // —— 对照 ——
  'https://query1.finance.yahoo.com/v8/finance/chart/JPY=X?range=1y&interval=1d',
  'https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/api/probe') {
      const out = {};
      await Promise.all(PROBE_URLS.map(async (u) => {
        const key = u.replace(/^https:\/\//, '').slice(0, 72);
        try {
          const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)' } });
          const t = await r.text();
          out[key] = { status: r.status, len: t.length, head: t.slice(0, 200).replace(/\s+/g, ' '), tail: t.slice(-200).replace(/\s+/g, ' ') };
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
          resp = jsonResp(data, 200, { 'Cache-Control': 'public, max-age=900' });
          const core = ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX'];
          if (core.every(k => data.macro[k] != null)) await cache.put(cacheKey, resp.clone());
        } catch (e) { resp = jsonResp({ error: e.message }, 502); }
      }
      return resp;
    }

    if (url.pathname === '/api/global') {
      try { return await globalWithFallback(); }
      catch (e) { return jsonResp({ error: e.message, mcap: null, btcD: null, ts: Date.now() }, 502); }
    }

    if (url.pathname === '/api/history') {
      try { return await historyWithFallback(); }
      catch (e) { return jsonResp({ error: e.message, ts: Date.now() }, 502); }
    }

    /* v3.25 因子宇宙：/api/universe?cat=fx,commodity 或 cat=meta 或 cat=all */
    if (url.pathname === '/api/universe') {
      try {
        const raw = (url.searchParams.get('cat') || 'all').trim();
        if (raw === 'meta') return jsonResp({ ...universeMeta(), ts: Date.now() }, 200, { 'Cache-Control': 'public, max-age=86400' });
        const cats = raw === 'all' ? UNIVERSE_CATS : raw.split(',').map(x => x.trim()).filter(x => UNIVERSE[x]);
        if (!cats.length) return jsonResp({ error: 'unknown cat: ' + raw, cats: UNIVERSE_CATS }, 400);
        /* 分类之间必须串行 —— 见 UNIV_CONCURRENCY 处的实测注释 */
        const parts = await mapPool(cats, 1, async (c) => {
          const r = await fetchUniverseCat(c);
          const j = await r.json();
          return { cat: c, src: r.headers.get('X-Universe-Source') || 'live', ...j };
        });
        const series = {}, fails = {}, srcs = {};
        /* keyCat / names 一并下发：前端要靠它做「外生排外围」的布环，
         * 再发一次 meta 请求纯属浪费（且两份数据可能来自不同缓存快照而不一致）。 */
        const keyCat = {}, names = {};
        let nOk = 0, nTot = 0;
        parts.forEach(function (p) {
          Object.keys(p.series || {}).forEach(k => { series[k] = p.series[k]; });
          if (p.fail && Object.keys(p.fail).length) fails[p.cat] = p.fail;
          srcs[p.cat] = p.src;
          const spec = UNIVERSE[p.cat] || {};
          Object.keys(spec).forEach(k => { keyCat[k] = p.cat; names[k] = spec[k][1]; });
          nOk += p.nOk || 0; nTot += p.n || 0;
        });
        return jsonResp({ series: series, ok: Object.keys(series), fail: fails, srcs: srcs,
          keyCat: keyCat, names: names,
          n: nTot, nOk: nOk, cats: cats, exo: UNIVERSE_EXO, ts: Date.now() },
          200, { 'Cache-Control': 'public, max-age=1800' });
      } catch (e) { return jsonResp({ error: e.message, ts: Date.now() }, 502); }
    }

    if (url.pathname === '/api/dvol') {
      try {
        if (url.searchParams.get('series')) {
          // v3.15: 回测用——返回 DVOL 完整历史序列（ts/closes），供本地 walk-forward 防御回测
          const drb = await deribitWithCache();
          if (!drb || !drb.DVOL || !drb.DVOL.closes || drb.DVOL.closes.length < 2)
            return jsonResp({ error: 'dvol series unavailable (cooldown or fail)' }, 502);
          return jsonResp({ ts: drb.DVOL.ts, closes: drb.DVOL.closes, src: 'deribit:dvol' }, 200, { 'Cache-Control': 'public, max-age=300' });
        }
        const s = await dvolStat();
        if (!s) return jsonResp({ error: 'dvol unavailable (cooldown or fail)' }, 502);
        return jsonResp(s, 200, { 'Cache-Control': 'public, max-age=300' });
      } catch (e) { return jsonResp({ error: e.message }, 502); }
    }

    if (url.pathname === '/api/calendar') {
      try { return await calendarWithFallback(); }
      catch (e) { return jsonResp({ error: e.message, events: [], ts: Date.now() }, 502); }
    }

    if (url.pathname === '/api/fetch') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('missing url param', { status: 400, headers: CORS });
      const cacheTtl = /api\.coingecko\.com|stablecoins\.llama\.fi|api\.blockchain\.info|nfs\.faireconomy\.media/.test(target) ? 600 : 0;
      try { return await proxyFetch(target, cacheTtl); }
      catch (e) { return jsonResp({ error: e.message }, 502); }
    }

    /* v3.30 护栏 RED 通知：前端把告警文本发到这里，Worker 转发到群机器人 Webhook。
     * Webhook URL 与校验 TOKEN 存于 env（wrangler secret），不进源码；
     * 按 host 自动识别企业微信 / 飞书 / 钉钉 / 自建 的 payload 格式。 */
    if (url.pathname === '/api/notify') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS });
      try {
        const webhook = env.NOTIFY_WEBHOOK;
        const tok = env.NOTIFY_TOKEN || '';
        if (!webhook) return jsonResp({ ok: false, error: 'notify not configured' }, 503);
        const body = await request.json().catch(function () { return {}; });
        if (tok && body.token !== tok) return jsonResp({ ok: false, error: 'bad token' }, 403);
        const text = String(body.text || '').slice(0, 2000);
        if (!text) return jsonResp({ ok: false, error: 'empty text' }, 400);
        let host = '';
        try { host = new URL(webhook).hostname; } catch (e) {}
        let payload;
        if (host.indexOf('qyapi.weixin.qq.com') >= 0) payload = { msgtype: 'text', text: { content: text } };
        else if (host.indexOf('open.feishu.cn') >= 0 || host.indexOf('larksuite.com') >= 0) payload = { msg_type: 'text', content: { text: text } };
        else if (host.indexOf('oapi.dingtalk.com') >= 0) payload = { msgtype: 'text', text: { content: text } };
        else payload = { text: text };
        const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const rt = await r.text();
        return jsonResp({ ok: r.ok, upstream: r.status, len: rt.length }, r.ok ? 200 : 502);
      } catch (e) { return jsonResp({ ok: false, error: e.message }, 502); }
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResp({ name: 'nexus-proxy', version: '3.31', status: 'ok', source: 'yahoo+stooq+nyfed+treasury+mof+coinlore+finforexfactory+bitcoin-data+bybit+deribit+proxy', universe: Object.keys(UNIVERSE).reduce(function(a,c){return a+Object.keys(UNIVERSE[c]).length;},0), symbols: Object.keys(SIMPLE).concat(['EFFR', 'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10', 'JGB10Y', 'DVOL', 'DVHV']) });
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
