/* v3.38 Worker 侧验证：crypto 哨兵（纯函数 + 真实 fetch 路径）+ scheduled 合并宏观/crypto + 去重 + /api/guard-live
 * 运行：node tests/v338_worker.test.js
 * 在 vm 沙箱里加载 worker.js，用最小 CF 运行时桩 + 合成 deribit/bybit/FRED 数据跑核心逻辑。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8')
  .replace('export default {', 'globalThis.__w = {');

// ---- 合成数据生成 ----
function genDvol(n) {
  const data = []; const now = Date.UTC(2026, 8, 25); const day = 86400000;
  for (let i = 0; i < n; i++) {
    const base = 60 + 10 * Math.sin(i / 20);
    // 末 10 根飙升 30%（制造 z60 高 + 加速度）
    const c = i >= n - 10 ? base * (1 + 0.03 * (i - (n - 10))) : base;
    data.push([now - (n - i) * day, base, c + 2, c - 2, c]);
  }
  return JSON.stringify({ result: { data } });
}
function genPremium(n) {
  const list = []; const now = Date.UTC(2026, 8, 25); const day = 86400000;
  for (let i = 0; i < n; i++) {
    const p = i < n - 12 ? 70000 - i : 70000 - (i - (n - 12)) * 1800; // 末 12 根从 70000 跌到 ~48400（回撤 ~31%）
    list.push([now - (n - i) * day, p, p, p, p]);
  }
  return JSON.stringify({ retCode: 0, result: { list } });
}
function genOI(n) {
  const list = []; const now = Date.UTC(2026, 8, 25); const day = 86400000;
  for (let i = 0; i < n; i++) list.push([now - (n - i) * day, 100000 + i * 10]);
  return JSON.stringify({ retCode: 0, result: { list } });
}
/* v3.40：BTC **现货价格**日 K（真实价格量级 ~7 万，末段崩盘 → 回撤 ~47%、动量大幅为负）。
 * 行格式同 bybit 现货 kline = [ts, open, high, low, close, volume, turnover]，取 close(x[4])。
 * 这是 crypto 哨兵回撤/动量的正确数据源（旧版误用 premium 基差）。 */
function genSpot(n) {
  const list = []; const now = Date.UTC(2026, 8, 25); const day = 86400000;
  for (let i = 0; i < n; i++) {
    const p = i < n - 20 ? 70000 + (i % 7) * 10 : 70000 - (i - (n - 20)) * 1750;
    list.push([now - (n - i) * day, p, p, p, p, 1, 1]);
  }
  return JSON.stringify({ retCode: 0, result: { list } });
}
const FRED = {
  UNRATE: '2026-08-01,4.1\n2026-09-01,4.4', CPIAUCSL: '2026-07-01,330\n2026-08-01,333',
  PAYEMS: '2026-08-01,159000\n2026-09-01,158900', ICSA: '2026-09-19,190000\n2026-09-26,220000',
  PCEPILFE: '2026-07-01,130.0\n2026-08-01,130.6',
};

function Resp(body, opts) {
  opts = opts || {}; const status = opts.status || 200;
  return { status, ok: status >= 200 && status < 300, headers: { get: () => opts.headers && opts.headers['Content-Type'] }, body,
    async text() { return typeof body === 'string' ? body : ''; }, async json() { return typeof body === 'string' ? JSON.parse(body) : body; } };
}
class ReqStub { constructor(u) { this.url = u; } }
class UrlStub { constructor(u) { const m = /^(https?:\/\/[^/]+)(\/[^?]*)?(\?.*)?$/.exec(u); this.hostname = m ? m[1].replace(/^https?:\/\//, '') : 'x'; this.pathname = m && m[2] ? m[2] : '/'; this.searchParams = { get: () => null }; } }
const kvMock = { _m: {}, async get(k) { return this._m[k] ? JSON.parse(this._m[k]) : null; }, async put(k, v) { this._m[k] = v; return true; } };

// ---- fetch 路由：deribit / bybit(premium|oi) / fred ----
const sandbox = {
  console, Math, Date, JSON, Number, isFinite, isNaN, parseFloat, parseInt, encodeURIComponent, Promise, Array, Object, String, Boolean,
  URL: UrlStub, Request: ReqStub, Response: Resp,
  caches: { default: { match: () => null, put: () => {} } },
  fetch: async (u) => {
    const s = String(u);
    if (s.indexOf('deribit.com') >= 0) return Resp(genDvol(400));
    if (s.indexOf('premium-index') >= 0) return Resp(genPremium(420));
    if (s.indexOf('open-interest') >= 0) return Resp(genOI(400));
    if (s.indexOf('category=spot') >= 0) return Resp(genSpot(200));
    const id = (s.split('id=')[1] || 'X').split('&')[0];
    return Resp(FRED[id] || '2026-08-01,1\n2026-09-01,1');
  },
  Headers: class { get() { return null; } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'worker.js' });
const W = sandbox.__w;

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra ? ' → ' + extra : '')); } }

