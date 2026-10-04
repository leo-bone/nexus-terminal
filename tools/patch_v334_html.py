#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.34 index.html 原子补丁：提醒中心抽屉 + 控件文案 + 版本号"""
import io

P = '/Users/leo/WorkBuddy/2026-09-30-12-17-12/index.html'
src = io.open(P, encoding='utf-8').read()

def rep(old, new, tag, cnt=1):
    global src
    n = src.count(old)
    assert n == cnt, 'FAIL[%s] count=%d expect=%d' % (tag, n, cnt)
    src = src.replace(old, new, 1)
    print('  ok  %s' % tag)

# ---------- A. title ----------
rep('<title>Nexus Terminal · 加密货币因子关系终端 v3.33</title>',
    '<title>Nexus Terminal · 加密货币因子关系终端 v3.34</title>', 'A title')

# ---------- B. LIVE 徽标 ----------
rep('LIVE · v3.33</div>', 'LIVE · v3.34</div>', 'B LIVE 徽标')

# ---------- C. CSS ----------
CSS = """
/* v3.34 提醒中心抽屉 */
.al-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:880;display:none}
.al-mask.on{display:block}
.al-drawer{position:fixed;top:0;right:0;width:430px;max-width:94vw;height:100vh;background:rgba(6,12,24,.985);border-left:1px solid var(--border2);z-index:890;overflow-y:auto;transform:translateX(102%);transition:transform .22s ease;padding:14px 16px 30px;box-shadow:-10px 0 34px rgba(0,0,0,.55)}
.al-drawer.on{transform:translateX(0)}
.al-hd{display:flex;align-items:center;gap:8px;margin-bottom:11px}
.al-hd .t{font-size:13px;font-weight:700;color:var(--text4);flex:1}
.al-x{background:transparent;border:1px solid var(--border2);color:var(--text2);border-radius:6px;padding:2px 9px;cursor:pointer;font-size:10px;font-family:inherit}
.al-x:hover{border-color:var(--blue);color:var(--blue)}
.al-card{background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:11px 12px;margin-bottom:9px}
.al-ttl{font-size:11px;font-weight:700;color:var(--text2);margin-bottom:7px;letter-spacing:.4px}
.al-line{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:11px;color:var(--text);font-family:'JetBrains Mono',monospace}
.al-line b{color:var(--text3);font-weight:600}
.al-dim{font-size:11px;color:var(--dim);line-height:1.6}
.al-note{font-size:10px;color:var(--dim);line-height:1.6;margin-top:8px;border-top:1px dashed var(--border);padding-top:7px}
.al-note b{color:var(--text2)}
.al-sw{display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:11px;color:var(--text2)}
.al-log{max-height:300px;overflow-y:auto;margin-top:2px}
.al-item{border-left:2px solid var(--border2);padding:5px 0 5px 9px;margin-bottom:7px}
.al-item.lv2{border-left-color:var(--red)}
.al-item.lv1{border-left-color:var(--yellow)}
.al-item.lv0{border-left-color:var(--blue)}
.al-it{font-size:9px;color:var(--dim);font-family:'JetBrains Mono',monospace;letter-spacing:.3px}
.al-ib{font-size:10.5px;color:var(--text2);line-height:1.55;white-space:pre-wrap;margin-top:2px;font-family:'JetBrains Mono',monospace}
"""
rep('.refresh-btn:hover{background:rgba(0,180,255,.18)}',
    '.refresh-btn:hover{background:rgba(0,180,255,.18)}' + CSS, 'C CSS')

# ---------- D. header 控件 ----------
OLD_HDR = '''      <label class="notify-toggle" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#9fb3c8;cursor:pointer;margin-left:8px"><input type="checkbox" id="notifyChk" style="cursor:pointer"> 🔔 RED 通知</label>
      <button id="notifyTestBtn" class="refresh-btn" style="margin-left:6px" title="发一条测试消息到群机器人，验证 Webhook 是否配置成功">🔔 测试</button>
      <span id="notifyStat" style="font-size:11px;color:#6b8299;margin-left:6px"></span>'''
NEW_HDR = '''      <label class="notify-toggle" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#9fb3c8;cursor:pointer;margin-left:8px" title="护栏进入 RED 时本地提醒：桌面通知 + 提示音 + 标题闪烁 + 告警时间轴。零配置、不出本机"><input type="checkbox" id="notifyChk" style="cursor:pointer"> 🔔 RED 提醒</label>
      <button id="notifyTestBtn" class="refresh-btn" style="margin-left:6px" title="立刻发一条本地提醒，验证桌面通知/提示音/标题闪烁是否可用">🔔 测试</button>
      <button id="alertLogBtn" class="refresh-btn" style="margin-left:6px" title="提醒中心：上次看到 vs 现在 + 告警时间轴 + 提醒设置">📋 提醒中心</button>
      <span id="notifyStat" style="font-size:11px;color:#6b8299;margin-left:6px"></span>'''
rep(OLD_HDR, NEW_HDR, 'D header 控件')

# ---------- E. 抽屉 DOM ----------
rep('</div>\n<script src="app.js"></script>',
    '</div>\n\n<div id="alertMask" class="al-mask"></div>\n<div id="alertDrawer" class="al-drawer"></div>\n\n<script src="app.js"></script>',
    'E 抽屉 DOM')

# ---------- F. footer ----------
rep('NEXUS TERMINAL v3.33 · 36 维实时评分', 'NEXUS TERMINAL v3.34 · 36 维实时评分', 'F footer 版本号')
rep('· ㊱ 护栏 RED 通知（进入 RED 时经数据 Worker 转发到群机器人 Webhook，带外提醒，不必 24h 盯盘；默认关闭，需主动开启）',
    '· ㊱ 本地提醒中心（进入 RED 时四重本地提醒：桌面通知 + 提示音 + 标题闪烁 + 告警时间轴，零配置、零外部账号、告警不出本机；默认关闭，需主动开启）',
    'F2 footer ㊱ 描述')

io.open(P, 'w', encoding='utf-8').write(src)
print('index.html 补丁完成，长度 %d' % len(src))
