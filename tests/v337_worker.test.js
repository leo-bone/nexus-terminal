/* v3.37 Worker 侧验证：宏观压力哨兵 + scheduled 写入 + /api/guard-live
 * 运行：node tests/v337_worker.test.js
 * 在 vm 沙箱里加载 worker.js（剥离 export default），用最小 CF 运行时桩跑核心逻辑。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8')
  .replace('export default {', 'globalThis.__w = {');

// ---- 最小 CF 运行时桩 ----
const csvFor = (id) => {
  const M = {
    UNRATE: '2026-08-01,4.1\n2026-09-01,4.4',          // mom +7.3% → 2
    CPIAUCSL: '2026-07-01,330\n2026-08-01,333',          // mom +0.91% → 2
    PAYEMS: '2026-08-01,159000\n2026-09-01,158900',       // -100k → 2
    ICSA: '2026-09-19,190000\n2026-09-26,220000',         // mom +15.8% → 2
    PCEPILFE: '2026-07-01,130.0\n2026-08-01,130.6',       // mom +0.46% → 2
  };
  return M[id] || '2026-08-01,1\n2026-09-01,1';
};
function Resp(body, opts) {
  opts = opts || {};
  const status = opts.status || 200;
  return { status, ok: status >= 200 && status < 300, headers: { get: () => opts.headers && opts.headers['Content-Type'] }, body,
    async text() { return typeof body === 'string' ? body : ''; }, async json() { return typeof body === 'string' ? JSON.parse(body) : body; } };
}
class ReqStub { constructor(u) { this.url = u; } }
class UrlStub { constructor(u) { const m = /^(https?:\/\/[^/]+)(\/[^?]*)?(\?.*)?$/.exec(u); this.hostname = m ? m[1].replace(/^https?:\/\//, '') : 'x'; this.pathname = m && m[2] ? m[2] : '/'; this.searchParams = { get: () => null }; } }

const kvMock = {
  _m: {},
  async get(k) { return this._m[k] ? JSON.parse(this._m[k]) : null; },
  async put(k, v) { this._m[k] = v; return true; },
};

const sandbox = {
  console,
  Math, Date, JSON, Number, isFinite, isNaN, parseFloat, parseInt, encodeURIComponent, Promise, Array, Object, String, Boolean,
  URL: UrlStub, Request: ReqStub, Response: Resp,
  caches: { default: { match: () => null, put: () => {} } },
  fetch: async (u) => Resp(csvFor(String(u).split('id=')[1] ? String(u).split('id=')[1].split('&')[0] : 'X')),
  Headers: class { get() { return null; } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'worker.js' });
const W = sandbox.__w;

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra ? ' → ' + extra : '')); } }

/* ---- 1. computeMacroSentinel 纯函数：RED 路径 ---- */
const red = W.computeMacroSentinel({
  UNRATE: { asof: '2026-09-01', v: 4.4, prev: 4.1 },
  CPIAUCSL: { asof: '2026-08-01', v: 333, prev: 330 },
  PAYEMS: { asof: '2026-09-01', v: 158900, prev: 159000 },
  ICSA: { asof: '2026-09-26', v: 220000, prev: 190000 },
  PCEPILFE: { asof: '2026-08-01', v: 130.6, prev: 130.0 },
});
ok('哨兵 RED：status=2', red.status === 2, 'status=' + red.status);
ok('哨兵 RED：score=10', red.score === 10, 'score=' + red.score);
ok('哨兵 RED：drivers 含 UNRATE', red.drivers.some(d => d.id === 'UNRATE'));

/* ---- 2. computeMacroSentinel 纯函数：GREEN 路径 ---- */
const green = W.computeMacroSentinel({
  UNRATE: { asof: '2026-09-01', v: 4.1, prev: 4.15 },
  CPIAUCSL: { asof: '2026-08-01', v: 330, prev: 329 },
  PAYEMS: { asof: '2026-09-01', v: 159100, prev: 159000 },
  ICSA: { asof: '2026-09-26', v: 190000, prev: 195000 },
  PCEPILFE: { asof: '2026-08-01', v: 130.0, prev: 129.9 },
});
ok('哨兵 GREEN：status=0', green.status === 0, 'status=' + green.status);

/* ---- 3. scheduled() 写入 KV：fred-live + guard-live + RED 追加 ---- */
(async () => {
  await W.scheduled({}, { NEXUS_KV: kvMock });
  const fredLive = JSON.parse(kvMock._m['fred-live'] || 'null');
  const guardLive = JSON.parse(kvMock._m['guard-live'] || 'null');
  const alerts = JSON.parse(kvMock._m['guardrail-alerts'] || '[]');
  ok('scheduled 写入 fred-live', !!fredLive && fredLive.series && fredLive.series.UNRATE, JSON.stringify(fredLive && Object.keys(fredLive)));
  ok('scheduled 写入 guard-live 且 status=2', guardLive && guardLive.status === 2, JSON.stringify(guardLive));
  ok('scheduled RED 追加到 guardrail-alerts', Array.isArray(alerts) && alerts.length === 1 && alerts[0].src === 'server-macro-sentinel', 'n=' + (alerts ? alerts.length : 0));

  /* ---- 4. /api/guard-live 端点读取快照 ---- */
  const r = await W.fetch(new ReqStub('https://x/api/guard-live'), { NEXUS_KV: kvMock });
  const j = await r.json();
  ok('/api/guard-live 返回 guard 快照', j.ok && j.guard && j.guard.status === 2, JSON.stringify(j));

  /* ---- 5. /api/guard-live 无 KV → 503 ---- */
  const r2 = await W.fetch(new ReqStub('https://x/api/guard-live'), {});
  ok('/api/guard-live 无 KV → 503', r2.status === 503, 'status=' + r2.status);

  console.log('\n=== v3.37 worker 侧：通过 ' + pass + ' / 失败 ' + fail + ' ===');
  process.exit(fail ? 1 : 0);
})();
