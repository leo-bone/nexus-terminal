/* v3.24 诊断：评分动态范围为何只有 20–77（分解压缩来源） */
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
const rep = ev('replayHistory')();
if (!rep) { console.log('REPLAY NULL'); process.exit(1); }
const f = t => new Date(t).toISOString().slice(0, 10);
const N = (v, d) => v == null ? '—' : v.toFixed(d == null ? 2 : d);
console.log('窗口 ' + f(rep.calTs[rep.start]) + ' → ' + f(rep.calTs[rep.n - 1]) + '  (' + (rep.n - rep.start) + ' 天)');

/* ---------- 基础统计 ---------- */
const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)); };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.floor(p * (b.length - 1))))]; };

const ids = Object.keys(rep.fvals || {});
const W = {}; ev('FACTORS').forEach(x => W[x.id] = { w: x.w, dir: x.dir, name: x.name });

/* ---------- ① 评分本身的分布 ---------- */
const S = []; for (let i = rep.start; i < rep.n; i++) if (rep.scores[i] != null) S.push(rep.scores[i]);
console.log('\n===== ① 评分分布 =====');
console.log('  实测范围 [' + Math.min(...S) + ', ' + Math.max(...S) + ']   均值 ' + N(mean(S)) + '   标准差 ' + N(sd(S)));
console.log('  分位 p01=' + q(S, .01) + ' p05=' + q(S, .05) + ' p25=' + q(S, .25) + ' p50=' + q(S, .5) + ' p75=' + q(S, .75) + ' p95=' + q(S, .95) + ' p99=' + q(S, .99));
console.log('  理论可用 0–100 → 实际占用 ' + ((Math.max(...S) - Math.min(...S)) / 100 * 100).toFixed(0) + '% 的标尺；'
  + '理论中位 50 vs 实测中位 ' + q(S, .5) + '（偏移 ' + (q(S, .5) - 50) + '）');

/* ---------- ② 单因子幅度：是因子自己温和吗 ---------- */
console.log('\n===== ② 单因子幅度（clamp 前 zRaw vs clamp 后）=====');
console.log('  因子              权重  参与天数   zRaw sd   |zRaw|均值   |z|均值   被夹紧%   clamp损失');
const rows = [];
for (const id of ids) {
  const raw = [], cl = [];
  for (let i = rep.start; i < rep.n; i++) {
    const a = rep.fraw[id] ? rep.fraw[id][i] : null, b = rep.fvals[id][i];
    if (b == null) continue;
    if (a != null && isFinite(a)) raw.push(a);
    cl.push(Math.abs(b));
  }
  if (!cl.length) continue;
  let nClamp = 0;
  for (let i = rep.start; i < rep.n; i++) {
    const a = rep.fraw[id] ? rep.fraw[id][i] : null;
    if (a != null && isFinite(a) && Math.abs(a) > 2.5) nClamp++;
  }
  const rsd = raw.length > 5 ? sd(raw) : null;
  rows.push({ id, n: cl.length, rsd, mRaw: raw.length ? mean(raw.map(Math.abs)) : null, mCl: mean(cl),
    pClamp: nClamp / (rep.n - rep.start), loss: (rsd && sd(rep.fzs[id].filter(v => v != null))) ? 1 - sd(rep.fzs[id].filter(v => v != null)) / rsd : null });
}
rows.sort((a, b) => (b.mCl || 0) - (a.mCl || 0));
for (const r of rows) {
  console.log('  ' + (W[r.id] ? W[r.id].name : r.id).padEnd(16) + N(W[r.id] ? W[r.id].w : 0, 1).padStart(5) +
    String(r.n).padStart(8) + N(r.rsd).padStart(10) + N(r.mRaw).padStart(11) + N(r.mCl).padStart(10) +
    ((r.pClamp * 100).toFixed(1) + '%').padStart(9) + (r.loss == null ? '   —' : ('  ' + (r.loss * 100).toFixed(1) + '%')).padStart(11));
}
const allRawSd = rows.filter(r => r.rsd).map(r => r.rsd);
console.log('  → 单因子 zRaw 标准差中位数 = ' + N(q(allRawSd, .5)) + '（若 ≈1 说明 z 本身标定正常，不是因子幅度的问题）');
console.log('  → 单因子 |贡献| 均值中位数 = ' + N(q(rows.map(r => r.mCl), .5)) + '  （满分 2.5）');

/* ---------- ③ 加权平均收缩 ---------- */
console.log('\n===== ③ 加权平均的方差收缩（除以 Σw 的代价）=====');
const comp = [], perFactorSd = [];
for (let i = rep.start; i < rep.n; i++) {
  let s = 0, ws = 0, k = 0, ss = 0;
  for (const id of ids) {
    const v = rep.fvals[id][i]; if (v == null) continue;
    const w = W[id] ? W[id].w : 1;
    s += v * w; ws += w; k++; ss += v * v;
  }
  if (k >= 3 && ws) { comp.push(s / ws); perFactorSd.push(Math.sqrt(ss / k)); }
}
console.log('  复合 c = Σw·z/Σw ：标准差 ' + N(sd(comp)) + '   均值 ' + N(mean(comp)) + '   范围 [' + N(Math.min(...comp)) + ', ' + N(Math.max(...comp)) + ']');
console.log('  当日因子 RMS（若不平均，单因子典型幅度）均值 = ' + N(mean(perFactorSd)));
console.log('  → 收缩比 = ' + N(sd(comp) / mean(perFactorSd)) + '   等权独立假设下应为 1/√N_eff');
/* 有效因子数：用权重算 N_eff = (Σw)^2/Σw^2 */
let sw = 0, sw2 = 0, nAct = 0;
for (const id of ids) { const w = W[id] ? W[id].w : 1; sw += w; sw2 += w * w; nAct++; }
console.log('  参与因子数 ' + nAct + '   权重 N_eff = (Σw)²/Σw² = ' + N(sw * sw / sw2) + '   → 1/√N_eff = ' + N(1 / Math.sqrt(sw * sw / sw2)));

