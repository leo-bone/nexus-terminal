#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3.34 README 补丁：本地提醒中心章节 + Webhook 章节改为「保留未启用」"""
import io

P = '/Users/leo/WorkBuddy/2026-09-30-12-17-12/README.md'
src = io.open(P, encoding='utf-8').read()

def rep(old, new, tag, cnt=1):
    global src
    n = src.count(old)
    assert n == cnt, 'FAIL[%s] count=%d expect=%d' % (tag, n, cnt)
    src = src.replace(old, new, 1)
    print('  ok  %s' % tag)

rep('# Nexus Terminal v3.33', '# Nexus Terminal v3.34', 'A 标题')

V334 = '''## v3.34 变更（本次）

**主题：提醒方式换轨 —— 从「群机器人 Webhook」改为「纯本地提醒中心」，零配置、零外部账号、告警不出本机。**

### 为什么换

v3.30~v3.33 的提醒走的是群机器人 Webhook，实际落地要跨三道坎：

1. 得先有企业微信 / 飞书 / 钉钉的**群和组织**（个人用户门槛最高的一步）；
2. 拿到 URL 后要 `wrangler secret put`，**改一次动一次命令行**；
3. 告警文本要**经过第三方服务器**。

v3.34 全部砍掉：不注册账号、不填 URL、不碰 Worker 密钥，一个字节都不出本机。

### 四层提醒（各自独立，任何一层能用就不漏）

| 层 | 机制 | 需要什么 | 页面在后台时 |
|---|---|---|---|
| ① | 桌面通知（Notification API） | 点一次「允许」授权 | ✅ 能弹系统通知 |
| ② | 提示音（Web Audio 现场合成，无音频文件） | 无 | ✅ 能响 |
| ③ | 标题闪烁（`🔴 护栏 RED · NEXUS`） | 无 | ✅ 能闪 |
| ④ | 告警时间轴（localStorage） | 无 | ✅ 回来能翻 |

桌面通知不可用时（非 HTTPS / 权限被拒 / 环境不支持），**如实标注并自动降级**到 ②③，绝不显示"已开启"来冒充送达。

### 「上次看到 vs 现在」

提醒中心抽屉里新增一张卡：离开时长、BTC 价、综合评分、护栏级别 —— **上次快照 → 现在实时值**。

口径说清楚：评分跑在浏览器里，**页面整个关掉时不再计算**，那段时间没有告警可言。所以这里比的是本地留存的快照与当前实时值的差，是真数据；**不推测、不补记**关闭期间的告警，也不冒充"离线也监控"。

### 触发规则

- 默认**关闭**，需主动勾选（不擅自替用户开启）；
- 从非 RED **进入** RED → 立即提醒；
- 持续 RED 期间每 **60 分钟**最多一次（冷却），不刷屏；
- 报状态不报方向（与护栏自身一致）。

### 回归

X 段改写为本地提醒路径，新增 **CC 段**共 38 项断言，其中关键几条：

- **零外发**：启用后捕获 `fetch`，断言任何路径都不发出一个请求（回归 X 段）；
- **不谎报**：桌面通知不可用时，`fireAlert` 返回值里不得出现"桌面通知"（CC8）；
- **不硬凑**：无旧快照 / 离开不足 1 分钟 → `missedSince()` 返回 `null`（CC5）；
- **只记真实**：历史条目 ts 必须接近当下，上限 50 条、淘汰最老的（CC3/CC4）。

---

'''
rep('## v3.33 变更（本次）', V334 + '## v3.33 变更（本次）', 'B v3.34 章节')

# Webhook 章节：从「主方案」改为「保留但未启用」
i0 = src.index('## 配置群机器人 Webhook（护栏 RED 通知）')
i1 = src.index('## v3.31 变更（上一版）')
NEW = '''## 提醒中心（默认方案，零配置）

见上方 **v3.34 变更**。用法只有三步：

1. 顶部勾选 **🔔 RED 提醒**；
2. 点 **🔔 测试** —— 听到提示音 / 看到桌面通知 / 标题开始闪烁，即链路可用；
3. 点 **📋 提醒中心** 看「上次看到 vs 现在」和告警时间轴。

> 桌面通知需要页面运行在 HTTPS 或 localhost 下（nexus.uichain.org 满足）。首次勾选时会弹系统授权框，**必须手动点允许**；点了拒绝也无所谓，会自动降级到提示音 + 标题闪烁，并在面板里如实写"已拒绝"。

---

## 群机器人 Webhook（v3.30~v3.33 旧方案，**保留代码但未启用**）

v3.34 起前端**不再调用** `/api/notify`，默认走上面的本地提醒。Worker 里的 `/api/notify` 端点代码保留未删除，将来若要接外部通道（企业微信 / 飞书 / 钉钉 / 自建）可直接启用：

```bash
cd worker
npx wrangler secret put NOTIFY_WEBHOOK      # 群机器人 URL
npx wrangler secret put NOTIFY_TOKEN        # 可选，前端内置 nexus-rg-v330
```

Worker **按 host 自动识别** payload 格式（text 型）：

| 平台 | URL 形如 |
|---|---|
| 企业微信 | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx` |
| 飞书 | `https://open.feishu.cn/open-apis/bot/v2/hook/xxxx` |
| 钉钉 | `https://oapi.dingtalk.com/robot/send?access_token=xxxx` |

未配置时该端点返回 503 `notify not configured`。**前端已不再依赖它**，页面上的开关只控制本地提醒。

---

'''
src = src[:i0] + NEW + src[i1:]
print('  ok  C Webhook 章节改为「保留未启用」')

io.open(P, 'w', encoding='utf-8').write(src)
print('README 补丁完成，长度 %d' % len(src))