/* ---- 1. computeCryptoSentinel 纯函数：RED（现货价格末段崩盘 → 回撤+动量双触发） ---- */
const red = W.computeCryptoSentinel({ z60: 2.5, pctTrailing1y: 0.95 }, 0.30, { closes: Array.from({ length: 40 }, (_, i) => i < 30 ? 70000 : 70000 - (i - 30) * 2500) }, 1700000000000);
ok('crypto RED：status=2', red && red.status === 2, 'status=' + (red && red.status));
ok('crypto RED：含 DVOL 分量', red && red.drivers.some(d => d.id === 'DVOL'));
ok('crypto RED：含 BTC_DD 分量', red && red.drivers.some(d => d.id === 'BTC_DD'));
ok('crypto RED：含 ACCEL 分量', red && red.drivers.some(d => d.id === 'ACCEL'));
ok('crypto RED：btcDD 合法比例∈[0,1]', red && red.btcDD >= 0 && red.btcDD <= 1, 'btcDD=' + (red && red.btcDD));

/* ---- 2. computeCryptoSentinel 纯函数：GREEN（现货横盘） ---- */
const green = W.computeCryptoSentinel({ z60: 0.4, pctTrailing1y: 0.5 }, 0.02, { closes: Array.from({ length: 40 }, () => 60000) }, 1700000000000);
ok('crypto GREEN：status=0', green && green.status === 0, 'status=' + (green && green.status));

/* ---- 2b. 回归：premium 基差（负值离群）不再被当作价格算回撤（旧版会得 3188% 假值） ---- */
const basisGuard = W.computeCryptoSentinel({ z60: 0.1, pctTrailing1y: 0.5 }, 0, { closes: Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -0.0004 : 0.00002)) }, 1700000000000);
ok('基差序列不会造出离谱回撤（btcDD<=1）', basisGuard && basisGuard.btcDD <= 1, 'btcDD=' + (basisGuard && basisGuard.btcDD));

/* ---- 3. cryptoSentinel 真实 fetch 路径（合成 deribit/bybit） ---- */
(async () => {
  const c = await W.cryptoSentinel();
  ok('cryptoSentinel 真实路径返回对象', c && typeof c.status === 'number', JSON.stringify(c && c.status));
  ok('cryptoSentinel 真实路径 status=2（合成数据含飙升+回撤）', c && c.status === 2, 'status=' + (c && c.status) + ' dd=' + (c && c.btcDD && (c.btcDD * 100).toFixed(0)) + '%');

  /* ---- 4. scheduled 合并宏观+crypto（宏观 stub 为绿，crypto 真实/红） ---- */
  W.computeMacroSentinel = () => ({ status: 0, score: 0, drivers: [], asof: '2026-09-01' });
  // crypto 走真实（上面已证 status=2）；重置 kv
  kvMock._m = {};
  await W.scheduled({}, { NEXUS_KV: kvMock });
  const guardLive = JSON.parse(kvMock._m['guard-live'] || 'null');
  ok('guard-live 合并：status=2（取 crypto）', guardLive && guardLive.status === 2, JSON.stringify(guardLive && guardLive.status));
  ok('guard-live 含 crypto 字段', guardLive && guardLive.crypto && guardLive.crypto.status === 2);
  ok('guard-live 含 macro 字段（status=0）', guardLive && guardLive.macro && guardLive.macro.status === 0);
  const alerts1 = JSON.parse(kvMock._m['guardrail-alerts'] || '[]');
  ok('crypto RED 追加 guardrail-alerts（src=server-crypto-sentinel）', Array.isArray(alerts1) && alerts1.length === 1 && alerts1[0].src === 'server-crypto-sentinel', 'n=' + (alerts1 ? alerts1.length : 0));

  /* ---- 5. 去重：6h 内再跑不发重复 ---- */
  await W.scheduled({}, { NEXUS_KV: kvMock });
  const alerts2 = JSON.parse(kvMock._m['guardrail-alerts'] || '[]');
  ok('6h 内重复运行不追加（去重生效）', alerts2.length === 1, 'n=' + alerts2.length);

  /* ---- 6. /api/guard-live 返回合并快照 ---- */
  const r = await W.fetch(new ReqStub('https://x/api/guard-live'), { NEXUS_KV: kvMock });
  const j = await r.json();
  ok('/api/guard-live 返回合并 guard', j.ok && j.guard && j.guard.status === 2 && j.guard.crypto, JSON.stringify(j && j.guard && j.guard.status));

  console.log('\n=== v3.38 worker 侧：通过 ' + pass + ' / 失败 ' + fail + ' ===');
  process.exit(fail ? 1 : 0);
})();
