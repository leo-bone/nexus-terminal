/* v3.24 真实十年数据实测：㉗ 幅度分解 / ㉘ 标尺重标定 / ㉙ 夹紧代价 */
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
console.log('回放 ' + (Date.now() - t0) + 'ms, 窗口 ' + (rep.n - rep.start) + ' 天');
const f = t => new Date(t).toISOString().slice(0, 10);
const N = (v, d) => v == null ? '—' : v.toFixed(d == null ? 2 : d);
const P = (v, d) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(d == null ? 2 : d) + '%';

/* ---------------- ㉗ 幅度分解 ---------------- */
let t1 = Date.now();
const S = call('scoreScale', rep);
console.log('\n===== ㉗ 幅度分解 =====  耗时 ' + (Date.now() - t1) + 'ms');
console.log('  评分实测 [' + S.score.min + ', ' + S.score.max + ']  sd ' + N(S.score.sd) + '  p05 ' + S.score.p05 + '  p95 ' + S.score.p95);
console.log('  复合 c：sd ' + N(S.comp.sd) + '  范围 [' + N(S.comp.min) + ', ' + N(S.comp.max) + ']');
console.log('  单因子加权 RMS（典型幅度）' + N(S.rmsFactor));
console.log('  ① 平均化收缩：' + N(S.rmsFactor) + ' → ' + N(S.comp.sd) + '，收缩比 ' + N(S.shrink) +
  '；独立假设下应为 1/√N_eff = ' + N(S.indepShrink) + '（N_eff=' + N(S.nEffW) + '，' + S.nFac + ' 个因子）');
console.log('  ② 方向一致性 ' + N(S.agree) + '（独立基准 ' + N(S.agreeIndep) + '）→ ' +
  (S.agree > S.agreeIndep ? '因子间正相关，抵消比独立情形更轻；收缩的主因是「平均」本身，不是「打架」' : '因子互相抵消比独立更严重'));
console.log('  ③ 标尺常数：现用 ' + S.mult.cur + '，要让 ±2.5σ 铺满 0–100 需要 ' + N(S.mult.need));
console.log('\n  ---- 逐因子：撞顶与 clamp 损失（按撞击比例降序）----');
console.log('  因子              权重   天数   zRaw sd   夹紧前|z|  夹紧后|z|  撞顶占比  sd损失  并列占比');
for (const p of S.per) {
  console.log('  ' + p.name.padEnd(16) + N(p.w, 1).padStart(5) + String(p.nDay).padStart(7) +
    N(p.sdRaw).padStart(10) + N(p.meanAbsRaw).padStart(11) + N(p.meanAbsCl).padStart(10) +
    ((p.pClamp == null ? 0 : p.pClamp * 100).toFixed(1) + '%').padStart(10) +
    ((p.lossSd == null ? 0 : p.lossSd * 100).toFixed(1) + '%').padStart(9) +
    ((p.pTie * 100).toFixed(1) + '%').padStart(10));
}
const sdMed = S.per.map(p => p.sdRaw).filter(v => v != null).sort((a, b) => a - b);
console.log('  → 单因子 zRaw sd 中位数 ' + N(sdMed[Math.floor(sdMed.length / 2)]) + '（≈1 = 标定正常）');

/* ---------------- ㉘ 标尺重标定 ---------------- */
let t2 = Date.now();
const R = call('scoreRescale', rep);
console.log('\n===== ㉘ 标尺重标定（扩张窗口，无前视）=====  耗时 ' + (Date.now() - t2) + 'ms');
console.log('  burn-in ' + R.minN + ' 天 → 从第 ' + R.lo + ' 天（' + f(rep.calTs[R.lo]) + '）起给值，共 ' + R.nScored + ' 天');
console.log('  σ 分位：p05 ' + N(R.sigQ.p05) + '  p25 ' + N(R.sigQ.p25) + '  p50 ' + N(R.sigQ.p50) +
  '  p75 ' + N(R.sigQ.p75) + '  p95 ' + N(R.sigQ.p95) + '  最小 ' + N(R.sigQ.min) +
  '  → σ下限 ' + N(R.sigFloor) + ' 触发率 ' + ((R.bindRate || 0) * 100).toFixed(1) + '%');
