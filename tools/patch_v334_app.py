#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.34 app.js 原子补丁：群机器人 Webhook → 纯本地提醒中心（零配置）
每处替换前 assert 出现次数 == 1，防止静默错改。"""
import io, sys

P = '/Users/leo/WorkBuddy/2026-09-30-12-17-12/app.js'
src = io.open(P, encoding='utf-8').read()

def rep(old, new, tag):
    global src
    n = src.count(old)
    assert n == 1, 'FAIL[%s] count=%d' % (tag, n)
    src = src.replace(old, new, 1)
    print('  ok  %s' % tag)

# ---------- A. 版本号 ----------
rep(' * NEXUS TERMINAL v3.33 — 加密货币实时监测与因子关系终端',
    ' * NEXUS TERMINAL v3.34 — 加密货币实时监测与因子关系终端', 'A 版本号')

# ---------- B. 头部变更说明 ----------
V334 = """ * v3.34 变更:
 *   1) 提醒方式换轨：v3.30~v3.33 的「群机器人 Webhook」需要企业/组织建群 + 加机器人 +
 *      复制 URL + wrangler secret 写进 Worker，门槛高且告警文本要过第三方服务器。
 *      v3.34 改为**纯本地提醒**，零配置、零外部账号、零数据外发：
 *      · ① 桌面通知（Notification API，页面在后台也能弹系统通知，需一次性授权）
 *      · ② 提示音（Web Audio 现场合成，无外部音频文件；RED 三连急鸣）
 *      · ③ 标题闪烁（任何浏览器都有效，切回页面即停）
 *      · ④ 告警时间轴（localStorage，回来能翻「我不在屏幕前时发生过什么」）
 *   2) 提醒中心抽屉（📋）：除时间轴外，新增「上次看到 vs 现在」——
 *      比的是本地留存的快照（BTC 价 / 综合评分 / 护栏级别）与当前实时值的差。
 *      这是真数据对比，**不推测、不补记**页面关闭期间的告警（那时根本没在计算）。
 *   3) 诚实边界写进 UI：评分跑在浏览器里 → 页面整个关掉即停止计算，
 *      本版明确不冒充「离线也监控」；桌面通知不可用时如实标「不支持/已拒绝」并降级。
 *   4) Worker 的 /api/notify 代码保留但未启用（前端不再调用），留给将来若要接外部通道。
 *
"""
rep(' * v3.33 变更:', V334 + ' * v3.33 变更:', 'B 头部说明')

# ---------- C. state ----------
rep('  notify: null, _prevGuardStatus: 0,  /* v3.30 护栏 RED 通知：配置 + 上次状态（边缘检测） */',
    '  notify: null, alert: null, _prevGuardStatus: 0,  /* v3.34 本地提醒：配置（state.alert）+ 上次护栏状态（边缘检测） */',
    'C state.alert')

# ---------- D. 绑定区 ----------
OLD_BIND = """  /* v3.30 护栏 RED 通知开关（默认关闭，需用户主动开启；状态存 localStorage） */
  const nchk = $('notifyChk');
  if (nchk) {
    if (!state.notify) state.notify = loadNotifyCfg();
    nchk.checked = !!state.notify.enabled;
    /* v3.32：一键验证 Webhook 是否真的配通（否则「已开启」只是自欺欺人） */
    const ntb = $('notifyTestBtn');
    if (ntb) ntb.addEventListener('click', async function () {
      const old = ntb.textContent; ntb.disabled = true; ntb.textContent = '发送中…';
      try {
        if (!state.notify) state.notify = loadNotifyCfg();
        const r = await fetch(NOTIFY.ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: NOTIFY.TOKEN, text: '【NEXUS 测试】Webhook 配置验证 —— 收到这条说明链路已通。\\n时间：' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '\\n（nexus.uichain.org）' })
        });
        const d = await r.json().catch(function () { return {}; });
        state.notify.lastResult = (r.ok && d.ok) ? '✅ 测试已送达' : ('❌ ' + (d.error || ('HTTP ' + r.status)));
      } catch (e) {
        if (!state.notify) state.notify = loadNotifyCfg();
        state.notify.lastResult = '❌ ' + (e && e.message || '网络失败');
      }
      saveNotifyCfg(); updateNotifyUI();
      ntb.disabled = false; ntb.textContent = old;
    });
    nchk.addEventListener('change', function () {
      if (!state.notify) state.notify = loadNotifyCfg();
      state.notify.enabled = nchk.checked;
      saveNotifyCfg(); updateNotifyUI();
    });
    updateNotifyUI();
  }
