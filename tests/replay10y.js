/* 真实数据的 10 年回放压力测试 + 预计算表一致性校验 */
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
  console,
  setTimeout, clearTimeout, setInterval: () => 0,
  requestAnimationFrame: () => {},
  devicePixelRatio: 1,
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

/* app.js 里的顶层声明用的是 const —— const 不会挂到沙箱全局对象上，
 * 必须用 runInContext 求值才能拿到（smoke.js 能用 sandbox.xxx 只是因为那些是 function 声明）。 */
const ev = e => vm.runInContext(e, sandbox);

const H = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/hist311.json', 'utf8'));
const st = ev('state');
st.klines = {}; st.chainSeries = {}; st.macroSeries = {}; st.asof = null;
st.histBundle = H;

/* ---- 0. 预计算表 vs 原函数 一致性 ---- */
(function () {
  let worst = 0, worstKey = '';
  const ser = {};
  Object.keys(H.macro || {}).forEach(k => ser[k] = H.macro[k].closes);
  if (H.fng) ser.FNG = H.fng.closes;
  if (H.tx) ser.TX = H.tx.closes;
  if (H.hr) ser.HR = H.hr.closes;
  const names = Object.keys(ser);
  for (let qi = 0; qi < names.length; qi++) {
    const k = names[qi], v = ser[k].slice(-1200);
    [['r120', 0, 120], ['r90', 0, 90], ['c30', 30, 120], ['c60', 60, 120], ['c90', 90, 120]].forEach(function (m) {
      const tab = m[1] ? ev('preChgZ')(v, m[1], m[2]) : ev('preRollZ')(v, m[2]);
      for (let i = 200; i < v.length; i += 37) {
        const pref = v.slice(0, i + 1);
        const ref = m[1] ? ev('chgZ')(pref, m[1], m[2]) : ev('rollZ')(pref, m[2]);
        const d = Math.abs(tab[i] - ref);
        if (d > worst) { worst = d; worstKey = k + '|' + m[0] + '@' + i; }
      }
    });
  }
  console.log('预计算表 vs 原 rollZ/chgZ 最大偏差 = ' + worst.toExponential(2) + '  (' + worstKey + ')');
  console.log('一致性: ' + (worst < 1e-6 ? 'PASS' : 'FAIL'));
})();

/* ---- 1. 10 年回放 ---- */
const t0 = Date.now();
const rep = ev('replayHistory')();
const ms = Date.now() - t0;
if (!rep) { console.log('REPLAY NULL'); process.exit(1); }
const f = t => new Date(t).toISOString().slice(0, 10);
console.log('\n=== 回放窗口 ===');
console.log('起点 ' + f(rep.calTs[rep.start]) + ' → 终点 ' + f(rep.calTs[rep.n - 1]) +
  '   共 ' + (rep.n - rep.start) + ' 个交易日（日历 ' + rep.n + ' 天）');
console.log('耗时 ' + ms + 'ms');

const sc = rep.scores.slice(rep.start).filter(v => v != null);
console.log('\n=== 评分分布 ===');
console.log('min=' + Math.min(...sc) + ' max=' + Math.max(...sc) +
  ' 均值=' + (sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(1) +
  ' 不同值=' + new Set(sc).size + ' 钳到边界=' + sc.filter(v => v === 2 || v === 98).length);

const act = rep.nAct.slice(rep.start).filter(v => v > 0);
console.log('参与因子数: min=' + Math.min(...act) + ' max=' + Math.max(...act) +
  ' 首日=' + rep.nAct[rep.start] + ' 末日=' + rep.nAct[rep.n - 1]);

/* ---- 2. 各因子上线时间（动态可用性） ---- */
console.log('\n=== 因子上线时间（首次进入分母的日期） ===');
const up = [];
Object.keys(rep.fvals).forEach(fid => {
  const a = rep.fvals[fid];
  for (let i = 0; i < a.length; i++) if (a[i] != null) { up.push({ fid, i }); break; }
});
up.sort((a, b) => a.i - b.i);
console.log(up.map(x => x.fid + '@' + f(rep.calTs[x.i])).join('  '));
const miss = ev('REPLAY_IDS').filter(id => !rep.fvals[id]);
console.log('全程缺席: ' + (miss.length ? miss.join(',') : '（无）'));

/* ---- 3. IC 检验 ---- */
console.log('\n=== 合成评分 IC ===');
[1, 5, 10, 20].forEach(h => {
  const c = ev('icFor')(rep, h);
  if (!c) { console.log(h + '日: null'); return; }
  console.log(h + '日: IC=' + (c.spear == null ? '—' : c.spear.toFixed(3)) +
    ' t=' + (c.t == null ? '—' : c.t.toFixed(2)) + ' n=' + c.n +
    ' | <40 ' + (c.buckets[0].mean == null ? '—' : (c.buckets[0].mean * 100).toFixed(2) + '%') +
    ' 40~60 ' + (c.buckets[1].mean == null ? '—' : (c.buckets[1].mean * 100).toFixed(2) + '%') +
    ' >60 ' + (c.buckets[2].mean == null ? '—' : (c.buckets[2].mean * 100).toFixed(2) + '%'));
});

/* ---- 4. 因子归因 ---- */
const facs = ev('factorICRows')(rep);
console.log('\n=== 因子归因（按 |IC(10)| 降序）===');
facs.forEach(r => {
  const p = r.per[10] || {};
  console.log('  ' + (r.id + '        ').slice(0, 8) +
    ' IC10=' + (p.ic == null ? '  —  ' : p.ic.toFixed(3).padStart(7)) +
    ' t=' + (p.t == null ? ' — ' : p.t.toFixed(2).padStart(6)) +
    '  (' + r.name + ')');
});
