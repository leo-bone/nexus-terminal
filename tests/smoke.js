/* 运行时冒烟测试：在 vm 沙箱里加载 app.js，灌入模拟数据，跑 refreshAll + computeNexusScore */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const N = 160;
const now = Date.now();
const days = (n, start) => Array.from({ length: n }, (_, i) => start + i * 86400000);
const series = (n, base, amp) => Array.from({ length: n }, (_, i) => base + Math.sin(i / 7) * amp + i * (amp / 50));
const ts = days(N, now - N * 86400000);

function payload(rawu) {
  const u = decodeURIComponent(String(rawu));
  if (u.includes('market/tickers') && u.includes('category=spot'))
    return { result: { list: [{ lastPrice: '80000', price24hPcnt: '0.012', highPrice24h: '81000', lowPrice24h: '78000', turnover24h: '1234567' }] } };
  if (u.includes('market/kline'))
    return { result: { list: Array.from({ length: 220 }, (_, i) => [now - i * 86400000, 79000 + i, 80000 + i, 78000 + i, 79500 + i, 100 + i]) } };
  if (u.includes('market/tickers') && u.includes('category=linear'))
    return { result: { list: [{ fundingRate: '0.00012' }] } };
  if (u.includes('open-interest'))
    return { result: { list: Array.from({ length: 200 }, (_, i) => ({ openInterest: String(1000 + i * 3), timestamp: String(now - i * 86400000) })) } };
  if (u.includes('account-ratio'))
    return { result: { list: Array.from({ length: 200 }, (_, i) => ({ buyRatio: String(0.5 + Math.sin(i / 9) * 0.08), timestamp: String(now - i * 86400000) })) } };
  if (u.includes('coinpaprika'))
    return { market_cap_usd: 2.6e12, bitcoin_dominance_percentage: 57.3 };
  if (u.includes('stablecoins.llama.fi'))
    return { peggedAssets: [{ circulating: { peggedUSD: 1.8e11 } }, { circulating: { peggedUSD: 1.3e11 } }] };
  if (u.includes('blockchain.info'))
    return { values: ts.map(t => ({ x: Math.floor(t / 1000), y: 600000 + Math.random() * 200000 })) };
  if (u.includes('alternative.me'))
    return { data: Array.from({ length: 90 }, (_, i) => ({ value: String(40 + Math.round(Math.sin(i / 6) * 25)), value_classification: 'Neutral', timestamp: String(Math.floor((now - i * 86400000) / 1000)) })) };
  if (u.includes('mempool.space'))
    return { hashrates: Array.from({ length: 365 }, (_, i) => ({ timestamp: now - i * 86400000, avgHashrate: 5e20 + i * 1e18 })) };
  if (u.includes('/api/snapshot')) {
    const keys = ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX', 'OIL', 'BRENT', 'AGRI', 'EFFR', 'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10', 'USDJPY', 'JGB10Y'];
    const base = { DXY: 101, US10Y: 5.2, GOLD: 4190, SPX: 7650, VIX: 16, OIL: 89, BRENT: 97, AGRI: 28, EFFR: 3.88, UST2Y: 4.88, T10Y2Y: 0.41, REAL10Y: 2.93, BEI10: 2.36, USDJPY: 158, JGB10Y: 3.06 };
    const S = {}, D = {}, M = {}, SRC = {};
    keys.forEach(k => { const n = k === 'EFFR' ? 300 : 160; S[k] = series(n, base[k], base[k] * 0.02); D[k] = ts.slice(-n); M[k] = S[k][S[k].length - 1]; SRC[k] = k === 'EFFR' ? 'nyfed' : 'yahoo:TEST'; });
    return { macro: M, series: S, dates: D, _prev: M, _src: SRC, ts: now };
  }
  if (u.includes('/api/calendar')) {
    const d = h => new Date(now + h * 3600000).toISOString();
    return { ts: now, events: [
      { t: d(-72), title: 'CB Consumer Confidence',       impact: 'Medium', f: '89.2', p: '89.4', a: '88.9' },
      { t: d(-24), title: 'Core PCE Price Index m/m',     impact: 'High',   f: '0.3%', p: '0.2%', a: '0.4%' },
      { t: d(-6),  title: 'Unemployment Claims',          impact: 'Medium', f: '201K', p: '197K', a: '205K' },
      { t: d(6),   title: 'Non-Farm Employment Change',   impact: 'High',   f: '90K',  p: '162K', a: '' },
      { t: d(6),   title: 'Unemployment Rate',            impact: 'High',   f: '4.1%', p: '4.1%', a: '' },
    ] };
  }
  throw new Error('unhandled url ' + u);
}

