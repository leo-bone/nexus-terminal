#!/usr/bin/env python3
"""
Nexus Terminal — 源码推送脚本（GitHub REST API / git-database）
本机 git 因 xcrun 损坏不可用，故用 REST API 整体刷新 main 分支（force 覆盖整棵树，
GitHub 仅作源码镜像，不对公服务；对外服务由 Cloudflare 两个 Worker 提供）。

用法:
    python3 push_to_github.py

行为:
    - 自动跳过 .workbuddy / .git / node_modules / .wrangler
    - 跳过根目录 public/（旧 GitHub Pages 构建产物，已废弃；真正静态资源在 frontend/public/）
    - Cloudflare 凭据走本机 ~/.wrangler/config/default.toml 的 OAuth token（wrangler 自管）
"""
import os, sys, base64, json, urllib.request, subprocess

OWNER = "leo-bone"
REPO = "nexus-terminal"
ROOT = os.path.dirname(os.path.abspath(__file__))

# token: 优先环境变量 GH_TOKEN，否则用本机 gh 取 token
TOKEN = os.environ.get("GH_TOKEN")
if not TOKEN:
    try:
        TOKEN = subprocess.check_output(
            ["/Users/leo/.workbuddy/binaries/gh/bin/gh", "auth", "token"]
        ).decode().strip()
    except Exception as e:
        print("NO_TOKEN", e); sys.exit(1)

API = f"https://api.github.com/repos/{OWNER}/{REPO}"

def req(method, path, data=None):
    if path.startswith("/"):
        url = "https://api.github.com" + path
    else:
        url = API + path
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, method=method)
    r.add_header("Authorization", f"Bearer {TOKEN}")
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("User-Agent", "nexus-push")
    if body:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:400])
        raise

# 收集文件（排除系统/构建目录 与 根级 public/ 旧构建产物）
SKIP = {".DS_Store"}
files = []
for dp, dns, fns in os.walk(ROOT):
    rel_dp = os.path.relpath(dp, ROOT)
    dns[:] = [d for d in dns if d not in (".workbuddy", ".git", "node_modules", ".wrangler")]
    if rel_dp == "public":  # 仅跳过根级 public（GitHub Pages 遗留）；保留 frontend/public
        continue
    for fn in fns:
        if fn in SKIP:
            continue
        full = os.path.join(dp, fn)
        rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
        if rel.startswith(".git/"):
            continue
        files.append((rel, full))
files.sort()
print("FILES:", [f[0] for f in files])

# base commit
st, commits = req("GET", f"/repos/{OWNER}/{REPO}/commits?per_page=1")
base_commit = commits[0]["sha"]
print("BASE_COMMIT", base_commit)

# blobs
tree = []
for rel, full in files:
    with open(full, "rb") as f:
        content = f.read()
    b64 = base64.b64encode(content).decode()
    st, j = req("POST", f"/repos/{OWNER}/{REPO}/git/blobs",
                {"content": b64, "encoding": "base64"})
    mode = "100755" if rel.endswith(".sh") else "100644"
    tree.append({"path": rel, "mode": mode, "type": "blob", "sha": j["sha"]})
    print("blob", rel, j["sha"][:10])

# tree (fresh full tree, no base_tree)
st, jt = req("POST", f"/repos/{OWNER}/{REPO}/git/trees", {"tree": tree})
new_tree = jt["sha"]
print("TREE", new_tree)

# commit
st, jc = req("POST", f"/repos/{OWNER}/{REPO}/git/commits", {
    "message": (
        "Nexus Terminal v3.1.2: 数据源切 Bybit+CoinPaprika(Cloudflare边缘可达)，"
        "全部外部请求经 Worker /api/fetch 代理修复中国大陆不可达；更新 README/SKILL 文档"
    ),
    "tree": new_tree,
    "parents": [base_commit],
})
commit = jc["sha"]
print("COMMIT", commit)

# update main (force 覆盖整棵树，GitHub 仅作镜像)
st, _ = req("PATCH", f"/repos/{OWNER}/{REPO}/git/refs/heads/main",
            {"sha": commit, "force": True})
print("PUSHED ref status", st)

# verify
st, jt2 = req("GET", f"/repos/{OWNER}/{REPO}/git/trees/main?recursive=1")
got = [t["path"] for t in jt2.get("tree", [])]
print("REMOTE TREE COUNT", len(got))
for g in sorted(got):
    print("  ", g)
missing = [f[0] for f in files if f[0] not in got]
if missing:
    print("MISSING:", missing); sys.exit(2)
print("OK_ALL_FILES_PRESENT")
