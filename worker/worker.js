/* =====================================================================
 * NEXUS PROXY — Cloudflare Worker  v3.6
 * 服务端数据聚合 + 通用代理，带边缘缓存，输出 CORS 友好的 API。
 *
 * 出口:
 *   /api/snapshot  宏观 / 政策 / 通胀 / 大宗 / 日元 序列（含日期 + 数据源诊断）
 *   /api/calendar  美国经济日历（非农 / 失业率 / 初请 / PCE / CPI / FOMC）
 *   /api/fetch     白名单代理（浏览器所有外部请求经此，绕 GFW + CORS）
 *   /health        健康检查
 *   /api/probe     数据源可达性诊断
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
 *       /api/calendar 与 /api/global 均采用「成功长缓存 + 失败退避 + 陈旧兜底」，日历并对 XML 端点做自动降级，
 *       避免被限流后持续重试导致「锁死」。
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
async function fetchJGB() {
  const rows = [];
  const push = txt => txt.split(/\r?\n/).forEach(l => { const p = parseJgbLine(l); if (p) rows.push(p); });
  // 完整历史大文件（1.2MB）边缘缓存 6 小时；当月小文件（2KB）实时取，取最新几天
  const [hist, mon] = await Promise.allSettled([
    fetchJgbCsv(JGB_URL_ALL, 21600),
    fetchJgbCsv(JGB_URL_MONTH, 0),
  ]);
  if (hist.status === 'fulfilled') push(hist.value);
  if (mon.status === 'fulfilled') push(mon.value);
  const map = new Map(); rows.forEach(r => map.set(r.t, r.c));
  const ts = [...map.keys()].sort((a, b) => a - b);
  if (ts.length < 60) throw new Error('jgb insufficient (' + ts.length + ')');
  const keep = 900;   // 约 3.5 年日频
  const kt = ts.slice(-keep);
  return { ts: kt, closes: kt.map(t => map.get(t)) };
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
const CAL_DATA_KEY = 'https://nexus-cache.internal/calendar-v1';
const CAL_META_KEY = 'https://nexus-cache.internal/calendar-meta-v1';
const CAL_TTL = 21600;        // 成功结果在缓存里保留 6 小时
const CAL_MIN_RETRY = 1800;   // 距上次尝试不足 30 分钟 → 不再打 FF（退避）

/* 把 FF 的 XML 日历也解析成同一结构（JSON 端点 429 时的备用出口） */
function parseFfXml(text) {
  const out = [];
  const blocks = text.split(/<event>/i).slice(1);
  const get = (b, tag) => { const m = b.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i')); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
  blocks.forEach(b => {
    const country = get(b, 'country');
    const title = get(b, 'title');
    if (country !== 'USD' || !title) return;
    out.push({ t: get(b, 'date'), title, impact: get(b, 'impact'), f: get(b, 'forecast'), p: get(b, 'previous'), a: get(b, 'actual') });
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
          .map(e => ({ t: e.date, title: e.title, impact: e.impact || '', f: e.forecast || '', p: e.previous || '', a: e.actual || '' }))
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

  if (hit && ageSec < CAL_MIN_RETRY) return wrap(await hit.text(), 'edge-cache');
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

  const [effr, nom, real, jgb] = await Promise.allSettled([fetchEFFR(), fetchTreasuryNominal(), fetchTreasuryReal(), fetchJGB()]);
  if (effr.status === 'fulfilled') put('EFFR', effr.value, 'nyfed'); else { put('EFFR', null); console.warn('effr fail'); }
  if (jgb.status === 'fulfilled') put('JGB10Y', jgb.value, 'mof'); else { put('JGB10Y', null); console.warn('jgb fail', jgb.reason && jgb.reason.message); }

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

    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResp({ name: 'nexus-proxy', version: '3.7', status: 'ok', source: 'yahoo+stooq+nyfed+treasury+mof+coinlore+finforexfactory+proxy', symbols: Object.keys(SIMPLE).concat(['EFFR', 'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10', 'JGB10Y']) });
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
