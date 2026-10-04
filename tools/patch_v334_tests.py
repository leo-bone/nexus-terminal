#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.34 回归补丁：X 段改写为本地提醒 + 新增 CC 段"""
import io

P = '/Users/leo/WorkBuddy/2026-09-30-12-17-12/tests/regression.js'
src = io.open(P, encoding='utf-8').read()

def rep(old, new, tag, cnt=1):
    global src
    n = src.count(old)
    assert n == cnt, 'FAIL[%s] count=%d expect=%d' % (tag, n, cnt)
    src = src.replace(old, new, 1)
    print('  ok  %s' % tag)

# ---------- 1. X 段整体替换 ----------
i0 = src.index("  /* ===== X. 护栏 RED 通知（v3.30）")
i1 = src.index("  /* ============ Y. v3.31 情景推演引擎")
OLD_X = src[i0:i1]
assert 'maybeNotifyGuardrail' in OLD_X and 'buildGuardrailNotifyText' in OLD_X

NEW_X = r'''  /* ===== X. 护栏 RED 本地提醒（v3.34）—— 文案 + 触发/冷却 + **零外发** ===== */
  {
    const G = {
      status: 2, label: 'RED', dvolLevel: 2, regimeLevel: 2, nCrash: 2, accelLevel: 1, nAccel: 1, ready: true,
      asof: Date.UTC(2022, 2, 1),
      firing: [
        { cat: 'rate', zh: '利率', kind: '超历史峰值', vsCrash: 1.1 },
        { cat: 'vol', zh: '波动率', kind: '逼近历史峰值(≥0.8×)', vsCrash: 0.85 },
      ],
    };
    const txt = run('buildGuardrailAlertText')(G);
    chk('X 提醒文案含护栏 RED 标题', txt.indexOf('护栏 RED') >= 0, 'true');
    chk('X 提醒文案含分量危级', txt.indexOf('危') >= 0, 'true');
    chk('X 提醒文案含 超历史峰值 / vs崩溃', txt.indexOf('超历史峰值') >= 0 && txt.indexOf('vs崩溃') >= 0, 'true');
    chk('X 提醒文案声明报状态不报方向', txt.indexOf('报状态不报方向') >= 0, 'true');
    chk('X 提醒文案无 NaN/undefined', txt.indexOf('NaN') < 0 && txt.indexOf('undefined') < 0, 'true');

    /* 捕获 fetch：v3.34 纯本地，任何路径都不得外发一个字节（这是本版的核心承诺） */
    let fetched = false;
    const realFetch = run('typeof fetch === "function" ? fetch : null');
    vmSet('fetch', function (u, opt) { fetched = true; return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } }); });

    /* 禁用路径：不写历史、不外发、不抛异常、仍记录 prevStatus */
    run('saveAlertLog')([]);
    state.alert = { enabled: false, sound: true, desktop: true, lastTs: 0, lastResult: null };
    state._prevGuardStatus = 0;
    fetched = false;
    let threw = false;
    try { run('maybeAlertGuardrail')(G); } catch (e) { threw = true; console.warn('X 禁用 threw', e); }
    chk('X 禁用时 maybeAlertGuardrail 不抛异常', !threw, 'true');
    chk('X 禁用时不写告警历史', run('loadAlertLog')().length, 0);
    chk('X 禁用时不外发任何请求', !fetched, 'true');
    chk('X 禁用时记录 prevStatus=2', state._prevGuardStatus === 2, 'true');

    /* 启用 + 新一波 RED：写 1 条历史 + 仍然零外发 */
    run('saveAlertLog')([]);
    state.alert = { enabled: true, sound: true, desktop: true, lastTs: 0, lastResult: null };
    state._prevGuardStatus = 0;
    fetched = false;
    try { run('maybeAlertGuardrail')(G); } catch (e) { threw = true; console.warn('X 启用 threw', e); }
    const log1 = run('loadAlertLog')();
    chk('X 启用且新 RED 时写入 1 条告警历史', log1.length, 1);
    chk('X 该条级别为 RED（lv=2）', log1[0] && log1[0].lv, 2);
    chk('X 该条正文即护栏文案', log1[0] && log1[0].body.indexOf('护栏 RED') >= 0, 'true');
    chk('X 纯本地：启用后仍无任何外发请求（零配置核心保证）', !fetched, 'true');

    /* 持续 RED 冷却：60 分钟内不重复提醒 */
    state.alert = { enabled: true, sound: true, desktop: true, lastTs: Date.now(), lastResult: null };
    state._prevGuardStatus = 2;
    try { run('maybeAlertGuardrail')(G); } catch (e) { threw = true; }
    chk('X 持续 RED 冷却期内不重复提醒（历史仍 1 条）', run('loadAlertLog')().length, 1);

    /* 冷却到期：再写一条 */
    state.alert.lastTs = Date.now() - 61 * 60 * 1000;
    try { run('maybeAlertGuardrail')(G); } catch (e) { threw = true; }
    chk('X 冷却到期后重新提醒（历史 2 条）', run('loadAlertLog')().length, 2);

    /* 离开 RED → 不再新增 */
    const Gg = Object.assign({}, G, { status: 1 });
    state._prevGuardStatus = 2;
    try { run('maybeAlertGuardrail')(Gg); } catch (e) { threw = true; }
    chk('X 非 RED 时不提醒（历史仍 2 条）', run('loadAlertLog')().length, 2);

    if (realFetch) vmSet('fetch', realFetch);
  }

'''
rep(OLD_X, NEW_X, 'X 段改写')

