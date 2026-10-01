/* 修复验证测试：回测 v2 + 模拟盘 v2 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const N = 160, now = Date.now();
const days = (n, s) => Array.from({ length: n }, (_, i) => s + i * 86400000);
const series = (n, base, amp) => Array.from({ length: n }, (_, i) => base + Math.sin(i / 7) * amp + i * (amp / 50));
const ts = days(N, now - N * 86400000);

function makeKl() {
  const out = []; let p = 100;
  [[60, 1.02], [50, 0.98], [60, 1.02], [50, 0.98]].forEach(([len, mul]) => {
    for (let i = 0; i < len; i++) { const o = p; p = p * mul; out.push({ t: now + out.length * 3600000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 100 }); }
  });
  return out;
}
const KL = makeKl();

function payload(rawu) {
  const u = decodeURIComponent(String(rawu));
  if (u.includes('market/kline')) return { result: { list: [...KL].reverse().map(k => [k.t, k.o, k.h, k.l, k.c, k.v]) } };
  if (u.includes('market/tickers') && u.includes('category=spot'))
    return { result: { list: [{ lastPrice: '80000', price24hPcnt: '0.012', highPrice24h: '81000', lowPrice24h: '78000', turnover24h: '1234567' }] } };
  if (u.includes('market/tickers') && u.includes('category=linear')) return { result: { list: [{ fundingRate: '0.00012' }] } };
  if (u.includes('open-interest')) return { result: { list: Array.from({ length: 200 }, (_, i) => ({ openInterest: String(1000 + i * 3), timestamp: String(now - i * 86400000) })) } };
  if (u.includes('account-ratio')) return { result: { list: Array.from({ length: 200 }, (_, i) => ({ buyRatio: String(0.5 + Math.sin(i / 9) * 0.08), timestamp: String(now - i * 86400000) })) } };
  if (u.includes('coinpaprika')) return { market_cap_usd: 2.6e12, bitcoin_dominance_percentage: 57.3 };
  if (u.includes('stablecoins.llama.fi')) return { peggedAssets: [{ circulating: { peggedUSD: 1.8e11 } }] };
  if (u.includes('blockchain.info')) return { values: ts.map(t => ({ x: Math.floor(t / 1000), y: 600000 })) };
  if (u.includes('alternative.me')) return { data: Array.from({ length: 90 }, (_, i) => ({ value: '50', value_classification: 'Neutral', timestamp: String(Math.floor((now - i * 86400000) / 1000)) })) };
  if (u.includes('mempool.space')) return { hashrates: Array.from({ length: 365 }, (_, i) => ({ timestamp: now - i * 86400000, avgHashrate: 5e20 })) };
  if (u.includes('/api/snapshot')) {
    const keys = ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX', 'OIL', 'BRENT', 'AGRI', 'EFFR', 'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10'];
    const base = { DXY: 101, US10Y: 5.2, GOLD: 4190, SPX: 7650, VIX: 16, OIL: 89, BRENT: 97, AGRI: 28, EFFR: 3.88, UST2Y: 4.88, T10Y2Y: 0.41, REAL10Y: 2.93, BEI10: 2.36 };
    const S = {}, D = {}, M = {}, SRC = {};
    keys.forEach(k => { const n = k === 'EFFR' ? 300 : 160; S[k] = series(n, base[k], base[k] * 0.02); D[k] = ts.slice(-n); M[k] = S[k][S[k].length - 1]; SRC[k] = 'yahoo:TEST'; });
    return { macro: M, series: S, dates: D, _prev: M, _src: SRC, ts: now };
  }
  if (u.includes('/api/calendar')) return { ts: now, events: [] };
  throw new Error('unhandled url ' + u);
}

const reg = {};
const ctxStub = new Proxy({}, { get: () => () => {} });
function makeEl(id) {
  return {
    id, style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', className: '',
    width: 0, height: 0, clientWidth: 800, clientHeight: 400, value: '', options: [],
    _cls: new Set(), _h: {},
    classList: { add(c) { this._o._cls.add(c); }, remove(c) { this._o._cls.delete(c); }, contains(c) { return this._o._cls.has(c); } },
    appendChild() {}, setAttribute() {}, getContext: () => ctxStub,
    addEventListener(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
  };
}
const $id = id => (reg[id] || (reg[id] = (() => { const e = makeEl(id); e.classList._o = e; return e; })()));
/* 策略 tab 元素 */
const TABS = ['ma', 'rsi', 'brk'].map(s => { const e = makeEl('tab-' + s); e.classList._o = e; e.dataset = { s }; return e; });

