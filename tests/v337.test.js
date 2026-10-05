/* v3.37 修复验证：告警归因 + 回测稳健性 + 程序化 API（app.js 侧，vm 沙箱加载）
 * 运行：node tests/v337.test.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const N = 160, now = Date.now();
const days = (n, s) => Array.from({ length: n }, (_, i) => s + i * 86400000);
const series = (n, base, amp) => Array.from({ length: n }, (_, i) => base + Math.sin(i / 7) * amp + i * (amp / 50));
const ts = days(N, now - N * 86400000);

function makeKl() {
  const out = []; let p = 100;
  [[60, 1.02], [50, 0.98], [60, 1.02], [50, 0.98]].forEach(([len, mul]) => {
    for (let i = 0; i < len; i++) { const o = p; p = p * mul; out.push({ t: now + out.length * 3600000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 100 }); }
  });
  return out;
}
const KL = makeKl();

function payload(rawu) {
  const u = decodeURIComponent(String(rawu));
  if (u.includes('market/kline')) return { result: { list: [...KL].reverse().map(k => [k.t, k.o, k.h, k.l, k.c, k.v]) } };
  if (u.includes('market/tickers') && u.includes('category=spot'))
    return { result: { list: [{ lastPrice: '80000', price24hPcnt: '0.012', highPrice24h: '81000', lowPrice24h: '78000', turnover24h: '1234567' }] } };
  if (u.includes('market/tickers') && u.includes('category=linear')) return { result: { list: [{ fundingRate: '0.00012' }] } };
  if (u.includes('open-interest')) return { result: { list: Array.from({ length: 200 }, (_, i) => ({ openInterest: String(1000 + i * 3), timestamp: String(now - i * 86400000) })) } };
  if (u.includes('account-ratio')) return { result: { list: Array.from({ length: 200 }, (_, i) => ({ buyRatio: String(0.5 + Math.sin(i / 9) * 0.08), timestamp: String(now - i * 86400000) })) } };
  if (u.includes('/api/global')) return { mcap: 2.87e12, btcD: 58.4, ethD: 11.5, src: 'coinlore' };
  if (u.includes('coinpaprika')) return { market_cap_usd: 2.6e12, bitcoin_dominance_percentage: 57.3 };
  if (u.includes('stablecoins.llama.fi')) return { peggedAssets: [{ circulating: { peggedUSD: 1.8e11 } }] };
  if (u.includes('blockchain.info')) return { values: ts.map(t => ({ x: Math.floor(t / 1000), y: 600000 })) };
  if (u.includes('alternative.me')) return { data: Array.from({ length: 90 }, (_, i) => ({ value: '50', value_classification: 'Neutral', timestamp: String(Math.floor((now - i * 86400000) / 1000)) })) };
  if (u.includes('mempool.space')) return { hashrates: Array.from({ length: 365 }, (_, i) => ({ timestamp: now - i * 86400000, avgHashrate: 5e20 })) };
  if (u.includes('/api/snapshot')) {
    const keys = ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX', 'OIL', 'BRENT', 'AGRI', 'EFFR', 'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10', 'USDJPY', 'JGB10Y'];
    const base = { DXY: 101, US10Y: 5.2, GOLD: 4190, SPX: 7650, VIX: 16, OIL: 89, BRENT: 97, AGRI: 28, EFFR: 3.88, UST2Y: 4.88, T10Y2Y: 0.41, REAL10Y: 2.93, BEI10: 2.36, USDJPY: 158, JGB10Y: 3.06 };
    const S = {}, D = {}, M = {}, SRC = {};
    keys.forEach(k => { const n = k === 'EFFR' ? 300 : 160; S[k] = series(n, base[k], base[k] * 0.02); D[k] = ts.slice(-n); M[k] = S[k][S[k].length - 1]; SRC[k] = 'yahoo:TEST'; });
    return { macro: M, series: S, dates: D, _prev: M, _src: SRC, ts: now };
  }
  if (u.includes('/api/calendar')) return { ts: now, events: [] };
  throw new Error('unhandled url ' + u);
}

const reg = {};
const ctxStub = new Proxy({}, { get: () => () => {} });
function makeEl(id) {
  return {
    id, style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', className: '',
    width: 0, height: 0, clientWidth: 800, clientHeight: 400, value: '', options: [],
    _cls: new Set(),
    classList: { add(c) { this._o._cls.add(c); }, remove(c) { this._o._cls.delete(c); }, contains(c) { return this._o._cls.has(c); } },
    appendChild() {}, setAttribute() {}, getContext: () => ctxStub,
    addEventListener(ev, fn) { (this._h = this._h || {}), (this._h[ev] = this._h[ev] || []).push(fn); },
  };
}
const $id = id => (reg[id] || (reg[id] = (() => { const e = makeEl(id); e.classList._o = e; return e; })()));
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0,
  requestAnimationFrame: () => {}, devicePixelRatio: 1,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
  document: { getElementById: $id, querySelectorAll: () => [], createElement: () => { const e = makeEl('x'); e.classList._o = e; return e; }, addEventListener() {} },
  window: { addEventListener() {}, devicePixelRatio: 1 },
  fetch: async (u) => ({ ok: true, json: async () => payload(String(u)) }),
  Math, Date, JSON, Number, isFinite, isNaN, parseFloat, encodeURIComponent, AbortController,
  Intl, Map, Set, Array, Object, String, Boolean, Error, Infinity, NaN,
};
sandbox.globalThis = sandbox;
const code = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'app.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
const run = expr => vm.runInContext(expr, sandbox);
const call = (expr, ...a) => vm.runInContext('(' + expr + ')', sandbox)(...a);

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra ? ' → ' + extra : '')); } }

/* ---- 1. stabilityOf：纯函数 ---- */
ok('stabilityOf 全正=1', Math.abs(call('stabilityOf', [0.01, 0.02, 0.03]) - 1) < 1e-9);
ok('stabilityOf 半正=0.5', Math.abs(call('stabilityOf', [0.01, -0.02, 0.03, -0.04]) - 0.5) < 1e-9);
ok('stabilityOf 空=0', call('stabilityOf', []) === 0);

