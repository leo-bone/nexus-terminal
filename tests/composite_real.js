/* v3.26 真实数据实测：分类合成 vs 单因子 vs 全池（真实十年数据） */
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
const t0 = Date.now();
const S = call('factorScreening');
console.log('筛选耗时', (Date.now() - t0) + 'ms', '进入筛选', S.nScreened);

console.log('\n=== 交叉验算：CMP.single 是否复现 v3.25 的 universeScore ===');
const US = call('universeScore', S);
const t1 = Date.now();
const C = call('categoryComposite', S);
console.log('分类合成耗时', (Date.now() - t1) + 'ms');
if (!C) { console.log('categoryComposite null'); process.exit(1); }
const f = v => v == null ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(4);
[['样本内', 'icIn'], ['样本外', 'icOut'], ['全样本', 'icAll']].forEach(([n, k]) => {
  const a = US[k], b = C.single[k];
  console.log('  ' + n.padEnd(6) + 'v3.25 ' + f(a && a.ic) + '   v3.26 ' + f(b && b.ic) +
    '   差 ' + ((a && b) ? (a.ic - b.ic).toExponential(2) : '—'));
});

console.log('\n=== 切点', dstr(C.cutDate), '视野', C.h, '日 | 因子', C.nFactor, '分类', C.nCat, '===');

console.log('\n=== 三种权重方案（各自按样本内 |IC| 重挑 Top-' + C.k + ' 分类）===');
C.schemes.forEach(s => {
  console.log('  ' + s.scheme.padEnd(6) + s.zh.padEnd(20) +
    ' 内 ' + f(s.icIn && s.icIn.ic) + ' (t' + (s.icIn ? s.icIn.t.toFixed(2) : '—') + ')' +
    '  外 ' + f(s.icOut && s.icOut.ic) + ' (t' + (s.icOut ? s.icOut.t.toFixed(2) : '—') + ')' +
    '  全 ' + f(s.icAll && s.icAll.ic) + '  选:' + (s.zhs || s.cats).join(','));
});

console.log('\n=== 样本外分段稳定性（把后 40% 再切段，看是一直稳还是一段撑起来的）===');
const segLine = (n, v) => {
  if (!v || !v.segs) { console.log('  ' + n.padEnd(16) + '—'); return; }
  const same = v.segs.filter(s => s.ic != null && (s.ic > 0) === (v.icIn && v.icIn.ic > 0)).length;
  console.log('  ' + n.padEnd(16) + '样本外 ' + f(v.icOut && v.icOut.ic) +
    '  分段 [' + v.segs.map(s => (s.ic == null ? '—' : f(s.ic))).join(' ') + ']' +
    '  同号 ' + same + '/' + v.segs.length +
    '  滚动胜率 ' + (v.roll ? (v.roll.win * 100).toFixed(0) + '%(' + v.roll.n + '窗)' : '—'));
};
C.schemes.forEach(s => segLine(s.scheme, s));
segLine('单因子Top' + C.k1, C.single);
segLine('分类Top' + C.k, C.cat);
segLine('全池等权', C.pool);
segLine('内生', C.endoExo.endo);
segLine('外生', C.endoExo.exo);

console.log('\n=== 内生 vs 外生（各自全部类的等权合成）===');
[['内生（加密市场内部）', C.endoExo.endo], ['外生（外部打进来）', C.endoExo.exo]].forEach(([n, v]) => {
  if (!v) { console.log('  ' + n + ' —'); return; }
  console.log('  ' + n.padEnd(22) + 'n类=' + v.n + '  内 ' + f(v.icIn && v.icIn.ic) + '  外 ' + f(v.icOut && v.icOut.ic) + '  全 ' + f(v.icAll && v.icAll.ic) + '  [' + v.cats.join(',') + ']');
});
if (C.agreeDiag) {
  console.log('\n=== 诊断：类内一致性 vs 样本外 IC ===');
  console.log('  秩相关 rho = ' + f(C.agreeDiag.rho) + '  (n=' + C.agreeDiag.n + ' 个分类)');
  console.log('  低一致性组 样本外均值 ' + f(C.agreeDiag.loAvg) + '  [' + C.agreeDiag.loCats.join(',') + ']');
  console.log('  高一致性组 样本外均值 ' + f(C.agreeDiag.hiAvg) + '  [' + C.agreeDiag.hiCats.join(',') + ']');
}

