/* v3.36 新模块单元测试：regimeConfidence / riskMetrics / volTargetWeight / explainScore / window.Nexus
 * 用与 regression.js 相同的 vm 沙箱加载 app.js，直接对纯函数做断言（不依赖 DOM/网络）。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = {
  console, setTimeout: () => 0, clearTimeout: () => 0, setInterval: () => 0,
  requestAnimationFrame: () => 0, devicePixelRatio: 1,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
  document: {
    getElementById: () => ({ style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {}, getContext: () => new Proxy({}, { get: () => () => {} }), appendChild() {}, addEventListener() {} }),
    querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} }),
    addEventListener() {},
  },
  window: { addEventListener() {}, devicePixelRatio: 1 },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  Math, Date, JSON, Number, isFinite, isNaN, parseFloat, encodeURIComponent, AbortController,
  Intl, Map, Set, Array, Object, String, Boolean, Error, Infinity, NaN,
};
sandbox.globalThis = sandbox;

const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });

const run = e => vm.runInContext(e, sandbox);
let fail = 0;
const chk = (label, actual, expect) => {
  const ok = String(actual) === String(expect);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}: 实际=${actual}  期望=${expect}`);
};
const ok = (label, cond) => { if (!cond) fail++; console.log(`  ${cond ? '✅' : '❌'} ${label}`); };

/* ---- ① regimeConfidence ---- */
console.log('===== ① regimeConfidence（模型谦逊 / 索罗斯·罗杰斯） =====');
run(`var __high = { c: 1.2, out: {
  a:{ok:true,dir:1,contribution:1}, b:{ok:true,dir:1,contribution:0.8}, c:{ok:true,dir:-1,contribution:-0.5},
  d:{ok:true,dir:1,contribution:0.9}, e:{ok:true,dir:1,contribution:0.7}, f:{ok:true,dir:1,contribution:0.6} } };`);
const high = run('regimeConfidence(__high)');
chk('  高度一致 → HIGH', high.level, 'HIGH');
chk('  同向计数 agree', high.agree, 5);
chk('  参与总数 total', high.total, 6);

run(`var __low = { c: 0.05, out: {
  a:{ok:true,dir:1,contribution:1}, b:{ok:true,dir:-1,contribution:-1}, c:{ok:true,dir:1,contribution:0.9}, d:{ok:true,dir:-1,contribution:-0.8} } };`);
const low = run('regimeConfidence(__low)');
chk('  方向不明确/分歧 → LOW', low.level, 'LOW');

run(`var __mix = { c: -0.8, out: {
  a:{ok:true,dir:1,contribution:1}, b:{ok:true,dir:1,contribution:0.5}, c:{ok:true,dir:-1,contribution:-0.9},
  d:{ok:true,dir:-1,contribution:-0.7}, e:{ok:true,dir:1,contribution:0.3} } };`);
const mix = run('regimeConfidence(__mix)');
// net<0：a,b,e(+)=3 同意；c,d(-)=2 反对 → agree 3/total5=0.6 → HIGH（边界）
chk('  净空但多数同向 → 不低于 MED', mix.level === 'HIGH' || mix.level === 'MED', true);

/* ---- ② riskMetrics ---- */
console.log('===== ② riskMetrics（对冲基金：下行/尾部风险） =====');
const rm1 = run('riskMetrics([0,0,0,0,0], 252)');
chk('  全零序列 var95=0', rm1.var95, 0);
chk('  全零序列 cvar95=0', rm1.cvar95, 0);
const rm2 = run('riskMetrics([-0.1,0.1,-0.1,0.1,-0.1], 252)');
chk('  5% VaR = 最差尾部 -0.1', rm2.var95, -0.1);
chk('  CVaR = 尾部均值 -0.1', rm2.cvar95, -0.1);
ok('  Sortino 为有限数', isFinite(rm2.sortino));
const rm3 = run('riskMetrics([0.02,0.03,-0.01,0.015,-0.02,0.01], 365)');
ok('  常规序列 var95 为负（损失侧）', rm3.var95 < 0);
ok('  常规序列 cvar95 <= var95（更悲观）', rm3.cvar95 <= rm3.var95 + 1e-9);

/* ---- ③ volTargetWeight ---- */
console.log('===== ③ volTargetWeight（波动目标仓位） =====');
chk('  已实现波动 4% → 目标 2% ⇒ 0.5', run('volTargetWeight(0.04, 0.02)'), 0.5);
chk('  波动为 0 ⇒ 不持仓(0)', run('volTargetWeight(0, 0.02)'), 0);
chk('  目标 > 已实现 ⇒ 封顶 2x', run('volTargetWeight(0.01, 0.05)'), 2);

/* ---- ④ explainScore（本地解释器，无外部 API） ---- */
console.log('===== ④ explainScore（本地推理层 / 黄仁勋·CZ） =====');
const exp = run('explainScore(__high)');
ok('  返回非空字符串', typeof exp === 'string' && exp.length > 0);
ok('  含「综合评分」', exp.indexOf('综合评分') >= 0);
ok('  含「主导因子」', exp.indexOf('主导因子') >= 0);

/* ---- ⑤ window.Nexus 程序化 API（平台化） ---- */
console.log('===== ⑤ window.Nexus 程序化 API =====');
chk('  window.Nexus 已暴露', run('typeof window.Nexus'), 'object');
chk('  version = 3.36', run('window.Nexus.version'), '3.36');
chk('  risk 即 riskMetrics', run('window.Nexus.risk === riskMetrics'), true);
chk('  volTarget 即 volTargetWeight', run('window.Nexus.volTarget === volTargetWeight'), true);
ok('  getScore 可调用并返回对象', (() => { try { const r = run('window.Nexus.getScore()'); return r && typeof r.score === 'number'; } catch (e) { return false; } })());

console.log(fail === 0 ? '\n✅ v3.36 全部断言通过' : `\n❌ v3.36 失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