/* ---------- ④ 方向一致性（抵消 vs 共振）---------- */
console.log('\n===== ④ 方向一致性：是「因子互相抵消」还是「一起温和」=====');
const agr = [], absAgr = [];
for (let i = rep.start; i < rep.n; i++) {
  let s = 0, sa = 0, ws = 0;
  for (const id of ids) {
    const v = rep.fvals[id][i]; if (v == null) continue;
    const w = W[id] ? W[id].w : 1;
    s += v * w; sa += Math.abs(v) * w; ws += w;
  }
  if (ws) { agr.push(Math.abs(s / ws)); absAgr.push(sa / ws); }
}
const agree = mean(agr) / mean(absAgr);
console.log('  E|加权平均| = ' + N(mean(agr)) + '   E[加权 |z|] = ' + N(mean(absAgr)) + '   一致性 = ' + N(agree));
console.log('  → 一致性 ≈ 1 = 全体同向共振；≈ 1/√N = 随机独立；实测 ' + N(agree) +
  ' vs 独立基准 ' + N(1 / Math.sqrt(sw * sw / sw2)));
console.log('  → 净抵消损失 = ' + ((1 - agree) * 100).toFixed(0) + '%（若接近独立基准，说明「抵消」不是额外病因，只是平均的必然后果）');

/* ---------- ⑤ 标尺映射常数 22 ---------- */
console.log('\n===== ⑤ 标尺映射 =====');
console.log('  score = 50 + 22 × c（c 理论 ±2.5 ⇒ 22×2.5=55 ⇒ 5–95，再 clamp 到 2–98）');
console.log('  实测 c 标准差 ' + N(sd(comp)) + ' ⇒ 评分标准差 = 22 × ' + N(sd(comp)) + ' = ' + N(22 * sd(comp)) + ' 分');
console.log('  若要让评分用满 0–100（±2.5σ 覆盖），需要乘数 = 2.5σ→50 ⇒ ' + N(50 / (2.5 * sd(comp))) + '（当前 22）');

/* ---------- ⑥ 若做「扩张窗口标准化」会发生什么 ---------- */
console.log('\n===== ⑥ 扩张窗口标准化（无前视）模拟 =====');
function expandStd(c, minN, floor) {
  const out = new Array(c.length).fill(null);
  let s = 0, s2 = 0, k = 0;
  for (let i = 0; i < c.length; i++) {
    if (k >= minN) {
      const m = s / k, v = Math.max(s2 / k - m * m, 1e-12), sg = Math.max(Math.sqrt(v), floor);
      out[i] = (c[i] - m) / sg;
    }
    s += c[i]; s2 += c[i] * c[i]; k++;
  }
  return out;
}
const cs = []; const cIdx = [];
for (let i = rep.start; i < rep.n; i++) {
  let s = 0, ws = 0, k = 0;
  for (const id of ids) { const v = rep.fvals[id][i]; if (v == null) continue; const w = W[id] ? W[id].w : 1; s += v * w; ws += w; k++; }
  if (k >= 3 && ws) { cs.push(s / ws); cIdx.push(i); }
}
for (const floor of [0.15, 0.25, 0.4]) {
  const z = expandStd(cs, 120, floor);
  const zz = z.filter(v => v != null);
  const sc = zz.map(v => Math.round(50 + 22 * Math.max(-2.5, Math.min(2.5, v))));
  console.log('  σ下限=' + floor + '：z 标准差 ' + N(sd(zz)) + '  |z|均值 ' + N(mean(zz.map(Math.abs))) +
    '  评分范围 [' + Math.min(...sc) + ', ' + Math.max(...sc) + ']  评分 sd ' + N(sd(sc)) +
    '  触发下限占比 ' + (zz.filter(v => Math.abs(v) > 2.5 / 1e9 && false).length) + '');
}
const z1 = expandStd(cs, 120, 0.25);
const wOld = cs.map(c => Math.max(-1, Math.min(1, (50 + 22 * c - 50) / 50)));
const wNew = z1.map(v => v == null ? null : Math.max(-1, Math.min(1, v / 2.5)));
console.log('  仓位 |w| 对比：线性映射 平均 ' + N(mean(wOld.map(Math.abs))) + ' / p95 ' + N(q(wOld.map(Math.abs), .95)) +
  '  →  标准化后 平均 ' + N(mean(wNew.filter(v => v != null).map(Math.abs))) + ' / p95 ' + N(q(wNew.filter(v => v != null).map(Math.abs), .95)));
console.log('  ⚠ 关键警示：σ 很小时除以 σ 会放大噪声。σ 的分位：p05=' + N(q([], 0)) + '');

/* σ 序列本身 */
const sig = []; let s = 0, s2 = 0, k = 0;
for (let i = 0; i < cs.length; i++) { if (k >= 120) sig.push(Math.sqrt(Math.max(s2 / k - (s / k) * (s / k), 1e-12))); s += cs[i]; s2 += cs[i] * cs[i]; k++; }
console.log('  滚动 σ 分位：p05=' + N(q(sig, .05)) + ' p25=' + N(q(sig, .25)) + ' p50=' + N(q(sig, .5)) + ' p75=' + N(q(sig, .75)) + ' p95=' + N(q(sig, .95)) + '   最小 ' + N(Math.min(...sig)));
console.log('  → σ 最小值 ' + N(Math.min(...sig)) + '：若下限设太高，下限会长期生效（等于换了个常数标尺）；太低则在 σ 塌陷期放大噪声');