const ctxStub = new Proxy({}, { get: () => () => {} });
const _reg = {};
const el = (id) => ({ _id: id,
  style: {}, classList: { add() {}, remove() {} }, dataset: {}, firstChild: null,
  appendChild() {}, setAttribute() {}, addEventListener() {}, getContext: () => ctxStub,
  innerHTML: '', textContent: '', title: '', className: '', width: 0, height: 0,
  clientWidth: 800, clientHeight: 400, options: [],
  get value() { return ({ btCoin: 'BTC', btInterval: '1d', btF: '10', btS: '30', btFee: '6', ptSym: 'BTC', ptAmt: '1000' })[this._id] || 'BTC'; },
  set value(v) {}
});

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval: () => 0,
  requestAnimationFrame: () => {},
  devicePixelRatio: 1,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: {
    getElementById: (id) => (_reg[id] || (_reg[id] = el(id))),
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener() {},
  },
  window: { addEventListener() {}, devicePixelRatio: 1 },
  fetch: async (u) => ({ ok: true, json: async () => payload(String(u)) }),
  Math, Date, JSON, Number, isFinite, isNaN, parseFloat, encodeURIComponent, AbortController,
  Intl, Map, Set, Array, Object, String, Boolean, Error, Infinity, NaN,
};
sandbox.globalThis = sandbox;
sandbox.window.devicePixelRatio = 1;

const code = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'app.js'), 'utf8');
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'app.js' });
} catch (e) { console.error('LOAD ERROR:', e.message); process.exit(1); }

(async () => {
  try {
    await sandbox.refreshAll();
  } catch (e) { console.error('refreshAll ERROR:', e.stack || e.message); process.exit(1); }
  try {
    const r = sandbox.computeNexusScore();
    console.log('Nexus Score =', r.score);
    const ids = Object.keys(r.out);
    console.log('因子数 =', ids.length);
    console.log(ids.map(k => `${k}[dir${r.out[k].dir}]z=${r.out[k].z.toFixed(2)}/c=${r.out[k].contribution.toFixed(2)}`).join(' '));
    const anyNaN = ids.filter(k => !isFinite(r.out[k].z) || !isFinite(r.out[k].contribution));
    if (anyNaN.length) { console.error('NaN 因子: ' + anyNaN.join(',')); process.exit(1); }
    console.log('ALL Z / CONTRIBUTION FINITE OK  (参与评分 =', r.nScored, ')');
    const badDir = ids.filter(k => ![1, -1, 0].includes(r.out[k].dir));
    if (badDir.length) { console.error('非法 dir: ' + badDir.join(',')); process.exit(1); }
  } catch (e) { console.error('score ERROR:', e.stack || e.message); process.exit(1); }
  try { sandbox.renderHeatmap(); console.log('heatmap OK'); } catch (e) { console.error('heatmap ERROR:', e.message); process.exit(1); }
  try {
    const keys = vm.runInContext('netKeys()', sandbox);
    console.log('net keys(' + keys.length + '):', keys.join(','));
    const corr = vm.runInContext("netKeys().map(k=>k+':'+(pearsonMaps(state.retMaps[k],state.retMaps.BTC)||0).toFixed(2)).join(' ')", sandbox);
    console.log('corr vs BTC:', corr);
  } catch(e){ console.error('corr ERROR:', e.message); }
  try { sandbox.renderEcon(); console.log('renderEcon OK, econ events =', vm.runInContext('state.econ.length', sandbox)); } catch (e) { console.error('renderEcon ERROR:', e.stack || e.message); process.exit(1); }
  try { await sandbox.renderBacktest(); console.log('backtest OK'); } catch (e) { console.error('backtest ERROR:', e.stack || e.message); process.exit(1); }
  try {
    vm.runInContext("state.acct = null", sandbox);
    sandbox.renderPaper();
    vm.runInContext("document.getElementById('ptAmt')", sandbox);
    sandbox.paperBuy();
    const cash = vm.runInContext('state.acct.cash', sandbox);
    console.log('paper OK, cash after buy =', cash, ', positions =', vm.runInContext('state.acct.positions.length', sandbox));
  } catch (e) { console.error('paper ERROR:', e.stack || e.message); process.exit(1); }
  console.log('SMOKE TEST PASSED');
})();
