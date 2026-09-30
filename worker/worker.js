/* =====================================================================
 * NEXUS PROXY — Cloudflare Worker
 * 服务端抓取宏观日线（Stooq 为主，Yahoo 兜底），边缘缓存，输出
 * CORS 友好的 /api/snapshot，供前端「宏观仪表盘」与「因子关系网络」使用。
 *
 * 数据源说明:
 *   - Stooq  (stooq.com) 免费、无需密钥、跨域友好，作为主源；
 *   - Yahoo Finance 作为兜底（query1/query2 双 host），任一可用即可。
 *   两者都失败才返回 null，前端对应卡片显示「—」，不影响其余功能。
 *
 * 部署:
 *   npm i -g wrangler        # 或 npx wrangler
 *   wrangler login
 *   wrangler deploy          # 读取同目录 wrangler.toml
 *
 * 部署后把前端 app.js 顶部的 CONFIG.PROXY 改成你的 Worker 地址，例如:
 *   const CONFIG = { PROXY: 'https://nexus-api.uichain.org', ... }
 * ===================================================================== */

// Stooq 符号（主源）
const STOOQ = {
  DXY: '^dxy',    // 美元指数
  US10Y: 'us10y', // 美债10年收益率 (%)
  GOLD: 'xauusd', // 黄金 (USD/oz)
  SPX: '^spx',    // 标普500
  VIX: '^vix',    // 恐慌指数
};

// Yahoo 符号（兜底源）
const YAHOO = {
  DXY: 'DX-Y.NYB',
  US10Y: '^TNX',
  GOLD: 'GC=F',
  SPX: '^GSPC',
  VIX: '^VIX',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=300',
};

// 通用代理白名单：仅允许这些主机，避免变成开放代理（被滥用）
const PROXY_ALLOW = [
  'api.bybit.com',        // 行情 / K线 / 资金费率 / 持仓 / 多空比
  'api.coinpaprika.com',  // 全球市值 / BTC 占比（主源，CF 边缘可用性好）
  'api.coingecko.com',    // 全球市值 / BTC 占比（备用源，限速，Worker 侧缓存 10min）
  'api.alternative.me',   // 恐惧贪婪指数
  'mempool.space',        // 比特币算力
];

// 代理任意白名单主机的请求，回传时带上 CORS 头。
// 浏览器只与本 Worker 通信（同源 Cloudflare），由 Worker 从边缘节点抓取
// 被墙/无 CORS 的数据源（Bybit/CoinGecko/alternative.me/mempool 等）。
// cacheTtl>0 时对响应做边缘缓存：CoinGecko 等限流严格的源，靠缓存把请求
// 频率压到很低（CF 边缘出口 IP 被多家数据商共享限流，缓存是关键）。
async function proxyFetch(target, cacheTtl) {
  let u;
  try { u = new URL(target); } catch { throw new Error('invalid url'); }
  if (!PROXY_ALLOW.includes(u.hostname)) throw new Error('host not allowed: ' + u.hostname);
  const cacheKey = new Request(u.toString());
  if (cacheTtl > 0) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  }
  const r = await fetch(u.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.1)',
      'Accept': 'application/json, text/plain, */*',
    },
  });
  const body = await r.text();
  const resp = new Response(body, {
    status: r.status,
    headers: {
      ...CORS,
      'Content-Type': r.headers.get('content-type') || 'application/json',
      'Cache-Control': cacheTtl > 0 ? `public, max-age=${cacheTtl}` : 'no-store',
    },
  });
  if (cacheTtl > 0 && r.ok) await caches.default.put(cacheKey, resp.clone());
  return resp;
}

// 主源：Stooq 免费日线 CSV（无需密钥）
async function fetchStooq(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.1)' },
  });
  if (!r.ok) throw new Error('stooq ' + r.status);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  // Stooq 找不到符号或限流时会返回 HTML/错误页，首行不是 Date
  if (lines.length < 2 || !/^Date/i.test(lines[0])) {
    throw new Error('stooq unexpected: ' + (lines[0] || '').slice(0, 40));
  }
  const data = lines.slice(1)
    .map(l => l.split(','))
    .map(r => ({ t: Date.parse(r[0]), c: parseFloat(r[4]) })) // Close 在第 5 列
    .filter(d => !isNaN(d.t) && !isNaN(d.c))
    .sort((a, b) => a.t - b.t); // 兼容 Stooq 正/逆序，统一按日期升序
  if (!data.length) throw new Error('stooq nodata ' + symbol);
  const closes = data.map(d => d.c);
  return { closes, last: closes[closes.length - 1] };
}

// 兜底源：Yahoo Finance（query1 常被限流，query2 兜底）
async function fetchYahoo(symbol) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      if (!r.ok) throw new Error('yahoo ' + r.status);
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error('no result');
      const closes = (res.indicators.quote[0].close || []).filter(v => v != null);
      if (!closes.length) throw new Error('empty');
      return { closes, last: closes[closes.length - 1] };
    } catch (e) { lastErr = e; console.warn('fetchYahoo fail', host, symbol, e.message); }
  }
  throw lastErr || new Error('yahoo failed ' + symbol);
}

async function fetchSeries(key) {
  // Stooq 为主，失败回落 Yahoo
  try {
    return await fetchStooq(STOOQ[key]);
  } catch (e) {
    console.warn('stooq primary failed, fallback yahoo', key, e.message);
    return await fetchYahoo(YAHOO[key]);
  }
}

async function buildSnapshot() {
  const macro = {}; const series = {};
  await Promise.all(Object.keys(STOOQ).map(async (key) => {
    try {
      const s = await fetchSeries(key);
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

    // 通用数据代理：前端所有外部请求（Bybit/CoinGecko/alternative.me/mempool）
    // 都经此转发，解决中国大陆无法直连 + 浏览器 CORS 问题。
    if (url.pathname === '/api/fetch') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('missing url param', { status: 400, headers: CORS });
      // CoinGecko 限流严格（CF 边缘出口 IP 被共享限流），缓存 10 分钟
      const cacheTtl = /api\.coingecko\.com/.test(target) ? 600 : 0;
      try {
        return await proxyFetch(target, cacheTtl);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ name: 'nexus-proxy', status: 'ok', source: 'stooq+yahoo+proxy', symbols: Object.keys(STOOQ) }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
