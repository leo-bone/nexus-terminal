/* v3.27 真实数据实测：把 v3.26 的"低一致性"规则拎到多个独立持有窗反复验证 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const reg = {}; const ctxStub = new Proxy({}, { get: () => () => {} });
const el = id => ({ id, style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', className: '', width: 0, height: 0, clientWidth: 900, clientHeight: 460, value: '', options: [], classList: { add() {}, remove() {}, contains() { return false; } }, appendChild() {}, setAttribute() {}, getContext: () => ctxStub, addEventListener() {} });
const sandbox = { console, setTimeout, clearTimeout, setInterval: () => 0, requestAnimationFrame: () => {}, devicePixelRatio: 1,
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: id => reg[id] || (reg[id] = el(id)), querySelectorAll: () => [], createElement: () => el(), addEventListener() {} },
  window: { addEventListener() {}, devicePixelRatio: 1 },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  navigator: { maxTouchPoints: 0 },
  Math, Date, JSON, Number, isFinite, isNaN, parseFloat, encodeURIComponent, AbortController, Intl, Map, Set, Array, Object, String, Boolean, Error, Infinity, NaN };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
const ev = e => vm.runInContext(e, sandbox);
const call = (e, ...a) => vm.runInContext('(' + e + ')', sandbox)(...a);
const state = ev('state');

const H = JSON.parse(fs.readFileSync('/tmp/hist.json', 'utf8'));
const U = JSON.parse(fs.readFileSync('/tmp/uni.json', 'utf8'));
state.klines = {}; state.chainSeries = {}; state.macroSeries = {}; state.asof = null; state.histBundle = H;
state.universe = { series: U.series, cats: {}, exo: U.exo, _keyCat: U.keyCat, _name: U.names, n: Object.keys(U.series).length, nOk: Object.keys(U.series).length };

const dstr = t => new Date(t).toISOString().slice(0, 10);
const f = v => v == null ? '   —   ' : (v >= 0 ? '+' : '') + v.toFixed(4);
const pc = v => v == null ? '  —  ' : (v * 100).toFixed(0) + '%';

const t0 = Date.now();
const S = call('factorScreening');
console.log('筛选耗时', (Date.now() - t0) + 'ms', '进入筛选', S.nScreened, '个交易日 N=', S.ctx.n);

const t1 = Date.now();
const O = call('oosTrack', S);
console.log('oosTrack 耗时', (Date.now() - t1) + 'ms', '| 因子', O.nFactor, '分类', O.nCat, '| 折数', O.folds.length, '持有窗', O.HOR, '日');

console.log('\n=== 逐折持有窗（持有窗 IC，视野 ' + O.HOR + ' 日）===');
console.log('  持有窗'.padEnd(24) + '低一致性  剔除BTC后  普通TopK   单因子    全池等权  BTC自身');
O.folds.forEach((fl, i) => {
  const last = i === O.folds.length - 1;
  const lab = (last ? '★' : ' ') + dstr(fl.cutDate) + '→' + dstr(fl.endDate);
  console.log('  ' + lab.padEnd(23) +
    f(fl.lowAgree.icOut && fl.lowAgree.icOut.ic) + '  ' +
    f(fl.lowAgree.incr && fl.lowAgree.incr.r.icOut && fl.lowAgree.incr.r.icOut.ic) + '  ' +
    f(fl.cat.icOut && fl.cat.icOut.ic) + '  ' +
    f(fl.single.icOut && fl.single.icOut.ic) + '  ' +
    f(fl.pool.icOut && fl.pool.icOut.ic) + '  ' +
    f(fl.btcOwn.icOut && fl.btcOwn.icOut.ic) +
    (last ? '   ← 最近两年（对今天最有发言权）' : ''));
});

console.log('\n=== 跨折聚合 ===');
const a = O.agg;
[['① 低一致性(事后规则)', 'lowAgree'], ['② 普通TopK(按|IC|)', 'cat'], ['③ 全池等权', 'pool'], ['④ 单因子Top' + O.K1, 'single']].forEach(([n, k]) => {
  const g = a[k];
  console.log('  ' + n.padEnd(20) + '中位 ' + f(g.median) + '  均值 ' + f(g.mean) +
    '  正折 ' + g.posN + '/' + g.n + '  强(|IC|>0.1) ' + g.strongN + '/' + g.n +
    '  剔除BTC后中位 ' + f(g.incMean) + ' 正折 ' + g.incPosN + '/' + g.n);
});

console.log('\n=== 判定 ===');
const la = a.lowAgree, ca = a.cat, pa = a.pool;
const survives = la.median != null && la.median > 0 && la.posN >= Math.ceil(la.n / 2);
const beatsPlain = la.median != null && ca.median != null && la.median > ca.median;
const beatsNone = la.median != null && pa.median != null && la.median > pa.median;
if (!survives) console.log('  ❌ 低一致性规则没通过独立验证：中位 ' + f(la.median) + '、仅 ' + la.posN + '/' + la.n + ' 折正 —— 换没看过的窗口就塌。');
else if (beatsNone) console.log('  ✅ 低一致性规则站住且优于不挑：中位 ' + f(la.median) + '、' + la.posN + '/' + la.n + ' 折正，高于全池等权（中位 ' + f(pa.median) + '）。');
else if (beatsPlain) console.log('  ⚠️ 低一致性规则站住但不如干脆不挑：中位 ' + f(la.median) + '、' + la.posN + '/' + la.n + ' 折正，低于全池等权（中位 ' + f(pa.median) + '）。');
else console.log('  ⚠️ 低一致性规则站住但不如朴素挑选：中位 ' + f(la.median) + '、' + la.posN + '/' + la.n + ' 折正，低于普通 TopK（中位 ' + f(ca.median) + '）。');
console.log('  注：跨折中位 IC 最高的是全池等权(' + f(pa.median) + ')和单因子Top' + O.K1 + '(' + f(a.single.median) + ')，不是任何精巧挑选。');

console.log('\n=== 风险监测（全分类，截至 ' + dstr(S.ctx.ts[S.ctx.n - 1]) + '）===');
const RM = call('riskMonitor', S);
if (RM && RM.rows.length) {
  console.log('  ' + '分类'.padEnd(10) + '当前值'.padEnd(8) + '分位'.padEnd(8) + '近60日'.padEnd(8) + '变化率(σ)');
  RM.rows.forEach(r => {
    console.log('  ' + r.zh.padEnd(8) + f(r.now).padEnd(8) + pc(r.pct).padEnd(8) + f(r.d60).padEnd(8) +
      (r.rc == null ? '  —' : (r.rc >= 0 ? '+' : '') + r.rc.toFixed(2)) + (r.extreme ? '  ' + (r.extreme === 'high' ? '历史高位' : '历史低位') : ''));
  });
} else console.log('  无读数');

console.log('\n=== 风险护栏（三联警报，截至 ' + dstr(S.ctx.ts[S.ctx.n - 1]) + '）===');
const G = call('guardrail', S);
const lvlTxt = ['静', '警', '危'];
console.log('  总状态: ' + G.label + '  (status=' + G.status + ', ready=' + G.ready + ')');
console.log('  ① DVOL 体制: ' + (G.dv ? ('DVOL=' + G.dv.latest.toFixed(0) + ' 近1年百分位 ' + pc(G.dv.pctTrailing1y) + ' 60日z ' + G.dv.z60.toFixed(2)) : '不可用') + ' → ' + (G.dvolLevel == null ? '—' : lvlTxt[G.dvolLevel]));
console.log('  ② 极端分位联动: 高位 ' + G.nHigh + ' 类 / 低位 ' + G.nLow + ' 类' + (G.volWild ? ' (叠加BTC波动极端体制)' : (G.regVol != null ? ' (BTC年化波动 ' + G.regVol.toFixed(2) + ')' : '')) + ' → ' + lvlTxt[G.regimeLevel]);
console.log('  ③ 变化率联动: ' + G.nAccel + ' 类 |rc|≥1.5 加速 → ' + lvlTxt[G.accelLevel]);
if (G.firing && G.firing.length) {
  console.log('  正在触发:');
  G.firing.forEach(f0 => console.log('    ' + f0.zh + ' · ' + f0.kind + ' · 分位 ' + pc(f0.pct) + ' · 变化率σ ' + (f0.rc == null ? '—' : (f0.rc >= 0 ? '+' : '') + f0.rc.toFixed(1))));
} else console.log('  无分类触发');
const GH = call('guardrailHTML', G) || '';
console.log('  guardrailHTML 长度 ' + GH.length + ' | 含undefined: ' + (GH.indexOf('undefined') >= 0) + ' | 含NaN: ' + (GH.indexOf('NaN') >= 0));

console.log('\nDONE');
process.exit(0);
