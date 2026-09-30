/* =====================================================================
 * NEXUS PROXY — Cloudflare Worker
 * 服务端抓取宏观日线（Yahoo Finance），边缘缓存，输出 CORS 友好的
 * /api/snapshot，供前端「宏观仪表盘」与「因子关系网络」使用。
 *
 * 部署:
 *   npm i -g wrangler        # 或 npx wrangler
 *   wrangler login
 *   wrangler deploy          # 读取同目录 wrangler.toml
 *
 * 部署后把前端 app.js 顶部的 CONFIG.PROXY 改成你的 Worker 地址，例如:
 *   const CONFIG = { PROXY: 'https://nexus-proxy.<你的子域>.workers.dev', ... }
 * ===================================================================== */

const SYMBOLS = {
  DXY: 'DX-Y.NYB',   // 美元指数
  US10Y: '^TNX',     // 美债10年收益率 (%)
  GOLD: 'GC=F',      // 黄金 (USD/oz)
  SPX: '^GSPC',      // 标普500
  VIX: '^VIX',       // 恐慌指数
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300',
};

async function fetchSeries(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'NexusTerminal/3.0' } });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('no result');
  const closes = (res.indicators.quote[0].close || []).filter(v => v != null);
  const last = closes[closes.length - 1];
  return { closes, last };
}

async function buildSnapshot() {
  const macro = {}; const series = {};
  await Promise.all(Object.entries(SYMBOLS).map(async ([key, sym]) => {
    try {
      const s = await fetchSeries(sym);
      macro[key] = s.last;
      series[key] = s.closes;
    } catch (e) {
      macro[key] = null; series[key] = [];
      console.warn('fetchSeries fail', key, e.message);
    }
  }));
  // 保存上一时刻用于日变动
  const prev = {};
  Object.keys(series).forEach(k => { const a = series[k]; if (a && a.length >= 2) prev[k] = a[a.length - 2]; });
  return { macro, series, _prev: prev, ts: Date.now() };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/snapshot') {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      let resp = await cache.match(cacheKey);
      if (!resp) {
        try {
          const data = await buildSnapshot();
          resp = new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
          // 仅当数据完整再缓存，避免缓存半截错误
          if (Object.values(data.macro).every(v => v != null)) await cache.put(cacheKey, resp.clone());
        } catch (e) {
          resp = new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
        }
      }
      return resp;
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ name: 'nexus-proxy', status: 'ok', symbols: Object.keys(SYMBOLS) }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