console.log('\n  口径               评分范围         sd      IC(h=' + R.h + ')     t      样本外IC');
console.log('  现行（线性 22）   [' + R.range.old[0] + ', ' + R.range.old[1] + ']'.padEnd(4) + '   ' + N(R.sd.old).padStart(6) +
  '  ' + N(R.ic.old).padStart(8) + '  ' + N(R.ic.oldT).padStart(7) + '   ' + (R.oos ? N(R.oos.old) : '—'));
console.log('  除 σ（保留锚点）  [' + R.range.neu[0] + ', ' + R.range.neu[1] + ']'.padEnd(4) + '   ' + N(R.sd.neu).padStart(6) +
  '  ' + N(R.ic.neu).padStart(8) + '  ' + N(R.ic.neuT).padStart(7) + '   ' + (R.oos ? N(R.oos.neu) : '—'));
console.log('  除 σ 且减 μ       [' + R.range.dem[0] + ', ' + R.range.dem[1] + ']'.padEnd(4) + '   ' + N(R.sd.dem).padStart(6) +
  '  ' + N(R.ic.dem).padStart(8) + '  ' + N(R.ic.demT).padStart(7) + '   —');
console.log('  → IC 变化 ' + (R.ic.neu - R.ic.old >= 0 ? '+' : '') + N(R.ic.neu - R.ic.old, 4) +
  '：' + (Math.abs(R.ic.neu - R.ic.old) < 0.01 ? '几乎不变 —— 说明这确实只是「换标尺」，没有往里塞信息' : '有明显变化，需警惕标尺改动引入了时序漂移'));
console.log('  → 仓位幅度 |w|：平均 ' + N(R.w.oldAvg) + ' → ' + N(R.w.neuAvg) + '（×' + N(R.w.neuAvg / R.w.oldAvg) + '）' +
  '   p95 ' + N(R.w.oldP95) + ' → ' + N(R.w.neuP95));

/* ---------------- ㉙ 夹紧代价 ---------------- */
let t3 = Date.now();
const K = call('clampCost', rep);
console.log('\n===== ㉙ 夹紧代价 =====  耗时 ' + (Date.now() - t3) + 'ms');
console.log('  撞顶 >8% 的因子（数据自己点名）：' + K.worst.map(p => p.name + ' ' + (p.pClamp * 100).toFixed(0) + '%').join('  '));
if (K.cmp) {
  console.log('  对照：把 ' + K.cmp.ids.join('/') + ' 的 z 用**扩张窗口自身 sd**归一化后再夹紧');
  for (const id of K.cmp.ids) {
    const p = K.cmp.per[id], o = S.per.find(x => x.id === id);
    console.log('    ' + p.name.padEnd(16) + ' 撞顶 ' + ((o.pClamp || 0) * 100).toFixed(1) + '% → ' + ((p.pClampAfter || 0) * 100).toFixed(1) + '%');
  }
  console.log('  复合 sd ' + N(S.comp.sd) + ' → ' + N(K.cmp.compSd) +
    '；评分 sd ' + N(K.cmp.sdOld) + ' → ' + N(K.cmp.sdFix) + '  范围 [' + K.cmp.rangeFix[0] + ', ' + K.cmp.rangeFix[1] + ']');
  console.log('  IC ' + N(K.cmp.icOld) + ' → ' + N(K.cmp.icFix) + '  变化 ' + (K.cmp.icFix - K.cmp.icOld >= 0 ? '+' : '') + N(K.cmp.icFix - K.cmp.icOld, 4));
  console.log('  → ' + (K.cmp.icFix > K.cmp.icOld ? '重标定后 IC 提升' : '重标定后 IC 未提升（说明被砍掉的那些极端值里没有额外信息，或者归一化引入了噪声）'));
}
