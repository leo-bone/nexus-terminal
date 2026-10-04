#!/usr/bin/env python3
"""从 FRED/ALFRED 免 key CSV 拉取宏观真值，生成 worker 的 FRED_FALLBACK 片段。

为什么需要这个脚本：
  FRED/ALFRED 的免 key CSV 端点在**本机可直连**，但在 Cloudflare 边缘实测返回 520（被挡）。
  所以 Worker 走「线上尝试 → 失败回退到本脚本生成的兜底值」。本脚本随时可重跑更新真值。

用法：python3 tools/refresh_truths.py [--write]
      --write 会直接把 FRED_FALLBACK 写回 worker/worker.js（幂等替换标记块之间内容）
"""
import io, json, sys, urllib.request, datetime

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


def main():
    out = {}
    for sid in SERIES:
        rows = fetch(sid)
        last = rows[-1]
        prev = rows[-2] if len(rows) > 1 else None
        out[sid] = {'asof': last['d'], 'v': last['v'],
                    'prev': prev['v'] if prev else None}
        print('%-10s asof=%s  v=%s  prev=%s' % (sid, last['d'], last['v'],
                                                prev['v'] if prev else '-'))
    frag = ',\n'.join(
        "  %s: { asof: '%s', v: %s, prev: %s }" % (k, v['asof'], repr(v['v']),
                                                   repr(v['prev']) if v['prev'] is not None else 'null')
        for k, v in out.items())
    print('\n--- FRED_FALLBACK 片段 ---')
    print(frag)
    if '--write' in sys.argv:
        P = 'worker/worker.js'
        s = io.open(P, encoding='utf-8').read()
        a, b = '/* FRED_FALLBACK_BEGIN */', '/* FRED_FALLBACK_END */'
        assert s.count(a) == 1 and s.count(b) == 1, 'FRED_FALLBACK 标记缺失或不唯一'
        i, j = s.index(a) + len(a), s.index(b)
        s = s[:i] + '\n' + frag + '\n' + s[j:]
        today = datetime.datetime.now().strftime('%Y-%m-%d')
        # 同步更新兜底刷新日期（前端据其判断「许久未刷新」）
        s = __import__('re').sub(r"const FALLBACK_GENERATED_ON = '[^']*';",
                                "const FALLBACK_GENERATED_ON = '%s';" % today, s)
        io.open(P, 'w', encoding='utf-8').write(s)
        print('\nwritten to worker/worker.js (FRED_FALLBACK + FALLBACK_GENERATED_ON 已更新为 %s)' % today)


if __name__ == '__main__':
    main()
