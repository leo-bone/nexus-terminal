#!/usr/bin/env python3
"""从 FRED/ALFRED 免 key CSV 拉取宏观真值，生成 worker 的 FRED_FALLBACK 片段。

为什么需要这个脚本：
  FRED/ALFRED 的免 key CSV 端点在**本机可直连**，但在 Cloudflare 边缘实测返回 520（被挡）。
  所以 Worker 走「线上尝试 → 失败回退到本脚本生成的兜底值」。本脚本随时可重跑更新真值。

用法：
  python3 tools/refresh_truths.py            # 只拉取并打印，不写入
  python3 tools/refresh_truths.py --write    # 把成功拉到的系列写回 worker/worker.js（幂等、不覆盖失败项）
  python3 tools/refresh_truths.py --check    # 校验本机 FRED 可达性 + 兜底新鲜度（不写入，供 cron 用）

健壮性设计（v3.35 优化）：
  · 单个系列拉取失败**不再中断整体**——只跳过该系列、保留 worker 里已有的兜底值，不会用空覆盖真值。
  · 写入前解析 worker 现有 FALLBACK，仅用本次成功拉到的系列覆盖对应行；失败的保留原值。
  · --check 输出兜底距今天数，可接 cron 判定「是否该提醒人工刷新」。
"""
import io
import re
import sys
import urllib.request
import datetime

SERIES = ['UNRATE', 'CPIAUCSL', 'PAYEMS', 'ICSA', 'PCEPILFE']
HOSTS = ['https://alfred.stlouisfed.org/graph/alfredgraph.csv',
         'https://fred.stlouisfed.org/graph/fredgraph.csv']
UA = {'User-Agent': 'Mozilla/5.0 (compatible; NexusTerminal/3.4)'}


def fetch(sid):
    last_err = None
    for host in HOSTS:
        url = '%s?id=%s' % (host, sid)
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                text = r.read().decode('utf-8', 'ignore')
            rows = []
            for line in text.strip().splitlines()[1:]:
                p = line.split(',')
                if len(p) < 2:
                    continue
                try:
                    v = float(p[1])
                except ValueError:
                    continue          # FRED 缺测写作 '.'
                rows.append({'d': p[0].strip(), 'v': v})
            if rows:
                return rows
        except Exception as e:
            last_err = e
    raise RuntimeError('%s failed: %s' % (sid, last_err))


def fmt_val(v):
    return 'null' if v is None else repr(float(v))


def main():
    check_only = '--check' in sys.argv
    write = '--write' in sys.argv
    out, errs = {}, {}
    for sid in SERIES:
        try:
            rows = fetch(sid)
            last = rows[-1]
            prev = rows[-2] if len(rows) > 1 else None
            out[sid] = {'asof': last['d'], 'v': last['v'], 'prev': prev['v'] if prev else None}
        except Exception as e:
            errs[sid] = str(e)

    print('%-10s %-12s %-16s %-16s %s' % ('SERIES', 'asof', 'v', 'prev', 'status'))
    for sid in SERIES:
        if sid in out:
            o = out[sid]
            print('%-10s %-12s %-16s %-16s OK' % (sid, o['asof'], o['v'], o['prev'] if o['prev'] is not None else '-'))
        else:
            print('%-10s %-12s %-16s %-16s FAIL: %s' % (sid, '-', '-', '-', errs[sid]))

    if errs:
        print('\n警告：%d 个系列拉取失败，--write 时不会覆盖其已有兜底值' % len(errs))

    if check_only:
        P = 'worker/worker.js'
        s = io.open(P, encoding='utf-8').read()
        m = re.search(r"const FALLBACK_GENERATED_ON = '([^']*)';", s)
        gen = m.group(1) if m else '?'
        today = datetime.datetime.now().strftime('%Y-%m-%d')
        age = (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(gen)).days if gen != '?' else -1
        print('\n本机 FRED 可达性: %s' % ('OK' if out else 'FAIL'))
        print('兜底刷新日期 = %s（距今天 %s 天）' % (gen, age if age >= 0 else '?'))
        print('结论: %s' % ('新鲜度可接受' if (not errs and 0 <= age <= 45) else '需关注（拉取失败或兜底过旧）'))
        sys.exit(0 if (not errs and age >= 0 and age <= 45) else 1)

    if not write:
        frag = ',\n'.join(
            "  %s: { asof: '%s', v: %s, prev: %s }" % (k, v['asof'], fmt_val(v['v']), fmt_val(v['prev']))
            for k, v in out.items())
        print('\n--- FRED_FALLBACK 片段（加 --write 才会写入）---')
        print(frag)
        return

    # --write 路径：仅用成功拉到的系列，避免用失败回退覆盖已有真值
    P = 'worker/worker.js'
    s = io.open(P, encoding='utf-8').read()
    a, b = '/* FRED_FALLBACK_BEGIN */', '/* FRED_FALLBACK_END */'
    assert s.count(a) == 1 and s.count(b) == 1, 'FRED_FALLBACK 标记缺失或不唯一'
    block = s[s.index(a) + len(a):s.index(b)]
    existing = {}
    for line in block.splitlines():
        m = re.match(r"\s*([A-Z0-9]+):\s*\{ asof: '([^']*)', v: ([^,]+), prev: ([^}]*) \},?", line)
        if m:
            existing[m.group(1)] = (m.group(2), m.group(3).strip(), m.group(4).strip())
    for sid, o in out.items():
        existing[sid] = (o['asof'], fmt_val(o['v']), fmt_val(o['prev']))
    order = [k for k in SERIES if k in existing] + [k for k in existing if k not in SERIES]
    frag = ',\n'.join(
        "  %s: { asof: '%s', v: %s, prev: %s }" % (k, existing[k][0], existing[k][1], existing[k][2])
        for k in order)
    i, j = s.index(a) + len(a), s.index(b)
    s = s[:i] + '\n' + frag + '\n' + s[j:]
    today = datetime.datetime.now().strftime('%Y-%m-%d')
    s = re.sub(r"const FALLBACK_GENERATED_ON = '[^']*';",
               "const FALLBACK_GENERATED_ON = '%s';" % today, s)
    io.open(P, 'w', encoding='utf-8').write(s)
    print('\nwritten to worker/worker.js：刷新 %d 个系列，保留 %d 个原值；FALLBACK_GENERATED_ON = %s'
          % (len(out), len(existing) - len(out), today))


if __name__ == '__main__':
    main()
