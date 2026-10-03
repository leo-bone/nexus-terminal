/* v3.22 真实十年数据实测：㉒ 换手率与可执行性 / ㉓ 信号健康度 */
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
st.klines['BTC1d'] = rep.calTs.map((t, i) => ({ t, c: rep.closes[i], o: rep.closes[i], h: rep.closes[i], l: rep.closes[i], v: 0 }));

const f = t => new Date(t).toISOString().slice(0, 10);
console.log('窗口 ' + f(rep.calTs[rep.start]) + ' → ' + f(rep.calTs[rep.n - 1]));

/* ---------------- ㉒ 换手率与可执行性 ---------------- */
let t1 = Date.now();
const E = ev('execAnalysis')(rep);
console.log('\n===== ㉒ 换手率与可执行性 =====  耗时 ' + (Date.now() - t1) + 'ms');
if (!E) console.log('  null');
else {
  const P = v => (v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%');
  console.log('  交易日 ' + E.days);
  console.log('  年化：毛 ' + P(E.grossY) + '   成本 −' + (E.costY * 100).toFixed(2) + '%   净 ' + P(E.netY) + '   买入持有 ' + P(E.bhY));
  console.log('  夏普：毛 ' + (E.shG == null ? '—' : E.shG.toFixed(2)) + '   净 ' + (E.shN == null ? '—' : E.shN.toFixed(2)) + '   躺平 ' + (E.shB == null ? '—' : E.shB.toFixed(2)));
  console.log('  日均换手 ' + E.turnD.toFixed(5) + '   盈亏平衡换手 ' + (E.beTurn == null ? '—' : E.beTurn.toFixed(5)) +
    '   实际/平衡 = ' + (E.beTurn ? (E.turnD / E.beTurn).toFixed(1) + ' 倍' : '—'));
  console.log('  成本占毛收益 ' + (E.costShare == null ? '—' : (E.costShare * 100).toFixed(0) + '%'));
  console.log('  日度方向命中率 ' + (E.hitRate * 100).toFixed(1) + '%   精确二项 p = ' + (E.hitP == null ? '—' : E.hitP.toFixed(4)));
  console.log('  躺平命中率 ' + (E.bhHitRate * 100).toFixed(1) + '%   边际命中 = ' + (E.hitEdge >= 0 ? '+' : '') + (E.hitEdge * 100).toFixed(1) + ' pp');
  console.log('  评分自相关 lag1 ' + (E.ac[1] == null ? '—' : E.ac[1].toFixed(3)) +
    '  lag5 ' + (E.ac[5] == null ? '—' : E.ac[5].toFixed(3)) +
    '  lag10 ' + (E.ac[10] == null ? '—' : E.ac[10].toFixed(3)) +
    '  lag20 ' + (E.ac[20] == null ? '—' : E.ac[20].toFixed(3)));
  console.log('  符号翻转率 ' + (E.flipRate == null ? '—' : (E.flipRate * 100).toFixed(1) + '%') +
    '   平均连续同向 ' + (E.meanRun == null ? '—' : E.meanRun.toFixed(1)) + ' 天');
}

/* ---------------- ㉓ 信号健康度 ---------------- */
t1 = Date.now();
const S = ev('signalHealth')(rep, 10);
console.log('\n===== ㉓ 信号健康度 =====  耗时 ' + (Date.now() - t1) + 'ms');
if (!S) console.log('  null');
else {
  console.log('  判定：<b>' + S.label + '</b> (key=' + S.key + ')   最近 ' + S.win + ' 天');
  console.log('  全样本 IC ' + (S.icFull == null ? '—' : S.icFull.toFixed(3)) + ' (t=' + (S.tFull == null ? '—' : S.tFull.toFixed(2)) + ', n=' + S.nFull + ')');
  console.log('  最近段 IC ' + (S.icRecent == null ? '—' : S.icRecent.toFixed(3)) + ' (t=' + (S.tRecent == null ? '—' : S.tRecent.toFixed(2)) + ', n=' + S.nRecent + ')');
  console.log('  对照段 IC ' + (S.icComp == null ? '—' : S.icComp.toFixed(3)) + ' (n=' + S.nComp + ')');
  console.log('  Fisher-z 两独立样本 z = ' + (S.z == null ? '—' : S.z.toFixed(2)) + '   p = ' + (S.p == null ? '—' : S.p.toFixed(4)));
  console.log('  最近段滚动 IC 为正的比例 = ' + (S.posShare == null ? '—' : (S.posShare * 100).toFixed(0) + '%'));
  if (S.mde) console.log('  MDE: n_eff 最近=' + S.neffRecent + ' 对照=' + S.neffComp + '  检测带 [' + S.mde.rLo.toFixed(3) + ', ' + S.mde.rHi.toFixed(3) + ']  se=' + S.mde.zSe.toFixed(3));
}

/* ---------------- ㉑ 台账：用回放末段构造一份「伪台账」验证结算逻辑 ---------------- */
console.log('\n===== ㉑ 台账结算逻辑（用日线序列喂进去验证）=====');
const L = { rows: [], n: 0, nRes: 0 };
const k = st.klines['BTC1d'];
for (let i = Math.max(0, k.length - 60); i + 10 < k.length; i += 1) {
  const fake = 50 + ((i % 7) - 3) * 8;   // 随便一个摆动序列
  L.rows.push({ d: f(k[i].t), s: fake, p: k[i].c, r: k[i + 10].c / k[i].c - 1 });
}
L.n = L.rows.length; L.nRes = L.rows.length;
const LS = ev('ledgerStats')(L);
console.log('  n=' + LS.n + ' 已结算=' + LS.nRes + ' enough=' + LS.enough);
console.log('  命中率 ' + (LS.hitRate == null ? '—' : (LS.hitRate * 100).toFixed(1) + '%') + ' (' + LS.hit + '/' + LS.nDir + ')  精确二项 p = ' + (LS.hitP == null ? '—' : LS.hitP.toFixed(4)));
console.log('  IC ' + (LS.ic == null ? '—' : LS.ic.toFixed(3)) + '  t=' + (LS.t == null ? '—' : LS.t.toFixed(2)) + '  基准 ' + (LS.base * 100).toFixed(3) + '%');
