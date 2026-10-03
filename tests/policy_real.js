/* v3.23 真实十年数据实测：㉔ 仓位政策对比 / ㉕ 归因与回撤 / ㉖ 选择偏差 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctxStub = new Proxy({}, { get: () => () => {} });
const _reg = {};
const el = (id) => ({ _id: id,
  style: {}, classList: { add(){}, remove(){} }, dataset: {}, firstChild: null,
  appendChild(){}, setAttribute(){}, addEventListener(){}, getContext: () => ctxStub,
  innerHTML: '', textContent: '', title: '', className: '', width: 0, height: 0,
  clientWidth: 800, clientHeight: 400, options: [],
  get value(){ return 'BTC'; }, set value(v){}
});
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0,
  requestAnimationFrame: () => {}, devicePixelRatio: 1,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { getElementById: id => (_reg[id] || (_reg[id] = el(id))), querySelectorAll: () => [], createElement: () => el(), addEventListener(){} },
  window: { addEventListener(){}, devicePixelRatio: 1 },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  Math, Date, JSON, Number, isFinite, isNaN, parseFloat, encodeURIComponent, AbortController,
  Intl, Map, Set, Array, Object, String, Boolean, Error, Infinity, NaN,
};
sandbox.globalThis = sandbox;
const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
const ev = e => vm.runInContext(e, sandbox);
const call = (e, ...a) => vm.runInContext('(' + e + ')', sandbox)(...a);

const H = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/hist.json', 'utf8'));
const st = ev('state');
st.klines = {}; st.chainSeries = {}; st.macroSeries = {}; st.asof = null;
st.histBundle = H;

const t0 = Date.now();
const rep = ev('replayHistory')();
if (!rep) { console.log('REPLAY NULL'); process.exit(1); }
console.log('回放耗时 ' + (Date.now() - t0) + 'ms, 窗口 ' + (rep.n - rep.start) + ' 天');
const f = t => new Date(t).toISOString().slice(0, 10);
console.log('窗口 ' + f(rep.calTs[rep.start]) + ' → ' + f(rep.calTs[rep.n - 1]));

const P = (v, d) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(d == null ? 2 : d) + '%';
const N = (v, d) => v == null ? '—' : v.toFixed(d == null ? 2 : d);

/* ---------------- ㉔ 仓位政策对比 ---------------- */
let t1 = Date.now();
const C = call('policyCompare', rep);
console.log('\n===== ㉔ 仓位政策对比 =====  耗时 ' + (Date.now() - t1) + 'ms  (bootstrap B=' + C.B + ', L=' + C.L + ')');
const bh = C.bh.ev;
console.log('  基准 买入持有：净年化 ' + P(bh.netY, 1) + '  夏普 ' + N(bh.shN) + '  最大回撤 ' + P(-bh.ddN.mdd, 1) +
  '  Calmar ' + N(bh.calmarN) + '  水下占比 ' + (bh.ddN.uwShare * 100).toFixed(0) + '%');
console.log('  政策                 净年化    净夏普   Δ夏普    95%区间          P(赢)  最大回撤   日均换手');
for (const R of C.rows) {
  if (R.bench) continue;
  const E = R.ev, b = R.boot, d = E.shN - bh.shN;
  console.log('  ' + R.nm.padEnd(14) +
    P(E.netY, 1).padStart(9) + N(E.shN).padStart(9) + (d >= 0 ? '+' : '') + N(d).padStart(8) +
    ('[' + N(b.lo) + ', ' + N(b.hi) + ']').padStart(18) +
    ((b.pBeat * 100).toFixed(0) + '%').padStart(8) +
    P(-E.ddN.mdd, 1).padStart(10) + N(E.turnD, 4).padStart(10));
}

/* ---------------- ㉕ 归因与回撤 ---------------- */
console.log('\n===== ㉕ 收益归因（恒等式 E[w·r] = E[w]E[r] + Cov(w,r)）=====');
for (const R of C.rows) {
  if (R.bench) continue;
  const A = R.ev.attr;
  if (!A) continue;
  const chkId = Math.abs(A.total - (A.beta + A.timing));
  console.log('  ' + R.nm.padEnd(14) + ' 平均敞口 ' + N(A.meanW).padStart(6) +
    '  beta ' + P(A.betaY, 1).padStart(9) + '  timing ' + P(A.timingY, 1).padStart(9) +
    '  合计 ' + P(A.totalY, 1).padStart(9) +
    '  恒等式残差 ' + chkId.toExponential(1));
}
const P0 = C.rows.filter(r => r.id === 'linear')[0];
const A0 = P0.ev.attr;
console.log('  买入持有年化 ' + P(bh.mktY, 1) + '；策略因降低敞口放弃的 beta = ' + P(bh.mktY - A0.betaY, 1) +
  '；timing 挣回 ' + P(A0.timingY, 1));