console.log('\n=== 三条对照（等权口径，同一切点同一视野）===');
const rep = (n, v) => '  ' + n.padEnd(24) + '内 ' + f(v.icIn && v.icIn.ic) + ' (t' + (v.icIn ? v.icIn.t.toFixed(2) : '—') + ')' +
  '  外 ' + f(v.icOut && v.icOut.ic) + ' (t' + (v.icOut ? v.icOut.t.toFixed(2) : '—') + ')' +
  '  全 ' + f(v.icAll && v.icAll.ic) + (v.icOut ? '  有效n ' + v.icOut.neff : '');
rep('① 单因子 Top-' + C.k1 + '（细挑）', C.single);
rep('② 分类合成 Top-' + C.k + '（降维）', C.cat);
rep('③ 全池等权（不挑）', C.pool);

console.log('\n=== 逐分类（等权合成，按样本内 |IC| 降序）===');
C.per.forEach(p => {
  console.log('  ' + (p.cat + '/' + p.zh).padEnd(18) + 'n=' + String(p.n).padStart(3) +
    '  类内一致性 ' + (p.agree == null ? '  —  ' : (p.agree >= 0 ? '+' : '') + p.agree.toFixed(3)).padStart(7) +
    '  内 ' + f(p.icIn && p.icIn.ic) + '  外 ' + f(p.icOut && p.icOut.ic) + (p.flip ? '  ⚠漂移' : ''));
});
console.log('\n  入选 Top-' + C.k + ':', C.picked.map(p => p.zh + '(' + (p.icIn && p.icIn.ic >= 0 ? '+' : '') + (p.icIn ? p.icIn.ic.toFixed(3) : '—') + ')').join(' '));

console.log('\n=== K 敏感性（真信号对 K 不敏感，过拟合只在一个点成立）===');
console.log('  K    ' + ['equal', 'ic', 'agree', 'lowAgree'].map(x => x.padStart(10)).join('') + '   (格内 = 样本外 IC)');
C.kSens.forEach(row => {
  console.log('  ' + String(row.k).padEnd(5) + ['equal', 'ic', 'agree', 'lowAgree'].map(sc => {
    const v = row.by[sc]; return f(v && v.icOut && v.icOut.ic).padStart(10);
  }).join(''));
});
console.log('  lowAgree 各 K 的分段同号数: ' + C.kSens.map(r => {
  const v = r.by.lowAgree; if (!v || !v.segs) return '—';
  const same = v.segs.filter(s => s.ic != null && s.ic > 0).length;
  return 'K' + r.k + ':' + same + '/' + v.segs.length;
}).join('  '));
console.log('  lowAgree 各 K 的滚动胜率:   ' + C.kSens.map(r => {
  const v = r.by.lowAgree; return 'K' + r.k + ':' + (v && v.roll ? (v.roll.win * 100).toFixed(0) + '%' : '—');
}).join('  '));

console.log('\n=== 留一法（去掉入选的任一类，剩下的还稳吗）===');
if (C.perLeave) {
  console.log('  全选 ' + C.k + ' 类: 外 ' + f(C.perLeave.all.icOut && C.perLeave.all.icOut.ic) +
    '  滚动胜率 ' + (C.perLeave.all.roll ? (C.perLeave.all.roll.win * 100).toFixed(0) + '%' : '—'));
  C.perLeave.each.forEach(e => {
    console.log('  去掉 ' + e.dropZh.padEnd(10) + ' 外 ' + f(e.r.icOut && e.r.icOut.ic) +
      '  分段 [' + (e.r.segs ? e.r.segs.map(s => s.ic == null ? '—' : f(s.ic)).join(' ') : '—') + ']' +
      '  胜率 ' + (e.r.roll ? (e.r.roll.win * 100).toFixed(0) + '%' : '—'));
  });
}