# ---------- 2. 新增 CC 段（插在总结前） ----------
ANCHOR = "  console.log('\\n' + (fail ? `❌ 失败 ${fail} 项` : '✅ 全部断言通过'));"
CC = r'''  /* ============ CC. v3.34 本地提醒中心（零配置） ============ */
  console.log('\n===== CC. v3.34 本地提醒中心（零配置 / 不出本机）=====');
  {
    /* CC1 默认配置：关闭 + 声音/桌面默认开 */
    run('localStorage').removeItem('nexus_alert');
    const c0 = run('loadAlertCfg')();
    chk('CC1 默认关闭（不擅自替用户开启）', c0.enabled, false);
    chk('CC1 默认开声音', c0.sound, true);
    chk('CC1 默认开桌面通知', c0.desktop, true);

    /* CC2 权限如实：无 Notification 环境必须报 unsupported，不假装可用 */
    chk('CC2 无 Notification 时权限如实为 unsupported', run('alertPerm')(), 'unsupported');
    state.alert = { enabled: true, sound: true, desktop: true, lastTs: 0, lastResult: null };
    const dh0 = run('alertDrawerHTML')();
    chk('CC2 抽屉如实显示「此环境不支持桌面通知」', dh0.indexOf('此环境不支持桌面通知') >= 0, 'true');
    chk('CC2 抽屉不谎称已授权', dh0.indexOf('✅ 已授权'), -1);

    /* CC3 时间轴上限 50 条（防止 localStorage 无限膨胀） */
    const big = [];
    for (let i = 0; i < 60; i++) big.push({ ts: Date.now() - i * 1000, lv: 2, title: 't' + i, body: 'b' + i });
    run('saveAlertLog')(big);
    chk('CC3 时间轴上限 50 条', run('loadAlertLog')().length, 50);
    chk('CC3 保留的是最近的 50 条', run('loadAlertLog')()[0].title, 't59');
    run('saveAlertLog')([]);
    chk('CC3 清空后为 0 条', run('loadAlertLog')().length, 0);

    /* CC4 只追加真实条目：ts 必须接近当下，不允许伪造历史时刻 */
    run('pushAlertLog')(2, 'T', 'B');
    const lg = run('loadAlertLog')();
    chk('CC4 写入 1 条', lg.length, 1);
    chk('CC4 时间戳为当下（非伪造历史）', Math.abs(lg[0].ts - Date.now()) < 5000, 'true');
    chk('CC4 级别与标题如实落盘', lg[0].lv === 2 && lg[0].title === 'T', 'true');

    /* CC5 「上次看到 vs 现在」：只比真实快照，不足 1 分钟不硬凑 */
    run('localStorage').removeItem('nexus_seen');
    chk('CC5 无旧快照 → missedSince 为 null（不硬凑）', run('missedSince')(), null);
    run('localStorage').setItem('nexus_seen', JSON.stringify({ ts: Date.now() - 5000, btc: 80000, score: 60, guard: 1 }));
    chk('CC5 离开不足 1 分钟 → null（不构成可比区间）', run('missedSince')(), null);
    state.prices.BTC.price = 81000;
    run('localStorage').setItem('nexus_seen', JSON.stringify({ ts: Date.now() - 2 * 3600 * 1000, btc: 80000, score: 60, guard: 1 }));
    const ms = run('missedSince')();
    chk('CC5 离开 2 小时 → 返回对比结果', !!ms, 'true');
    near('CC5 BTC 变化率 = 81000/80000-1', ms.dbtc, 0.0125, 1e-9);
    chk('CC5 离开时长约 2 小时', Math.abs(ms.awayMs - 7200000) < 20000, 'true');
    chk('CC5 结果里带旧快照原值（不是重算的假值）', ms.from.btc, 80000);
    run('localStorage').removeItem('nexus_seen');

    /* CC6 抽屉文案：诚实边界必须写进 UI */
    const dh = run('alertDrawerHTML')();
    chk('CC6 含「上次看到 vs 现在」', dh.indexOf('上次看到 vs 现在') >= 0, 'true');
    chk('CC6 含告警时间轴', dh.indexOf('告警时间轴') >= 0, 'true');
    chk('CC6 如实声明不推测、不补记关闭期间告警', dh.indexOf('不推测、不补记') >= 0, 'true');
    chk('CC6 如实声明不冒充离线监控', dh.indexOf('不冒充离线监控') >= 0, 'true');
    chk('CC6 声明零配置 / 数据不出本机', dh.indexOf('不出本机') >= 0, 'true');
    chk('CC6 说明页面关闭期间不计算', dh.indexOf('页面整个关掉时不再计算') >= 0, 'true');
    chk('CC6 抽屉无 NaN/undefined', dh.indexOf('NaN') < 0 && dh.indexOf('undefined') < 0, 'true');

    /* CC7 抽屉开关不抛异常（stub DOM 下也要稳） */
    let t7 = false;
    try { run('toggleAlertDrawer')(true); run('toggleAlertDrawer')(false); run('renderAlertDrawer')(); t7 = true; } catch (e) { console.warn('CC7 threw', e && e.message); }
    chk('CC7 抽屉开/关/渲染均不抛异常', t7, 'true');

    /* CC8 降级：桌面通知不可用时，不能谎报已发 */
    run('saveAlertLog')([]);
    state.alert = { enabled: true, sound: true, desktop: true, lastTs: 0, lastResult: null };
    const got = run('fireAlert')(2, 'T2', 'B2');
    chk('CC8 降级后仍走标题闪烁', got.indexOf('标题闪烁') >= 0, 'true');
    chk('CC8 不谎报「桌面通知」已发', got.indexOf('桌面通知'), -1);
    chk('CC8 降级后仍如实写入历史', run('loadAlertLog')().length, 1);

    /* CC9 提示音在无 AudioContext 环境下静默失败、不影响其它层 */
    chk('CC9 无 AudioContext 时 alertBeep 返回 false（不抛）', run('alertBeep')('red'), false);

    /* CC10 冷却常量与历史上限写死在 ALERT 上 */
    chk('CC10 冷却 60 分钟', run('ALERT').COOLDOWN_MS, 3600000);
    chk('CC10 历史上限 50 条', run('ALERT').MAX_LOG, 50);
    run('saveAlertLog')([]);
  }

'''
rep(ANCHOR, CC + ANCHOR, 'CC 段插入')

io.open(P, 'w', encoding='utf-8').write(src)
print('regression.js 补丁完成，长度 %d' % len(src))