/* ---- 2. buildAlertPayload：结构化归因（依赖 computeNexusScore + regimeConfidence，纯本地） ---- */
const st = run('state');
st.alert = st.alert || { enabled: true, cloudSync: false, lastTs: 0 };
const G = { ready: true, status: 2, dvolLevel: 2, regimeLevel: 1, accelLevel: 0, nCrash: 1, nAccel: 0, firing: [] };
const p = call('buildAlertPayload', G);
ok('buildAlertPayload 返回 score(2~98)', p.score >= 2 && p.score <= 98, 'score=' + p.score);
ok('buildAlertPayload 返回置信等级', ['HIGH', 'MED', 'LOW'].includes(p.confidence), 'conf=' + p.confidence);
ok('buildAlertPayload 返回 Top 因子(≤4)', Array.isArray(p.topFactors) && p.topFactors.length > 0 && p.topFactors.length <= 4, 'n=' + (p.topFactors || []).length);
ok('buildAlertPayload 因子含 name/dir', p.topFactors[0] && typeof p.topFactors[0].name === 'string' && (p.topFactors[0].dir === 1 || p.topFactors[0].dir === -1));

/* ---- 3. pushAlertLog 透传 payload（不改本地告警契约） ---- */
const before = run('loadAlertLog().length');
call('pushAlertLog', 2, 'TEST', 'body', p);
const log = run('loadAlertLog()');
ok('pushAlertLog 写入且带 payload', log.length === before + 1 && log[log.length - 1].payload && log[log.length - 1].payload.score === p.score);

/* ---- 4. window.Nexus 扩展：guard / lastAlert / 版本 ---- */
ok('Nexus.version = 3.37', run("window.Nexus.version") === '3.37', 'v=' + run("window.Nexus.version"));
run('state').guardrail = G;
const gd = run('window.Nexus.guard()');
ok('Nexus.guard 返回 status=2', gd && gd.status === 2, 'guard=' + JSON.stringify(gd));
const la = run('window.Nexus.lastAlert()');
ok('Nexus.lastAlert 返回最近带 payload 的告警', la && la.score === p.score);
ok('Nexus.alertPayload 是函数', run('typeof window.Nexus.alertPayload === "function"'));

console.log('\n=== v3.37 app.js 侧：通过 ' + pass + ' / 失败 ' + fail + ' ===');
process.exit(fail ? 1 : 0);
