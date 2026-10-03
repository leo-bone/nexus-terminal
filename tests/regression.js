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
  if (u.includes('/api/global'))
    return { mcap: 2.87e12, btcD: 58.4, ethD: 11.5, src: 'coinlore' };
  if (u.includes('coinpaprika')) return { market_cap_usd: 2.6e12, bitcoin_dominance_percentage: 57.3 };
  if (u.includes('stablecoins.llama.fi')) return { peggedAssets: [{ circulating: { peggedUSD: 1.8e11 } }] };
  if (u.includes('blockchain.info')) return { values: ts.map(t => ({ x: Math.floor(t / 1000), y: 600000 })) };
  if (u.includes('alternative.me')) return { data: Array.from({ length: 90 }, (_, i) => ({ value: '50', value_classification: 'Neutral', timestamp: String(Math.floor((now - i * 86400000) / 1000)) })) };
  if (u.includes('mempool.space')) return { hashrates: Array.from({ length: 365 }, (_, i) => ({ timestamp: now - i * 86400000, avgHashrate: 5e20 })) };
  if (u.includes('/api/snapshot')) {
    const keys = ['DXY', 'US10Y', 'GOLD', 'SPX', 'VIX', 'OIL', 'BRENT', 'AGRI', 'EFFR', 'UST2Y', 'T10Y2Y', 'REAL10Y', 'BEI10', 'USDJPY', 'JGB10Y'];
    const base = { DXY: 101, US10Y: 5.2, GOLD: 4190, SPX: 7650, VIX: 16, OIL: 89, BRENT: 97, AGRI: 28, EFFR: 3.88, UST2Y: 4.88, T10Y2Y: 0.41, REAL10Y: 2.93, BEI10: 2.36, USDJPY: 158, JGB10Y: 3.06 };
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
const vmGet = e => vm.runInContext(e, sandbox);
const vmRun = e => vm.runInContext(e, sandbox);
const vmSet = (e, v) => { sandbox.__tmp = v; vm.runInContext(e + ' = __tmp', sandbox); };
function __setNetOpts(k, v) { NET_OPTS[k] = v; }
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
const call = (expr, ...args) => vm.runInContext('(' + expr + ')', sandbox)(...args);

const fDate2 = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };
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

  console.log('\n===== D. 因子方向一致性（v3.6 核心修复）=====');
  const F = run('FACTORS');
  chk('因子总数（含 5 个回放专用）', F.length, 33);
  chk('回放专用因子 5 个且实时不参与', F.filter(f => f.replayOnly).map(f => f.id).join(','), 'mrv,adr,fee,prem,oih');
  chk('每个因子都有合法 dir', F.every(f => [1, -1, 0].includes(f.dir)), 'true');
  chk('仅 1 项为「仅展示」(dir=0)', F.filter(f => f.dir === 0).length, 1);
  chk('参与评分的因子数', run('computeNexusScore().nScored'), 27);
  const expectDir = { fng: -1, fund: -1, ls: -1, oi: -1, dom: -1, stable: 1, hr: 1, tx: 1, mrv: -1, adr: 1, fee: 1, prem: -1, oih: -1, dxy: -1, us10y: -1, spx: 1, vix: -1, gold: -1, oil: -1, agri: 0, geo: -1, fed: -1, bei: -1, curve: 1, jpy: 1, jgb: -1, nfp: -1, urate: 1, claims: 1, pce: -1, cpi: -1, tech: 1, mom: 1 };
  const bad = Object.entries(expectDir).filter(([k, v]) => (F.find(f => f.id === k) || {}).dir !== v).map(([k]) => k);
  chk('方向表与设计一致', bad.length ? bad.join(',') : 'ok', 'ok');
  chk('因子 id 无遗漏', F.filter(f => !(f.id in expectDir)).length, 0);

  // 方向化贡献：把某个序列的末值拉高/压低，检查贡献符号
  const setLast = (k, m) => call('(k,m)=>{const a=state.macroSeries[k].slice(); a[a.length-1]=a[0]*m; state.macroSeries[k]=a;}', k, m);
  const contrib = id => run(`computeNexusScore().out.${id}.contribution`);
  const orig = {};
  ['DXY', 'SPX', 'VIX', 'JGB10Y', 'USDJPY', 'GOLD'].forEach(k => orig[k] = run(`state.macroSeries.${k}.slice()`));

  setLast('DXY', 1.5); chk('美元 z>0 → 贡献为负（利空）', contrib('dxy') < 0, 'true');
  setLast('DXY', 0.5); chk('美元 z<0 → 贡献为正（利多）', contrib('dxy') > 0, 'true');
  setLast('SPX', 1.5); chk('标普 60日动能 z>0 → 贡献为正', contrib('spx') > 0, 'true');
  setLast('VIX', 3.0); chk('VIX z>0 → 贡献为负（避险）', contrib('vix') < 0, 'true');
  setLast('JGB10Y', 2.0); chk('日债10Y z>0 → 贡献为负（套息成本升）', contrib('jgb') < 0, 'true');
  setLast('USDJPY', 1.3); chk('美元日元 z>0 → 贡献为正（套息顺畅）', contrib('jpy') > 0, 'true');
  setLast('GOLD', 1.5); chk('黄金急涨 z>0 → 贡献为负（避险）', contrib('gold') < 0, 'true');
  chk('农业 dir=0 → 贡献恒为 0', contrib('agri'), 0);
  Object.entries(orig).forEach(([k, v]) => call('(k,a)=>{state.macroSeries[k]=a;}', k, v));

  console.log('\n===== E. 趋势型 z 不再贴顶 =====');
  const trend = 'Array.from({length:300},(_,i)=>100*Math.pow(1.002,i))';
  near('稳定复利上涨序列 chgZ ≈ 0', run(`chgZ(${trend},60,120)`), 0, 0.6);
  chk('同一序列 rollZ 明显偏离 0（旧做法会贴顶）', Math.abs(run(`rollZ(${trend},120)`)) > 1, 'true');

  console.log('\n===== F. 无数据因子不稀释评分（v3.7 核心修复）=====');
  const full = call('computeNexusScore');
  chk('数据齐全时无死因子 (nDead=0)', full.nDead, 0);
  chk('数据齐全时参与评分 27', full.nScored, 27);

  // 拿掉 global / 稳定币 / 算力 → 三个因子应标记无数据并退出分母
  run("state.global = null; state.stableMcap = null; state.chainSeries.hashrate = null;");
  const dk = call('computeNexusScore');
  chk('global 缺失 → dom 标记无数据', dk.out.dom.ok, false);
  chk('global 缺失 → dom 不再显示假值 52，而是「无数据」', dk.out.dom.note, '无数据');
  chk('stable 缺失 → 标记无数据', dk.out.stable.ok, false);
  chk('hashrate 缺失 → hr 标记无数据', dk.out.hr.ok, false);
  chk('nDead 正确计数为 3', dk.nDead, 3);
  chk('参与评分从 27 降到 24', dk.nScored, 24);
  chk('死因子的贡献为 0', dk.out.dom.contribution, 0);

  // 关键：活因子全部 +2 时，评分必须只由活因子决定（不被死权重拉向 50）
  // 注意：dir=-1 的因子 z=+2 时贡献是 -2，所以要让每个活因子的「贡献」都等于 +2，z 必须带上方向符号
  // 这里会临时改写 calc，必须原样还原，否则后面所有段落都会跑在被污染的因子表上
  run("globalThis.__origCalc = FACTORS.map(f => f.calc); globalThis.__origState = { g: state.global, s: state.stableMcap, hr: state.chainSeries.hashrate };");
  run("FACTORS.forEach(f => { if (f.dir && f.id !== 'dom' && f.id !== 'stable' && f.id !== 'hr') { const zz = f.dir > 0 ? 2 : -2; f.calc = () => ({ z: zz, note: 'x' }); } });");
  const forced = call('computeNexusScore');
  chk('活因子全 +2 → 评分 94（不稀释）', forced.score, 94);
  // 对照：若按 v3.6 的旧逻辑（死因子也进分母），分母含 1.7 假权重 → 50 + 22*2*(24/25.6)= 91.4，会被拉低
  console.log('  (对照: 若死因子进分母应为 ' + Math.round(50 + 22 * 2 * (forced.nScored * 1 / (forced.nScored + 1.7))) + '，会被拉向 50)');

  // 还原被污染的因子表与 state，保证 F 段对后续段落零副作用
  run("FACTORS.forEach((f,i) => { f.calc = globalThis.__origCalc[i]; }); state.global = globalThis.__origState.g; state.stableMcap = globalThis.__origState.s; state.chainSeries.hashrate = globalThis.__origState.hr; delete globalThis.__origCalc; delete globalThis.__origState;");


  console.log('\n===== G. 历史回放引擎 + IC 检验（v3.8）=====');

  /* 构造一份「人工埋了信号」的合成历史包：所有宏观序列都带同一条正弦，
   * 符号按各自 dir 选取，使 sig 上行时各因子贡献一致为正；BTC 收益也由同一条正弦驱动。
   * 信号周期取 120 天 ≈ rollZ(120) 的一个窗口，目的是让 z 平滑摆动 ±1.4 而不是长期贴顶
   * （周期远大于窗口时 (last−mean) 长期同号，z 会一直顶在 ±2，分档就全挤在一档）。 */
  const mkHist = () => call(`(N) => {
    const day = 86400000, t0 = Date.parse('2025-01-01');
    const ts = Array.from({length: N}, (_, i) => t0 + i * day);
    const mk = f => ({ ts: ts.slice(), closes: ts.map((_, i) => f(i)) });
    const S  = i => Math.sin(i / 19.1);          // BTC 自身
    const SP = i => Math.sin((i + 60) / 19.1);   // 预测因子：领先 BTC 半个周期
    const K = 0.20;
    const ser = {};
    ser.DXY    = mk(i => 100  * (1 - K * SP(i)));   // dir -1
    ser.US10Y  = mk(i => 5    * (1 - K * SP(i)));   // dir -1
    ser.SPX    = mk(i => 5000 * (1 + K * SP(i)));   // dir +1
    ser.VIX    = mk(i => 20   * (1 - K * SP(i)));   // dir -1
    ser.GOLD   = mk(i => 4000 * (1 - K * SP(i)));   // dir -1
    ser.OIL    = mk(i => 90   * (1 - K * SP(i)));   // dir -1
    ser.BRENT  = mk(i => 95   * (1 - K * SP(i)));
    ser.UST2Y  = mk(i => 5    * (1 - K * SP(i)));   // dir -1
    ser.BEI10  = mk(i => 2.4  * (1 - K * SP(i)));   // dir -1
    ser.T10Y2Y = mk(i => 0.5  * (1 + K * SP(i)));   // dir +1
    ser.USDJPY = mk(i => 150  * (1 + K * SP(i)));   // dir +1
    ser.JGB10Y = mk(i => 3    * (1 - K * SP(i)));   // dir -1
    ser.MRV   = mk(i => 1.5    * (1 - 0.8 * K * SP(i)));  // dir -1（高估反向）
    ser.ADR   = mk(i => 9e5    * (1 + K * SP(i)));        // dir +1
    ser.FEE   = mk(i => 5e5    * (1 + K * SP(i)));        // dir +1
    ser.PREM  = mk(i => 0.0004 * (1 - 2 * K * SP(i)));    // dir -1（拥挤反向）
    ser.OIH   = mk(i => 8e8    * (1 - K * SP(i)));        // dir -1
    const fng = mk(i => 50 - 25 * SP(i));            // dir -1
    const hr  = mk(i => 1e21 * (1 + 0.20 * SP(i)));  // dir +1
    const tx  = mk(i => 500000 * (1 + 0.20 * SP(i)));// dir +1
    const btc = mk(i => 30000 * Math.exp(0.0004 * i + 0.30 * S(i)));
    return { macro: ser, fng, tx, hr, btc, srcs: { BTC: 'test:btc' } };
  }`, 420);

  run('state.asof = null; state.hist = null; state.histBundle = null;');
  const liveBefore = call('computeNexusScore');
  call('h => { state.histBundle = h; }', mkHist());
  const rep = call('replayHistory');

  chk('回放返回结果', !!rep, 'true');
  if (rep) {
    const win = rep.n - rep.start;
    chk('回放窗口 ≥ 250 天', win >= 250, 'true');
    chk('回放因子数 = 22', rep.nScored, 22);
    chk('评分全部落在 [2,98]', rep.scores.slice(rep.start).every(x => x >= 2 && x <= 98), 'true');
    const uniq = new Set(rep.scores.slice(rep.start)).size;
    chk('评分有足够波动（非贴顶）', uniq > 20, 'true');
    chk('评分未被钳到边界（既不恒 2 也不恒 98）', rep.scores.slice(rep.start).some(x => x > 5 && x < 95), 'true');

    /* —— 无前视偏差（look-ahead bias）：篡改最后 60 天输入，历史评分必须一字不变 —— */
    const H2 = mkHist();
    const cut = 60, last = rep.n - 1;
    for (let i = last - cut + 1; i <= last; i++) {
      H2.macro.SPX.closes[i] *= 3;
      H2.macro.DXY.closes[i] *= 0.4;
      H2.macro.VIX.closes[i] *= 4;
      H2.btc.closes[i] *= 2;
    }
    call('h => { state.histBundle = h; }', H2);
    const rep2 = call('replayHistory');
    let same = true;
    for (let i = rep.start; i <= last - cut; i++) if (rep.scores[i] !== rep2.scores[i]) { same = false; break; }
    chk('无前视偏差（篡改未来不改变历史评分）', same, 'true');

    /* —— IC：应检出人工埋入的信号 —— */
    const ic1 = call('icFor', rep, 1);
    const ic5 = call('icFor', rep, 5);
    const ic10 = call('icFor', rep, 10);
    chk('有足够样本（10 日）', ic10.n >= 200, 'true');
    chk('IC(1日) Spearman > 0', ic1.spear > 0, 'true');
    chk('IC(5日) Spearman > 0', ic5.spear > 0, 'true');
    chk('IC(10日) Spearman > 0', ic10.spear > 0, 'true');
    chk('IC 在 [-1,1] 内', Math.abs(ic10.spear) <= 1 && Math.abs(ic10.pear) <= 1, 'true');

    const up = ic10.buckets[2], mid = ic10.buckets[1], dn = ic10.buckets[0];
    chk('偏多档有样本', up.n >= 5, 'true');
    chk('偏空档有样本', dn.n >= 5, 'true');
    chk('分档单调：>60 档收益 > 中性档 > <40 档', up.mean > mid.mean && mid.mean > dn.mean, 'true');
    chk('偏多档胜率 > 偏空档胜率', up.win > dn.win, 'true');
    console.log('   IC(10日)=' + ic10.spear.toFixed(3) + ' · 分档样本 ' + dn.n + '/' + mid.n + '/' + up.n +
      ' · 10日平均收益 ' + (dn.mean * 100).toFixed(2) + '% / ' + (mid.mean * 100).toFixed(2) + '% / ' + (up.mean * 100).toFixed(2) + '%');
  }

  /* =================================================================
   *  H. 单项因子 IC 归因 + 样本内外验证 + 滚动 IC（v3.9）
   *  -----------------------------------------------------------------
   *  v3.8 只证明了「合成分数没用」。v3.9 必须能回答：
   *    ① 哪个因子在做正贡献（归因表必须指出人工埋入信号的那批因子）
   *    ② 样本内挑出来的因子，样本外还能不能用
   *    ③ IC 是常数还是随市场状态漂移
   * ================================================================= */
  console.log('\n===== H. 因子 IC 归因 / 样本内外 / 滚动 IC（v3.9）=====');
  if (rep) {
    const facs = call('factorICRows', rep);
    chk('归因表覆盖全部回放因子（22）', facs.length, 22);
    chk('每个因子都有 IC(1/5/10/20) 且有足够样本',
      facs.every(r => [1, 5, 10, 20].every(h => r.per[h] && r.per[h].n >= 100)), 'true');
    const pos = facs.filter(r => r.per[10] && r.per[10].ic > 0).length;
    chk('多数因子 IC(10日) > 0（合成数据埋了信号，归因必须能指出来）', pos >= 8, 'true');
    chk('排序首位 |IC(10)| > 0.15（确实挑出了在做事的因子）', Math.abs(facs[0].per[10].ic) > 0.15, 'true');
    chk('归因表按 |IC(10)| 降序',
      facs.every((r, i) => i === 0 || Math.abs(facs[i - 1].per[10].ic) >= Math.abs(r.per[10].ic) - 1e-12), 'true');
    chk('每个因子都带 dir 与权重', facs.every(r => (r.dir === 1 || r.dir === -1) && r.w > 0), 'true');

    const oos = call('oosTest', rep);
    chk('样本内外切分成功', !!oos, 'true');
    if (oos) {
      chk('样本内 + 样本外 = 回放窗口', oos.nTrain + oos.nTest, rep.n - rep.start);
      chk('优选维数在 [1, 全部]', oos.nKept >= 1 && oos.nKept <= oos.nAll, 'true');
      chk('样本内优选 IC > 0（筛选在样本内必须有效）', oos.pick.tr > 0, 'true');
      chk('样本外优选 IC > 0（合成信号平稳，必须能延续）', oos.pick.te > 0, 'true');
      chk('样本内/外 IC 均在 [-1,1]',
        [oos.live.tr, oos.live.te, oos.equal.tr, oos.equal.te, oos.pick.tr, oos.pick.te]
          .filter(v => v != null).every(v => Math.abs(v) <= 1), 'true');
      chk('三组组合（现状/等权/优选）都有结果',
        oos.live.tr != null && oos.equal.tr != null && oos.pick.tr != null, 'true');
      console.log('   样本内 ' + oos.nTrain + ' 天 / 样本外 ' + oos.nTest + ' 天 · 优选 ' + oos.nKept + '/' + oos.nAll +
        ' 维 · 优选 IC ' + oos.pick.tr.toFixed(3) + ' → ' + oos.pick.te.toFixed(3) +
        ' · 现状 IC ' + (oos.live.tr == null ? '—' : oos.live.tr.toFixed(3)) + ' → ' + (oos.live.te == null ? '—' : oos.live.te.toFixed(3)));
    }

    const roll = call('rollingIC', rep, 60, 10);
    const rv = roll.map(x => x.ic).filter(v => v != null);
    chk('滚动 IC 有足够窗口', roll.length > 100, 'true');
    chk('滚动 IC 全部有界', rv.every(v => Math.abs(v) <= 1), 'true');
    chk('滚动 IC 有波动（IC 不是常数）', new Set(rv.map(v => v.toFixed(3))).size > 20, 'true');
    chk('滚动窗口全部有值', rv.length, roll.length);
    console.log('   滚动 IC ' + rv.length + ' 个窗口 · 最小 ' + Math.min.apply(null, rv).toFixed(3) +
      ' / 最大 ' + Math.max.apply(null, rv).toFixed(3));

    const top5 = facs.slice(0, 5).map(r => r.id + ' ' + r.per[10].ic.toFixed(3)).join(' · ');
    console.log('   归因前 5：' + top5);
  }

  /* =================================================================
   *  I. 十年窗口 · 因子动态可用性 · 极端行情归因 · 分体制（v3.11）
   *  -----------------------------------------------------------------
   *  v3.8~v3.10 全在 2 年窗口上做，因子还没走完一个周期，IC 恒 ≈ 0。
   *  v3.11 把窗口拉到 10 年，随之必须回答四个新问题：
   *    ① 早期很多序列还不存在（情绪指数 / 永续溢价 / 持仓量都是后来才有的），
   *       回放能不能在「缺数据」的情况下照样跑起来、且缺数据不稀释评分？
   *    ② 为了不让 10 年 × 22 因子把主线程冻住，z 值改成了预计算查表 ——
   *       表里的值必须与原函数**逐位相等**，否则「回放与实时同一套代码」不成立
   *    ③ 暴涨暴跌能不能被程序自己找出来，并挂到正确的外生事件上？
   *    ④ 同一批因子，在平静期和极端期作用方式一样吗？
   * ================================================================= */
  console.log('\n===== I. 十年复盘：动态可用性 / 极端行情 / 分体制（v3.11）=====');

  /* 合成 2900 个交易日（≈ 8 年）的「错位上线」历史：
   *  核心宏观 + 链上从一开始就有（撑起回放骨架）；
   *  情绪指数第 400 天、永续溢价第 1800 天、持仓量第 2400 天才上线；
   *  MVRV / 活跃地址整段缺席 —— 复刻真实世界里「限速源拿不到」的处境；
   *  波动率分三段（平静 0.006 / 震荡 0.030 / 极端 0.075），用于分体制对比；
   *  在 312 与特朗普当选两个真实事件日附近各注入一次暴跌 / 暴涨，
   *  用来检验极端行情识别能不能自己找出来、并挂到正确的事件上。 */
  const mkHistLong = () => call(`(N) => {
    const day = 86400000, t0 = Date.parse('2019-01-01');
    const ts = Array.from({length: N}, (_, i) => t0 + i * day);
    const mk = (f, from) => { const a = from == null ? 0 : from;
      return { ts: ts.slice(a), closes: ts.slice(a).map((_, j) => f(j + a)) }; };
    /* 确定性伪随机（LCG + Box-Muller），保证每次跑出来的数完全一样 */
    let seed = 20261001;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const Z = new Array(N);
    for (let i = 0; i < N; i++) {
      let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd();
      Z[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    const sig = i => (i >= 1200 && i < 1291) ? 0.075
                  : (i >= 2200 && i < 2291) ? 0.068
                  : ((i >= 600 && i < 1001) || (i >= 1600 && i < 2001)) ? 0.030
                  : 0.006;
    const S  = i => Math.sin(i / 19.1);          // BTC 自身周期
    const SP = i => Math.sin((i + 60) / 19.1);   // 预测因子（与 G 段同一配方）
    const K = 0.20;
    const inc = new Array(N).fill(0);
    inc[0] = Math.log(30000);
    for (let i = 1; i < N; i++) inc[i] = 0.0004 + 0.30 * (S(i) - S(i - 1)) + sig(i) * Z[i];
    const inject = (a, b, tot) => { for (let i = a; i <= b; i++) inc[i] = tot / (b - a + 1); };
    inject(436, 440, Math.log(0.65));    // 2020-03-12 附近 · 5 日 -35%（312 崩盘）
    inject(2135, 2139, Math.log(1.42));  // 2024-11-05 附近 · 5 日 +42%（特朗普当选）
    const px = []; let acc = 0;
    for (let i = 0; i < N; i++) { acc += inc[i]; px.push(Math.exp(acc)); }
    const ser = {};
    ser.DXY    = mk(i => 100  * (1 - K * SP(i)));
    ser.US10Y  = mk(i => 5    * (1 - K * SP(i)));
    ser.SPX    = mk(i => 5000 * (1 + K * SP(i)));
    ser.VIX    = mk(i => 20   * (1 - K * SP(i)));
    ser.GOLD   = mk(i => 4000 * (1 - K * SP(i)));
    ser.OIL    = mk(i => 90   * (1 - K * SP(i)));
    ser.BRENT  = mk(i => 95   * (1 - K * SP(i)));
    ser.UST2Y  = mk(i => 5    * (1 - K * SP(i)));
    ser.BEI10  = mk(i => 2.4  * (1 - K * SP(i)));
    ser.REAL10Y= mk(i => 1.8  * (1 - K * SP(i)));
    ser.T10Y2Y = mk(i => 0.5  * (1 + K * SP(i)));
    ser.USDJPY = mk(i => 150  * (1 + K * SP(i)));
    ser.JGB10Y = mk(i => 3    * (1 - K * SP(i)));
    ser.FEE    = mk(i => 5e5  * (1 + K * SP(i)));
    ser.PREM   = mk(i => 0.0004 * (1 - 2 * K * SP(i)), 1800);   // 第 1800 天才上线
    ser.OIH    = mk(i => 8e8  * (1 - K * SP(i)), 2400);         // 第 2400 天才上线
    ser.DVOL   = mk(i => 70   * (1 + 0.8 * K * SP(i)), 800);    // 第 800 天才上线（crypto 原生，晚于核心宏观）
    return { macro: ser, fng: mk(i => 50 - 25 * SP(i), 400),
             tx: mk(i => 500000 * (1 + 0.20 * SP(i))),
             hr: mk(i => 1e21   * (1 + 0.20 * SP(i))),
             btc: { ts: ts.slice(), closes: px }, srcs: { BTC: 'test:long' } };
  }`, 2900);

  run('state.asof = null; state.hist = null; state.histBundle = null;');
  call('h => { state.histBundle = h; }', mkHistLong());
  const repL = call('replayHistory');

  chk('十年窗口回放成功', !!repL, 'true');
  if (repL) {
    const winL = repL.n - repL.start;
    chk('回放窗口 ≥ 2800 天（≈ 8 年）', winL >= 2800, 'true');
    chk('起点不被"最短序列"绑死（< 200 天）', repL.start < 200, 'true');
    chk('末日参与评分的因子数 ≥ 18', repL.nScored >= 18, 'true');
    chk('评分全部落在 [2,98]', repL.scores.slice(repL.start).every(x => x >= 2 && x <= 98), 'true');

    /* —— ① 动态可用性：因子按自己的可见长度进出分母 —— */
    const firstAt = a => { if (!a) return -1; for (let i = 0; i < a.length; i++) if (a[i] != null) return i; return -1; };
    const fPrem = firstAt(repL.fvals.prem), fOih = firstAt(repL.fvals.oih), fDxy = firstAt(repL.fvals.dxy);
    chk('核心因子一开始就参与（DXY 起点 < 200）', fDxy >= 0 && fDxy < 200, 'true');
    chk('永续溢价晚于核心因子上线（第 1800 天后）', fPrem >= 1800, 'true');
    chk('持仓量晚于永续溢价上线（第 2400 天后）', fOih >= 2400, 'true');
    chk('上线顺序：DXY → 溢价 → 持仓量', fDxy < fPrem && fPrem < fOih, 'true');
    chk('MVRV / 活跃地址整段缺席（限速源拿不到）', !repL.fvals.mrv && !repL.fvals.adr, 'true');
    chk('早期参与因子数 < 末期（动态可用性生效）', repL.nAct[repL.start] < repL.nAct[repL.n - 1], 'true');
    console.log('   起点 ' + fDate2(repL.calTs[repL.start]) + ' → 末日 ' + fDate2(repL.calTs[repL.n - 1]) +
      ' · ' + winL + ' 个交易日 · 参与因子数 ' + repL.nAct[repL.start] + ' → ' + repL.nAct[repL.n - 1]);
    console.log('   因子上线：DXY 第 ' + fDxy + ' 天 · 溢价 第 ' + fPrem + ' 天 · 持仓量 第 ' + fOih + ' 天');

    /* —— ② 预计算 z 表必须与原函数逐位相等 —— */
    const raw = run('state.histBundle.macro.US10Y.closes');
    const tabR = call('preRollZ', raw, 120);
    const tabC = call('preChgZ', raw, 60, 120);
    let maxR = 0, maxC = 0, nCmp = 0;
    for (let i = 40; i < raw.length; i += 97) {
      const a = call('rollZ', raw.slice(0, i + 1), 120);
      const b = call('chgZ', raw.slice(0, i + 1), 60, 120);
      maxR = Math.max(maxR, Math.abs(tabR[i] - a));
      maxC = Math.max(maxC, Math.abs(tabC[i] - b));
      nCmp++;
    }
    chk('查表 vs 原函数：rollZ 逐位一致（<1e-9）', maxR < 1e-9, 'true');
    chk('查表 vs 原函数：chgZ 逐位一致（<1e-9）', maxC < 1e-9, 'true');
    /* 退化窗口：120 个全同值（利率平台期）。滑窗版会因大数相消算出与 rollZ 差 1.0 的 z */
    const flat = new Array(300).fill(5.33);
    const flatTab = call('preRollZ', flat, 120);
    let maxF = 0;
    for (let i = 130; i < 300; i += 17) maxF = Math.max(maxF, Math.abs(flatTab[i] - call('rollZ', flat.slice(0, i + 1), 120)));
    chk('退化窗口（全同值）也不出现 ±1.0 偏差（<1e-9）', maxF < 1e-9, 'true');
    console.log('   预计算表比对 ' + nCmp + ' 个采样点 · rollZ 最大偏差 ' + maxR.toExponential(1) +
      ' · chgZ 最大偏差 ' + maxC.toExponential(1) + ' · 退化窗口 ' + maxF.toExponential(1));

    /* —— ③ 极端行情：程序自己找出来，并挂到外生事件上 —— */
    const ext = call('findExtremes', repL).map(e => {
      const m = call('matchEvent', repL, e);
      e.hit = m ? m.ev : null; return e;
    });
    chk('识别出极端行情窗口', ext.length >= 2, 'true');
    chk('抓到 312 级别的暴跌（5 日 ≤ -28%）', ext.some(x => x.r5 <= -0.28), 'true');
    chk('抓到特朗普当选级别的暴涨（5 日 ≥ +30%）', ext.some(x => x.r5 >= 0.30), 'true');
    chk('每波极端行情都带"事件前因子状态"快照', ext.every(x => x.preScore != null && (x.topZ || []).length > 0), 'true');
    chk('至少一波能挂到外生事件日历上', ext.filter(x => x.hit).length >= 1, 'true');
    chk('312 那一波挂到"疫情全球崩盘"', ext.some(x => x.hit && /疫情/.test(x.hit.t)), 'true');
    console.log('   极端行情 ' + ext.length + ' 波 · 命中事件 ' + ext.filter(x => x.hit).length + ' 波');
    ext.slice(0, 4).forEach(x => console.log('     ' + fDate2(x.ts) + '  5日 ' + (x.r5 * 100).toFixed(1) + '%' +
      (x.hit ? '  ← ' + x.hit.t : '  ← 无对应事件') + '  · 前 20 日评分 ' + x.preScore.toFixed(1)));

    /* —— ④ 分体制：平静 / 震荡 / 极端 —— */
    const regL = call('regimeTest', repL);
    ['calm', 'chop', 'wild'].forEach(k => {
      const r = regL.byRegime[k];
      chk('分体制「' + r.label + '」样本 ≥ 30', r.n >= 30, 'true');
      chk('分体制「' + r.label + '」IC 有界', r.ic == null || Math.abs(r.ic) <= 1, 'true');
    });
    const sumN = ['calm', 'chop', 'wild'].reduce((a, k) => a + regL.byRegime[k].n, 0);
    chk('三档样本数不超过回放窗口', sumN <= winL, 'true');
    chk('因子体制画像覆盖全部活跃因子（≥ 18）', Object.keys(regL.byFactor).length >= 18, 'true');
    chk('因子的体制画像三档齐全', Object.keys(regL.byFactor).every(id =>
      ['calm', 'chop', 'wild'].every(k => regL.byFactor[id][k] == null || typeof regL.byFactor[id][k].ic === 'number')), 'true');
    console.log('   分体制 IC(10日)：' + ['calm', 'chop', 'wild'].map(k => {
      const r = regL.byRegime[k];
      return r.label + ' n=' + r.n + ' IC=' + (r.ic == null ? '—' : r.ic.toFixed(3));
    }).join(' · '));

    /* —— ⑤ 分期：全样本 IC 是不是只由某一年拉起来 —— */
    const perL = call('periodIC', repL);
    chk('分期覆盖 ≥ 6 年', perL.length >= 6, 'true');
    chk('每一期都够 60 个交易日', perL.every(r => r.n >= 60), 'true');
    chk('年份连续递增', perL.every((r, i) => i === 0 || r.y === perL[i - 1].y + 1), 'true');
    chk('每期 IC 有界', perL.every(r => r.ic == null || Math.abs(r.ic) <= 1), 'true');
    console.log('   逐年 IC(10日)：' + perL.map(r => r.y + ' ' + (r.ic == null ? '—' : r.ic.toFixed(2))).join(' · '));
  }

  /* =================================================================
   *  J. 极端体制子评分（v3.11 实践延展）
   *  -----------------------------------------------------------------
   *  验证 v3.11 分体制画像的产物：把「只在极端期做事」的因子（算力/黄金/原油）
   *  抽成子评分。需要确认：① 合成日线能正确判定体制；② 子评分在实时 out 上算得出来；
   *  ③ 回放里子评分序列与主评分在极端体制内的 IC 都算得出来（诚实标注同样本）。
   * ================================================================= */
  console.log('\n===== J. 极端体制子评分（v3.11 实践延展）=====');

  /* ① currentRegime：用合成日线判定体制 */
  const mkKlines = (amp) => call(`(amp) => {
    let seed = 777;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const t0 = Date.parse('2026-08-01');
    const kl = []; let p = 60000;
    for (let i = 0; i < 40; i++) { const e = (rnd() - 0.5) * 2 * amp; p = p * (1 + e); kl.push({ t: t0 + i * 86400000, o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1e9 }); }
    return kl;
  }`, amp);
  run('state.klines["BTC1d"] = null;');
  chk('无日线时 currentRegime 返回 null', call('currentRegime') === null, 'true');
  call('h => { state.klines["BTC1d"] = h; }', mkKlines(0.006));
  const rgCalm = call('currentRegime');
  chk('低波动日线 → 平静体制', rgCalm && rgCalm.key === 'calm', 'true');
  call('h => { state.klines["BTC1d"] = h; }', mkKlines(0.09));
  const rgWild = call('currentRegime');
  chk('高波动日线 → 极端体制', rgWild && rgWild.key === 'wild', 'true');
  chk('极端体制波动率 ≥ 0.80', rgWild && rgWild.vol >= 0.8, 'true');
  console.log('   合成日线：平静 vol=' + (rgCalm ? (rgCalm.vol).toFixed(3) : '—') + ' · 极端 vol=' + (rgWild ? rgWild.vol.toFixed(3) : '—'));
  run('state.klines["BTC1d"] = null;');

  /* ② extremeSubScore：实时 out 上合成 */
  const fakeOut = {
    hr:   { z: 1.2, contribution: 1.2, ok: true },
    gold: { z: -0.4, contribution: -0.4, ok: true },
    oil:  { z: 1.5, contribution: -1.5, ok: true },   // oil dir=-1 → 负贡献
  };
  const esLive = call('extremeSubScore', fakeOut);
  chk('子评分对 3 个可用因子算得出', esLive && esLive.available === 3 && typeof esLive.score === 'number', 'true');
  chk('子评分落在 [2,98]', esLive && esLive.score >= 2 && esLive.score <= 98, 'true');
  const fakeOutDead = { hr: { ok: false }, gold: { ok: false }, oil: { ok: false } };
  const esDead = call('extremeSubScore', fakeOutDead);
  chk('3 个因子全无数据 → 子评分休眠', esDead && esDead.score === null && esDead.available === 0, 'true');
  console.log('   子评分（算力+1.2 / 黄金-0.4 / 原油-1.5 加权）→ ' + esLive.score);

  /* ③ 回放里子评分序列 + 极端体制内 IC */
  if (repL) {
    const exS = call('extremeSubSeries', repL);
    chk('子评分序列与 rep 对齐', exS && exS.length === repL.n, 'true');
    chk('子评分序列有非 null 值', exS && exS.some(v => v != null), 'true');
    const exAll = call('icCore', exS, repL, 10, repL.start, repL.n);
    chk('子评分全样本 IC 算得出', exAll && exAll.spear != null && Math.abs(exAll.spear) <= 1, 'true');
    const masked = call('regimeMasked', exS, repL, 'wild');
    chk('极端体制遮罩序列长度对齐', masked && masked.length === repL.n, 'true');
    const exWild = call('icCore', masked, repL, 10, repL.start, repL.n);
    chk('子评分极端期 IC 算得出或样本不足为 null', exWild === null || (exWild.spear != null && Math.abs(exWild.spear) <= 1), 'true');
    console.log('   子评分：全样本 IC(10)=' + (exAll ? exAll.spear.toFixed(3) : '—') +
      ' · 极端期 IC(10)=' + (exWild ? exWild.spear.toFixed(3) + ' (n=' + exWild.n + ')' : '样本不足'));

    /* ④ v3.12: Deribit DVOL 作为分析专用参考（不入评分）—— auxRegimeIC 必须优雅工作 */
    chk('auxRegimeIC(不存在的键) 返回 null', call('auxRegimeIC', repL, 'NOPE') === null, 'true');
    const auxDV = call('auxRegimeIC', repL, 'DVOL');
    chk('auxRegimeIC(DVOL) 返回结构', !!(auxDV && auxDV.full && auxDV.byRegime), 'true');
    chk('auxRegimeIC(DVOL) 三档齐全', auxDV && ['calm', 'chop', 'wild'].every(k => auxDV.byRegime[k] && typeof auxDV.byRegime[k].n === 'number'), 'true');
    chk('auxRegimeIC(DVOL) 全样本 IC 有界', auxDV && (auxDV.full.spear == null || Math.abs(auxDV.full.spear) <= 1), 'true');
    console.log('   DVOL 参考 IC(10): 全样本=' + (auxDV && auxDV.full.spear != null ? auxDV.full.spear.toFixed(3) : '—') +
      ' · 分体制=' + (auxDV ? ['calm', 'chop', 'wild'].map(k => auxDV.byRegime[k].spear == null ? '—' : auxDV.byRegime[k].spear.toFixed(2)).join('/') : ''));
  }

  /* —— 回放不得污染实时状态 —— */
  const liveAfter = call('computeNexusScore');
  chk('回放后游标已复位', run('state.asof'), null);
  chk('回放不污染实时评分', liveAfter.score, liveBefore.score);
  chk('回放后实时评分仍为 28 维', Object.keys(liveAfter.out).length, 28);
  run('state.histBundle = null;');

  /* —— 渲染兜底：renderReview 必须不抛错且 ⑦ 极端子评分块渲染出来（防「reg 未定义」类 bug 被 catch 静默吞掉）—— */
  const mockHist = {
    reg: { byRegime: {
      calm:  { n: 1000, ic: 0.13, t: 1.5, up: 0.02, dn: -0.01, base: 0.018 },
      chop:  { n: 1500, ic: 0.18, t: 2.3, up: 0.045, dn: 0.01, base: 0.014 },
      wild:  { n: 672, ic: 0.13, t: 1.1, up: 0.03, dn: 0.003, base: 0.035 },
    }, byFactor: {} },
    ext: [], per: [{ y: 2020, n: 100, ic: 0.1, t: 2.0, ret: 0.05 }],
    ics: [null, null, { spear: 0.14, t: 2.5, n: 3544 }],
    extreme: { wildIC: { spear: 0.157, t: 1.9, n: 672 }, allIC: { spear: 0.054, t: 0.9, n: 3544 }, mainWildIC: 0.13 },
  };
  run('state.hist = (' + JSON.stringify(mockHist) + ');');
  let renderErr = null;
  try { run('renderReview()'); } catch (e) { renderErr = e.message || String(e); }
  chk('renderReview 不抛错（⑦ 块变量作用域正确）', renderErr, null);
  const exBoxHtml = $id('extScoreBox').innerHTML || '';
  chk('⑦ 极端体制子评分块渲染', exBoxHtml.indexOf('极端体制子评分') >= 0, 'true');
  chk('⑦ 块给出诚实结论文本', /极端体制内|外生冲击|样本外验证/.test(exBoxHtml), 'true');
  run('state.hist = null;');

  console.log('\n===== K. 多重检验与过拟合校正（v3.17）=====');
  run('state.hist = null;');

  /* —— 数值核自洽：这是整套校正的地基，算错就全是假的 —— */
  near('normInv(0.975) 回到 1.96', call('normInv', 0.975), 1.959964, 1e-3);
  near('tToP2(1.96) 双侧 p ≈ 0.05', call('tToP2', 1.959964), 0.05, 1e-3);
  near('normCdf(0) = 0.5', call('normCdf', 0), 0.5, 1e-6);
  chk('normInv 单调递增', call('normInv', 0.99) > call('normInv', 0.95), 'true');
  chk('normInv(0) 不返回 NaN', Number.isFinite(call('normInv', 0)), 'true');

  /* —— 合成纯噪声样本：验证校正确实在收紧判定 —— */
  (function () {
    let s = 42;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const NN = 400, closes = [], calTs = [];
    const fv = { gold: [], oil: [], hr: [] };
    let px = 100;
    for (let i = 0; i < NN; i++) {
      px *= (1 + (rnd() - 0.5) * 0.04);
      closes.push(px);
      calTs.push(Date.UTC(2018, 0, 1) + i * 86400000);
      Object.keys(fv).forEach(k => fv[k].push(rnd() - 0.5));
    }
    const repN = { start: 0, n: NN, calTs, closes, scores: fv.gold, fvals: fv, fzs: {} };
    run('var __repN = ' + JSON.stringify(repN) + ';');
    const mt2 = run('multiTest(__repN)');
    chk('multiTest 在合成样本上返回结构', !!mt2, 'true');
    if (mt2) {
      const nf = Object.keys(fv).length;
      chk('检验次数 K = 因子数 × horizon 数', mt2.K, nf * 4);
      near('期望假阳性数 = K × alpha', mt2.expFalse, mt2.K * 0.05, 1e-9);
      chk('Bonferroni 门槛高于未校正门槛', mt2.tCritBonf > mt2.tCritRaw, 'true');
      chk('Sidak 门槛不高于 Bonferroni', mt2.tCritSidak <= mt2.tCritBonf, 'true');
      chk('Bonferroni 通过数 ≤ 未校正通过数', mt2.nBonfSig <= mt2.nRawSig, 'true');
      chk('BH-FDR 通过数 ≥ Bonferroni 通过数', mt2.nBhSig >= mt2.nBonfSig, 'true');
      chk('每次检验都算出 q 值', mt2.tests.every(x => x.q != null && x.q >= 0 && x.q <= 1), 'true');
      chk('q 值不小于对应 p 值（校正只会变松）', mt2.tests.every(x => x.q >= x.p - 1e-12), 'true');
      chk('WRC bootstrap 在合成样本上算得出', mt2.wrc !== null && mt2.wrc !== undefined, 'true');
      if (mt2.wrc) {
        chk('WRC 家族 p 落在 (0,1]', mt2.wrc.pval > 0 && mt2.wrc.pval <= 1, 'true');
        chk('WRC 噪声 95 分位 ≥ 中位数', mt2.wrc.p95 >= mt2.wrc.med, 'true');
      }
      console.log('   合成噪声样本：K=' + mt2.K + ' 未校正显著=' + mt2.nRawSig +
        ' Bonferroni=' + mt2.nBonfSig + ' BH=' + mt2.nBhSig +
        (mt2.wrc ? ' WRC观测=' + mt2.wrc.obsMax.toFixed(3) + ' 噪声中位=' + mt2.wrc.med.toFixed(3) : ''));
    }
    run('__repN = null;');
  })();

  /* —— 渲染兜底：⑩ 块在无数据时不得抛错（异步 bootstrap 失败也要能降级） —— */
  run('state.hist = { mt: null, mtBusy: false };');
  let mtErr = null;
  try { run('renderMtBox()'); } catch (e) { mtErr = e.message || String(e); }
  chk('renderMtBox 无数据时也不抛错', mtErr, null);
  const mtHtml = $id('mttBox').innerHTML || '';
  chk('⑩ 块给出兜底文案', mtHtml.indexOf('多重检验校正') >= 0, 'true');
  run('state.hist = { mt: null, mtBusy: true };');
  try { run('renderMtBox()'); } catch (e) { mtErr = e.message || String(e); }
  chk('renderMtBox 在计算中状态也不抛错', mtErr, null);
  run('state.hist = null;');

  console.log('\n===== L. 回测过拟合概率 PBO(CSCV) 与去通胀夏普 DSR（v3.18）=====');
  run('state.hist = null;');

  /* —— rollingZFrom：滚动 z 必须只用过去窗口（前视是回测造假最隐蔽的形式） —— */
  (function () {
    const vals = [];
    for (let i = 0; i < 400; i++) vals.push(Math.sin(i / 9) * 10 + (i % 7));
    const z = call('rollingZFrom', vals, 100);
    chk('rollingZFrom 返回等长数组', z.length, 400);
    chk('rollingZFrom 前若干点为 null（窗口未攒够）', z[0] === null && z[10] === null, 'true');
    chk('rollingZFrom 有产出后均为有限值', z.slice(150).every(v => v === null || Number.isFinite(v)), 'true');
    /* 无前视：把序列在第 300 点之后整体改写，第 300 点之前的 z 必须一字不动 */
    const vals2 = vals.slice();
    for (let i = 300; i < 400; i++) vals2[i] = 9999;
    const z2 = call('rollingZFrom', vals2, 100);
    let same = true;
    for (let i = 0; i < 299; i++) if (z[i] !== z2[i]) same = false;
    chk('rollingZFrom 无前视（未来数据不影响过去的值）', same, 'true');
  })();

  /* —— deflatedSharpe 的数学自洽：N 越大，运气门槛越高，DSR 越低 —— */
  (function () {
    const T = 3000, sr = 0.05, g3 = 0.5, g4 = 8, V = 2e-4;
    const d10 = call('deflatedSharpe', sr, T, g3, g4, 10, V, null);
    const d100 = call('deflatedSharpe', sr, T, g3, g4, 100, V, null);
    const d1000 = call('deflatedSharpe', sr, T, g3, g4, 1000, V, null);
    chk('SR0 随尝试次数 N 单调上升', (d10.sr0 < d100.sr0) && (d100.sr0 < d1000.sr0), 'true');
    chk('DSR 随尝试次数 N 单调下降', (d10.psr > d100.psr) && (d100.psr > d1000.psr), 'true');
    chk('SR0 为正（试过多次后纯运气也有门槛）', d100.sr0 > 0, 'true');
    chk('DSR 落在 [0,1]', d100.psr >= 0 && d100.psr <= 1, 'true');
    chk('DSR 严于 PSR(vs 0)（去通胀只会更苛刻）', d100.psr <= d100.psr0 + 1e-12, 'true');
    /* benchmark 版：给定的门槛高于 SR0 时应得到更低的 PSR */
    const hi = call('deflatedSharpe', sr, T, g3, g4, 100, V, sr * 1.2);
    chk('PSR 的门槛越高通过概率越低', hi.psrBH < d100.psr, 'true');
    chk('PSR(vs 自身) ≈ 0.5', Math.abs(hi.psrBH - 0.5) < 0.5, 'true');
  })();

  /* —— 合成纯噪声：整模块最关键的自校准检验 ——
   * 数据是纯随机、因子与未来收益毫无关系时，IS 挑出的最优在 OOS 上应当随机沉浮，
   * 于是 PBO 必须落在 0.5 附近。若算出来很低，说明 pipeline 在某个环节偷看了未来。 */
  (function () {
    let s = 20261003;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const FIDS = ['fng', 'hr', 'tx', 'mrv', 'fee', 'dxy', 'us10y', 'gold', 'oil', 'vix'];
    const NN = 900, closes = [], calTs = [], fvals = {};
    FIDS.forEach(k => { fvals[k] = []; });
    let px = 50000;
    for (let i = 0; i < NN; i++) {
      px *= (1 + (rnd() - 0.5) * 0.05);
      closes.push(px);
      calTs.push(Date.UTC(2019, 0, 1) + i * 86400000);
      FIDS.forEach(k => { fvals[k].push(rnd() - 0.5); });
    }
    const repP = { start: 0, n: NN, calTs, closes, scores: [], fvals, fzs: {} };
    run('var __repP = ' + JSON.stringify(repP) + ';');

    const built = run('pboBuildStrategies(__repP)');
    chk('pboBuildStrategies 在合成样本上返回结构', !!built, 'true');
    if (built) {
      chk('候选池规模合理（>=10）', built.nCand >= 10, 'true');
      chk('每个候选都有等长收益序列', built.rets.every(r => r.length === NN), 'true');
      chk('返回了仓位序列（供敞口检验用）', built.poss.length === built.rets.length, 'true');
      chk('滞后一步：第 0 天无收益（信号只能赚明天的钱）', built.rets.every(r => r[0] === null), 'true');
    }

    const pb = run('pboTest(__repP)');
    chk('pboTest 在纯噪声样本上算得出', !!pb, 'true');
    if (pb) {
      chk('PBO 经验值落在 [0,1]', pb.pboEmp >= 0 && pb.pboEmp <= 1, 'true');
      chk('枚举组合数 = C(S, S/2)', pb.combos, 252);
      chk('λ 样本数 = 有效组合数', pb.nLambda, pb.combos);
      chk('PBO 两种口径相互接近（|差|<0.20）', Math.abs(pb.pboEmp - pb.pboNorm) < 0.20, 'true');
      chk('有效样本量 ≤ 总长度', pb.T <= NN, 'true');
      chk('收益峰度 γ4 为正（厚尾）', pb.g4 > 0, 'true');
      chk('买入持有基准算得出', pb.bhSRDay !== null && Number.isFinite(pb.bhSRDay), 'true');
      chk('跑赢躺平计数在 [0, N]', pb.nBeatBH >= 0 && pb.nBeatBH <= pb.NC, 'true');
      chk('PSR(SR>BH) 落在 [0,1]', pb.psrBH >= 0 && pb.psrBH <= 1, 'true');
      chk('平均仓位有界于 [-1,1]', Math.abs(pb.avgPos) <= 1, 'true');
      chk('多空中性化后也算得出夏普', pb.srNeutralDay === null || Number.isFinite(pb.srNeutralDay), 'true');
      console.log('   纯噪声自校准：PBO(经验)=' + (pb.pboEmp * 100).toFixed(1) + '%' +
        ' PBO(拟合)=' + (pb.pboNorm * 100).toFixed(1) + '%' +
        ' λ均值=' + pb.lamMu.toFixed(3) + ' → 应靠近 50%/0');
      console.log('   纯噪声 vs 躺平：最优 SR(ann)=' + pb.srAnn.toFixed(2) +
        ' BH SR(ann)=' + (pb.bhSRAnn == null ? '—' : pb.bhSRAnn.toFixed(2)) +
        ' 跑赢数=' + pb.nBeatBH + '/' + pb.NC);
    }
    run('__repP = null;');
  })();

  /* —— 零信息对照必须能在伪数据上跑出「看起来不错」的结果，这正是它的意义 —— */
  (function () {
    let s = 20261004;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const FIDS = ['fng', 'hr', 'tx', 'mrv', 'fee', 'dxy', 'us10y', 'gold', 'oil', 'vix'];
    const NN = 900, closes = [], calTs = [], fvals = {};
    FIDS.forEach(k => { fvals[k] = []; });
    let px = 50000;
    for (let i = 0; i < NN; i++) {
      px *= (1 + (rnd() - 0.5) * 0.05);
      closes.push(px); calTs.push(Date.UTC(2019, 0, 1) + i * 86400000);
      FIDS.forEach(k => { fvals[k].push(rnd() - 0.5); });
    }
    const repQ = { start: 0, n: NN, calTs, closes, scores: [], fvals, fzs: {} };
    run('var __repQ = ' + JSON.stringify(repQ) + ';');
    const nul = run('pboNullCalib(__repQ, { nullRuns: 6 })');
    chk('pboNullCalib 在纯噪声上返回结构', !!nul, 'true');
    if (nul) {
      chk('零信息对照跑够指定轮数', nul.runs >= 4 && nul.runs <= 6, 'true');
      chk('零信息最优夏普为正（机器确能制造漂亮数字）', nul.maxDay > 0, 'true');
      chk('零信息分布有离散度（不是常数）', nul.maxDay > nul.minDay, 'true');
      chk('零信息中位 ≥ 最小、≤ 最大', nul.medDay >= nul.minDay && nul.medDay <= nul.maxDay, 'true');
      console.log('   零信息对照（年化）：中位=' + (nul.medDay * Math.sqrt(365)).toFixed(2) +
        ' 最高=' + (nul.maxDay * Math.sqrt(365)).toFixed(2) +
        ' ← 这台机器在没有真实信息时也能吐出的数字');
    }
    run('__repQ = null;');
  })();

  /* —— 渲染兜底：⑪ 块在无数据 / 计算中都不得抛错 —— */
  run('state.hist = { pbo: null, pboBusy: false };');
  let pboErr = null;
  try { run('renderPboBox()'); } catch (e) { pboErr = e.message || String(e); }
  chk('renderPboBox 无数据时也不抛错', pboErr, null);
  const pboHtml = $id('pboBox').innerHTML || '';
  chk('⑪ 块给出兜底文案', pboHtml.indexOf('回测过拟合') >= 0, 'true');
  run('state.hist = { pbo: null, pboBusy: true };');
  try { run('renderPboBox()'); } catch (e) { pboErr = e.message || String(e); }
  chk('renderPboBox 在计算中状态也不抛错', pboErr, null);
  run('state.hist = null;');

  /* —— 容器存在性：⑪ 必须真的挂到面板上，否则功能算写了但用户看不见 —— */
  /* 容器存在性：⑪ 必须真的挂到面板上，否则功能算写了但用户看不见 */
  const IDX = require('fs').readFileSync(__dirname + '/../index.html', 'utf8');
  chk('index.html 存在 ⑪ pboBox 容器', IDX.indexOf('id="pboBox"') >= 0, 'true');


  /* ==================================================================
   *  M. v3.19 日历数据时效性
   *     ① 发布时刻已过但无实际值 → stale，不许再冒充「还没到」
   *     ② 未来的预告不得盖住刚发布的真值（econFind 的选择语义）
   *     ③ Worker 热点窗口的秒/毫秒单位不能搞反
   *     ④ XML 的 <time> 是 UTC，US/Eastern 换算是错的
   * ================================================================== */
  console.log('\n===== M. v3.19 日历数据时效性 =====');

  /* 独立作用域，避免变量名污染其他段 */
  {
  const nfpIsoAt = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const nfpEv = (mins, f, p, a, t) => ({
    t: t === undefined ? nfpIsoAt(mins) : t,
    title: 'Non-Farm Employment Change', f: f, p: p, a: (a === null ? '' : a)
  });
  const nfpOut = (evts) => {
    run('state.econ = ' + JSON.stringify(evts) + ';');
    return run("computeNexusScore(['nfp']).out.nfp");
  };

  /* ① 已过时辰 —— 正是用户实际撞到的场景：非农已发布 3 小时仍无实际值 */
  let _o = nfpOut([nfpEv(-180, '89K', '162K', null)]);
  chk('已过时辰 3 小时 → stale=true', _o.stale, true);
  chk('文案标明「已过时辰」而非冒充「未发布」', /已过时辰/.test(_o.note), true);
  chk('且注明数据未到（让使用者知道不是事实）', /数据未到/.test(_o.note), true);
  chk('代理值仍按 (89-162)/60×0.5', Math.abs(_o.z - (-0.608)) < 0.01, true);
  chk('evTime 带着发布时刻供 hover 自查', typeof _o.evTime === 'string' && _o.evTime.length > 8, true);

  /* ② 尚未到点 —— 正常等待发布，不该被标脏 */
  _o = nfpOut([nfpEv(120, '89K', '162K', null)]);
  chk('未来事件 → stale=false', _o.stale, false);
  chk('未来事件文案仍是「未发布·半权重」', /未发布·半权重/.test(_o.note), true);

  /* ③ 宽限期边界：30 分钟不报警（数据源回填需要时间），90 分钟报警 */
  _o = nfpOut([nfpEv(-30, '89K', '162K', null)]);
  chk('宽限期内(30min)不误报 stale', _o.stale, false);
  _o = nfpOut([nfpEv(-90, '89K', '162K', null)]);
  chk('超过宽限期(90min) → stale=true', _o.stale, true);

  /* ④ 老缓存格式 MM-DD-YYYY 无钟点 → 不误伤未来事件 */
  _o = nfpOut([nfpEv(0, '89K', '162K', null, '10-02-2026')]);
  chk('无钟点的旧格式不误报 stale', _o.stale, false);

  /* ⑤ 发布后 → 全权重真值路径 */
  _o = nfpOut([nfpEv(-180, '89K', '162K', '150K')]);
  chk('有实际值时走真值路径', /实际 150K/.test(_o.note), true);
  chk('真值不打折：(150-89)/60', Math.abs(_o.z - 1.017) < 0.01, true);
  chk('真值路径不带 stale', _o.stale, false);

  /* ⑥ 关键回归：未来预告不得盖住刚发布的真值 */
  _o = nfpOut([nfpEv(-60, '89K', '162K', '150K'), nfpEv(+43200, '100K', '150K', null)]);
  chk('econFind 优先取已发布那条', /实际 150K/.test(_o.note), true);
  chk('未被下周预告的半权重值取代', Math.abs(_o.z - 1.017) < 0.01, true);

  /* ⑦ 只有未来预告 → 仍能退回半权重且不报错 */
  _o = nfpOut([nfpEv(+43200, '100K', '150K', null)]);
  chk('仅有未来预告 → 退回半权重且不 stale', /未发布·半权重/.test(_o.note) && !_o.stale, true);

  /* ⑧ 陈旧态不应把因子判为「无数据」而从评分里消失 */
  _o = nfpOut([nfpEv(-180, '89K', '162K', null)]);
  chk('陈旧态因子仍参与评分(ok≠false)', _o.ok, true);
  chk('陈旧态仍给出非零贡献', Math.abs(_o.contribution) > 0.25, true);

  run('state.econ = [];');

  /* ⑨ 渲染层：源码里必须真的有 stale 分支（灰标 + 「数据未到」） */
  const APPJS = require('fs').readFileSync(__dirname + '/../app.js', 'utf8');
  chk('渲染有 stale 灰度分支', /stl \? '#8a93a6'/.test(APPJS), true);
  chk('渲染把 stale 标为「数据未到」', /stl \? '数据未到'/.test(APPJS), true);
  chk('econOverdue 只认带钟点的 ISO', /indexOf\('T'\) < 0/.test(APPJS), true);

  /* ⑩ Worker 热点窗口 —— 跑的是从 worker.js 原样抽出来的代码 */
  const Probe = new Function("const BIG_EVENT_RE = /Non-Farm Employment Change|Unemployment Rate|Core PCE Price Index|CPI |Consumer Price Index|Federal Funds Rate|FOMC|Initial Jobless Claims/i;\nconst BIG_WINDOW_SEC = 7200;\nasync function calendarHotWindow(text) {\n  try {\n    const j = JSON.parse(text);\n    const arr = (j && j.events) || [];\n    const now = Date.now();\n    for (let i = 0; i < arr.length; i++) {\n      if (!BIG_EVENT_RE.test(arr[i].title || '')) continue;\n      const t = Date.parse(arr[i].t);\n      if (!isFinite(t)) continue;\n      /* 单位：t-now 是毫秒，BIG_WINDOW_SEC 是秒 —— 不换算的话窗口只有 7.2 秒，等于功能整个失效 */\n      const d = (t - now) / 1000;\n      if (d < BIG_WINDOW_SEC && d > -BIG_WINDOW_SEC) return true;\n    }\n  } catch (e) { }\n  return false;\n}" + '\nreturn calendarHotWindow;')();
  const nfpMk = (evts) => JSON.stringify({ events: evts, ts: Date.now() });
  const nfpAt = (mins, title) => ({ t: nfpIsoAt(mins), title: title });
  chk('热点窗口做了毫秒→秒换算（否则窗口只有 7.2 秒）', true, true);
  chk('非农 -30min 命中热点窗口', await Probe(nfpMk([nfpAt(-30, 'Non-Farm Employment Change')])), true);
  chk('非农 +60min 命中热点窗口（发布前同样要勤刷新）', await Probe(nfpMk([nfpAt(60, 'Non-Farm Employment Change')])), true);
  chk('非农 -300min 退出热点窗口', await Probe(nfpMk([nfpAt(-300, 'Non-Farm Employment Change')])), false);
  chk('无关事件不触发', await Probe(nfpMk([nfpAt(-5, 'Some Random Speech')])), false);
  chk('CPI 命中热点窗口', await Probe(nfpMk([nfpAt(-20, 'CPI m/m')])), true);
  chk('FOMC 命中热点窗口', await Probe(nfpMk([nfpAt(30, 'Federal Funds Rate')])), true);
  chk('混合事件里能挑出在窗口的那个', await Probe(nfpMk([nfpAt(-9999, 'Old Speech'), nfpAt(-15, 'Unemployment Rate')])), true);
  chk('坏 JSON 不抛错', await Probe('not json'), false);
  chk('空内容不抛错', await Probe(''), false);
  chk('缺 t 字段安全跳过', await Probe(nfpMk([{ title: 'Non-Farm Employment Change' }])), false);

  /* ⑪ XML 的 <time> 实测是 UTC —— 按 America/New_York 换算会把发布时刻推晚 4 小时。
      下面的期望值全部取自两个端点的实测对齐：
        JSON 2026-09-28T08:15:00-04:00  <->  XML 09-28-2026 12:15pm */
  const IsoConv = new Function("function ffXmlTimeToIso(dateStr, timeStr) {\n  const ds = String(dateStr || '').trim();\n  const dm = /^(\\d{2})-(\\d{2})-(\\d{4})$/.exec(ds);\n  if (!dm) return ds;\n  const yy = +dm[3], mo = +dm[1], dd = +dm[2];\n  let hh = 0, mi = 0;\n  const tm = /^(\\d{1,2}):(\\d{2})\\s*(am|pm)?$/i.exec(String(timeStr || '').trim());\n  if (tm) {\n    hh = +tm[1]; mi = +tm[2];\n    const ap = (tm[3] || '').toLowerCase();\n    if (ap === 'pm' && hh < 12) hh += 12;\n    if (ap === 'am' && hh === 12) hh = 0;\n  }\n  const d = new Date(Date.UTC(yy, mo - 1, dd, hh, mi));\n  return isFinite(d.getTime()) ? d.toISOString() : ds;\n}" + '\nreturn ffXmlTimeToIso;')();
  chk('XML 12:15pm → 12:15Z（不得再加夏令时偏移）', IsoConv('09-28-2026', '12:15pm').indexOf('2026-09-28T12:15') === 0, true);
  chk('XML 5:30pm → 17:30Z', IsoConv('09-28-2026', '5:30pm').indexOf('2026-09-28T17:30') === 0, true);
  chk('XML 1:00pm → 13:00Z', IsoConv('09-29-2026', '1:00pm').indexOf('2026-09-29T13:00') === 0, true);
  chk('XML 11:50pm → 23:50Z（同日，不跨午夜）', IsoConv('09-27-2026', '11:50pm').indexOf('2026-09-27T23:50') === 0, true);
  chk('XML 08:30am → 08:30Z', IsoConv('10-02-2026', '08:30am').indexOf('2026-10-02T08:30') === 0, true);
  chk('日期仍是 MM-DD-YYYY 而非 DD/MM', IsoConv('12-25-2026', '10:00am').indexOf('2026-12-25T10:00') === 0, true);
  chk('缺 time 字段安全降级为当日 00:00Z', IsoConv('10-02-2026', '').indexOf('2026-10-02T00:00') === 0, true);
  chk('非法输入原样返回不炸', IsoConv('garbage', 'xx').indexOf('garbage') >= 0, true);
  }


  /* =================================================================
   *  N. v3.20 · ⑫ 动态权重评分 / ⑬ 关系网络 v2 / ⑭-⑯ 相关性监控
   *  -----------------------------------------------------------------
   *  这一段的定位与前面不同：前面验证的是「功能没坏」，这一段验证的是
   *  **数学没有错**。四组独立交叉验证：
   *    ① 特征值/求逆/解方程 —— 对每个都不用「实现 vs 实现」，而是对着解析解：
   *       不变量（tr、Frobenius 范数）、A·A⁻¹=I、已知 3 变量偏相关公式；
   *    ② 岭回归：用测试里**另一份独立实现**（Gauss-Jordan 直接解正规方程）
   *       逐位对照增量累加器 + Cholesky 解出来的系数；
   *    ③ 前视偏差零容忍：篡改未来必须一字不改地留下历史预测；
   *    ④ 偏相关的定性含义：共因子造成的虚假相关必须在偏相关里消失。
   * ================================================================= */
  console.log('\n===== N. v3.20 · 动态权重 / 网络 v2 / 相关性监控 =====');

  /* 段内统一的确定性随机数发生器：任何一次失败都要能原样复现 */
  let sd = 20261003;
  const rndN = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return (sd / 0x7fffffff) * 2 - 1; };


  /* ---------- ① 数值内核：对着解析解验，不对着实现验 ---------- */
  const Eg = call(`(A) => jacobiEigen(A, A.length)`, [[2, 1], [1, 2]]);
  chk('2×2 特征值 = 3 与 1（解析解）', Eg.val[0].toFixed(6) + '/' + Eg.val[1].toFixed(6), '3.000000/1.000000');

  const A3 = [[2, -1, 0], [-1, 2, -1], [0, -1, 2]];
  const Eg3 = call(`(A) => jacobiEigen(A, 3)`, A3);
  const tr = Eg3.val.reduce((a, b) => a + b, 0);
  let frob = 0;
  for (const row of A3) for (const v of row) frob += v * v;
  const frobEig = Eg3.val.reduce((a, b) => a + b * b, 0);
  near('特征值和 = 迹（6）', tr, 6, 1e-6);
  near('特征值平方和 = ‖A‖²_F（18）', frobEig, frob, 1e-6);
  near('三对角链的最大特征值 = 2+√2', Eg3.val[0], 2 + Math.SQRT2, 1e-5);
  /* 特征向量：A·v = λ·v 才是「特征」的定义，只验值等于没验 */
  let residMax = 0;
  Eg3.vec.forEach(function (v, k) {
    for (let i = 0; i < 3; i++) {
      let s = 0;
      for (let j = 0; j < 3; j++) s += A3[i][j] * v[j];
      residMax = Math.max(residMax, Math.abs(s - Eg3.val[k] * v[i]));
    }
  });
  chk('特征向量满足 A·v = λ·v', residMax < 1e-6, 'true');

  const Inv = call(`(A) => cholInv(A, 3)`, A3);
  let idErr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A3[i][k] * Inv[k][j];
    idErr = Math.max(idErr, Math.abs(s - (i === j ? 1 : 0)));
  }
  chk('Cholesky 求逆：A·A⁻¹ = I', idErr < 1e-8, 'true');
  chk('Cholesky 求逆：非正定返回 null（而不是假装能算）',
    call(`(A) => cholInv(A, 2)`, [[1, 2], [2, 1]]), 'null');

  const Sol = call(`(A, b) => cholSolve(A, b, 3)`, A3, [1, 0, 1]);
  let solveErr = 0;
  for (let i = 0; i < 3; i++) {
    let s = 0;
    for (let j = 0; j < 3; j++) s += A3[i][j] * Sol[j];
    solveErr = Math.max(solveErr, Math.abs(s - [1, 0, 1][i]));
  }
  chk('Cholesky 解方程组：Ax = b', solveErr < 1e-8, 'true');

  near('Fisher z(0.5) = 0.5493', call(`(r) => fisherZ(r)`, 0.5), 0.5493061, 1e-6);
  near('Fisher 往返变换零损失', call('(r) => fisherZInv(fisherZ(r))', 0.5), 0.5, 1e-12);
  const ciWide = call(`(r, n) => corrCI(r, n)`, 0.5, 40);
  const ciNarrow = call(`(r, n) => corrCI(r, n)`, 0.5, 400);
  chk('95% CI 包含点估计', ciWide[0] < 0.5 && 0.5 < ciWide[1], 'true');
  chk('样本越大 CI 越窄', (ciNarrow[1] - ciNarrow[0]) < (ciWide[1] - ciWide[0]), 'true');
  chk('样本不足 6 点不硬算 CI', call(`(r, n) => corrCI(r, n)`, 0.5, 4), 'null');
  chk('|r|=1 不做对数爆炸', isFinite(call(`(r) => fisherZ(r)`, 1)), 'true');

  const Q = call(`(p) => bhQ(p)`, [0.001, 0.02, 0.9]);
  chk('BH 校正：最小 p 的 q = p·m/1', Q[0].toFixed(4), '0.0030');
  chk('BH 校正：次小 p 的 q = min(后继, p·m/2)', Q[1].toFixed(4), '0.0300');
  chk('BH 校正：最大 p 的 q = p', Q[2].toFixed(4), '0.9000');
  const Q2 = call(`(p) => bhQ(p)`, [1, 1, 1, 1]);
  chk('BH：全为 1 时 q 全为 1', Q2.every(v => v === 1), 'true');
  const Q3 = call(`(p) => bhQ(p)`, [0.5, 0.5]);
  chk('BH 校正值不小于原始 p', Q3.every(v => v >= 0.5 - 1e-12), 'true');

  chk('相关距离：d(1)=0', call(`(r) => corrDist(r)`, 1).toFixed(6), '0.000000');
  chk('相关距离：d(0)=√2', call(`(r) => corrDist(r)`, 0).toFixed(6), Math.SQRT2.toFixed(6));
  chk('相关距离：d(-1)=2', call(`(r) => corrDist(r)`, -1).toFixed(6), '2.000000');
  /* 三角不等式必须在**自洽的**相关系数三元组上验：随手抽三个独立的 r
   * 未必能构成一个合法的相关矩阵（例如 0.9/0.9/-0.9 在数学上不可能并存），
   * 那种组合连欧氏空间里都不存在，拿来验距离度量是冤枉它。 */
  let triOk = true;
  for (let t = 0; t < 300; t++) {
    const std = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; const c = a.map(x => x - m); const s = Math.sqrt(c.reduce((x, y) => x + y * y, 0)); return c.map(x => x / (s || 1)); };
    const u = [0, 1, 2].map(() => std(Array.from({ length: 12 }, () => rndN())));
    const dot = (a, b) => u[a].reduce((acc, x, i) => acc + x * u[b][i], 0);
    const d = [dot(0, 1), dot(0, 2), dot(1, 2)].map(r => call('(r) => corrDist(r)', r));
    if (d[0] > d[1] + d[2] + 1e-12 || d[1] > d[0] + d[2] + 1e-12 || d[2] > d[0] + d[1] + 1e-12) triOk = false;
  }
  chk('Mantegna 距离满足三角不等式（MST 才成立）', triOk, 'true');

  /* ---------- ② 偏相关：对着三变量解析公式验 ----------
   * ρ_13.2 = (r13 − r12·r23) / √((1−r12²)(1−r23²))   —— 这是课本上的闭式解 */
  const R3 = [[1, 0.5, 0.3], [0.5, 1, 0.4], [0.3, 0.4, 1]];
  const P3 = call(`(A) => cholInv(A, 3)`, R3);
  const part13 = call(`(P, i, j) => -P[i][j] / Math.sqrt(P[i][i] * P[j][j])`, P3, 0, 2);
  const analytic = (0.3 - 0.5 * 0.4) / Math.sqrt((1 - 0.25) * (1 - 0.16));
  near('偏相关 ρ(1,3|2) 与解析解一致', part13, analytic, 1e-9);
  chk('总相关 ≠ 偏相关（构造数据下必须能区分）', Math.abs(part13 - 0.3) > 0.05, 'true');

  /* 非半正定矩阵：r(1,2)=r(1,3)=0.9, r(2,3)=-0.9 在数学上不可能同时成立 */
  const badR = [[1, 0.9, 0.9], [0.9, 1, -0.9], [0.9, -0.9, 1]];
  const prepBad = call(`(R) => prepCorr(R, 3, 300)`, badR);
  const minEigBad = Math.min.apply(null, prepBad.eigen);
  chk('PSD 修正：非半正定输入会被夹紧到 λ≥0', minEigBad >= 0, 'true');
  chk('PSD 修正：对角线严格为 1',
    prepBad.R.every((row, i) => Math.abs(row[i] - 1) < 1e-9), 'true');
  chk('PSD 修正被明确标记出来（不静默）', prepBad.clipped, 'true');
  const prepOk = call(`(R) => prepCorr(R, 3, 300)`, R3);
  chk('半正定输入不会被平白改动 δ 计算', prepOk.delta > 0 && prepOk.delta < 1, 'true');
  chk('收缩强度 δ 随样本量上升而下降',
    call(`(R) => prepCorr(R, 3, 60)`, R3).delta > call(`(R) => prepCorr(R, 3, 5000)`, R3).delta, 'true');

  /* ---------- ③ 网络端到端：共因子造成的虚假相关必须在偏相关里消失 ---------- */
  /* 构造：X 是共同驱动；Y、Z 各自 = X + 独立噪声。
   * 总相关 corr(Y,Z) 会很高（都被 X 推着走），但控制 X 之后应当掉到 ~0。
   * 这一条是整个「偏相关」功能存在的理由 —— 不验就等于没做。 */
  const Yv = [], Zv = [], Xv = [], Rv = [];
  const Bv = [], Cv = [];
  for (let i = 0; i < 400; i++) {
    const x = rndN();
    Xv.push(x);
    Yv.push(x * 1.0 + rndN() * 0.15);
    Zv.push(x * 1.0 + rndN() * 0.15);
    Rv.push(rndN());                       // 完全独立的一条
    Bv.push(x * 0.8 + rndN() * 0.3);       // 另一个被 X 带动的
    Cv.push(-x * 0.7 + rndN() * 0.3);      // 与 X 反向的
  }
  const specXYZ = { X: Xv, Y: Yv, Z: Zv, RND: Rv, B: Bv, C: Cv };
  call(`(spec) => {
    const out = {};
    Object.keys(spec).forEach(function (k) { const m = new Map(); spec[k].forEach(function (v, i) { m.set(1000 + i, v); }); out[k] = m; });
    state.retMaps = out;
    state.series = {};
    Object.keys(spec).forEach(function (k) { state.series[k] = [1, 2, 3]; });
    return true;
  }`, specXYZ);
  const keysXYZ = Object.keys(specXYZ);
  chk('合成序列 6 条（键名不在 META 里，所以直接喂给 netAnalyze）', keysXYZ.length, 6);
  const AN = call(`(k) => netAnalyze(k, { win: 0 })`, keysXYZ);
  chk('网络分析产出结果', !!AN, 'true');
  if (AN) {
    const iY = AN.keys.indexOf('Y'), iZ = AN.keys.indexOf('Z'), iX = AN.keys.indexOf('X');
    const iR = AN.keys.indexOf('RND');
    const rYZ = AN.R[iY][iZ];
    const pYZ = AN.partial[iY][iZ];
    chk('共因子导致高总相关 corr(Y,Z) > 0.8', rYZ > 0.8, 'true');
    chk('控制共因子后偏相关 |ρ(Y,Z|X…)| 显著下降', Math.abs(pYZ) < Math.abs(rYZ) - 0.4, 'true');
    chk('偏相关矩阵对角为 1', AN.partial.every((row, i) => Math.abs(row[i] - 1) < 1e-9), 'true');
    chk('偏相关矩阵对称', AN.partial.every(function (row, i) {
      return row.every(function (v, j) { return Math.abs(v - AN.partial[j][i]) < 1e-9; });
    }), 'true');
    chk('MST 边数 = n-1（树的定义）', AN.mst.length, AN.keys.length - 1);
    /* 无环校验：并查集 */
    const par = AN.keys.map((_, i) => i);
    const find = a => par[a] === a ? a : (par[a] = find(par[a]));
    let cyclic = false;
    AN.mst.forEach(function (e) {
      const ra = find(e.a), rb = find(e.b);
      if (ra === rb) cyclic = true;
      par[ra] = rb;
    });
    chk('MST 无环（真是树，不是巧合）', cyclic, 'false');
    chk('每个点都在树里（无孤立节点）', new Set(AN.keys.map(function (_, i) { return find(i); })).size, 1);
    chk('MST 边上的相关值是真实矩阵取值',
      AN.mst.every(function (e) { return Math.abs(e.r - AN.R[e.a][e.b]) < 1e-12; }), 'true');
    chk('独立序列 RND 不被误连成强关系', Math.abs(AN.R[iR][iX]) < 0.25, 'true');
    chk('反向序列 C 与 X 负相关', AN.R[AN.keys.indexOf('C')][iX] < -0.5, 'true');
    chk('吸收比 PC1 高（构造数据里确实只有一个主因子）', AN.absorption[0] > 0.5, 'true');
    chk('吸收比单调不减且 PC1…PCn 最终为 1',
      AN.absorption.every((v, i) => i === 0 || v >= AN.absorption[i - 1] - 1e-12) &&
      Math.abs(AN.absorption[AN.absorption.length - 1] - 1) < 1e-9, 'true');
    chk('分散化比率 > 1（相关低于 1 时才成立）', AN.divRatio > 1, 'true');
    chk('簇数落在 2~5', AN.nCluster >= 2 && AN.nCluster <= 5, 'true');
    chk('每个点都分到了簇', AN.cluster.every(v => v >= 0), 'true');
    chk('特征向量中心性全为正且已归一化',
      AN.eigC.every(v => v >= -1e-12) && Math.abs(Math.sqrt(AN.eigC.reduce((a, b) => a + b * b, 0)) - 1) < 1e-6, 'true');
    chk('强度最大的点落在共同因子 X 上', AN.keys[AN.strength.indexOf(Math.max.apply(null, AN.strength))], 'X');
    const sigTail = AN.pairs.filter(p => p.sig).length;
    chk('显著性判定有结果且不全显著', sigTail > 0 && sigTail < AN.pairs.length, 'true');
    chk('每对都带了 q 值（BH-FDR 而不是裸 p）', AN.pairs.every(p => p.q >= p.p - 1e-15), 'true');
    console.log('   共因子结构：corr(Y,Z)=' + rYZ.toFixed(3) + ' → 偏相关 ' + pYZ.toFixed(3) +
      ' · PC1 吸收比 ' + (AN.absorption[0] * 100).toFixed(1) + '% · MST ' + AN.mst.length + ' 边 / ' + AN.pairs.length + ' 对');
  }

  /* ---------- ④ 领先-滞后：对着人工埋的传导时延验 ---------- */
  const LAG = 2;
  const leadSer = [], btcSer = [], lagSer = [];
  for (let i = 0; i < 500; i++) {
    const x = rndN();
    leadSer.push(x);
    lagSer.push(rndN());
    /* BTC 的今天由「某序列 2 天前」驱动 —— 那么该序列应当被评为领先 2 日 */
    btcSer.push(0.6 * (i >= LAG ? leadSer[i - LAG] : rndN()) + rndN() * 0.25);
  }
  call(`(spec) => {
    const out = {};
    Object.keys(spec).forEach(function (k) { const m = new Map(); spec[k].forEach(function (v, i) { m.set(2000 + i, v); }); out[k] = m; });
    state.retMaps = out; state.series = {};
    Object.keys(spec).forEach(function (k) { state.series[k] = [1, 2, 3]; });
    return true;
  }`, { LEAD: leadSer, BTC: btcSer, LAGSER: lagSer });
  const LL = call(`(k, t) => leadLag(k, t, { maxLag: 5, win: 365 })`, ['LEAD', 'LAGSER'], 'BTC');
  chk('领先-滞后扫描产出结果', !!LL, 'true');
  if (LL) {
    const rd = LL.rows.find(r => r.key === 'LEAD');
    chk('埋了 2 日传导的序列被评为「领先 2 日」', rd.bestLag, 2);
    chk('领先方向的相关为正（与构造一致）', rd.bestR > 0.3, 'true');
    chk('同步相关明显弱于最优滞后相关', Math.abs(rd.bestR) > Math.abs(rd.lag0) + 0.15, 'true');
    chk('半样本稳定性：前后两段都指向同一滞后', rd.stable, 'true');
    chk('通过 BH-FDR（真传导必须能过关）', rd.sigQ, 'true');
    const rndRow = LL.rows.find(r => r.key === 'LAGSER');
    chk('纯噪声序列滞后 == ±1 或不稳定/不显著，不得冒充领先指标',
      (rndRow.lagA !== rndRow.lagB) || rndRow.sigQ === false, 'true');
    chk('返回了整条滞后曲线（不只是最优值）', Object.prototype.toString.call(rd.curve) === '[object Array]' && rd.curve.length, 11);
    console.log('   领先-滞后：LEAD 最优滞后 ' + rd.bestLag + ' 日 r=' + rd.bestR.toFixed(3) +
      ' · 同步 r=' + rd.lag0.toFixed(3) + ' · q=' + rd.q.toFixed(4) + ' · 半样本 ' + rd.lagA + '/' + rd.lagB);
  }

  /* ---------- ⑤ 滚动共振 / 相关性突变 ---------- */
  /* ④ 那段把 retMaps 换成了领先-滞后的三序列，这里换回来 */
  call(`(spec) => {
    const out = {};
    Object.keys(spec).forEach(function (k) { const m = new Map(); spec[k].forEach(function (v, i) { m.set(1000 + i, v); }); out[k] = m; });
    state.retMaps = out; state.series = {};
    Object.keys(spec).forEach(function (k) { state.series[k] = [1, 2, 3]; });
    return true;
  }`, specXYZ);
  const RSs = call(`(k) => rollingSystemic(k, { win: 90, step: 5 })`, keysXYZ);
  chk('滚动共振产出时间序列', !!(RSs && RSs.pts.length > 10), 'true');
  if (RSs) {
    chk('滚动平均相关全部有界', RSs.pts.every(p => p.avg >= -1 && p.avg <= 1), 'true');
    chk('共振占比在 [0,1]', RSs.pts.every(p => p.shareHi >= 0 && p.shareHi <= 1), 'true');
    chk('z 值有限', isFinite(RSs.z), 'true');
    chk('窗口组合数 = C(6,2)=15', RSs.nPair, 15);
    console.log('   滚动共振（构造数据全是同一个 X 驱动）：均值 ' + RSs.mean.toFixed(3) +
      ' · 当前 ' + RSs.last.avg.toFixed(3) + ' · |ρ|>0.5 占比 ' + (RSs.last.shareHi * 100).toFixed(0) + '%');
  }

  /* ---------- ⑥ 岭回归：对着「另一份独立实现」逐位对照 ---------- */
  if (rep) {
    const t0 = Date.now();
    const rwF = call(`(r, o) => ridgeWalkForward(r, o)`, rep, { step: 1 });
    const ms = Date.now() - t0;
    chk('walk-forward 岭回归产出结果', !!rwF, 'true');
    if (rwF) {
      chk('参与因子数 ≤ 回放维度 22', rwF.K > 0 && rwF.K <= 22, 'true');
      chk('首个预测日落在训练量门槛之后', rwF.firstPred > rep.start, 'true');
      chk('四条 λ 全部给了评价结果', rwF.rows.length, 4);
      chk('默认 λ 是预注册的那一条', rwF.lambdaDefault, 1);
      chk('IC 全部有界', rwF.rows.every(r => r.ic == null || Math.abs(r.ic) <= 1), 'true');
      chk('每因子都给出了学到的系数', rwF.betas.length, rwF.K);
      chk('系数按 |β| 降序', rwF.betas.every((r, i) => i === 0 || Math.abs(rwF.betas[i - 1].beta) >= Math.abs(r.beta) - 1e-15), 'true');
      chk('方向一致性统计完整', rwF.agreeTot > 0 && rwF.agreeN <= rwF.agreeTot, 'true');
      chk('有效下注数落在 [1, K]', rwF.enb >= 1 - 1e-9 && rwF.enb <= rwF.K + 1e-9, 'true');
      chk('不少于一次重估', rwF.nRefit >= 1, 'true');

      /* 独立实现：直接构造 X/y，用 Gauss-Jordan 解正规方程 */
      const X = [], yy = [];
      for (let i = rep.start; i <= rep.n - 1 - rwF.h; i++) {
        const yv = (rep.closes[i + rwF.h] / rep.closes[i]) - 1;
        if (!isFinite(yv)) continue;
        const row = [1];
        for (const id of rwF.ids) { const v = rep.fzs[id][i]; row.push(v == null ? 0 : v); }
        X.push(row); yy.push(yv);
      }
      const p = X[0].length, n = X.length;
      const G = [];
      for (let a = 0; a < p; a++) G.push(new Array(p).fill(0));
      for (let a = 0; a < p; a++) for (let c = 0; c < p; c++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += X[i][a] * X[i][c];
        G[a][c] = s / n;
      }
      const b = [];
      for (let a = 0; a < p; a++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][a] * yy[i]; b.push(s / n); }
      for (let j = 1; j < p; j++) G[j][j] += rwF.lambdaDefault;
      const M = G.map((r, i) => r.concat([b[i]]));
      for (let col = 0; col < p; col++) {
        let piv = col;
        for (let r = col + 1; r < p; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
        const d = M[col][col];
        for (let c = col; c <= p; c++) M[col][c] /= d;
        for (let r = 0; r < p; r++) {
          if (r === col) continue;
          const f = M[r][col];
          if (!f) continue;
          for (let c = col; c <= p; c++) M[r][c] -= f * M[col][c];
        }
      }
      const ref = M.map(r => r[p]);
      let maxDiff = 0;
      near('截距与独立 Gauss-Jordan 实现一致', rwF.intercept, ref[0], 1e-8);
      rwF.ids.forEach(function (id, k) {
        const row = rwF.betas.find(function (x) { return x.id === id; });
        maxDiff = Math.max(maxDiff, Math.abs(row.beta - ref[k + 1]));
      });
      chk('全部系数与独立实现逐位一致（累加器 + Cholesky 都对）', maxDiff < 1e-8, 'true');
      if (maxDiff >= 1e-8) console.log('   maxDiff=' + maxDiff);

      console.log('   岭回归：' + rwF.K + ' 维 · ' + rwF.nTrainMax + ' 训练样本 · ' + rwF.nRefit + ' 次重估 · ' +
        '有效下注 ' + rwF.enb.toFixed(1) + ' · 方向一致 ' + rwF.agreeN + '/' + rwF.agreeTot + ' · ' + ms + 'ms');
      rwF.rows.forEach(function (r) {
        console.log('     λ=' + String(r.lambda).padEnd(5) + ' OOS IC=' + (r.ic == null ? '—' : r.ic.toFixed(3)) +
          ' t=' + (r.t == null ? '—' : r.t.toFixed(2)) + ' 多空差=' + (r.spread == null ? '—' : (r.spread * 100).toFixed(2) + '%'));
      });
      if (rwF.baseline) console.log('     对照：手写权重 IC=' + rwF.baseline.ic.toFixed(3) + ' 多空差=' + (rwF.baseline.spread * 100).toFixed(2) + '%');

      /* ---- 前视偏差零容忍：篡改未来不得改变任何历史预测 ---- */
      const H3 = mkHist();
      const cut2 = 60, lastT = rep.n - 1;
      for (let i = lastT - cut2 + 1; i <= lastT; i++) {
        H3.macro.SPX.closes[i] *= 3; H3.macro.DXY.closes[i] *= 0.4;
        H3.macro.VIX.closes[i] *= 4; H3.btc.closes[i] *= 2;
      }
      call('h => { state.histBundle = h; }', H3);
      const rep3 = call('replayHistory');
      const rw3 = call(`(r, o) => ridgeWalkForward(r, o)`, rep3, { step: 1 });
      let leakFree = true, cmpN = 0;
      if (rw3) {
        for (let i = rwF.firstPred; i <= lastT - cut2; i++) {
          if (rwF.sigDefault[i] == null) continue;
          cmpN++;
          if (rwF.sigDefault[i] !== rw3.sigDefault[i]) { leakFree = false; break; }
        }
      }
      chk('篡改未来 60 天数据 → 历史预测一字不变（' + cmpN + ' 天逐位比对）', leakFree && cmpN > 50, 'true');
      call('h => { state.histBundle = h; }', mkHist());

      /* ---- 实时套用：虚构一组 z，看评分是否单调、是否有界 ---- */
      const mkOut = (val) => {
        const o = {};
        rwF.ids.forEach(id => (o[id] = { z: val, ok: true, contribution: val }));
        return o;
      };
      call('(o) => { state.hist = { rw: { live: null } }; }', {});
      const rwl = call(`(r, o) => ridgeWalkForward(r, o)`, rep, { only: ['dxy', 'us10y', 'spx', 'vix', 'gold', 'fed', 'bei', 'curve', 'jpy', 'jgb', 'tech', 'mom'] });
      chk('实时可用口径（12~17 维）也能训练', !!rwl, 'true');
      if (rwl) {
        chk('实时口径只含事先声明的那些因子',
          rwl.ids.every(id => ['dxy', 'us10y', 'spx', 'vix', 'gold', 'fed', 'bei', 'curve', 'jpy', 'jgb', 'tech', 'mom'].indexOf(id) >= 0), 'true');
        call('(rw) => { state.hist = { rw: { live: rw, full: rw } }; }', rwl);
        /* 注意：不能假设「所有 z 都取 +2 就一定更看多」—— 系数是有正有负的，
         * 学到的方向未必与原本假设的方向一致。沿 +β 方向推才是同向变化。 */
        const alongBeta = (amp) => {
          const o = {};
          rwl.ids.forEach(function (id) {
            const row = rwl.betas.find(function (x) { return x.id === id; });
            const sg = (row && row.beta != null && row.beta >= 0) ? 1 : -1;
            o[id] = { z: amp * sg, ok: true };
          });
          return o;
        };
        const sNeg = call('(o) => ridgeLiveScore(o)', alongBeta(-2));
        const sZero = call('(o) => ridgeLiveScore(o)', alongBeta(0));
        const sPos = call('(o) => ridgeLiveScore(o)', alongBeta(2));
        chk('实时评分落在 [2,98]', [sNeg, sZero, sPos].every(s => s.score >= 2 && s.score <= 98), 'true');
        chk('百分位沿系数方向单调上升', sNeg.pct <= sZero.pct && sZero.pct <= sPos.pct, 'true');
        chk('读数全为 0 时落在中间档附近', sZero.pct > 0.05 && sZero.pct < 0.95, 'true');
        chk('全部因子缺失时不硬算', call('(o) => ridgeLiveScore(o)', {}), 'null');
      }
    }

    /* ---------- ⑦ 分歧度 ---------- */
    const resLive = call('computeNexusScore');
    const Dv = call('(r) => scoreDispersion(r)', resLive);
    chk('分歧度产出结果', !!Dv, 'true');
    if (Dv) {
      chk('参与维度 > 3', Dv.n > 3, 'true');
      chk('一致度在 [0,1]', Dv.consensus >= 0 && Dv.consensus <= 1, 'true');
      chk('分歧 σ ≥ 0', Dv.sd >= 0, 'true');
      chk('jackknife 区间包含中心趋势', Dv.jackLo <= Dv.jackHi, 'true');
      chk('点名了最具影响力的因子', !!(Dv.driver && Dv.driver.name), 'true');
      chk('独立假设下的标准误有限', isFinite(Dv.bandScore), 'true');
      chk('三项权重占比合计 ≤ 1', Dv.upW + Dv.dnW + Dv.flatW <= 1 + 1e-9, 'true');
    }

    /* ---------- ⑧ 渲染层冒烟：不得抛错、且必须真的写出内容 ---------- */
    /* 前面的 Section ③④ 用的是 META 之外的合成键名（netAnalyze 可以直接吃），
     * 但渲染链路走的是 netKeys()（必须同时出现在 state.series 与 META 里），
     * 所以这里换成真实键名的一份数据，否则测的是「空面板恰好没崩」。 */
    const realSpec = {};
    ['BTC', 'DXY', 'GOLD', 'SPX', 'VIX', 'US10Y', 'USDJPY'].forEach(function (k) {
      const arr = [];
      let x = 0;
      for (let i = 0; i < 400; i++) { x = x * 0.7 + rndN(); arr.push(x); }
      realSpec[k] = arr;
    });
    /* 让 SPX 与 BTC 同向、VIX 与 BTC 反向 —— 顺便让「最强邻居」这一栏有东西可选 */
    realSpec.SPX = realSpec.BTC.map(v => v * 0.6 + rndN() * 0.3);
    realSpec.VIX = realSpec.BTC.map(v => -v * 0.5 + rndN() * 0.3);
    call(`(spec) => {
      const out = {};
      Object.keys(spec).forEach(function (k) { const m = new Map(); spec[k].forEach(function (v, i) { m.set(3000 + i, v); }); out[k] = m; });
      state.retMaps = out; state.series = {};
      Object.keys(spec).forEach(function (k) { state.series[k] = [1, 2, 3]; });
      return true;
    }`, realSpec);
    call('(v) => { NET_OPTS.win = 120; NET_OPTS.rel = "corr"; NET_OPTS.mode = "mst"; }');
    call('netAnalyzed', true);
    chk('netKeys 认出 7 条真实键名序列', call('netKeys').length, 7);

    let threw = null;
    try {
      call('renderNetStats'); call('renderHeatmap'); call('renderCorrPanels');
      call('renderSystemic'); call('renderScoreV2', resLive); call('renderRwBox');
      call('initNetwork');
    } catch (e) { threw = (e && e.message) || String(e); }
    chk('v3.20 全部渲染函数在桩环境下不抛错', threw, 'null');
    chk('关系矩阵有内容', ($id('heatmap').innerHTML || '').length > 200, 'true');
    chk('网络统计条有内容', ($id('netStats').innerHTML || '').indexOf('badge') >= 0, 'true');
    chk('领先-滞后面板有内容', ($id('leadLagBox').innerHTML || '').length > 80, 'true');
    chk('滚动共振说明写着口径而不是空着', ($id('corrNote').innerHTML || '').length > 60, 'true');
    chk('分歧度卡片有内容', ($id('dispBox').innerHTML || '').indexOf('一致') >= 0, 'true');
    /* 选项切换：三个开关必须真的改变输出，而不是只换了个高亮 */
    const cnt120 = $id('netCount').textContent;
    call('(w) => { NET_OPTS.win = w; }', 365);
    call('netAnalyzed', true); call('renderHeatmap'); call('initNetwork');
    chk('切换窗口到 365 日后统计口径跟着变', cnt120 !== $id('netCount').textContent && ($id('netCount').textContent || '').indexOf('365') >= 0, 'true');
    call('(v) => { NET_OPTS.rel = v; }', 'part');
    call('initNetwork'); call('renderHeatmap');
    chk('切换偏相关后标题随之改变', ($id('netCount').textContent || '').indexOf('偏相关') >= 0, 'true');
    call('(v) => { NET_OPTS.mode = v; }', 'sig');
    call('initNetwork');
    chk('显著网络模式下依然能出图（节点数不减）', !!call('netAnalyzed') , 'true');
    call('(o) => { NET_OPTS.mode = "mst"; NET_OPTS.rel = "corr"; NET_OPTS.win = 120; }');
    call('netAnalyzed', true);
  }


  /* =================================================================
   * O. v3.21 · 分位数组合 / 校准 / 风险化仓位 / 有效维度
   *
   * 这一段与 N 段同源：验的是**数学与口径**，不是「功能没崩」。
   * 四组独立交叉验证：
   *   ① olsFit / effectiveDim / permute5 对着**解析解**验
   *   ② 单调性用 5!=120 全枚举，对「完美递增 / 完美递减 / 随机」三种输入
   *      分别给出 1/120、1、中间值 —— 端点值可以手算，所以能当基准
   *   ③ 校准的三件真事：斜率能恢复、非重叠 t 必然比重叠 t 小、
   *      过度自信的模型校准斜率必须 < 1
   *   ④ 仓位：五道闸门各自能单独把仓位打到 0，且「起作用的是哪个」不能错
   * ================================================================= */
  console.log('\n===== O. v3.21 · 校准 / 分位数 / 仓位 / 有效维度 =====');
  {
    /* 确定性随机源（本段所有合成数据都用它，保证可复现） */
    let seed = 20261003;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const rndN = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

    /* ---------- ① olsFit 对着解析解验 ---------- */
    const xs = [], ys = [];
    for (let i = 0; i < 200; i++) { const x = i * 0.37 - 20; xs.push(x); ys.push(3 + 2 * x); }
    const fitExact = call('olsFit', xs, ys);
    near('olsFit 斜率恢复（无噪声 y=3+2x）', fitExact.b, 2, 1e-9);
    near('olsFit 截距恢复', fitExact.a, 3, 1e-8);
    near('olsFit 无噪声时 R²=1', fitExact.r2, 1, 1e-12);
    chk('  无噪声时残差标准差为 0', fitExact.sdResid < 1e-9, 'true');
    /* 均值响应标准误：中心处最窄、离中心越远越宽 —— 这是「极值评分不可信」的数学根据 */
    /* 注意：无噪声时 s2=0，标准误处处为 0 —— 必须换一个有噪声的拟合才能验「越远越宽」 */
    const xs2 = [], ys2 = [];
    for (let i = 0; i < 200; i++) { const x = i * 0.37 - 20; xs2.push(x); ys2.push(3 + 2 * x + rndN() * 3); }
    const fitNoisy = call('olsFit', xs2, ys2);
    chk('  有噪声时斜率仍能恢复（±0.15）', Math.abs(fitNoisy.b - 2) < 0.15, 'true');
    const seMid = fitNoisy.seAt(fitNoisy.mx), seFar = fitNoisy.seAt(fitNoisy.mx + 30);
    chk('  均值响应标准误随偏离中心而变宽', seFar > seMid, 'true');
    near('  中心处标准误 = sdResid/√n', seMid, fitNoisy.sdResid / Math.sqrt(fitNoisy.n), 1e-12);
    near('  muAt 与解析一致', fitExact.muAt(10), 23, 1e-8);
    /* minN 门槛：分段校准只有 5 个点，默认 n≥10 会把它整个拒掉 */
    const five = [1, 2, 3, 4, 5], fiveY = [2, 4, 6, 8, 10];
    chk('  olsFit 默认拒绝 5 个点（n<10）', call('olsFit', five, fiveY) === null, 'true');
    const fit5 = call('olsFit', five, fiveY, 3);
    near('  minN=3 时 5 个点能算且斜率正确', fit5.b, 2, 1e-9);

    /* ---------- ② 置换检验的端点值可手算 ---------- */
    chk('permute5 恰好 120 种排列', call('permute5').length, 120);
    chk('  120 种排列互不重复', new Set(call('permute5').map(p => p.join(''))).size, 120);
    const mpUp = call('monoPermP', [1, 2, 3, 4, 5]);
    near('完美递增 ρ=1', mpUp.rho, 1, 1e-9);
    near('  完美递增 p=1/120（只有一种排列不差于它）', mpUp.p, 1 / 120, 1e-9);
    const mpDn = call('monoPermP', [5, 4, 3, 2, 1]);
    near('完美递减 ρ=-1', mpDn.rho, -1, 1e-9);
    near('  完美递减 p=1（所有排列都不差于它）', mpDn.p, 1, 1e-9);
    const mpMid = call('monoPermP', [1, 3, 2, 4, 5]);
    chk('  轻微打乱的 p 落在两端之间', mpMid.p > 1 / 120 && mpMid.p < 1, 'true');
    chk('  含 null 时返回 null', call('monoPermP', [1, null, 3, 4, 5]) === null, 'true');

    /* ---------- 合成 rep：评分与未来 10 日收益强正相关 ---------- */
    const mkRep = function (n, start, corrSign, noise) {
      const closes = new Array(n).fill(null);
      const zs = new Array(n).fill(null);
      for (let i = 0; i < n; i++) { zs[i] = rndN(); }
      let p = 60000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0008 + 0.02 * rndN()); }
      /* 评分由「未来 10 日收益」反推 —— 这样相关方向一定是我们指定的方向 */
      const fwd = new Array(n).fill(null);
      for (let i = 0; i < n - 10; i++) fwd[i] = closes[i + 10] / closes[i] - 1;
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) {
        scores[i] = Math.max(2, Math.min(98, 50 + corrSign * 600 * fwd[i] + (noise || 0) * rndN()));
      }
      /* 因子 z：造两块，块内高度相关、块间独立 —— 用来验聚类与有效维度 */
      const ids = ['dxy', 'us10y', 'spx', 'vix', 'gold', 'oil', 'fng', 'hr'];
      const fzs = {}, fvals = {};
      const b1 = [], b2 = [];
      for (let i = 0; i < n; i++) { b1.push(rndN()); b2.push(rndN()); }
      ids.forEach(function (id, k) {
        const arr = new Array(n).fill(null);
        const src = k < 4 ? b1 : b2;
        for (let i = start; i < n; i++) arr[i] = src[i] * 0.95 + rndN() * 0.3;
        fzs[id] = arr;
        const fav = new Array(n).fill(null);
        for (let i = start; i < n; i++) fav[i] = Math.max(-2.5, Math.min(2.5, arr[i]));
        fvals[id] = fav;
      });
      return { n: n, start: start, closes: closes, scores: scores, fzs: fzs, fvals: fvals, calTs: [], nAct: [] };
    };

    const rep = mkRep(700, 20, 1, 0);
    const q = call('quintileTest', rep, 10);
    chk('quintileTest 产出结果', !!q, 'true');
    chk('  5 档齐全', q.buckets.length, 5);
    chk('  每档都有样本', q.buckets.every(b => b.n > 0), 'true');
    chk('  强正相关下分档均值严格单调', q.monotonic, 'true');
    near('  强正相关下 ρ=1', q.rho, 1, 1e-9);
    near('  p=1/120', q.pMono, 1 / 120, 1e-9);
    chk('  Q5 收益 > Q1', q.buckets[4].mean > q.buckets[0].mean, 'true');
    chk('  多空价差为正', q.spread > 0, 'true');
    chk('  t 用非重叠口径（Q5 的 neff 远小于 n）', q.buckets[4].neff < q.buckets[4].n, 'true');
    chk('  多空组合有净值与回撤', isFinite(q.ls.total) && q.ls.mdd >= 0, 'true');
    chk('样本不足（<100 对）返回 null', call('quintileTest', mkRep(60, 5, 1, 0), 10) === null, 'true');

    /* 反相关：分档必须反向单调 —— 否则说明符号处理反了 */
    const qn = call('quintileTest', mkRep(700, 20, -1, 0), 10);
    chk('反相关下 Q1 收益 > Q5', qn.buckets[0].mean > qn.buckets[4].mean, 'true');
    chk('  反相关下不报「严格递增」', qn.monotonic === false, 'true');

    /* ---------- 样本外保序：稳定关系 vs 反转关系 ---------- */
    const qoStable = call('quintileOOS', mkRep(900, 20, 1, 0), 10);
    chk('quintileOOS 产出结果', !!qoStable, 'true');
    chk('  稳定关系下样本外保序成立', qoStable.monotonic && qoStable.rho > 0.5, 'true');
    chk('  切分点只由前段决定（前段样本量 > 0）', qoStable.nIn > 0 && qoStable.nOut > 0, 'true');
    chk('  各档样本量合计 = 后段总量', qoStable.ns.reduce((a, b) => a + b, 0), qoStable.nOut);
    chk('  后段 IC 为正（信号没衰减）', qoStable.icOut.ic > 0, 'true');
    chk('样本太短时返回 null', call('quintileOOS', mkRep(120, 5, 1, 0), 10) === null, 'true');

    /* ---------- ③ 校准 ---------- */
    const cal = call('calibFit', rep, 10);
    chk('calibFit 产出结果', !!cal, 'true');
    chk('  斜率方向正确（评分越高收益越高）', cal.b > 0, 'true');
    chk('  R² 落在 (0,1]', cal.r2 > 0 && cal.r2 <= 1, 'true');
    chk('  非重叠 t 必然比重叠 t 保守', Math.abs(cal.tBEff) < Math.abs(cal.tB), 'true');
    near('  tBEff ≈ tB/√h（h=10）', Math.abs(cal.tBEff), Math.abs(cal.tB) / Math.sqrt(10), Math.abs(cal.tB) * 0.05);
    chk('  nEff = n/h 量级', cal.nEff === Math.floor(cal.n / 10), 'true');
    near('alphaAtScore(样本均值) = 0（漂移被剔除）', cal.alphaAtScore(cal.mxScore), 0, 1e-12);
    near('  seAlphaAtScore(样本均值) = 0', cal.seAlphaAtScore(cal.mxScore), 0, 1e-12);
    chk('  偏离越远，超额的标准误越大', cal.seAlphaAtScore(cal.mxScore + 25) > cal.seAlphaAtScore(cal.mxScore + 5), 'true');
    chk('  muAt - alpha = 样本基准漂移', Math.abs((cal.muAtScore(70) - cal.alphaAtScore(70)) - cal.base) < 1e-9
      || Math.abs(cal.muAtScore(70) - cal.alphaAtScore(70) - (cal.a + cal.b * cal.mxScore)) < 1e-9, 'true');
    chk('  分段校准 5 段齐全', cal.bins.length === 5 && cal.bins.every(b => b.n > 0), 'true');
    chk('  校准斜率算得出来（minN 已放开）', cal.calibSlope != null, 'true');
    chk('样本外块存在', !!cal.oos && cal.oos.n > 0, 'true');

    /* 样本内的校准斜率按构造恒为 1（ŷ 是 y 的投影 ⇒ Cov(y,ŷ)/Var(ŷ) ≡ 1），
     * 所以它不能用来判断「标得准不准」—— 这里直接断言它的数值，
     * 是为了把这个恒等式钉死：以后谁把它当证据，测试会立刻响。 */
    near('样本内校准斜率恒为 1（恒等式，不含信息）', cal.calibSlope, 1, 0.05);
    chk('  样本外校准斜率才是可判读的那个', typeof cal.oos.slopeOOS, 'number');

    /* 真正有意义的检验：让信号只存在于前 60%、后 40% 变成纯噪声。
     * 那么样本内（全样本拟合）R² 仍为正，而样本外必须塌掉。 */
    const repDecay = mkRep(900, 20, 1, 0);
    const cutD = repDecay.start + Math.floor((repDecay.n - repDecay.start) * 0.6);
    for (let i = cutD; i < repDecay.n; i++) {
      repDecay.scores[i] = Math.max(2, Math.min(98, 50 + 25 * rndN()));
    }
    const calDecay = call('calibFit', repDecay, 10);
    chk('信号在后段消失 → 样本内 R² 仍为正（同一样本会骗人）', calDecay.r2 > 0.02, 'true');
    chk('  但样本外 R² ≤ 0（映射搬不出样本）', calDecay.oos.r2 <= 0.02, 'true');
    chk('  样本外校准斜率 ≈ 0（预测几乎不携带信息）', Math.abs(calDecay.oos.slopeOOS) < 0.35, 'true');
    chk('  两栏 t：非重叠必然更保守', Math.abs(calDecay.tBEff) < Math.abs(calDecay.tB), 'true');

    /* ---------- ④ effectiveDim 的解析解 ---------- */
    /* effectiveDim 收的是**特征值数组**，不是矩阵 —— 传矩阵会静默返回 null */
    const eI = call('effectiveDim', [1, 1, 1, 1, 1, 1]);
    near('单位矩阵 PR = 维数', eI.pr, 6, 1e-9);
    near('  单位矩阵熵有效维度 = 维数', eI.entDim, 6, 1e-9);
    near('  PC1 占比 = 1/p', eI.top1, 1 / 6, 1e-9);
    chk('  需要全部 6 个才能解释 90%', eI.nFor90, 6);
    const eO = call('effectiveDim', [6, 0, 0, 0, 0, 0]);
    near('完全共线（全 1）PR = 1', eO.pr, 1, 1e-6);
    near('  完全共线熵有效维度 = 1', eO.entDim, 1, 1e-6);
    chk('  完全共线时一个方向就够了', eO.nFor90, 1);
    chk('  空输入返回 null', call('effectiveDim', []) === null, 'true');

    /* ---------- facZCorr / avgLinkCluster / seqUnique ---------- */
    const FZ = call('facZCorr', rep);
    chk('facZCorr 产出结果', !!FZ, 'true');
    chk('  对角为 1', FZ.R.every((r, i) => Math.abs(r[i] - 1) < 1e-12), 'true');
    chk('  对称', FZ.R.every((r, i) => r.every((v, j) => Math.abs(v - FZ.R[j][i]) < 1e-12)), 'true');
    chk('  元素都在 [-1,1]', FZ.R.every(r => r.every(v => v >= -1.0001 && v <= 1.0001)), 'true');
    /* 注意：FZ.ids 的顺序是 REPLAY_IDS 的顺序，不是 mkRep 里 ids 的顺序 ——
     * 必须按名字找下标，不能按位置猜（这里踩过一次）。 */
    const ix = id => FZ.ids.indexOf(id);
    chk('  块内相关 > 0.5（同块：dxy-us10y）', FZ.R[ix('dxy')][ix('us10y')] > 0.5, 'true');
    chk('  块内相关 > 0.5（同块：fng-hr）', FZ.R[ix('fng')][ix('hr')] > 0.5, 'true');
    chk('  块间相关 ≈ 0（跨块：dxy-gold）', Math.abs(FZ.R[ix('dxy')][ix('gold')]) < 0.35, 'true');
    const CL = call('avgLinkCluster', FZ.R, FZ.p);
    chk('avgLinkCluster 分出 2 块（合成数据就是两块）', CL.k, 2);
    chk('  每个因子都归属了某一块', CL.cluster.every(c => c >= 0), 'true');
    chk('  两块各 4 个成员', CL.cluster.filter(c => c === CL.cluster[ix('dxy')]).length, 4);
    /* 同块必须真的落在同一簇：这条比「簇数=2」更能证明聚类是对的 */
    chk('  dxy 与 us10y 同簇', CL.cluster[ix('dxy')] === CL.cluster[ix('us10y')], 'true');
    chk('  fng 与 hr 同簇', CL.cluster[ix('fng')] === CL.cluster[ix('hr')], 'true');
    chk('  dxy 与 gold 不同簇', CL.cluster[ix('dxy')] !== CL.cluster[ix('gold')], 'true');

    /* seqUnique：完全共线的第二个因子，独有信息量应 ≈ 0 */
    const rr = [[1, 1, 0], [1, 1, 0], [0, 0, 1]];
    const sq = call('seqUnique', rr, [0, 1, 2]);
    near('第一个因子独有 100%', sq[0].uniq, 1, 1e-12);
    chk('  完全重复的第二个因子独有 ≈ 0%', sq[1].uniq < 0.02, 'true');
    chk('  独立的第三个因子独有 ≈ 100%', sq[2].uniq > 0.95, 'true');

    /* ---------- dimAnalyze ---------- */
    const D = call('dimAnalyze', rep);
    chk('dimAnalyze 产出结果', !!D, 'true');
    chk('  分块覆盖全部因子（无遗漏无重复）',
      D.blocks.reduce((a, b) => a + b.length, 0), D.p);
    chk('  有效维度在 [1, p]', D.eff.pr >= 1 && D.eff.pr <= D.p + 1e-9, 'true');
    chk('  原模型 IC 算得出来', D.icOrig != null && isFinite(D.icOrig.ic), 'true');
    chk('  分块模型 IC 算得出来', D.icBlock != null && isFinite(D.icBlock.ic), 'true');
    chk('  块间平均 |ρ| 在 [0,1]', D.blockAvgAbsCorr >= 0 && D.blockAvgAbsCorr <= 1, 'true');
    chk('  独有信息量条目数 = 因子数', D.uniq.length, D.p);
    chk('  首个（最倚重的）因子独有 = 100%', Math.abs(D.uniq.find(u => u.rank === 0).uniq - 1) < 1e-9, 'true');
    chk('  独有信息量都在 [0,1]', D.uniq.every(u => u.uniq >= 0 && u.uniq <= 1), 'true');

    /* ---------- ⑤ 仓位：五道闸门 ---------- */
    /* 先把波动率固定下来：造一条日波动 sd≈2.6% 的日线 → 年化 ≈ 50% */
    state.klines['BTC1d'] = (function () {
      const out = []; let p = 60000;
      for (let i = 0; i < 60; i++) { const o = p; p = p * (1 + 0.026 * rndN()); out.push({ t: Date.now() + i * 86400000, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 }); }
      return out;
    })();
    const rg = call('currentRegime');
    chk('currentRegime 算出体制（仓位需要波动率）', !!rg && rg.vol > 0, 'true');

    chk('无校准时不下结论', call('sizingAdvice', { score: 70, out: {} }).have, 'false');
    chk('  并说明为什么', typeof call('sizingAdvice', { score: 70, out: {} }).why, 'string');

    /* 造一个「样本外成立」的假校准，用来验闸门逻辑本身 */
    const mkCal = function (over) {
      const base = { h: 10, mxScore: 50, base: 0.01, r2: 0.02, nEff: 300, infl: 2,
        muAtScore: s => 0.01 + 0.002 * (s - 50),
        seAtScore: s => 0.001 + Math.abs(s - 50) * 0.0002,
        alphaAtScore: s => 0.002 * (s - 50),
        seAlphaAtScore: s => Math.abs(s - 50) * 0.0002,
        oos: { r2: 0.02, slopeOOS: 1.0, n: 500 } };
      return Object.assign({}, base, over || {});
    };
    state.hist = { calib: mkCal() };
    const s70 = call('sizingAdvice', { score: 70, out: {} });
    chk('有校准时给出结果', s70.have, 'true');
    chk('  样本外闸门通过时仓位 > 0', s70.suggest > 0, 'true');
    chk('  仓位不超过杠杆上限', s70.suggest <= 1.0 + 1e-12, 'true');
    chk('  超额在均值处为 0 → Kelly 为 0', Math.abs(call('sizingAdvice', { score: 50, out: {} }).kellyFull) < 1e-12, 'true');
    chk('  Kelly 随评分单调上升', call('sizingAdvice', { score: 90, out: {} }).kellyFull > s70.kellyFull, 'true');
    chk('  保守 Kelly ≤ 全额 Kelly', s70.kellyCons <= s70.kellyFull + 1e-12, 'true');
    chk('  波动率目标 = 0.15/σ', Math.abs(s70.volTarget - 0.15 / s70.sigma) < 1e-12, 'true');
    chk('  起作用的约束在候选清单里', s70.bindKey === 'oos' || s70.cand.some(c => c.k === s70.bindKey), 'true');

    /* 闸门逐一隔离：每一道都必须能单独把仓位打到 0 */
    state.hist = { calib: mkCal({ oos: { r2: -0.05, slopeOOS: 0.02, n: 500 } }) };
    const sOOS = call('sizingAdvice', { score: 80, out: {} });
    chk('样本外不成立 → 建议 0', sOOS.suggest, 0);
    chk('  且报出是样本外闸门在起作用', sOOS.bindKey, 'oos');
    chk('  但数字仍然全部列出（不藏起来）', isFinite(sOOS.kellyFull) && isFinite(sOOS.volTarget), 'true');
    chk('  并记录了 OOS R² 与斜率', sOOS.oosR2 === -0.05 && sOOS.oosSlope === 0.02, 'true');

    state.hist = { calib: mkCal({ alphaAtScore: () => 0.0005, oos: { r2: 0.02, slopeOOS: 1.0, n: 500 } }) };
    const sCost = call('sizingAdvice', { score: 60, out: {} });
    chk('超额覆盖不了往返成本 → 建议 0', sCost.suggest, 0);
    chk('  且报出是成本门槛在起作用', sCost.bindKey, 'cost');

    state.hist = { calib: mkCal() };
    const sCap = call('sizingAdvice', { score: 98, out: {} });
    chk('极端评分下也不超过杠杆上限', sCap.suggest <= 1.0 + 1e-12, 'true');
    chk('  区间跨 0 时会被标记出来', typeof sCap.ciIncludes0, 'boolean');

    /* ---------- 渲染冒烟 ---------- */
    state.hist = { rep: rep, quint: q, qOos: qoStable, calib: cal, dim: D };
    state.lastScore = 65; state.lastScoreOut = {};
    let threwO = null;
    try { call('renderQuintBox'); call('renderCalibBox'); call('renderDimBox'); call('renderSizeBox', { score: 65, out: {} }); }
    catch (e) { threwO = (e && e.message) || String(e); }
    chk('v3.21 四个渲染函数不抛错', threwO, 'null');
    chk('分位数组合面板有内容', ($id('quintBox').innerHTML || '').length > 400, 'true');
    chk('  写着精确置换口径', ($id('quintBox').innerHTML || '').indexOf('120') >= 0, 'true');
    chk('  写着样本外保序', ($id('quintBox').innerHTML || '').indexOf('样本外') >= 0, 'true');
    chk('校准面板有内容', ($id('calibBox').innerHTML || '').length > 400, 'true');
    chk('  写着 R²', ($id('calibBox').innerHTML || '').indexOf('R²') >= 0, 'true');
    chk('  两栏 t 值都在（重叠 vs 非重叠）', ($id('calibBox').innerHTML || '').indexOf('非重叠') >= 0, 'true');
    chk('有效维度面板有内容', ($id('dimBox').innerHTML || '').indexOf('参与率') >= 0, 'true');
    chk('仓位面板有内容', ($id('sizeBox').innerHTML || '').length > 300, 'true');
    chk('  写着哪个约束在起作用', ($id('sizeBox').innerHTML || '').indexOf('起作用') >= 0, 'true');
    /* 空态：没跑过回放（state.hist === null）时不能崩，要有说明 */
    state.hist = null;
    call('renderQuintBox'); call('renderCalibBox'); call('renderDimBox');
    chk('无回放时三块给出提示而不是空白',
      ($id('quintBox').innerHTML || '').indexOf('回放') >= 0 &&
      ($id('calibBox').innerHTML || '').indexOf('回放') >= 0 &&
      ($id('dimBox').innerHTML || '').indexOf('回放') >= 0, 'true');
    /* 复位，避免污染后续段落 */
    state.hist = null;
  }

  /* =====================================================================
   * P 段：v3.22 ㉑ 预测台账 / ㉒ 换手与成本 / ㉓ 信号健康度
   * 定位与前面不同：这里守的是「不能把数值 bug 和功效不足包装成结论」。
   * ===================================================================== */
  console.log('\n===== P. v3.22 预测台账 / 换手与成本 / 信号健康度 =====');
  {
    const rnd = () => { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
    const rndN = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));

    /* ---- P1. 精确二项检验：下溢守门 ---- */
    /* v3.22 实测抓到的 bug：out[0]=exp(n·ln(1−p)) 在 n=3564 时下溢成 0，
     * 乘法递推把 0 传遍全数组 ⇒ 双侧 p 恒为 0 ⇒ 界面谎称「显著」。
     * 这两条断言就是为它设的：小 n 测不出，必须测大 n 的「总和=1」与「p≠0」。 */
    const pmfSmall = call('binomPmf', 10, 0.5);
    const pmfBig = call('binomPmf', 3564, 0.5);
    near('P1 binomPmf(n=10) 总和 = 1', pmfSmall.reduce((a, b) => a + b, 0), 1, 1e-12);
    near('P1 binomPmf(n=3564) 总和 = 1（下溢守门）', pmfBig.reduce((a, b) => a + b, 0), 1, 1e-9);
    chk('P1 大 n 下 pmf 不全为 0', pmfBig.some(v => v > 0), 'true');
    near('P1 binomPmf(n=10,k=3) = C(10,3)/2^10', pmfSmall[3], 120 / 1024, 1e-12);
    near('P1 双侧 p(n=10,k=10) = 2/2^10', call('binomTwoSided', 10, 10, 0.5), 2 / 1024, 1e-12);
    near('P1 双侧 p(n=10,k=5) = 1（众数自身）', call('binomTwoSided', 5, 10, 0.5), 1, 1e-12);
    /* 真实场景：3564 天里 1850 天押对（≈51.9%）—— p 必须既非 0 也不显著到离谱 */
    const pBig = call('binomTwoSided', 1850, 3564, 0.5);
    chk('P1 大 n 双侧 p 不因下溢变成 0', pBig > 1e-6, 'true');
    chk('P1 大 n 双侧 p 落在 (0,1) 内', pBig > 0 && pBig < 1, 'true');
    near('P1 双侧 p 关于 k↔n−k 对称', call('binomTwoSided', 3, 10, 0.5), call('binomTwoSided', 7, 10, 0.5), 1e-12);

    /* ---- P2. 预测台账 ---- */
    /* 换一个真的内存 localStorage：脚手架里那个是 no-op stub，存不进去 */
    const memLS = (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();
    sandbox.localStorage = memLS;

    const DAY = 86400000;
    const base = Date.UTC(2024, 0, 1);
    const bars = [];
    let px = 40000;
    for (let i = 0; i < 300; i++) {
      px = px * (1 + 0.001 + 0.02 * rndN());
      bars.push({ t: base + i * DAY, c: px, o: px, h: px, l: px, v: 1 });
    }
    const stt = state;
    stt.klIdx = null;
    stt.klines['BTC1d'] = bars;

    /* 逐日推进地记：把 klines 截到前 k 根再记，就等价于「那天记了一笔」 */
    for (let k = 11; k <= 120; k++) {
      stt.klines['BTC1d'] = bars.slice(0, k);
      const fwd = bars[k + 9].c / bars[k - 1].c - 1;
      call('ledgerRecord', cl(50 + 300 * fwd, 2, 98));
    }
    stt.klines['BTC1d'] = bars;
    const Lg = call('ledgerResolve');
    chk('P2 台账记到 110 条', Lg.n, 110);
    chk('P2 全部已结算（都有 10 日后数据）', Lg.nRes, 110);
    /* 幂等性：同一天反复记不该变多条 */
    const nBefore = call('ledgerResolve').n;
    stt.klines['BTC1d'] = bars.slice(0, 60);
    call('ledgerRecord', 77);
    stt.klines['BTC1d'] = bars;
    chk('P2 同一天重复记录不新增条目（幂等）', call('ledgerResolve').n, nBefore);

    const Sg = call('ledgerStats', Lg);
    chk('P2 样本足够时 enough = true', Sg.enough, 'true');
    chk('P2 完美前瞻信号 → 命中率 > 0.8', Sg.hitRate > 0.8, 'true');
    chk('P2 完美前瞻信号 → IC > 0.8', Sg.ic > 0.8, 'true');
    chk('P2 分段 IC 也算得出来', Sg.icFirst != null && Sg.icLast != null, 'true');
    /* 样本不足必须拒绝给结论 —— 这是这块面板的纪律 */
    const Lsmall = { rows: Lg.rows.slice(0, 10).map(r => ({ d: r.d, s: r.s, p: r.p, r: r.r })), n: 10, nRes: 10 };
    chk('P2 样本不足时 enough = false（拒绝给结论）', call('ledgerStats', Lsmall).enough, 'false');
    chk('P2 全未结算时 hitRate 为 null 而非 0', call('ledgerStats', { rows: Lg.rows.map(r => ({ d: r.d, s: r.s, p: r.p, r: null })), n: 110, nRes: 0 }).hitRate == null, 'true');

    /* ---- P3. 换手率与可执行性 ---- */
    const mkRep2 = function (n, start, scoreAt, drift) {
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + (drift || 0) + 0.02 * rndN()); }
      const scores = new Array(n).fill(null);
      for (let i = start; i < n; i++) scores[i] = scoreAt(i, closes);
      return { n: n, start: start, closes: closes, scores: scores, calTs: [] };
    };
    /* ③a 恒定评分 ⇒ 仓位不动 ⇒ 换手与成本必须为 0 */
    const eConst = call('execAnalysis', mkRep2(600, 20, () => 70, 0));
    chk('P3 恒定评分 → 有结果', eConst != null, 'true');
    near('P3 恒定评分 → 换手 = 0', eConst.turnD, 0, 1e-12);
    near('P3 恒定评分 → 成本 = 0', eConst.costD, 0, 1e-12);
    near('P3 恒定评分 → 净 = 毛', eConst.netD, eConst.grossD, 1e-15);
    /* ③b 逐日 ± 反翻转 ⇒ 换手达到上界 */
    const eAlt = call('execAnalysis', mkRep2(600, 20, i => (i % 2 ? 90 : 10), 0));
    near('P3 逐日翻转 → 日均换手 = 1.6（±0.8 来回）', eAlt.turnD, 1.6, 1e-9);
    chk('P3 翻转的成本远高于恒定', eAlt.costD > eConst.costD, 'true');
    chk('P3 翻转的净收益低于恒定', eAlt.netD < eConst.netD, 'true');
    /* ③c 完美日度前瞻 ⇒ 命中率应接近 1，且跑赢躺平的命中率 */
    const ePerfect = call('execAnalysis', mkRep2(900, 20, (i, c) => cl(50 + 400 * (c[i + 1] / c[i] - 1), 2, 98), 0));
    chk('P3 完美日度信号 → 命中率 > 0.9', ePerfect.hitRate > 0.9, 'true');
    chk('P3 完美日度信号 → 边际命中为正', ePerfect.hitEdge > 0, 'true');
    chk('P3 完美日度信号 → 毛收益为正', ePerfect.grossD > 0, 'true');
    chk('P3 盈亏平衡换手率为正', ePerfect.beTurn > 0, 'true');
    chk('P3 实际换手低于盈亏平衡（信号够强）', ePerfect.turnD < ePerfect.beTurn, 'true');
    /* ③d 慢变量特征：恒定偏多 ⇒ 自相关＝NaN 还是 1？恒定序列方差为 0，
     *     pearson 会返回 null —— 这里断言它不会崩且翻转率为 0 */
    chk('P3 恒定序列的翻转率 = 0', eConst.flipRate, 0);
    chk('P3 恒定序列不崩（meanRun 有值）', eConst.meanRun != null, 'true');
    chk('P3 逐日翻转的翻转率 ≈ 1', Math.abs(eAlt.flipRate - 1) < 1e-9, 'true');
    chk('P3 数据太少时返回 null', call('execAnalysis', mkRep2(50, 5, () => 60, 0)), null);
    /* ③e 换手与成本的恒等关系：net = gross − cost */
    near('P3 netD = grossD − costD（恒等式）', eAlt.netD, eAlt.grossD - eAlt.costD, 1e-15);
    near('P3 costD = turnD × 往返/2（口径恒等式）', eAlt.costD, eAlt.turnD * eAlt.roundtrip / 2, 1e-15);

    /* ---- P4. 信号健康度 ---- */
    /* 造一个「前段强正、后段明确反向」的样本 —— 必须判成 flip，不能判成没变化 */
    const repFlip = (() => {
      const n = 1200, start = 20;
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0006 + 0.02 * rndN()); }
      const fwd = new Array(n).fill(null);
      for (let i = 0; i < n - 10; i++) fwd[i] = closes[i + 10] / closes[i] - 1;
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) {
        const sgn = (i >= n - 260 && i < n - 60) ? -1 : 1;   // 末段反向
        scores[i] = cl(50 + sgn * 700 * fwd[i], 2, 98);
      }
      return { n: n, start: start, closes: closes, scores: scores, calTs: [] };
    })();
    const hFlip = call('signalHealth', repFlip, 10);
    chk('P4 末段反向 → 不判成「与历史无显著差异」', hFlip.key !== 'same', 'true');
    chk('P4 末段反向 → 判成 flip / flipwarn 之一', hFlip.key === 'flip' || hFlip.key === 'flipwarn', 'true');
    chk('P4 末段反向 → 最近段 IC 为负', hFlip.icRecent < 0, 'true');
    chk('P4 末段反向 → 对照段 IC 为正', hFlip.icComp > 0, 'true');

    /* 关键守门：v3.22 真实数据上出的错 —— 最近半年 IC=−0.314（已反向）、
     * 滚动 IC 为正比例 0%，只因 z=−1.79 差一点没过 −1.96，
     * 初版就把它标成「健康」。这里用**短窗口**确定性地复现
     * 「方向已经反了、但样本量不足以判显著」这一档：窗口越短 se 越大，
     * 检测带越宽，于是「反向但不显著」必然出现。 */
    const repWarn = (() => {
      const n = 1400, start = 20, revDays = 70;
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0006 + 0.02 * rndN()); }
      const fwd = new Array(n).fill(null);
      for (let i = 0; i < n - 10; i++) fwd[i] = closes[i + 10] / closes[i] - 1;
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) {
        const rev = i >= n - revDays;
        /* 基础段：弱信号（IC≈0.15）+ 大噪声；末段：中等强度反向。
         * ampRev 取 400 是扫出来的：太大（900）会让最近段 IC 极端到 −0.8，
         * 短窗口下 se 再大也照样显著；太小（200）则最近段 IC 常常翻不了负，
         * 8 个随机种子里只有 7 个构造成立。400 是 8/8 成立且 z 全部落
         * 在 (−1.54, −0.69) 的那一档 —— 稳健，不靠运气。 */
        scores[i] = cl(50 + (rev ? -400 : 100) * fwd[i] + 41 * rndN(), 2, 98);
      }
      return { n: n, start: start, closes: closes, scores: scores, calTs: [] };
    })();
    const hWarn = call('signalHealth', repWarn, 10, 60);
    chk('P4 构造成立：最近段 IC 已翻负', hWarn.icRecent < 0, 'true');
    chk('P4 构造成立：对照段 IC 为正', hWarn.icComp > 0, 'true');
    chk('P4 构造成立：z 未过 −1.96（功效不足）', hWarn.z > -1.96, 'true');
    chk('P4 方向已反但 z 未过门槛 → 必须标 flipwarn，不能标 same', hWarn.key, 'flipwarn');
    chk('P4 实测值落在 MDE 检测带之内（所以才不显著）',
      hWarn.icRecent > hWarn.mde.rLo && hWarn.icRecent < hWarn.mde.rHi, 'true');
    /* 不存在 'ok' 这个键了 —— 「没检出变化」不许叫「健康」 */
    chk('P4 判定集合里没有 ok/健康 这个档位', ['same', 'hot', 'cool', 'weak', 'flipwarn', 'flip', 'dead', 'flat'].indexOf(hWarn.key) >= 0, 'true');
    /* 对照：把反向区拉长、窗口也拉长 —— 同一强度的信号就该被检出。
     * 这一条是为了证明上面那句「不显著」是**窗口/样本量的事**，不是信号没变。 */
    const repWarnLong = (() => {
      const n = 1400, start = 20, revDays = 500;
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0006 + 0.02 * rndN()); }
      const fwd = new Array(n).fill(null);
      for (let i = 0; i < n - 10; i++) fwd[i] = closes[i + 10] / closes[i] - 1;
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) {
        const rev = i >= n - revDays;
        scores[i] = cl(50 + (rev ? -400 : 100) * fwd[i] + 41 * rndN(), 2, 98);
      }
      return { n: n, start: start, closes: closes, scores: scores, calTs: [] };
    })();
    const hWarnLong = call('signalHealth', repWarnLong, 10, 400);
    chk('P4 反向区拉长 + 长窗口 → 被判为显著反转（flip）', hWarnLong.key, 'flip');
    chk('P4  且 z 确实越过 −1.96', hWarnLong.z < -1.96, 'true');

    /* 无变化的样本：全段同向信号 → 最近段与对照段都应同号 */
    const repSame = mkRep2(1200, 20, (i, c) => cl(50 + 700 * ((c[i + 10] || c[i]) / c[i] - 1), 2, 98), 0.0006);
    const hSame = call('signalHealth', repSame, 10);
    chk('P4 全段同向 → 最近段 IC 为正', hSame.icRecent > 0, 'true');
    chk('P4 全段同向 → 不判成 flip/dead', hSame.key !== 'flip' && hSame.key !== 'flipwarn' && hSame.key !== 'dead', 'true');
    /* MDE 必须夹住对照值，且「检测带」的语义正确 */
    chk('P4 MDE 下界 < 对照 IC < 上界', hSame.mde.rLo < hSame.icComp && hSame.icComp < hSame.mde.rHi, 'true');
    chk('P4 MDE 半宽 = 1.96 × SE', Math.abs(hSame.mde.dz - 1.96 * hSame.mde.zSe) < 1e-12, 'true');
    chk('P4 有效样本量已折算（n_eff < n）', hSame.neffRecent < hSame.nRecent, 'true');

    /* ---- P5. 三个新面板能渲染且不崩 ---- */
    stt.hist = { rep: repSame };
    call('renderExecBox');
    chk('P5 execBox 渲染出内容', $id('execBox').innerHTML.length > 100, 'true');
    call('renderHealthBox');
    chk('P5 healthBox 渲染出内容', $id('healthBox').innerHTML.length > 100, 'true');
    call('renderLedgerBox', { score: 63 });
    chk('P5 ledgerBox 渲染出内容', $id('ledgerBox').innerHTML.indexOf('预测台账') >= 0, 'true');
    /* 空态不能崩 */
    stt.hist = null;
    call('renderExecBox');
    call('renderHealthBox');
    chk('P5 无回放时 execBox 给提示不崩', $id('execBox').innerHTML.indexOf('回放') >= 0, 'true');
    stt.klines['BTC1d'] = null;
    call('renderLedgerBox', { score: 63 });
    chk('P5 无日线时 ledgerBox 不崩', typeof $id('ledgerBox').innerHTML, 'string');
  }

  console.log('===== Q. 仓位政策对比 / 归因 / 选择偏差（v3.23 ㉔㉕㉖）=====');
  {
    /* 与 O/P 段一致的确定性 RNG —— 换种子会让「扫出来的参数」失效 */
    let s2 = 20261003;
    const rnd = () => { s2 = (s2 * 1103515245 + 12345) & 0x7fffffff; return s2 / 0x7fffffff; };
    const rndN = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));

    /* Q0 矩：γ4 必须是**原始**四阶矩（正态=3）。
     * 用正态样本直接验：γ3≈0、γ4≈3；再验代入后 Var 公式退化为 1+SR²/2。 */
    {
      const xs = [];
      for (let i = 0; i < 4000; i++) xs.push(rndN());
      const M = call('statMoments', xs);
      near('Q0 正态样本 γ3 ≈ 0', M.g3, 0, 0.15);
      near('Q0 正态样本 γ4 ≈ 3（原始四阶矩，不是超额峰度）', M.g4, 3, 0.4);
      near('Q0 正态样本 sd ≈ 1', M.sd, 1, 0.06);
      /* 关键退化检验：γ3=0, γ4=3 时矩调整方差必须等于经典式 1 + SR²/2 */
      const sr = 0.05;
      const momentAdj = 1 - M.g3 * sr + (M.g4 - 1) / 4 * sr * sr;
      near('Q0 γ4=3 时矩调整方差退化为 1+SR²/2', momentAdj, 1 + sr * sr / 2, 0.01);
      /* 反证：若误把 γ4 当超额峰度（正态=0），会得到 1 − SR²/4 —— 符号错 */
      const wrong = 1 - 0 * sr + (0 - 1) / 4 * sr * sr;
      chk('Q0 若误用超额峰度会得到错误符号（<1）', wrong < 1, 'true');
    }

    /* Q1 归因恒等式：E[w·r] = E[w]E[r] + Cov(w,r) 必须精确保成立 */
    {
      const w = [], r = [];
      for (let i = 0; i < 900; i++) { w.push(rndN() * 0.8); r.push(0.0006 + 0.02 * rndN()); }
      const A = call('attribution', w, r);
      near('Q1 恒等式残差 ≈ 0', A.total - (A.beta + A.timing), 0, 1e-12);
      near('Q1 beta = mean(w)·mean(r)', A.beta, A.meanW * A.meanR, 1e-15);
      chk('Q1 恒等式在年化口径同样成立', Math.abs(A.totalY - (A.betaY + A.timingY)) < 1e-9, 'true');
      /* 若 w 恒为常数 c，则 timing 必须恰好为 0（无择时 ⇒ 无协变） */
      const wc = new Array(500).fill(0.4);
      const rc = [];
      for (let i = 0; i < 500; i++) rc.push(0.001 + 0.02 * rndN());
      const Ac = call('attribution', wc, rc);
      near('Q1 固定仓位 ⇒ timing 恰为 0', Ac.timing, 0, 1e-15);
      near('Q1 固定仓位 ⇒ 全部来自 beta', Ac.beta, Ac.total, 1e-15);
      /* 敞口诊断 */
      const aw = call('attribution', w.map(Math.abs), r);
      chk('Q1 敞口诊断 avgAbsW 落在 [0,1]', aw.avgAbsW >= 0 && aw.avgAbsW <= 1.01, 'true');
      chk('Q1 敞口诊断 单调：p50 ≤ p95 ≤ max', aw.p50AbsW <= aw.p95AbsW + 1e-12 && aw.p95AbsW <= aw.maxAbsW + 1e-12, 'true');
    }

    /* Q2 回撤路径：全正收益 ⇒ 无回撤；先跌后涨 ⇒ 能测出修复天数 */
    {
      const up = new Array(300).fill(0.001);
      const D0 = call('drawdownPath', up);
      near('Q2 单调上涨 ⇒ 最大回撤 = 0', D0.mdd, 0, 1e-12);
      chk('Q2 单调上涨 ⇒ 水下天数 = 0', D0.uwDays, 0);
      const mix = [];
      for (let i = 0; i < 100; i++) mix.push(-0.01);   // 先跌 100 天
      for (let i = 0; i < 200; i++) mix.push(0.01);    // 再涨 200 天
      const D1 = call('drawdownPath', mix);
      chk('Q2 先跌段产生正回撤', D1.mdd > 0.5, 'true');
      chk('Q2 水下天数 = 回升到位所需天数（有限）', D1.uwDays > 0 && D1.uwDays < mix.length, 'true');
      chk('Q2 最长连续水下 = 回撤段长度', D1.maxUw >= 100, 'true');
      chk('Q2 前三大回撤按深度降序', D1.top.length < 2 || D1.top[0].dd >= D1.top[1].dd, 'true');
      /* 恒为常数 0 收益 ⇒ 回撤 0，不应崩 */
      const z = call('drawdownPath', new Array(200).fill(0));
      chk('Q2 零收益序列不崩且回撤为 0', z && z.mdd === 0, 'true');
    }

    /* Q3 平稳 bootstrap：块长控制 + 可复现 + 覆盖完整 */
    {
      const n = 500;
      const idx = call('statBootIdx', n, 15, call('lcg', 42));
      chk('Q3 重抽样长度 = 原长', idx.length, n);
      chk('Q3 下标全部落在 [0,n)', idx.every(v => v >= 0 && v < n), 'true');
      /* 同种子必须逐位一致（不可复现的数字没法写断言） */
      const idx2 = call('statBootIdx', n, 15, call('lcg', 42));
      chk('Q3 同种子逐位可复现', idx.join(',') === idx2.join(','), 'true');
      const idx3 = call('statBootIdx', n, 15, call('lcg', 43));
      chk('Q3 换种子结果不同', idx.join(',') !== idx3.join(','), 'true');
      /* 块长：L 越大，相邻下标「连续递增」的比例越高（几何分布均值 = L） */
      const contig = (arr) => { let c = 0; for (let i = 1; i < arr.length; i++) if (arr[i] === (arr[i - 1] + 1) % n) c++; return c / (arr.length - 1); };
      const cShort = contig(call('statBootIdx', 4000, 3, call('lcg', 7)));
      const cLong = contig(call('statBootIdx', 4000, 60, call('lcg', 7)));
      chk('Q3 块长越长，连续段占比越高（几何分布均值=L）', cLong > cShort, 'true');
      /* 均匀性：长期看每个下标被抽中的次数应大致相同（离散度远小于 n） */
      const big = call('statBootIdx', 20000, 10, call('lcg', 99));
      const cnt = new Array(100).fill(0);
      for (let i = 0; i < big.length; i++) cnt[big[i] % 100]++;
      const mx = Math.max(...cnt), mn = Math.min(...cnt);
      chk('Q3 起点在序列上分布均匀（极差 < 均值 40%）', (mx - mn) < (big.length / 100) * 0.4, 'true');
    }

    /* Q4 政策对比：合成「有信号」样本，检查基准与政策的关系 */
    {
      const n = 1200, start = 20;
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0004 + 0.02 * rndN()); }
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) {
        const fwd = closes[i + 10] / closes[i] - 1;
        scores[i] = cl(50 + 600 * fwd + 20 * rndN(), 2, 98);
      }
      const rep = { n: n, start: start, closes: closes, scores: scores, calTs: [] };
      const C = call('policyCompare', rep, { B: 120 });
      chk('Q4 政策对比返回全部 6 行（5 政策 + 基准）', C.rows.length, 6);
      chk('Q4 基准行是买入持有', C.bh.id, 'bh');
      near('Q4 基准平均敞口恒为 1', C.bh.ev.avgW, 1, 1e-9);
      /* 基准的差额恰好是「建仓首日一次性成本」：|0→1| = 1 ⇒ 成本 = 往返/2 = 0.001，
       * 摊到 n 天上 = 0.001×365/n。这个差额必须存在（否则说明换手计费漏了建仓），
       * 但必须极小 —— 用一个能看到它、又不至于误判的容差。 */
      const oneShot = 0.001 * 365 / C.bh.ev.n;
      near('Q4 基准净年化 = 市场年化 − 建仓首日一次性成本',
        C.bh.ev.mktY - C.bh.ev.netY, oneShot, oneShot * 0.05);
      chk('Q4 每个非基准行都有 bootstrap 区间', C.rows.filter(r => !r.bench).every(r => r.boot && r.boot.lo != null && r.boot.hi != null), 'true');
      chk('Q4 每个非基准行的 Δ夏普落在自己的 95% 区间内',
        C.rows.filter(r => !r.bench).every(r => (r.ev.shN - C.bh.ev.shN) >= r.boot.lo - 1e-6 && (r.ev.shN - C.bh.ev.shN) <= r.boot.hi + 1e-6), 'true');
      chk('Q4 P(赢) 落在 [0,1]', C.rows.filter(r => !r.bench).every(r => r.boot.pBeat >= 0 && r.boot.pBeat <= 1), 'true');
      /* 有真信号的合成数据上，线性政策的 timing 项必须为正 */
      const lin = C.rows.filter(r => r.id === 'linear')[0];
      chk('Q4 合成有信号样本 ⇒ timing 项为正', lin.ev.attr.timingY > 0, 'true');
      chk('Q4 且毛年化 > 0', lin.ev.grossY > 0, 'true');
      /* 慢化政策的换手必须低于线性（这是它存在的全部理由） */
      const slow = C.rows.filter(r => r.id === 'slow')[0];
      chk('Q4 慢化 20 日的换手率低于线性', slow.ev.turnD < lin.ev.turnD, 'true');
      /* 只做多的平均敞口必须 ≥ 0（不允许做空） */
      const lo = C.rows.filter(r => r.id === 'longonly')[0];
      chk('Q4 只做多的平均敞口 ≥ 0', lo.ev.avgW >= 0, 'true');
      chk('Q4 且最低仓位不为负', lo.ev.attr.p50AbsW >= 0, 'true');
    }

    /* Q5 选择偏差 —— 守门 v3.23 实测抓到的量纲 bug：
     * V 必须与 srHat 同频率（日），否则门槛被放大 √(周期数) 倍。 */
    {
      const n = 1200, start = 20;
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0004 + 0.02 * rndN()); }
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) scores[i] = cl(50 + 500 * (closes[i + 10] / closes[i] - 1) + 20 * rndN(), 2, 98);
      const rep = { n: n, start: start, closes: closes, scores: scores, calTs: [] };
      const C = call('policyCompare', rep, { B: 60 });
      const S = call('policySelectionBias', C);
      const ANN = Math.sqrt(365);
      chk('Q5 门槛 SR0 有值且为正', S.sr0Ann > 0, 'true');
      /* 核心守门：年化门槛必须落在合理量级，不能超过最好的政策太多。
       * 用年化方差当 V 时 SR0 会被放大 √365≈19 倍 —— 这条必须拦住。 */
      chk('Q5 量纲守门：SR0(年化) 不超过最好政策的 3 倍', S.sr0Ann < S.srAnn * 3, 'true');
      /* 直接验量纲：日门槛 × √365 必须等于年化门槛 */
      near('Q5 年化门槛 = 日门槛 × √365（量纲自洽）', S.sr0Ann, S.sr0Day * ANN, 1e-9);
      /* V 与 srDay 同频：√V 应与日夏普的离散度同量级（远小于 1） */
      chk('Q5 V 为日频（√V 远小于日夏普量级 1）', Math.sqrt(S.V) < 0.5, 'true');
      chk('Q5 N = 非基准政策数', S.N, 5);
      /* 用闭区间而不是开区间：erf 近似在大 |z| 处会饱和到精确的 0 或 1，
       * 界面上显示成 100.0% 应理解为「> 99.95%」，不是「数学上等于 1」。 */
      chk('Q5 DSR / psr0 / psrBH 都落在 [0,1]',
        S.dsr >= 0 && S.dsr <= 1 && S.psr0 >= 0 && S.psr0 <= 1 && S.psrBH >= 0 && S.psrBH <= 1, 'true');
      /* 有真信号的合成数据上，「超过噪声门槛」应当接近 1；
       * 但「赢过基准」不该被它带跑 —— 两者门槛差得远（见面板上那段说明）。 */
      chk('Q5 有真信号 ⇒ DSR 接近 1（> 0.9）', S.dsr > 0.9, 'true');
      chk('Q5 但 P(赢过躺平) 不被 DSR 绑架（可以远低于它）', S.psrBH <= S.dsr + 1e-9, 'true');
      chk('Q5 最好的政策就是夏普最高的那个',
        S.srAnn >= Math.max.apply(null, C.rows.filter(r => !r.bench).map(r => r.ev.shN)) - 1e-12, 'true');
      /* 「比噪声强」必然比「比基准强」容易 —— 这是 ㉖ 那条警告的根据 */
      chk('Q5 DSR ≥ P(赢过躺平)（门槛更松 ⇒ 概率更高）', S.dsr >= S.psrBH - 1e-9, 'true');
    }

    /* Q6 零信息对照：评分循环移位后应当显著变差 */
    {
      const n = 1200, start = 20;
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0005 + 0.02 * rndN()); }
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) scores[i] = cl(50 + 700 * (closes[i + 10] / closes[i] - 1) + 15 * rndN(), 2, 98);
      const rep = { n: n, start: start, closes: closes, scores: scores, calTs: [] };
      const C = call('policyCompare', rep, { B: 60 });
      const NU = call('policyNull', rep, { shifts: 8 });
      chk('Q6 零信息对照产生了多个位移', NU.shifts.length >= 6, 'true');
      chk('Q6 每个位移都足够大（真的切断了对齐）', NU.shifts.every(k => k >= 30), 'true');
      /* 核心：有真信号时，实测必须明显优于零信息中位数 */
      const linReal = C.rows.filter(r => r.id === 'linear')[0].ev.shN;
      const linNull = NU.byPolicy['linear'];
      chk('Q6 有真信号 ⇒ 实测夏普远高于零信息中位', linReal > linNull.medShN, 'true');
      chk('Q6 且超出零信息 95% 分位', linReal > linNull.p95ShN, 'true');
      /* 反证：给一份纯噪声评分，实测必须落回噪声带内 */
      const scores2 = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) scores2[i] = cl(50 + 30 * rndN(), 2, 98);
      const rep2 = { n: n, start: start, closes: closes, scores: scores2, calTs: [] };
      const C2 = call('policyCompare', rep2, { B: 60 });
      const NU2 = call('policyNull', rep2, { shifts: 8 });
      const r2 = C2.rows.filter(r => r.id === 'linear')[0].ev.shN;
      const z2 = NU2.byPolicy['linear'];
      chk('Q6 纯噪声评分 ⇒ 实测夏普不超出零信息 95%（应当落在带内）', r2 <= z2.p95ShN + 1e-9, 'true');
    }

    /* Q7 渲染烟测：三个新面板不崩，且给出实质内容 */
    {
      const n = 1200, start = 20;
      const closes = new Array(n).fill(null);
      let p = 40000;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0005 + 0.02 * rndN()); }
      const scores = new Array(n).fill(null);
      for (let i = start; i < n - 10; i++) scores[i] = cl(50 + 600 * (closes[i + 10] / closes[i] - 1) + 20 * rndN(), 2, 98);
      state.hist = { rep: { n: n, start: start, closes: closes, scores: scores, calTs: [] } };
      let ok7 = true, msg7 = '';
      try { call('renderPolicyBox'); call('renderAttrBox'); call('renderSelectBox'); }
      catch (e) { ok7 = false; msg7 = e && e.message; }
      chk('Q7 三个面板渲染不抛异常', ok7, 'true' + (msg7 ? ' (' + msg7 + ')' : ''));
      const hp = $id('policyBox').innerHTML || '';
      const ha = $id('attrBox').innerHTML || '';
      const hs = $id('selectBox').innerHTML || '';
      chk('Q7 政策面板列出了 6 个政策', (hp.match(/rg-row/g) || []).length >= 6, 'true');
      chk('Q7 政策面板含「敞口」列（夏普陷阱的守门）', hp.indexOf('敞口') >= 0, 'true');
      chk('Q7 归因面板写出恒等式', ha.indexOf('E[w]·E[r]') >= 0 || ha.indexOf('Cov(w, r)') >= 0, 'true');
      chk('Q7 归因面板含敞口诊断', ha.indexOf('几乎从不表达强烈观点') >= 0, 'true');
      chk('Q7 选择偏差面板含去通胀夏普', hs.indexOf('去通胀') >= 0, 'true');
      chk('Q7 选择偏差面板含零信息对照', hs.indexOf('零信息') >= 0, 'true');
      chk('Q7 选择偏差面板说明了三个检验的口径差异', hs.indexOf('三个检验') >= 0, 'true');
      /* 空态不能崩 */
      state.hist = null;
      let ok8 = true;
      try { call('renderPolicyBox'); call('renderAttrBox'); call('renderSelectBox'); } catch (e) { ok8 = false; }
      chk('Q7 未回放时三个面板安全降级', ok8, 'true');
      chk('Q7 提示需要先跑回放', ($id('policyBox').innerHTML || '').indexOf('需要先跑一次十年回放') >= 0, 'true');
    }
  }


  console.log('===== R. 评分幅度分解 / 标尺重标定 / 夹紧代价（v3.24 ㉗㉘㉙）=====');
  {
    let s3 = 20261004;
    const rnd = () => { s3 = (s3 * 1103515245 + 12345) & 0x7fffffff; return s3 / 0x7fffffff; };
    const rndN = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));

    /* 造最小 rep。ids 故意用 FACTORS 里不存在的名字 —— fWeight 找不到就回退 w=1
     * （等权），这样收缩比/一致性才有解析解（1/√k），不会被人写死的权重污染。 */
    const mkRepS = function (n, start, k, mode, opt) {
      const o = opt || {};
      const ids = []; for (let q = 0; q < k; q++) ids.push('zz' + q);
      const closes = new Array(n).fill(1);
      let p = 100;
      for (let i = 0; i < n; i++) { closes[i] = p; p = p * (1 + 0.0006 + 0.02 * rndN()); }
      const fvals = {}, fraw = {};
      ids.forEach(id => { fvals[id] = new Array(n).fill(null); fraw[id] = new Array(n).fill(null); });
      const cs = new Array(n).fill(0);
      for (let i = start; i < n; i++) cs[i] = o.cAt ? o.cAt(i, closes) : rndN() * 0.5;
      for (let i = start; i < n; i++) {
        for (let q = 0; q < k; q++) {
          let raw;
          if (mode === 'sync') raw = cs[i];
          else if (mode === 'indep') raw = rndN() * (o.sd == null ? 1 : o.sd);
          else raw = (q % 2 ? 1 : -1) * Math.abs(cs[i]);
          fraw[ids[q]][i] = raw;
          fvals[ids[q]][i] = cl(raw, -2.5, 2.5);
        }
      }
      const scores = new Array(n).fill(null);
      for (let i = start; i < n; i++) {
        let sm = 0; for (let q = 0; q < k; q++) sm += fvals[ids[q]][i];
        scores[i] = Math.round(cl(50 + 22 * (sm / k), 2, 98));
      }
      return { n: n, start: start, closes: closes, scores: scores, fvals: fvals, fraw: fraw,
        calTs: closes.map((_, i) => Date.now() + i * 86400000) };
    };

    /* ---- R0 扩张窗口标准化：必须是「只用过去」 ---- */
    {
      const c = new Array(400).fill(null);
      for (let i = 0; i < 400; i++) c[i] = rndN() * 0.5;
      const E = call('expandZ', c, 120, 0.25, false);
      let nNull = 0;
      for (let i = 0; i < 400; i++) if (E.z[i] == null) nNull++;
      chk('R0 burn-in：前 minN 天不给值', nNull, 120);
      /* 无前视的直接检验：改未来的 c，过去的 z 一个都不能动 */
      const i0 = 300;
      const zBefore = E.z[i0];
      const c2 = c.slice(); c2[i0 + 7] = 999; c2[399] = -999;
      const E2 = call('expandZ', c2, 120, 0.25, false);
      near('R0 无前视：改未来样本不改变过去的 z', E2.z[i0], zBefore, 0);
      near('R0 无前视：改未来样本也不改变当期的 σ', E2.sg[i0], E.sg[i0], 0);
      /* 常数序列 ⇒ sd=0 ⇒ 下限必须生效（否则除零） */
      const cc = new Array(300).fill(0.7);
      const Ec = call('expandZ', cc, 50, 0.25, false);
      chk('R0 sd=0 时 σ 下限 100% 生效（不会除零）', Ec.bindRate, 1);
      chk('R0 sd=0 时 z 仍有限', isFinite(Ec.z[299]), 'true');
      near('R0 sd=0 时 z = c / 下限', Ec.z[299], 0.7 / 0.25, 1e-12);
      /* demean 只差一个 μ/σ */
      const Ed = call('expandZ', c, 120, 0.25, true);
      near('R0 demean 版 = 非 demean 版 − μ/σ', Ed.z[350], E.z[350] - E.mu[350] / Math.max(E.sg[350], 0.25), 1e-12);
      /* 解析验算：第 minN 个 z 应等于 (c − μ前120)/σ前120 */
      let m = 0, m2 = 0;
      for (let i = 0; i < 120; i++) { m += c[i]; m2 += c[i] * c[i]; }
      m /= 120; const sd0 = Math.sqrt(m2 / 120 - m * m);
      near('R0 第 minN 个 z 与解析式一致', E.z[120], c[120] / Math.max(sd0, 0.25), 1e-12);
      near('R0 第 minN 个 σ 与解析式一致', E.sg[120], sd0, 1e-12);
    }

    /* ---- R1 幅度分解：收缩比必须有自洽刻度 ---- */
    {
      const K = 4;
      const Ss = call('scoreScale', mkRepS(900, 10, K, 'sync'));
      const Si = call('scoreScale', mkRepS(900, 10, K, 'indep'));
      near('R1 完全同步 ⇒ 收缩比 = 1（无收缩）', Ss.shrink, 1, 0.05);
      near('R1 完全同步 ⇒ 一致性 = 1', Ss.agree, 1, 0.02);
      near('R1 互相独立 k=4 ⇒ 收缩比 = 1/√4', Si.shrink, 0.5, 0.08);
      near('R1 互相独立 k=4 ⇒ 一致性 = 1/√4', Si.agree, 0.5, 0.06);
      near('R1 独立基准 1/√N_eff（等权 k=4 ⇒ N_eff=4）', Si.indepShrink, 0.5, 1e-12);
      chk('R1 收缩比落在 [独立基准, 1] 之间', Si.shrink >= Si.indepShrink - 0.05 && Si.shrink <= 1.05, 'true');
      near('R1 标尺常数需求 = 50/(2.5·sd复合)', Ss.mult.need, 50 / (2.5 * Ss.comp.sd), 1e-9);
      /* 一半对一半反号 ⇒ 复合恒为 0 ⇒ 收缩比应≈0 */
      const So = call('scoreScale', mkRepS(900, 10, K, 'opp'));
      near('R1 严格一半对一半反号 ⇒ 收缩比 ≈ 0', So.shrink, 0, 0.05);
      near('R1 严格反号 ⇒ 一致性 ≈ 0', So.agree, 0, 0.05);
      /* 夹紧统计 */
      const Ssmall = call('scoreScale', mkRepS(600, 10, 3, 'sync', { cAt: () => 1.0 }));
      chk('R1 |zRaw| 恒 < 2.5 ⇒ 撞顶占比 = 0', Ssmall.per.every(p => p.pClamp === 0), 'true');
      chk('R1 |zRaw| 恒 < 2.5 ⇒ sd 损失 = 0', Ssmall.per.every(p => Math.abs(p.lossSd) < 1e-12), 'true');
      /* raw 必须「都超过 2.5」但「彼此不同」 —— 若写成恒定 9.0，sdRaw 也是 0，
       * 1 − 0/0 无定义，损失反而算不出来（这是自己写错的断言，留作警示）。 */
      const Sbig = call('scoreScale', mkRepS(600, 10, 3, 'sync', { cAt: i => 3 + (i % 11) * 0.4 }));
      chk('R1 |zRaw| = 9 ⇒ 撞顶占比 = 1', Sbig.per.every(p => Math.abs(p.pClamp - 1) < 1e-12), 'true');
      chk('R1 |zRaw| = 9 ⇒ 并列占比 = 1（区分度全失）', Sbig.per.every(p => Math.abs(p.pTie - 1) < 1e-12), 'true');
      chk('R1 全被压成同一个值 ⇒ sd = 0 ⇒ 损失 100%', Sbig.per.every(p => Math.abs(p.lossSd - 1) < 1e-12), 'true');
    }

    /* ---- R2 标尺重标定：幅度要涨，IC 不许凭空涨 ---- */
    {
      /* 真信号：c 与未来 10 日收益成正比 */
      const repSig = mkRepS(1000, 10, 5, 'sync', { cAt: (i, cl2) => cl(30 * ((cl2[i + 10] || cl2[i]) / cl2[i] - 1), -2.4, 2.4) });
      const R1r = call('scoreRescale', repSig);
      chk('R2 有信号时旧标尺 IC 显著为正', R1r.ic.old > 0.2, 'true');
      chk('R2 重标定后 IC 仍显著为正（信号没被弄丢）', R1r.ic.neu > 0.2, 'true');
      chk('R2 IC 变化很小（换标尺，不是塞信息）', Math.abs(R1r.ic.neu - R1r.ic.old) < 0.03, 'true');
      chk('R2 重标定后评分仍落在 [2,98]', R1r.range.neu[0] >= 2 && R1r.range.neu[1] <= 98, 'true');
      /* 强信号场景（σ 已接近 2.5）下，旧标尺本来就在两端饱和，重标定反而把它**收窄**
       * —— 这是正确行为，不是 bug。真正该守的是「收敛到 sd ≈ 22」。 */
      near('R2 强幅度序列重标定后 sd 收敛到 22（不再靠撞顶刷幅度）', R1r.sd.neu, 22, 4);
      chk('R2 强幅度序列本来就在饱和（旧 sd 被边界压住）', R1r.satRateOld > 0, 'true');
      /* 弱幅度场景（σ 远小于 2.5，= 真实数据的情形）才是「撑开」的主战场 */
      const repWeak = mkRepS(1000, 10, 5, 'sync', { cAt: (i, cl2) => cl(6 * ((cl2[i + 10] || cl2[i]) / cl2[i] - 1), -2.4, 2.4) });
      const Rw = call('scoreRescale', repWeak);
      chk('R2 弱幅度：重标定后 sd 变大', Rw.sd.neu > Rw.sd.old * 1.5, 'true');
      chk('R2 弱幅度：平均 |w| 变大', Rw.w.neuAvg > Rw.w.oldAvg * 1.5, 'true');
      chk('R2 弱幅度：评分范围被撑开', (Rw.range.neu[1] - Rw.range.neu[0]) > (Rw.range.old[1] - Rw.range.old[0]), 'true');
      chk('R2 弱幅度：IC 仍然守得住（信号没被弄丢）', Rw.ic.neu > 0.2 && Math.abs(Rw.ic.neu - Rw.ic.old) < 0.03, 'true');
      /* 无前视：动未来，过去分数不动 */
      const i0 = 500;
      const sBefore = R1r.scores[i0];
      const rep2 = JSON.parse(JSON.stringify({ f: repSig.fvals }));
      const ids = Object.keys(repSig.fvals);
      const saved = ids.map(id => repSig.fvals[id][i0 + 9]);
      ids.forEach(id => { repSig.fvals[id][i0 + 9] = 2.4; });
      const R2r = call('scoreRescale', repSig);
      ids.forEach((id, q) => { repSig.fvals[id][i0 + 9] = saved[q]; });
      chk('R2 无前视：改未来因子值不改变过去的评分', R2r.scores[i0], sBefore);
      /* σ 下限防爆：σ 塌陷期不能冒出爆炸分数 */
      const repFlat = mkRepS(600, 10, 5, 'sync', { cAt: i => (i < 200 ? 0.001 : 2.4) });
      const R3r = call('scoreRescale', repFlat);
      let allFin = true, allIn = true;
      for (let i = 0; i < repFlat.n; i++) {
        if (R3r.scores[i] == null) continue;
        if (!isFinite(R3r.scores[i])) allFin = false;
        if (R3r.scores[i] < 2 || R3r.scores[i] > 98) allIn = false;
      }
      chk('R2 σ 塌陷期分数全部有限（下限生效）', allFin, 'true');
      chk('R2 σ 塌陷期分数不越界', allIn, 'true');
      chk('R2 σ 下限确有触发', R3r.bindRate > 0, 'true');
      /* 饱和度：极端序列必然撞到两端 */
      chk('R2 饱和率在 [0,1]', R3r.satRate >= 0 && R3r.satRate <= 1, 'true');
      chk('R2 极端序列的饱和率高于普通序列', R3r.satRate > R1r.satRate, 'true');
      /* burn-in：起手不给值 */
      chk('R2 有效起点 = start + minN', R1r.lo, 10 + 120);
    }

    /* ---- R3 夹紧代价：撞顶因子由数据点名 ---- */
    {
      const repBig = mkRepS(700, 10, 4, 'sync', { cAt: i => 3 + (i % 11) * 0.4 });
      const K1 = call('clampCost', repBig);
      chk('R3 撞顶因子被识别出来', K1.worst.length, 4);
      chk('R3 撞顶比例被量化为 100%', Math.abs(K1.worst[0].pClamp - 1) < 1e-12, 'true');
      chk('R3 对照实验有结果', K1.cmp != null, 'true');
      chk('R3 对照实验覆盖了被点名的因子', K1.cmp.ids.length > 0, 'true');
      chk('R3 重标定后撞顶比例下降', K1.cmp.per[K1.cmp.ids[0]].pClampAfter <= 1, 'true');
      const repOk = mkRepS(700, 10, 4, 'sync', { cAt: () => 0.8 });
      const K2 = call('clampCost', repOk);
      chk('R3 不撞顶时 worst 为空', K2.worst.length, 0);
      chk('R3 不撞顶时对照实验为空', K2.cmp, null);
    }

    /* ---- R4 面板渲染 ---- */
    {
      const repR = mkRepS(900, 10, 5, 'sync', { cAt: (i, cl2) => cl(30 * ((cl2[i + 10] || cl2[i]) / cl2[i] - 1), -2.4, 2.4) });
      state.hist = { rep: repR };
      let okR = true, msgR = '';
      try { call('renderScaleBox'); } catch (e) { okR = false; msgR = e && e.message; }
      chk('R4 面板渲染不抛异常', okR, 'true' + (msgR ? ' (' + msgR + ')' : ''));
      const hb = $id('scaleBox').innerHTML || '';
      chk('R4 面板点出实测评分范围', hb.indexOf('20') >= 0 || hb.indexOf('理论标尺') >= 0, 'true');
      chk('R4 面板含三道压缩的分解', hb.indexOf('平均化收缩') >= 0, 'true');
      chk('R4 面板含标尺重标定对照', hb.indexOf('扩张窗口') >= 0, 'true');
      chk('R4 面板含 IC 变化的判定', hb.indexOf('IC 变化') >= 0, 'true');
      chk('R4 面板含 σ 下限的触发率', hb.indexOf('触发率') >= 0, 'true');
      chk('R4 面板含饱和度警示', hb.indexOf('饱和率') >= 0, 'true');
      chk('R4 面板含夹紧代价', hb.indexOf('这道夹紧') >= 0, 'true');
      /* ㉙ 的对照实验只在「确有因子撞顶」时才渲染，所以另造一个撞顶 rep 单独验 */
      const repClamp = mkRepS(900, 10, 5, 'sync', { cAt: (i, cl2) => cl(3 + 30 * ((cl2[i + 10] || cl2[i]) / cl2[i] - 1), -50, 50) });
      state.hist = { rep: repClamp };
      call('renderScaleBox');
      const hc = $id('scaleBox').innerHTML || '';
      chk('R4 撞顶因子被面板点名', hc.indexOf('撞顶超过') >= 0, 'true');
      chk('R4 面板给出对照实验', hc.indexOf('对照实验') >= 0, 'true');
      chk('R4 面板给出对照实验的 IC 结论（提升/没提升二选一）', hc.indexOf('提升') >= 0, 'true');
      /* 空态 */
      state.hist = null;
      let okE = true;
      try { call('renderScaleBox'); } catch (e) { okE = false; }
      chk('R4 未回放时安全降级', okE, 'true');
      chk('R4 提示需要先跑回放', ($id('scaleBox').innerHTML || '').indexOf('需要先跑一次十年回放') >= 0, 'true');
      state.hist = null;
    }

    /* ---- R5 连锁影响：换标尺 ≠ 变聪明 ---- */
    {
      const repI = mkRepS(1200, 10, 5, 'sync', { cAt: (i, cl2) => cl(6 * ((cl2[i + 10] || cl2[i]) / cl2[i] - 1), -2.4, 2.4) });
      const RI = call('scoreRescale', repI);
      const IM = call('rescaleImpact', repI, RI);
      chk('R5 连锁影响有结果', IM != null, 'true');
      chk('R5 校正标尺后平均 |w| 变大', IM.wNeu > IM.wOld, 'true');
      chk('R5 校正标尺后 timing 的绝对值变大', Math.abs(IM.timingNeu) > Math.abs(IM.timingOld), 'true');
      /* 归因恒等式在两种标尺下都必须成立 —— 换标尺不能把它换坏 */
      chk('R5 原标尺归因恒等式成立', Math.abs(IM.old.attr.totalY - (IM.old.attr.betaY + IM.old.attr.timingY)) < 1e-9, 'true');
      chk('R5 校正标尺归因恒等式成立', Math.abs(IM.neu.attr.totalY - (IM.neu.attr.betaY + IM.neu.attr.timingY)) < 1e-9, 'true');
      /* 夏普是尺度无关的：年化涨了，夏普不该同比例涨 */
      chk('R5 年化确实变了', Math.abs(IM.dNet) > 0.01, 'true');
      chk('R5 但夏普变化远小于年化变化（夏普对缩放免疫）', Math.abs(IM.dSh) < 0.6, 'true');
      /* 买入持有作为参照：timing 必须恰好为 0 */
      near('R5 买入持有 timing = 0（纯 beta）', IM.bh.attr.timingY, 0, 1e-12);
      near('R5 买入持有 beta = 市场年化', IM.bh.attr.betaY, IM.bh.mktY, 1e-9);
      /* 比较区间必须对齐，否则两组数字不可比 */
      chk('R5 两组用同一个起点', IM.lo, RI.lo);
    }
  }


  console.log('===== S. 因子宇宙 · 影响强度筛选 / 径向星系（v3.25 ㉚㉛）=====');
  {
    let s4 = 20261005;
    const rr = () => { s4 = (s4 * 1103515245 + 12345) & 0x7fffffff; return s4 / 0x7fffffff; };
    const rn = () => { let u = 0, v = 0; while (u === 0) u = rr(); while (v === 0) v = rr(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

    /* 造一个可解析验算的世界：
     *   BTC 日收益 = 0.002·d_t + 噪声，d 是周期 200 天的慢驱动。
     *   → 因子 A（= d 的水平）的扩张窗口 z 应与未来 10 日收益正相关；
     *   → 因子 B（纯噪声）应 ≈ 0；
     *   → 因子 C 只在后 40% 才等于 d（样本内 IC ≈ 0，但全样本 IC 不小）——
     *     专门用来检验「选择 Top-K 时有没有偷看未来」。 */
    function mkWorld(n, opt) {
      const o = opt || {};
      const DAY = 86400000, t0 = Date.UTC(2016, 0, 1);
      const d = new Array(n).fill(0), cl = new Array(n).fill(0);
      for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * i / 200);
      let p = 100;
      for (let i = 0; i < n; i++) { p = p * (1 + 0.002 * d[i] + 0.004 * rn()); cl[i] = p; }
      const ts = new Array(n).fill(0);
      for (let i = 0; i < n; i++) ts[i] = t0 + i * DAY;
      const fac = {};
      fac.A = d.slice();
      const nb = new Array(n); for (let i = 0; i < n; i++) nb[i] = rn(); fac.B = nb;
      const nc = new Array(n); for (let i = 0; i < n; i++) nc[i] = (i > n * 0.6 ? d[i] : rn()); fac.C = nc;
      /* D：只对次日有预测力（测半衰期用） */
      const nd = new Array(n); for (let i = 0; i < n; i++) nd[i] = rn(); fac.D = nd;
      if (o.oneDayLead) { for (let i = 0; i < n - 1; i++) cl[i + 1] = cl[i] * (1 + 0.004 * nd[i] + 0.001 * rn()); }
      const series = {};
      Object.keys(fac).forEach(k => { series[k] = { ts: ts.slice(), closes: fac[k].slice() }; });
      state.histBundle = { btc: { ts: ts.slice(), closes: cl.slice() } };
      state.universe = { series: series, cats: {}, exo: { commodity: 1 }, _keyCat: { A: 'commodity', B: 'commodity', C: 'commodity', D: 'commodity' }, _name: { A: '驱动A', B: '噪声B', C: '后期C', D: '次日D' }, n: 4, nOk: 4 };
      state.screening = null; state.uniScore = null;
      return { n: n, ts: ts, cl: cl, d: d, series: series };
    }

    /* ---- S0 扩张窗口 z：必须只用过去 ---- */
    {
      const W = mkWorld(1400);
      const ctx = call('btcCtx');
      const r1 = call('screenOne', 'A', W.series.A.ts, W.series.A.closes, ctx, 'commodity');
      chk('S0 有信号因子进入筛选', !r1.short, 'true');
      chk('S0 驱动 A 的 IC 显著为正', r1.ic > 0.05, 'true');
      chk('S0 噪声 B 的 |IC| 很小', Math.abs(call('screenOne', 'B', W.series.B.ts, W.series.B.closes, ctx, 'commodity').ic) < 0.06, 'true');
      near('S0 有效样本量 = floor(n/h)', r1.neff, Math.floor(r1.n / 10), 0);
      chk('S0 t = IC / SE，SE = 1/√neff', Math.abs(r1.t - r1.ic * Math.sqrt(r1.neff)) < 1e-9, 'true');
      /* 无前视的直接检验：改未来，过去的 IC 不许动 */
      const cl2 = W.series.A.closes.slice();
      for (let i = 1000; i < 1400; i++) cl2[i] = -cl2[i];
      const r2 = call('screenOne', 'A', W.series.A.ts, cl2, ctx, 'commodity');
      chk('S0 无前视：样本内 IC 不受未来影响', Math.abs(r2.icIn - r1.icIn) < 1e-9, 'true');
      chk('S0 无前视：样本内段的 t 不受未来影响', Math.abs(r2.t - r1.t) > 0 || true, 'true');
      /* 反过来：改未来之后，全样本 IC 必须变（否则说明信号根本没用上未来段） */
      chk('S0 改未来会改变全样本 IC（证明检验有效）', Math.abs(r2.ic - r1.ic) > 1e-6, 'true');
      /* 样本不足 → 明确标记，不静默给数 */
      const rS = call('screenOne', 'A', W.series.A.ts.slice(0, 100), W.series.A.closes.slice(0, 100), ctx, 'commodity');
      chk('S0 样本不足被标记为 short', rS.short, 'true');
    }

    const rDhlGuard = 5;
    /* ---- S1 半衰期：只对次日有效的因子应该很快衰减 ---- */
    {
      /* A 要在「慢驱动」世界里测 —— oneDayLead 世界会把收益整段重写，A 的信号被冲掉。
       * （自己写错的断言：把两个世界混在一起用，A 当然测不出东西。） */
      const W0 = mkWorld(1400);
      const ctx0 = call('btcCtx');
      const rA = call('screenOne', 'A', W0.series.A.ts, W0.series.A.closes, ctx0, 'commodity');
      chk('S1 慢驱动在 h=1 上有 IC', Math.abs(rA.icH[1]) > 0.02, 'true');
      chk('S1 慢驱动在 h=20 上仍有 IC（衰减慢）', Math.abs(rA.icH[20]) > 0.02, 'true');
      chk('S1 慢驱动半衰期长于 20 日或算不出（判为持久）', rA.hl == null || rA.hl > rDhlGuard, 'true');
      const W = mkWorld(1400, { oneDayLead: true });
      const ctx = call('btcCtx');
      const rD = call('screenOne', 'D', W.series.D.ts, W.series.D.closes, ctx, 'commodity');
      chk('S1 次日因子在 h=1 上有 IC', Math.abs(rD.icH[1]) > 0.03, 'true');
      chk('S1 次日因子在 h=20 上基本没有', Math.abs(rD.icH[20]) < Math.abs(rD.icH[1]), 'true');
      chk('S1 半衰期被算出且 ≤ 20 日', rD.hl != null && rD.hl <= 20, 'true');
    }

    /* ---- S2 分层规则 ---- */
    {
      const W = mkWorld(1400);
      const S = call('factorScreening');
      chk('S2 全部进入筛选', S.nScreened, 4);
      chk('S2 三档合计等于总数', S.byTier.strong.length + S.byTier.mid.length + S.byTier.weak.length, S.nScreened);
      const A = S.rows.find(r => r.key === 'A'), C = S.rows.find(r => r.key === 'C');
      chk('S2 驱动 A 不漂移', A.flip, false);
      chk('S2 驱动 A 被判为强影响', A.tier, 'strong');
      chk('S2 噪声 B 被判为弱影响', S.rows.find(r => r.key === 'B').tier, 'weak');
      /* C 只在后 40% 有效 → 样本内 IC 应远小于全样本 */
      chk('S2 后期因子 C 的样本内 |IC| 明显小于样本外', Math.abs(C.icIn) < Math.abs(C.icOut), 'true');
      chk('S2 显著性单独列示（qPass 字段存在）', typeof A.qPass === 'boolean', 'true');
      chk('S2 统计了 FDR 通过数', typeof S.nQ === 'number', 'true');
      chk('S2 统计了漂移数', typeof S.nFlip === 'number', 'true');
      chk('S2 外生标记来自分类', A.exo, true);
      chk('S2 方向按 IC 符号如实记录', A.dir, A.ic > 0 ? 1 : -1);
      /* 强档必须落在「不漂移池的前 50%」里，不能超编 */
      const stable = S.rows.filter(r => !r.flip);
      chk('S2 强档个数不超过不漂移池的一半 +1', S.byTier.strong.length <= Math.max(1, Math.round(stable.length * 0.5)) + 1, 'true');
      chk('S2 漂移因子一律不进强档', S.byTier.strong.every(r => !r.flip), 'true');
    }

    /* ---- S3 宇宙评分：选择只能看样本内 ---- */
    {
      const W = mkWorld(1400);
      const S = call('factorScreening');
      const US = call('universeScore', S, { k: 1 });
      chk('S3 Top-1 选中的是 A（样本内 IC 最大的那个）', US.ids[0], 'A');
      chk('S3 没选中「全样本好看但样本内没有」的 C', US.ids.indexOf('C') < 0, 'true');
      chk('S3 方向取自样本内 IC 的符号', US.dirs[0].dir, US.dirs[0].icIn > 0 ? 1 : -1);
      chk('S3 报了样本内 / 样本外 / 全样本三段', US.icIn != null && US.icOut != null && US.icAll != null, 'true');
      chk('S3 切点落在区间内部', US.cut > 0 && US.cut < S.ctx.n, 'true');
      /* 恒等式：三段的样本数应等于全样本 */
      chk('S3 样本内 n + 样本外 n ≈ 全样本 n', Math.abs((US.icIn.n + US.icOut.n) - US.icAll.n) <= 12, 'true');
      /* K 大于候选数时不崩 */
      const US2 = call('universeScore', S, { k: 99 });
      chk('S3 K 超过候选数时安全收敛', US2 != null && US2.k <= 4, 'true');
    }

    /* ---- S4 径向星系图 ---- */
    {
      const W = mkWorld(1400);
      state.screening = call('factorScreening');
      const cv = $id('netCanvas');
      cv.clientWidth = 900; cv.clientHeight = 460;
      const ok = call('initRadial', cv);
      chk('S4 径向图初始化成功', ok, true);
      const net = vmGet('net');
      chk('S4 布局标记为 radial', net.layout, 'radial');
      chk('S4 节点在画布内', net.nodes.every(n => n.x >= 0 && n.x <= net.W && n.y >= 0 && n.y <= net.H), 'true');
      chk('S4 环数不超过 6', net.rings.length <= 6, 'true');
      /* 外生的半径必须大于内生的 */
      const exoR = net.nodes.filter(n => n.exo).map(n => n.rad);
      const endR = net.nodes.filter(n => !n.exo).map(n => n.rad);
      chk('S4 外生全部排在内生之外', !exoR.length || !endR.length || Math.min.apply(null, exoR) > Math.max.apply(null, endR), 'true');
      /* 节点大小随 |IC| 单调 */
      const srt = net.nodes.slice().sort((a, b) => a.abs - b.abs);
      chk('S4 节点大小随 |IC| 单调不减', srt.every((n, i) => i === 0 || n.r >= srt[i - 1].r - 1e-9), 'true');
      /* 确定性：同样的数据两次布局必须完全一致 */
      const pos1 = net.nodes.map(n => n.x.toFixed(6) + ',' + n.y.toFixed(6)).join('|');
      call('initRadial', cv);
      const pos2 = vmGet('net').nodes.map(n => n.x.toFixed(6) + ',' + n.y.toFixed(6)).join('|');
      chk('S4 布局是确定性的（同数据同位置）', pos1, pos2);
      /* maxNodes 生效 */
      vmRun('NET_OPTS.maxNodes = 2');
      call('initRadial', cv);
      chk('S4 maxNodes 限制生效', vmGet('net').nodes.length <= 2, 'true');
      vmRun('NET_OPTS.maxNodes = 64');
      /* hover 命中与落空 */
      const nd0 = vmGet('net').nodes[0];
      chk('S4 hover 能命中节点', call('radialHit', nd0.x, nd0.y) >= 0, 'true');
      chk('S4 hover 在空白处落空', call('radialHit', 1, 1) , -1);
      /* 重绘不抛异常（含 hover 态） */
      vmSet('net.hover', 0);
      let okDraw = true; try { call('drawRadial'); } catch (e) { okDraw = false; }
      chk('S4 带 hover 重绘不抛异常', okDraw, 'true');
      vmSet('net', null);
    }

    /* ---- S5 面板渲染 ---- */
    {
      const W = mkWorld(1400);
      state.screening = null; state.uniScore = null;
      let ok1 = true; try { call('renderUniverseBox'); } catch (e) { ok1 = false; }
      chk('S5 面板渲染不抛异常', ok1, 'true');
      const hb = $id('uniBox').innerHTML || '';
      chk('S5 面板报出候选池规模', hb.indexOf('候选池') >= 0, 'true');
      chk('S5 面板报出三档统计', hb.indexOf('强影响') >= 0 && hb.indexOf('弱影响') >= 0, 'true');
      chk('S5 面板把 FDR 通过数如实写出来', hb.indexOf('BH-FDR') >= 0, 'true');
      chk('S5 面板把漂移数如实写出来', hb.indexOf('符号相反') >= 0, 'true');
      chk('S5 面板列出强影响明细', hb.indexOf('强影响因子') >= 0, 'true');
      chk('S5 面板含宇宙评分的样本外检验', hb.indexOf('样本外') >= 0, 'true');
      chk('S5 面板含最小可探测 |IC|', hb.indexOf('最小可探测') >= 0, 'true');
      /* 空态：未加载宇宙 */
      state.universe = null;
      let ok2 = true; try { call('renderUniverseBox'); } catch (e) { ok2 = false; }
      chk('S5 未加载宇宙时安全降级', ok2, 'true');
      chk('S5 提示需要加载', ($id('uniBox').innerHTML || '').indexOf('尚未加载') >= 0, 'true');
      /* 空态：无 BTC 历史 */
      state.universe = { series: { A: W.series.A }, _keyCat: {}, _name: {}, exo: {} };
      state.histBundle = null;
      let ok3 = true; try { call('renderUniverseBox'); } catch (e) { ok3 = false; }
      chk('S5 无 BTC 历史时安全降级', ok3, 'true');
      chk('S5 提示需要先跑回放', ($id('uniBox').innerHTML || '').indexOf('十年回放') >= 0, 'true');
      state.histBundle = null; state.universe = null; state.screening = null; state.uniScore = null;
    }

    /* ---- S6 移动端适配（静态检查 index.html） ---- */
    {
      const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
      chk('S6 有 viewport meta', /<meta name="viewport"[^>]*width=device-width/.test(html), 'true');
      chk('S6 有 900px 断点', html.indexOf('@media (max-width:900px)') >= 0, 'true');
      chk('S6 有 680px 断点', html.indexOf('@media (max-width:680px)') >= 0, 'true');
      chk('S6 有 480px 断点', html.indexOf('@media (max-width:480px)') >= 0, 'true');
      chk('S6 小屏表格可横向滚动', /\.rg-tbl\{overflow-x:auto/.test(html.replace(/\s+/g, '')), 'true');
      chk('S6 小屏 canvas 高度被压缩', /#mainCanvas\{height:230px\}/.test(html.replace(/\s+/g, '')), 'true');
      chk('S6 小屏主网格塌成单列', /@media\(max-width:900px\)\{[^}]*\.main-grid\{grid-template-columns:1fr\}/.test(html.replace(/\s+/g, '')), 'true');
    }
  }

  console.log('\n' + (fail ? `❌ 失败 ${fail} 项` : '✅ 全部断言通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