const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0,
  requestAnimationFrame: () => {}, devicePixelRatio: 1,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
  document: {
    getElementById: $id,
    querySelectorAll: sel => sel === '.bt-tab' ? TABS : (sel === '.bt-param' ? [] : []),
    createElement: () => { const e = makeEl('x'); e.classList._o = e; return e; },
    addEventListener() {},
  },
  window: { addEventListener() {}, devicePixelRatio: 1 },
  fetch: async (u) => ({ ok: true, json: async () => payload(String(u)) }),
  Math, Date, JSON, Number, isFinite, isNaN, parseFloat, encodeURIComponent, AbortController,
  Intl, Map, Set, Array, Object, String, Boolean, Error, Infinity, NaN,
};
sandbox.globalThis = sandbox;

const code = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'app.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });
const state = vm.runInContext('state', sandbox);
const run = expr => vm.runInContext(expr, sandbox);

let fail = 0;
const chk = (label, actual, expect) => {
  const ok = String(actual) === String(expect);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}: 实际=${actual}  期望=${expect}`);
};
const near = (label, actual, expect, tol) => {
  const ok = Math.abs(actual - expect) <= tol;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}: 实际=${Number(actual).toFixed(4)}  期望≈${expect} (±${tol})`);
};

(async () => {
  await sandbox.refreshAll();
  run('bindUI()');

  console.log('===== A. 模拟盘账户模型 =====');
  const px0 = state.prices.BTC.price;
  console.log(`  初始资金 10,000 · BTC 现价 ${px0}`);
  $id('ptSym').value = 'BTC'; $id('ptAmt').value = '1000';
  sandbox.paperBuy();
  near('买入 $1000 后 总资产（含 1 手续费）', parseFloat($id('ptEquity').textContent.replace(/,/g, '')), 9999.0, 0.5);
  chk('  可用现金', $id('ptCash').textContent, '9,000.00');
  chk('  持仓数', state.acct.positions.length, 1);

  state.prices.BTC.price = px0 * 0.9;
  sandbox.renderPaper();
  near('  跌 10% 后 总资产', parseFloat($id('ptEquity').textContent.replace(/,/g, '')), 9899.1, 1);
  chk('  浮动盈亏为负', $id('ptPL').textContent.startsWith('-'), 'true');

  sandbox.paperSell(0);
  near('  平仓后 总资产（已实现盈亏必须保留）', parseFloat($id('ptEquity').textContent.replace(/,/g, '')), 9898.2, 1.5);
  chk('  持仓数归零', state.acct.positions.length, 0);
  chk('  已实现盈亏非零', state.acct.realized.toFixed(2) !== '0.00', 'true');
  chk('  交易流水 2 笔', state.acct.trades.length, 2);
  chk('  平仓触发胜率统计', state.acct.wins + state.acct.losses, 1);

  // 持久化：整账户落盘（现金+已实现盈亏+流水）
  const saved = JSON.parse(sandbox.localStorage._d['nexus_acct_v2']);
  chk('  落盘包含 cash', typeof saved.cash, 'number');
  chk('  落盘包含 realized', typeof saved.realized, 'number');
  chk('  落盘包含 trades', saved.trades.length, 2);

  // 余额约束
  $id('ptAmt').value = '999999';
  sandbox.paperBuy();
  chk('  超额开仓被拦截', state.acct.positions.length, 0);
  chk('  并给出提示', $id('ptMsg').textContent.includes('不足'), 'true');
  // 重置
  sandbox.paperReset();
  chk('  重置后现金', state.acct.cash, 10000);

  console.log('\n===== B. 回测 =====');
  $id('btCoin').value = 'BTC'; $id('btInterval').value = '1d';
  $id('btF').value = '10'; $id('btS').value = '30'; $id('btFee').value = '6';
  await sandbox.renderBacktest();
  chk('  有结果提示', $id('btMsg').className.includes('ok'), 'true');
  chk('  结果面板已展开', $id('btRes').classList.contains('show'), 'true');
  console.log('   累计收益', $id('btRet').textContent, '| 买入持有', $id('btBH').textContent,
    '| 年化', $id('btCagr').textContent, '| 夏普', $id('btSharpe').textContent,
    '| 回撤', $id('btDD').textContent, '| 胜率', $id('btWin').textContent, '| 盈亏比', $id('btPF').textContent);
  console.log('   范围', $id('btScope').textContent);

  // 独立复算胜率，必须一致
  const c = KL.map(k => k.c);
  const sma = (a, p) => a.map((_, i) => i < p - 1 ? null : a.slice(i - p + 1, i + 1).reduce((x, y) => x + y, 0) / p);
  const f = sma(c, 10), s = sma(c, 30);
  let pos = 0, ledger = [], prev = 0;
  for (let i = 1; i < c.length; i++) { const sig = (i < 30 || f[i] == null || s[i] == null) ? 0 : (f[i] > s[i] ? 1 : 0); if (sig !== prev) { if (sig > 0 && !pos) pos = c[i]; else if (sig === 0 && pos) { ledger.push(c[i] > pos); pos = 0; } } prev = sig; }
  const winRate = ledger.length ? Math.round(ledger.filter(Boolean).length / ledger.length * 100) : 0;
  chk('  胜率与独立复算一致', $id('btWin').textContent, winRate + '%');
  chk('  交易次数', $id('btTrades').textContent, ledger.length);

  // 通道突破：必须既有开仓也有平仓
  const r2 = run("(function(){const k=btCache['BTC1d'];return btRun(k,btSignals('brk',k,{n:20,e:1.5}),{capital:10000,feeBps:6,interval:'1d'})})()");
  console.log(`  通道突破：已平仓 ${r2.tradeCount} 笔（持仓中=${r2.hasOpen}），收益 ${r2.ret.toFixed(1)}%`);
  chk('  突破策略不再只买不卖', r2.tradeCount > 0, 'true');

  // RSI tab 切换 + 重跑
  TABS[1]._h.click[0]();
  chk('  切到 RSI 后 state.btStrat', state.btStrat, 'rsi');
  chk('  RSI tab 高亮', TABS[1]._class_check = TABS[1].classList.contains('on'), 'true');
  $id('btP').value = '14'; $id('btB').value = '35'; $id('btSell').value = '70';
  await sandbox.renderBacktest();
  chk('  RSI 回测成功', $id('btMsg').className.includes('ok'), 'true');
  console.log('   RSI 范围', $id('btScope').textContent, '| 胜率', $id('btWin').textContent);

  // 参数非法要有提示，不能静默
  TABS[0]._h.click[0]();
  await new Promise(r => setTimeout(r, 30));   // 等 tab 自动重跑结束，避免与 btRunning 抢
  $id('btF').value = '50'; $id('btS').value = '30';
  await sandbox.renderBacktest();
  chk('  快线≥慢线 有明确错误提示', $id('btMsg').className.includes('err'), 'true');

  console.log('\n' + (fail ? `❌ 失败 ${fail} 项` : '✅ 全部断言通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
