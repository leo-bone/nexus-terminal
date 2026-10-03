/* v3.21 真实十年数据实测：⑰ 分位数组合 / ⑱ 校准 / ⑲ 仓位 / ⑳ 有效维度 */
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

const H = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/hist.json', 'utf8'));
const st = ev('state');
st.klines = {}; st.chainSeries = {}; st.macroSeries = {}; st.asof = null;
st.histBundle = H;

const t0 = Date.now();
const rep = ev('replayHistory')();
if (!rep) { console.log('REPLAY NULL'); process.exit(1); }
console.log('回放耗时 ' + (Date.now() - t0) + 'ms, 窗口 ' + (rep.n - rep.start) + ' 天');

/* 注入日线以便 currentRegime 能算出波动率 */
st.klines['BTC1d'] = rep.calTs.map((t, i) => ({ t, c: rep.closes[i], o: rep.closes[i], h: rep.closes[i], l: rep.closes[i], v: 0 }));
st.klIdx = rep.n - 1;

const f = t => new Date(t).toISOString().slice(0, 10);
console.log('窗口 ' + f(rep.calTs[rep.start]) + ' → ' + f(rep.calTs[rep.n - 1]));

/* ---------------- ⑰ 分位数组合 ---------------- */
let t1 = Date.now();
const q = ev('quintileTest')(rep, 10);
console.log('\n===== ⑰ 分位数组合检验（h=10）=====  耗时 ' + (Date.now() - t1) + 'ms');
if (!q) console.log('  null');
else {
  console.log('  样本 ' + q.n + ' 对，基准（全样本 10 日收益）' + (q.base * 100).toFixed(3) + '%');
  q.buckets.forEach((b, i) => {
    console.log('  Q' + (i + 1) + '  n=' + String(b.n).padStart(4) +
      '  平均 ' + (b.mean == null ? '  —  ' : (b.mean * 100).toFixed(3).padStart(7) + '%') +
      '  胜率 ' + (b.win == null ? ' — ' : (b.win * 100).toFixed(0) + '%') +
      '  t=' + (b.t == null ? '  —  ' : b.t.toFixed(2).padStart(6)));
  });
  console.log('  单调性 Spearman ρ = ' + (q.rho == null ? '—' : q.rho.toFixed(3)) +
    '   精确置换 p = ' + (q.pMono == null ? '—' : q.pMono.toFixed(4)) + '  (枚举 ' + q.nPerm + ' 种排列)');
  console.log('  是否严格单调 = ' + q.monotonic + '   Q5−Q1 差 = ' + (q.spread == null ? '—' : (q.spread * 100).toFixed(3) + '%'));
  const qo = ev('quintileOOS')(rep, 10);
  if (qo) {
    console.log('  —— 样本外保序（切分点由前 ' + qo.nIn + ' 个样本定死，后 ' + qo.nOut + ' 天评估）:');
    console.log('     ' + qo.means.map((m,i)=>'Q'+(i+1)+' '+(m==null?'—':(m*100).toFixed(2)+'%')).join('  '));
    console.log('     ρ=' + (qo.rho==null?'—':qo.rho.toFixed(3)) + '  p=' + (qo.pMono==null?'—':qo.pMono.toFixed(4)) + '  单调=' + qo.monotonic + '  价差=' + (qo.spread==null?'—':(qo.spread*100).toFixed(3)+'%'));
  }
  const L = q.ls;
  console.log('  多空组合: 累计 ' + (L.total * 100).toFixed(1) + '%  年化≈' + (L.cagr == null ? '—' : (L.cagr * 100).toFixed(1) + '%') +
    '  夏普 ' + (L.sharpe == null ? '—' : L.sharpe.toFixed(2)) + '  最大回撤 ' + (L.mdd * 100).toFixed(1) + '%');
}

/* ---------------- ⑱ 校准 ---------------- */
t1 = Date.now();
const c = ev('calibFit')(rep, 10);
console.log('\n===== ⑱ 校准（h=10）=====  耗时 ' + (Date.now() - t1) + 'ms');
if (!c) console.log('  null');
else {
  console.log('  每 1 分 = ' + (c.perUnit * 100).toFixed(4) + '%   每 10 分 = ' + (c.per10 * 100).toFixed(3) + '%');
  console.log('  斜率 t(重叠) = ' + (c.tB == null ? '—' : c.tB.toFixed(2)) + '   t(非重叠) = ' + (c.tBEff == null ? '—' : c.tBEff.toFixed(2)) + '   R² = ' + (c.r2 * 100).toFixed(2) + '%');
  console.log('  样本 n=' + c.n + '  有效 n_eff=' + c.nEff + '  校准斜率=' + (c.calibSlope==null?'—':c.calibSlope.toFixed(3)));
  console.log('  评分区间: 均值 ' + c.mxScore.toFixed(1) + '  sd ' + c.scoreSd.toFixed(1));
  console.log('  分段校准（预测 vs 实际）:');
  c.bins.forEach(b => console.log('    段' + (b.b + 1) + ' n=' + String(b.n).padStart(4) +
    '  预测 ' + (b.pred == null ? '  —  ' : (b.pred * 100).toFixed(3).padStart(7) + '%') +
    '  实际 ' + (b.actual == null ? '  —  ' : (b.actual * 100).toFixed(3).padStart(7) + '%') +
    '  误差 ' + (b.err == null ? '  —  ' : (b.err * 100).toFixed(3).padStart(7) + '%')));
  console.log('  校准斜率 = ' + (c.calibSlope == null ? '—' : c.calibSlope.toFixed(3)));
  if (c.oos) console.log('  样本外: n=' + c.oos.n + '  R²_OOS = ' + (c.oos.r2 == null ? '—' : (c.oos.r2 * 100).toFixed(2) + '%') +
    '  OOS校准斜率 = ' + (c.oos.slopeOOS == null ? '—' : c.oos.slopeOOS.toFixed(3)));
  [30, 50, 70, 90].forEach(s => console.log('    评分 ' + s + ' → 期望 ' + (c.muAtScore(s) * 100).toFixed(3) + '%  ±1.645σ [' +
    ((c.muAtScore(s) - 1.645 * c.seAtScore(s)) * 100).toFixed(3) + '%, ' + ((c.muAtScore(s) + 1.645 * c.seAtScore(s)) * 100).toFixed(3) + '%]'));
}

