/* v3.25 真实数据实测：因子宇宙 + 影响强度分层 */
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

const t0 = Date.now();
const S = call('factorScreening');
const ms = Date.now() - t0;
if (!S) { console.log('screening null'); process.exit(1); }
const dstr = t => new Date(t).toISOString().slice(0, 10);
console.log('=== 因子宇宙筛选（真实十年数据）===');
console.log('候选', S.nTotal, '进入筛选', S.nScreened, '样本不足', S.nShort, '耗时', ms + 'ms');
console.log('BTC 区间', dstr(S.btcSpan.t0), '→', dstr(S.btcSpan.t1), '主视野', S.h, '日');
console.log('分层: 强', S.byTier.strong.length, '中', S.byTier.mid.length, '弱', S.byTier.weak.length);
console.log('\n--- 按分类 ---');
Object.keys(S.catStat).sort((a, b) => S.catStat[b].absAvg - S.catStat[a].absAvg).forEach(c => {
  const v = S.catStat[c];
  console.log('  ' + c.padEnd(12) + 'n=' + String(v.n).padStart(3) + '  强' + String(v.strong).padStart(3) + ' 中' + String(v.mid).padStart(3) + ' 弱' + String(v.weak).padStart(3) + '  平均|IC| ' + v.absAvg.toFixed(4));
});
const row = r => '  ' + (r.key + '').padEnd(12) + (r.ic >= 0 ? '+' : '') + r.ic.toFixed(3).padStart(7) +
  '  ICIR ' + (r.icir == null ? '  —  ' : r.icir.toFixed(2).padStart(5)) +
  '  胜率 ' + (r.winRate == null ? '—' : (r.winRate * 100).toFixed(0) + '%').padStart(4) +
  '  q ' + r.q.toFixed(3) + '  内' + (r.icIn == null ? '  —  ' : r.icIn.toFixed(3).padStart(6)) + '→外' + (r.icOut == null ? '  —  ' : r.icOut.toFixed(3).padStart(6)) + (r.flip ? ' ⚠' : '') +
  '  hl ' + (r.hl == null ? '>20' : r.hl.toFixed(1)) + '  n=' + r.n + '  ' + (r.exo ? '外生' : '内生');
console.log('\n--- 强影响 (top 20) ---');
S.byTier.strong.slice(0, 20).forEach(row);
console.log('\n--- 中影响 (top 10) ---');
S.byTier.mid.slice(0, 10).forEach(row);
console.log('\n--- 弱影响里 |IC| 最大的 8 个（看看为什么没进强档）---');
S.byTier.weak.slice(0, 8).forEach(row);

console.log('\n=== 宇宙评分：前 60% 选 / 后 40% 验 ===');
const US = call('universeScore', S);
if (!US) console.log('universeScore null');
else {
  console.log('Top-K', US.k, '切点', dstr(US.cutDate));
  [['样本内', US.icIn], ['样本外', US.icOut], ['全样本', US.icAll]].forEach(([n, v]) => {
    console.log('  ' + n.padEnd(6) + 'IC ' + (v ? (v.ic >= 0 ? '+' : '') + v.ic.toFixed(4) : '—') + '  t ' + (v ? v.t.toFixed(2) : '—') + '  n ' + (v ? v.n : '—') + '  有效n ' + (v ? v.neff : '—'));
  });
  console.log('  入选:', US.dirs.map(d => d.key + '(' + (d.dir > 0 ? '+' : '-') + d.ic.toFixed(3) + ')').join(' '));
}
console.log('\n=== 渲染冒烟 ===');
try { call('renderUniverseBox'); console.log('  renderUniverseBox OK, len', (reg['uniBox'].innerHTML || '').length); }
catch (e) { console.log('  renderUniverseBox FAIL', e.message); }
try { state.screening = S; const ok = call('initRadial', el('netCanvas')); console.log('  initRadial ->', ok, 'net layout', ev('net && net.layout'), 'nodes', ev('net && net.nodes.length')); }
catch (e) { console.log('  initRadial FAIL', e.message); }