console.log('  → timing 能否补回放弃的 beta？ ' + (A0.timingY > (bh.mktY - A0.betaY) ? '能' : '不能'));
console.log('\n  ---- 回撤路径 ----');
console.log('  买入持有：最大回撤 ' + P(-bh.ddB.mdd, 1) + '  水下 ' + (bh.ddB.uwShare * 100).toFixed(0) +
  '%  最长连续水下 ' + bh.ddB.maxUw + ' 天  Calmar ' + N(bh.calmarB));
console.log('  线性信号：最大回撤 ' + P(-P0.ev.ddN.mdd, 1) + '  水下 ' + (P0.ev.ddN.uwShare * 100).toFixed(0) +
  '%  最长连续水下 ' + P0.ev.ddN.maxUw + ' 天  Calmar ' + N(P0.ev.calmarN));
console.log('  最大回撤削减 = ' + P(bh.ddB.mdd - P0.ev.ddN.mdd, 1) + '（正 = 削掉了）');
console.log('  净年化代价   = ' + P(bh.netY - P0.ev.netY, 1));
console.log('  前三大回撤（信号）：' + P0.ev.ddN.top.map((e, i) =>
  '#' + (i + 1) + ' ' + P(-e.dd, 1) + (e.rec == null ? '(未修复)' : '(' + e.rec + '天)')).join('  '));

/* ---------------- ㉖ 选择偏差与零信息 ---------------- */
let t2 = Date.now();
const NU = call('policyNull', rep);
console.log('\n===== ㉖ 选择偏差 =====  policyNull 耗时 ' + (Date.now() - t2) + 'ms');
const S = call('policySelectionBias', C);
console.log('  最好的政策 = ' + S.bestNm + '  实测年化夏普 ' + N(S.srAnn));
console.log('  门槛 SR0(年化) = ' + N(S.sr0Ann) + '   （N=' + S.N + ' 个政策，V=' + S.V.toExponential(2) + '）');
console.log('  去通胀后 P(有真本事) DSR = ' + (S.dsr * 100).toFixed(1) + '%');
console.log('  P(夏普>0) = ' + (S.psr0 * 100).toFixed(1) + '%   P(赢过躺平) = ' + (S.psrBH * 100).toFixed(1) + '%');
console.log('  γ3=' + N(S.g3) + '  γ4=' + N(S.g4) + '（正态=3）  T=' + S.T);
console.log('\n  ---- 敞口诊断（本轮最要紧的一个数）----');
console.log('  平均|w| = ' + N(P0.ev.attr.avgAbsW) + '  中位|w| = ' + N(P0.ev.attr.p50AbsW) +
  '  p95|w| = ' + N(P0.ev.attr.p95AbsW) + '  最大|w| = ' + N(P0.ev.attr.maxAbsW) + '（满仓=1）');
let sMin=1e9,sMax=-1e9,ss2=[];
for(let i=rep.start;i<rep.n;i++){const v=rep.scores[i]; if(v!=null&&isFinite(v)){ss2.push(v); if(v<sMin)sMin=v; if(v>sMax)sMax=v;}}
console.log('  评分实际范围 [' + sMin.toFixed(1) + ', ' + sMax.toFixed(1) + ']（理论 0-100）');
console.log('\n  ---- 零信息对照（评分循环移位 ' + NU.shifts.length + ' 次）----');
console.log('  政策               实测夏普   零信息中位  零信息95%   判定');
for (const R of C.rows) {
  if (R.bench) continue;
  const z = NU.byPolicy[R.id];
  if (!z) continue;
  console.log('  ' + R.nm.padEnd(14) + N(R.ev.shN).padStart(10) + N(z.medShN).padStart(12) +
    N(z.p95ShN).padStart(11) + '   ' + (R.ev.shN > z.p95ShN ? '超出噪声带' : '落在噪声带内') +
    '   (零信息中位净年化 ' + P(z.medNetY, 1) + ')');
}
console.log('\n  零信息中位夏普不接近 0 的原因：平均敞口仍为正 ⇒ 牛市里白捡 beta。这正是 ㉕ 的 beta 项。');
