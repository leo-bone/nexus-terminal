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
  chk('因子总数', F.length, 28);
  chk('每个因子都有合法 dir', F.every(f => [1, -1, 0].includes(f.dir)), 'true');
  chk('仅 1 项为「仅展示」(dir=0)', F.filter(f => f.dir === 0).length, 1);
  chk('参与评分的因子数', run('computeNexusScore().nScored'), 27);
  const expectDir = { fng: -1, fund: -1, ls: -1, oi: -1, dom: -1, stable: 1, hr: 1, tx: 1, dxy: -1, us10y: -1, spx: 1, vix: -1, gold: -1, oil: -1, agri: 0, geo: -1, fed: -1, bei: -1, curve: 1, jpy: 1, jgb: -1, nfp: -1, urate: 1, claims: 1, pce: -1, cpi: -1, tech: 1, mom: 1 };
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
    chk('回放因子数 = 17', rep.nScored, 17);
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

  /* —— 回放不得污染实时状态 —— */
  const liveAfter = call('computeNexusScore');
  chk('回放后游标已复位', run('state.asof'), null);
  chk('回放不污染实时评分', liveAfter.score, liveBefore.score);
  chk('回放后实时评分仍为 28 维', Object.keys(liveAfter.out).length, 28);
  run('state.histBundle = null;');

  console.log('\n' + (fail ? `❌ 失败 ${fail} 项` : '✅ 全部断言通过'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