"""
NEW_BIND = """  /* v3.34 本地提醒开关（默认关闭，需用户主动开启；状态存 localStorage，不出本机） */
  const nchk = $('notifyChk');
  if (nchk) {
    if (!state.alert) state.alert = loadAlertCfg();
    nchk.checked = !!state.alert.enabled;
    /* 一键验证提醒链路是否真的可用（否则「已开启」只是自欺欺人） */
    const ntb = $('notifyTestBtn');
    if (ntb) ntb.addEventListener('click', function () {
      if (!state.alert) state.alert = loadAlertCfg();
      state.alert.enabled = true; nchk.checked = true;
      const got = fireAlert(0, 'NEXUS 提醒测试',
        '这是一条本地测试提醒。\\n时间：' + new Date().toLocaleString() +
        '\\n听到声音 / 看到桌面通知 = 提醒链路可用。\\n（纯本地，不经过任何第三方服务器）');
      state.alert.lastResult = '✅ 已触发（' + got.join('+') + '）';
      saveAlertCfg(); updateAlertUI(); renderAlertDrawer();
    });
    nchk.addEventListener('change', function () {
      if (!state.alert) state.alert = loadAlertCfg();
      state.alert.enabled = nchk.checked;
      /* 开启瞬间顺便申请桌面通知权限 —— 必须由用户手势触发，浏览器才给弹授权框 */
      if (nchk.checked && alertPerm() === 'default') {
        askAlertPerm(function () { updateAlertUI(); renderAlertDrawer(); });
      }
      saveAlertCfg(); updateAlertUI(); renderAlertDrawer();
    });
    updateAlertUI();
  }
  /* v3.34 提醒中心抽屉 */
  const alb = $('alertLogBtn'), almk = $('alertMask');
  if (alb) alb.addEventListener('click', function () { toggleAlertDrawer(true); });
  if (almk) almk.addEventListener('click', function () { toggleAlertDrawer(false); });
  /* 页面切走/关闭前打一个「上次看到」的点，供下次回来对比（只存当时事实，不存告警） */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) markSeenFromState(); else alertBlink(false);
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('beforeunload', markSeenFromState);
  setInterval(markSeenFromState, 60000);  /* 兜底：每 60 秒打一次点，防止直接关页面没触发 */