console.log('\n=== 风险监测读数（当前状态分位，非预测）===');
const RM = call('riskMonitor', S);
if (!RM) console.log('  null');
else RM.rows.forEach(r => {
  console.log('  ' + r.zh.padEnd(10) + '当前 ' + (r.now >= 0 ? '+' : '') + r.now.toFixed(3) +
    '  历史分位 ' + (r.pct * 100).toFixed(1) + '%' + (r.extreme ? '  【' + (r.extreme === 'high' ? '历史高位' : '历史低位') + '】' : '') +
    '  近60日 ' + (r.d60 == null ? '—' : (r.d60 >= 0 ? '+' : '') + r.d60.toFixed(3)) + '  n=' + r.n + '  @' + dstr(r.date));
});

console.log('\n=== 【关键证伪】这个信号是不是只是在复述 BTC 自己 ===');
const vline = (n, v) => {
  if (!v) { console.log('  ' + n.padEnd(20) + '—'); return; }
  console.log('  ' + n.padEnd(20) + '内 ' + f(v.icIn && v.icIn.ic) + '  外 ' + f(v.icOut && v.icOut.ic) +
    '  分段 [' + (v.segs ? v.segs.map(s => s.ic == null ? '—' : f(s.ic)).join(' ') : '—') + ']' +
    '  胜率 ' + (v.roll ? (v.roll.win * 100).toFixed(0) + '%' : '—'));
};
vline('BTC 自身同口径信号', C.btcOwn);
C.schemes.forEach(s => vline('残差: ' + s.scheme, s.incr));
vline('残差: 内生类', C.endoIncr);
const la = C.schemes.find(s => s.scheme === 'lowAgree');
if (la && la.incr) console.log('  lowAgree 对 BTC 自身信号的 β = ' + la.incr.beta.toFixed(3) + '（样本内估）');
if (C.endoIncr) console.log('  内生类对 BTC 自身信号的 β = ' + C.endoIncr.beta.toFixed(3) + '（样本内估）');

console.log('\n=== 判定 ===');
const so = C.single.icOut, co = C.cat.icOut, po = C.pool.icOut;
const g = v => v == null ? null : v.ic;
console.log('  单因子样本外 ' + f(g(so)) + ' → 分类合成样本外 ' + f(g(co)) + ' → 全池样本外 ' + f(g(po)));
if (g(co) != null && g(so) != null) {
  const d = g(co) - g(so);
  console.log('  分类合成 − 单因子 = ' + (d >= 0 ? '+' : '') + d.toFixed(4) +
    (Math.abs(d) < 0.01 ? '  （差别在噪声量级内：降维没有买到稳定性）' :
      d > 0 ? '  （降维改善了样本外）' : '  （降维反而更差）'));
}
const maxO = Math.max(Math.abs(g(co) || 0), Math.abs(g(so) || 0), Math.abs(g(po) || 0));
console.log('  三条路样本外 |IC| 最大 ' + maxO.toFixed(4) +
  (maxO < 0.03 ? '  ⇒ 全部接近零：分类合成也救不了，结论就是「不适合方向择时」' : '  ⇒ 需要再看显著性'));

console.log('\n=== 渲染冒烟 ===');
try { state.screening = S; state.composite = C; call('renderUniverseBox'); console.log('  renderUniverseBox OK len', (reg['uniBox'].innerHTML || '').length); }
catch (e) { console.log('  renderUniverseBox FAIL', e.message, e.stack && e.stack.split('\n')[1]); }
try {
  call('renderCompositeInto', S);
  const n = reg['cmpBox'];
  const html = (n && (n.outerHTML || n.innerHTML)) || '';
  console.log('  renderCompositeInto OK len', html.length);
  ['分类合成', '关键证伪', '风险监测读数', '留一法', 'K 敏感性'].forEach(k => {
    console.log('    含「' + k + '」:', html.indexOf(k) >= 0);
  });
  console.log('    含 undefined/NaN:', /undefined|NaN/.test(html));
} catch (e) { console.log('  renderCompositeInto FAIL', e.message, e.stack && e.stack.split('\n')[1]); }
process.exit(0);
