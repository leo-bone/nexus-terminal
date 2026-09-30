var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var STOOQ = {
  DXY: "^dxy",
  // 美元指数
  US10Y: "us10y",
  // 美债10年收益率 (%)
  GOLD: "xauusd",
  // 黄金 (USD/oz)
  SPX: "^spx",
  // 标普500
  VIX: "^vix"
  // 恐慌指数
};
var YAHOO = {
  DXY: "DX-Y.NYB",
  US10Y: "^TNX",
  GOLD: "GC=F",
  SPX: "^GSPC",
  VIX: "^VIX"
};
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=300"
};
async function fetchStooq(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NexusTerminal/3.1)" }
  });
  if (!r.ok) throw new Error("stooq " + r.status);
  const text = await r.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^Date/i.test(lines[0])) {
    throw new Error("stooq unexpected: " + (lines[0] || "").slice(0, 40));
  }
  const data = lines.slice(1).map((l) => l.split(",")).map((r2) => ({ t: Date.parse(r2[0]), c: parseFloat(r2[4]) })).filter((d) => !isNaN(d.t) && !isNaN(d.c)).sort((a, b) => a.t - b.t);
  if (!data.length) throw new Error("stooq nodata " + symbol);
  const closes = data.map((d) => d.c);
  return { closes, last: closes[closes.length - 1] };
}
__name(fetchStooq, "fetchStooq");
async function fetchYahoo(symbol) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastErr;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept": "application/json"
        }
      });
      if (!r.ok) throw new Error("yahoo " + r.status);
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error("no result");
      const closes = (res.indicators.quote[0].close || []).filter((v) => v != null);
      if (!closes.length) throw new Error("empty");
      return { closes, last: closes[closes.length - 1] };
    } catch (e) {
      lastErr = e;
      console.warn("fetchYahoo fail", host, symbol, e.message);
    }
  }
  throw lastErr || new Error("yahoo failed " + symbol);
}
__name(fetchYahoo, "fetchYahoo");
async function fetchSeries(key) {
  try {
    return await fetchStooq(STOOQ[key]);
  } catch (e) {
    console.warn("stooq primary failed, fallback yahoo", key, e.message);
    return await fetchYahoo(YAHOO[key]);
  }
}
__name(fetchSeries, "fetchSeries");
async function buildSnapshot() {
  const macro = {};
  const series = {};
  await Promise.all(Object.keys(STOOQ).map(async (key) => {
    try {
      const s = await fetchSeries(key);
      macro[key] = s.last;
      series[key] = s.closes;
    } catch (e) {
      macro[key] = null;
      series[key] = [];
      console.warn("fetchSeries fail", key, e.message);
    }
  }));
  const prev = {};
  Object.keys(series).forEach((k) => {
    const a = series[k];
    if (a && a.length >= 2) prev[k] = a[a.length - 2];
  });
  return { macro, series, _prev: prev, ts: Date.now() };
}
__name(buildSnapshot, "buildSnapshot");
var worker_default = {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/api/snapshot") {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      let resp = await cache.match(cacheKey);
      if (!resp) {
        try {
          const data = await buildSnapshot();
          resp = new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
          if (Object.values(data.macro).every((v) => v != null)) await cache.put(cacheKey, resp.clone());
        } catch (e) {
          resp = new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }
      return resp;
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ name: "nexus-proxy", status: "ok", source: "stooq+yahoo", symbols: Object.keys(STOOQ) }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return new Response("Not Found", { status: 404, headers: CORS });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