"""
rep(OLD_BIND, NEW_BIND, 'D 绑定区')

# ---------- E. NOTIFY 模块 → ALERT 模块 ----------
i0 = src.index('/* =====================================================================\n * ㉟+ 护栏 RED 通知（v3.30）')
i1 = src.index('async function sendGuardrailNotify(G) {')
i1 = src.index('\n}\n', src.index('updateNotifyUI();', i1)) + len('\n}\n')
OLD_MOD = src[i0:i1]
assert OLD_MOD.rstrip().endswith('}'), OLD_MOD[-80:]
assert 'sendGuardrailNotify' in OLD_MOD and 'maybeNotifyGuardrail' in OLD_MOD

NEW_MOD = r'''/* =====================================================================
 * ㊱ 本地提醒中心（v3.34）—— 零配置：桌面通知 + 提示音 + 标题闪烁 + 告警时间轴
 * ---------------------------------------------------------------------
 * v3.30–v3.33 走的是「群机器人 Webhook」带外通道：要先有企业/组织的群、加机器人、
 * 复制 URL，再用 wrangler secret 写进 Worker —— 配置门槛高，且告警文本要过第三方服务器。
 * v3.34 改为**纯本地**：不依赖任何外部账号，一个字节都不出本机。
 *
 * 四层提醒（各自独立，任何一层能用就不漏）：
 *   ① 桌面通知（Notification API）：页面在后台也能弹系统通知，需一次性授权
 *   ② 提示音：Web Audio 现场合成（无外部音频文件）—— RED 三连急鸣 / 测试单声
 *   ③ 标题闪烁：任何浏览器都有效，切回页面即停
 *   ④ 告警时间轴：localStorage，回来能翻「我不在屏幕前时发生过什么」
 *
 * 触发规则（边缘 + 冷却，避免刷屏）：
 *   · 仅在用户主动开启（state.alert.enabled，默认关闭）且 G.ready 时生效
 *   · 从非 RED 转入 RED（新一波）→ 立即提醒
 *   · 持续 RED 期间，每 60 分钟最多再提醒一次
 *   · 不报方向，只报状态（与护栏自身一致）
 *
 * 诚实边界（这条必须写清楚，否则等于自欺欺人）：
 *   · 评分跑在浏览器里 → 页面整个关掉时不再计算，那段时间没有告警可言。
 *     本版不冒充「离线也监控」；时间轴里每一条都是页面开着时真实触发的。
 *   · 「上次看 vs 现在」比的是本地留存的快照与当前实时值的差 —— 真数据，
 *     不推测、不补记关闭期间的告警。
 *   · 桌面通知仅在 HTTPS / localhost 下可用；权限被拒则如实标「已拒绝」并降级到 ②③，
 *     不假装开了。
 * ===================================================================== */
const ALERT = {
  COOLDOWN_MS: 60 * 60 * 1000,
  MAX_LOG: 50,
  LS_CFG: 'nexus_alert',
  LS_LOG: 'nexus_alerts',
  LS_SEEN: 'nexus_seen',
};

function loadAlertCfg() {
  try {
    const s = JSON.parse(localStorage.getItem(ALERT.LS_CFG) || '{}');
    return { enabled: !!s.enabled, sound: s.sound !== false, desktop: s.desktop !== false,
             lastTs: s.lastTs || 0, lastResult: s.lastResult || null };
  } catch (e) { return { enabled: false, sound: true, desktop: true, lastTs: 0, lastResult: null }; }
}
function saveAlertCfg() {
  try { if (state.alert) localStorage.setItem(ALERT.LS_CFG, JSON.stringify(state.alert)); } catch (e) {}
}

function loadAlertLog() {
  try { const a = JSON.parse(localStorage.getItem(ALERT.LS_LOG) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function saveAlertLog(a) {
  try { localStorage.setItem(ALERT.LS_LOG, JSON.stringify((a || []).slice(-ALERT.MAX_LOG))); } catch (e) {}
}
/* 写一条：只追加真实发生过的提醒。不补记、不臆造关闭期间的条目。 */
function pushAlertLog(lv, title, body) {
  const a = loadAlertLog();
  a.push({ ts: Date.now(), lv: lv, title: String(title || ''), body: String(body || '') });
  saveAlertLog(a);
  return a;
}

/* ① 桌面通知权限：不支持 / 已授权 / 已拒绝 / 未询问 —— 如实返回，不美化 */
function alertPerm() {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission || 'default';
  } catch (e) { return 'unsupported'; }
}
function askAlertPerm(cb) {
  try {
    if (typeof Notification === 'undefined' || !Notification.requestPermission) { if (cb) cb('unsupported'); return; }
    const p = Notification.requestPermission(function (r) { if (cb) cb(r || alertPerm()); });
    if (p && p.then) p.then(function (r) { if (cb) cb(r || alertPerm()); });
  } catch (e) { if (cb) cb('unsupported'); }
}

/* ② 提示音：Web Audio 现场合成，不加载任何外部音频文件 */
let alertAudio = null;
function alertBeep(kind) {
  try {
    if (typeof window === 'undefined') return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!alertAudio) alertAudio = new AC();
    if (alertAudio.state === 'suspended' && alertAudio.resume) alertAudio.resume();
    /* RED：三连下行急鸣（远-近-远，穿透力强）；测试：单声；其余：两声 */
    const spec = kind === 'red' ? [[932, 0, .16], [699, .20, .16], [932, .40, .24]]
      : kind === 'test' ? [[784, 0, .14]]
        : [[622, 0, .13], [622, .19, .13]];
    spec.forEach(function (s) {
      const o = alertAudio.createOscillator(), g = alertAudio.createGain();
      o.type = 'sine'; o.frequency.value = s[0];
      const t0 = alertAudio.currentTime + s[1];
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.22, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + s[2]);
      o.connect(g); g.connect(alertAudio.destination);
      o.start(t0); o.stop(t0 + s[2] + 0.03);
    });
    return true;
  } catch (e) { return false; }
}

/* ③ 标题闪烁：任何浏览器都有效；回到页面立即停 */
let alertBlinkT = 0, alertBlinkOn = false, alertBaseTitle = '';
function alertBlink(on) {
  try {
    if (typeof document === 'undefined') return;
    if (!alertBaseTitle) alertBaseTitle = document.title || '';
    if (!alertBaseTitle) return;
    if (on) {
      if (alertBlinkT) return;
      alertBlinkOn = false;
      alertBlinkT = setInterval(function () {
        alertBlinkOn = !alertBlinkOn;
        document.title = alertBlinkOn ? '🔴 护栏 RED · NEXUS' : alertBaseTitle;
      }, 900);
    } else {
      if (alertBlinkT) { clearInterval(alertBlinkT); alertBlinkT = 0; }
      document.title = alertBaseTitle;
    }
  } catch (e) {}
}

/* 四层一起发：任一层失败不影响其它层 */
function fireAlert(lv, title, body) {
  if (!state.alert) state.alert = loadAlertCfg();
  const cfg = state.alert;
  pushAlertLog(lv, title, body);
  const got = [];
  try {
    if (cfg.desktop && alertPerm() === 'granted' && typeof Notification !== 'undefined') {
      const n = new Notification(String(title), { body: String(body || '').slice(0, 300), tag: 'nexus-guardrail' });
      if (n && n.addEventListener) n.addEventListener('click', function () {
        try { if (typeof window !== 'undefined' && window.focus) window.focus(); } catch (e2) {}
        alertBlink(false);
      });
      got.push('桌面通知');
    }
  } catch (e) {}
  if (cfg.sound && alertBeep(lv === 2 ? 'red' : 'test')) got.push('提示音');
  alertBlink(true); got.push('标题闪烁');
  cfg.lastResult = '已提醒 ' + new Date().toLocaleTimeString() + '（' + got.join('+') + '）';
  saveAlertCfg();
  updateAlertUI();
  return got;
}

function buildGuardrailAlertText(G) {
  const LVL = ['静', '警', '危'];
  const lv = function (x) { return LVL[x == null ? 0 : x]; };
  const d = (G.asof ? new Date(G.asof).toISOString().slice(0, 10) : '—');
  const lines = [];
  lines.push('【NEXUS 护栏 RED】');
  lines.push('时间：' + d);
  lines.push('分量 → DVOL体制:' + lv(G.dvolLevel) + ' · 极端分位联动:' + lv(G.regimeLevel) +
    '(nCrash=' + (G.nCrash || 0) + ') · 变化率联动:' + lv(G.accelLevel) + '(nAccel=' + (G.nAccel || 0) + ')');
  if (G.firing && G.firing.length) {
    lines.push('触发项：');
    G.firing.slice(0, 12).forEach(function (f) {
      let s = '· ' + (f.zh || f.cat) + '：' + f.kind;
      if (f.vsCrash != null) s += (f.vsCrash >= 1 ? '（超历史峰值）' : '（vs崩溃 ' + f.vsCrash.toFixed(2) + '×）');
      lines.push(s);
    });
  }
  lines.push('报状态不报方向。建议复核仓位与波动暴露。');
  return lines.join('\n');
}

/* ---------- 「上次看到 vs 现在」：只存当时看到的事实，不存告警 ---------- */
function alertSnapshot() {
  let sc = null;
  try { const r = computeNexusScore(); sc = r && r.score != null ? r.score : null; } catch (e) {}
  const p = state.prices && state.prices.BTC ? state.prices.BTC.price : null;
  const G = state.guardrail;
  return { ts: Date.now(), btc: p != null ? p : null, score: sc, guard: G && G.ready ? G.status : null };
}
function loadSeen() {
  try { return JSON.parse(localStorage.getItem(ALERT.LS_SEEN) || 'null'); } catch (e) { return null; }
}
function markSeenFromState() {
  try { localStorage.setItem(ALERT.LS_SEEN, JSON.stringify(alertSnapshot())); } catch (e) {}
}
/* 返回「离开期间的事实变化」；不足 1 分钟或没有旧快照 → null（不硬凑） */
function missedSince() {
  const s = loadSeen();
  if (!s || !s.ts) return null;
  const cur = alertSnapshot();
  const away = Date.now() - s.ts;
  if (!(away >= 60000)) return null;
  return {
    awayMs: away, from: s, to: cur,
    dbtc: (s.btc != null && cur.btc != null && s.btc > 0) ? (cur.btc / s.btc - 1) : null,
    dscore: (s.score != null && cur.score != null) ? (cur.score - s.score) : null,
  };
}

/* ---------- UI ---------- */
const ALERT_PERM_TXT = {
  granted: '✅ 已授权',
  denied: '❌ 已拒绝（自动降级为 提示音 + 标题闪烁）',
  default: '⚠️ 未授权（点「授权桌面通知」）',
  unsupported: '— 此环境不支持桌面通知（用 提示音 + 标题闪烁）',
};
const ALERT_LV_TXT = { 0: '测试', 1: '提醒', 2: 'RED' };

function fmtAway(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}

function updateAlertUI() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('notifyStat');
  if (!el || !state.alert) return;
  const p = alertPerm();
  const pd = (p === 'granted' || p === 'unsupported') ? '' : (' · 桌面通知：' + ALERT_PERM_TXT[p]);
  let t = state.alert.enabled ? 'RED 提醒已开启' : 'RED 提醒已关闭';
  if (state.alert.enabled && p === 'denied') t += '（桌面通知不可用）';
  if (state.alert.lastResult) t += ' · ' + state.alert.lastResult;
  el.textContent = t + pd;
}

function maybeAlertGuardrail(G) {
  try {
    if (!state.alert) state.alert = loadAlertCfg();
    const prev = state._prevGuardStatus || 0;
    const now = Date.now();
    if (state.alert.enabled && G && G.ready && G.status === 2) {
      const freshEdge = prev !== 2;
      const cooled = (now - (state.alert.lastTs || 0)) > ALERT.COOLDOWN_MS;
      if (freshEdge || cooled) {
        state.alert.lastTs = now;
        fireAlert(2, 'NEXUS 护栏 RED', buildGuardrailAlertText(G));
      }
    }
    if (!G || G.status !== 2) alertBlink(false);  /* 离开 RED 立刻停闪，不持续打扰 */
    state._prevGuardStatus = (G ? G.status : 0);
    saveAlertCfg();
    updateAlertUI();
  } catch (e) { console.warn('alert hook', e && e.message); }
}

/* ---------- 提醒中心抽屉 ---------- */
function alertDrawerHTML() {
  const cfg = state.alert || loadAlertCfg();
  const perm = alertPerm();
  const log = loadAlertLog().slice().reverse();
  const ms = missedSince();
  const GL = ['GREEN', 'YELLOW', 'RED'];
  let h = '';

  h += '<div class="al-hd"><span class="t">🔔 提醒中心</span>' +
    '<button id="alCloseBtn" class="al-x">关闭</button></div>';

  /* ① 上次看到 vs 现在 */
  h += '<div class="al-card"><div class="al-ttl">上次看到 vs 现在</div>';
  if (ms) {
    const pc = ms.dbtc == null ? '—' : (ms.dbtc >= 0 ? '+' : '') + (ms.dbtc * 100).toFixed(2) + '%';
    const cls = ms.dbtc == null ? '' : (ms.dbtc >= 0 ? 'up' : 'dn');
    const sg = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(3);
    h += '<div class="al-line"><span>离开时长</span><b>' + fmtAway(ms.awayMs) + '</b></div>';
    h += '<div class="al-line"><span>BTC</span><b class="' + cls + '">' + fmt(ms.from.btc, 0) + ' → ' + fmt(ms.to.btc, 0) + '（' + pc + '）</b></div>';
    h += '<div class="al-line"><span>综合评分</span><b>' + sg(ms.from.score) + ' → ' + sg(ms.to.score) + '</b></div>';
    h += '<div class="al-line"><span>护栏</span><b>' + (ms.from.guard == null ? '—' : GL[ms.from.guard]) +
      ' → ' + (ms.to.guard == null ? '—' : GL[ms.to.guard]) + '</b></div>';
  } else {
    h += '<div class="al-dim">刚刚才看过（不到 1 分钟），无可比区间。</div>';
  }
  h += '<div class="al-note">口径说明：评分跑在浏览器里，页面整个关掉时不再计算 —— 所以这里比的是' +
    '「你上次看到的快照」与「现在的实时值」的差，是真数据；<b>不推测、不补记</b>关闭期间的告警。</div>';
  h += '</div>';

  /* ② 提醒设置 */
  h += '<div class="al-card"><div class="al-ttl">提醒设置</div>';
  h += '<div class="al-sw"><span>桌面通知（后台也能弹）</span>' +
    '<span><span style="font-size:10px;color:var(--dim)">' + ALERT_PERM_TXT[perm] + '</span>' +
    (perm === 'default' ? ' <button id="alPermBtn" class="al-x">授权</button>' : '') + '</span></div>';
  h += '<div class="al-sw"><span>提示音</span><input type="checkbox" id="alSoundChk"' + (cfg.sound ? ' checked' : '') + '></div>';
  h += '<div class="al-sw"><span>桌面通知</span><input type="checkbox" id="alDeskChk"' + (cfg.desktop ? ' checked' : '') + '></div>';
  h += '<div class="al-note">RED 触发规则：从非 RED 进入 RED 立即提醒；持续 RED 期间每 60 分钟最多一次。' +
    '不报方向，只报状态。<br>纯本地：不注册账号、不填 URL、告警文本不出本机。</div>';
  h += '</div>';

  /* ③ 告警时间轴 */
  h += '<div class="al-card"><div class="al-ttl">告警时间轴' +
    (log.length ? '<span style="font-weight:400;color:var(--dim)"> · 最近 ' + log.length + ' 条</span>' : '') +
    (log.length ? ' <button id="alClearBtn" class="al-x" style="float:right">清空</button>' : '') + '</div>';
  if (!log.length) {
    h += '<div class="al-dim">还没有任何提醒记录。点顶部「🔔 测试」可以发一条本地测试提醒。</div>';
  } else {
    h += '<div class="al-log">';
    log.forEach(function (r) {
      h += '<div class="al-item lv' + r.lv + '">' +
        '<div class="al-it">' + new Date(r.ts).toLocaleString() + ' · ' + (ALERT_LV_TXT[r.lv] || '提醒') + '</div>' +
        '<div class="al-ib">' + (r.body || '').replace(/</g, '&lt;') + '</div></div>';
    });
    h += '</div>';
  }
  h += '<div class="al-note">每一条都是页面开着时<b>真实触发</b>的。页面关闭期间不计算，' +
    '所以那段时间不会有记录 —— 本版不冒充离线监控。</div>';
  h += '</div>';
  return h;
}

function renderAlertDrawer() {
  if (typeof document === 'undefined') return;
  const d = document.getElementById('alertDrawer');
  if (!d) return;
  if (!state.alert) state.alert = loadAlertCfg();
  d.innerHTML = alertDrawerHTML();
  const bind = function (id, fn) { const e = document.getElementById(id); if (e) e.addEventListener('click', fn); };
  const chg = function (id, key) {
    const e = document.getElementById(id);
    if (e) e.addEventListener('change', function () {
      if (!state.alert) state.alert = loadAlertCfg();
      state.alert[key] = !!e.checked; saveAlertCfg(); updateAlertUI();
    });
  };
  bind('alCloseBtn', function () { toggleAlertDrawer(false); });
  bind('alPermBtn', function () { askAlertPerm(function () { updateAlertUI(); renderAlertDrawer(); }); });
  bind('alClearBtn', function () { saveAlertLog([]); renderAlertDrawer(); });
  chg('alSoundChk', 'sound'); chg('alDeskChk', 'desktop');
}

function toggleAlertDrawer(on) {
  if (typeof document === 'undefined') return;
  const d = document.getElementById('alertDrawer'), m = document.getElementById('alertMask');
  const want = (on == null) ? !(d && d.classList && d.classList.contains('on')) : !!on;
  if (want) renderAlertDrawer();
  if (d && d.classList) { if (want) d.classList.add('on'); else d.classList.remove('on'); }
  if (m && m.classList) { if (want) m.classList.add('on'); else m.classList.remove('on'); }
}
'''
rep(OLD_MOD, NEW_MOD, 'E NOTIFY→ALERT 模块')

# ---------- F. 调用点 ----------
rep("    maybeNotifyGuardrail(G);  /* v3.30：RED 时经 Worker 转发到群机器人 Webhook（边缘触发 + 冷却）*/",
    "    maybeAlertGuardrail(G);  /* v3.34：RED 时本地提醒（桌面通知+提示音+标题闪烁+时间轴，边缘触发 + 冷却）*/",
    'F 调用点')

io.open(P, 'w', encoding='utf-8').write(src)
print('app.js 补丁完成，总长度 %d' % len(src))