/* ---------------- ⑳ 有效维度 ---------------- */
t1 = Date.now();
const D = ev('dimAnalyze')(rep);
console.log('\n===== ⑳ 有效维度与分块 =====  耗时 ' + (Date.now() - t1) + 'ms');
if (!D) console.log('  null');
else {
  const E = D.eff;
  console.log('  因子数 p = ' + D.p + '  收缩 δ = ' + (D.delta == null ? '—' : D.delta.toFixed(3)));
  console.log('  参与率 PR = ' + E.pr.toFixed(2) + '   熵有效维度 = ' + E.entDim.toFixed(2) +
    '   PC1 = ' + (E.top1 * 100).toFixed(1) + '%   解释90%需 ' + E.nFor90 + ' 个');
  console.log('  分块 ' + D.k + ' 块:');
  D.blocks.forEach((b, i) => console.log('    块' + (i + 1) + ' (' + b.length + '): ' + b.join(',')));
  console.log('  IC 原模型 = ' + (D.icOrig ? D.icOrig.ic.toFixed(4) + ' (t=' + (D.icOrig.t == null ? '—' : D.icOrig.t.toFixed(2)) + ')' : '—'));
  console.log('  IC 分块等权 = ' + (D.icBlock ? D.icBlock.ic.toFixed(4) + ' (t=' + (D.icBlock.t == null ? '—' : D.icBlock.t.toFixed(2)) + ')' : '—'));
  console.log('  块间平均 |ρ| = ' + (D.blockAvgAbsCorr == null ? '—' : D.blockAvgAbsCorr.toFixed(3)));
  console.log('  独有信息量（降序前 8 / 后 5）:');
  const uq = D.uniq.slice().sort((a, b) => b.uniq - a.uniq);
  console.log('    ' + uq.slice(0, 8).map(u => u.id + ' ' + (u.uniq * 100).toFixed(0) + '%').join('  '));
  console.log('    ' + uq.slice(-5).map(u => u.id + ' ' + (u.uniq * 100).toFixed(0) + '%').join('  '));
}

/* ---------------- ⑲ 仓位 ---------------- */
console.log('\n===== ⑲ 风险化仓位 =====');
st.hist = { rep, calib: c, qOos: ev('quintileOOS')(rep, 10) };
const rg = ev('currentRegime')();
console.log('  当前体制 = ' + (rg ? rg.key + ' 波动 ' + (rg.vol * 100).toFixed(0) + '%' : 'null'));
[30, 50, 65, 80, 95].forEach(s => {
  const r = ev('sizingAdvice')({ score: s, out: {} });
  if (!r.have) { console.log('  评分 ' + s + ': ' + r.why); return; }
  console.log('  评分 ' + s + ': μ(总)=' + (r.muH * 100).toFixed(3) + '%  超额α=' + (r.alphaH * 100).toFixed(3) + '%  区间[' + (r.alphaLo * 100).toFixed(3) + ',' + (r.alphaHi * 100).toFixed(3) + ']' +
    '  Kelly全额=' + (r.kellyFull * 100).toFixed(1) + '%  volTarget=' + (r.volTarget * 100).toFixed(1) + '%  OOS线性=' + r.oosLinear + ' OOS保序=' + r.oosOrder +
    '  → 建议 ' + (r.suggest * 100).toFixed(1) + '%  [' + r.bindKey + ']');
});

/* ---------------- 渲染冒烟 ---------------- */
console.log('\n===== 渲染冒烟 =====');
st.hist = { rep, calib: c, quint: q, qOos: ev('quintileOOS')(rep, 10), dim: D };
st.lastScore = 57; st.lastScoreOut = ev('computeNexusScore')().out;
try { ev('renderQuintBox')(); console.log('  renderQuintBox OK, len=' + _reg['quintBox'].innerHTML.length); } catch (e) { console.log('  renderQuintBox FAIL ' + e.message); }
try { ev('renderCalibBox')(); console.log('  renderCalibBox OK, len=' + _reg['calibBox'].innerHTML.length); } catch (e) { console.log('  renderCalibBox FAIL ' + e.message); }
try { ev('renderDimBox')(); console.log('  renderDimBox OK, len=' + _reg['dimBox'].innerHTML.length); } catch (e) { console.log('  renderDimBox FAIL ' + e.message); }
try { ev('renderSizeBox')({ score: 57, out: {} }); console.log('  renderSizeBox OK, len=' + _reg['sizeBox'].innerHTML.length); } catch (e) { console.log('  renderSizeBox FAIL ' + e.message); }
