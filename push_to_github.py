#!/usr/bin/env python3
"""
Nexus Terminal — 源码推送脚本（GitHub REST API / git-database）
本机 git 因 xcrun 损坏不可用，故用 REST API 整体刷新 main 分支（force 覆盖整棵树，
GitHub 仅作源码镜像，不对公服务；对外服务由 Cloudflare 两个 Worker 提供）。

用法:
    python3 push_to_github.py

行为:
    - 自动跳过 .workbuddy / .git / node_modules / .wrangler / archive
    - archive/ 存放历史产物（旧 GitHub Pages 构建页、版本截图），不进镜像
      —— 它里面的 wrangler.toml 指向生产数据域名 nexus-api.uichain.org，
         误入 deploy 会威胁线上，留在镜像里也是纯风险
    - Cloudflare 凭据走本机 ~/.wrangler/config/default.toml 的 OAuth token（wrangler 自管）
"""
import os, sys, re, base64, json, urllib.request, subprocess

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
            raw = resp.read().decode()
            # GitHub 对 204/空体返回无 JSON；直接 j.loads 会抛异常并被误当成推送失败
            try:
                return resp.status, (json.loads(raw) if raw.strip() else {})
            except json.JSONDecodeError:
                return resp.status, {}
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:400])
        raise

# 收集文件（排除系统/构建目录 与 archive/ 历史产物）
SKIP = {".DS_Store"}
files = []
for dp, dns, fns in os.walk(ROOT):
    rel_dp = os.path.relpath(dp, ROOT)
    dns[:] = [d for d in dns if d not in (".workbuddy", ".git", "node_modules", ".wrangler", "archive", "__pycache__")]
    for fn in fns:
        if fn in SKIP:
            continue
        # 排除 Python 字节码/缓存（py_compile 等产生，纯属构建残留）
        if fn.endswith((".pyc", ".pyo")):
            continue
        full = os.path.join(dp, fn)
        rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
        if rel.startswith(".git/") or rel.startswith("__pycache__/"):
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
local_sha = {}   # rel -> 本地 git blob sha（用于末尾按**内容**校验，而非只比文件名）
for rel, full in files:
    with open(full, "rb") as f:
        content = f.read()
    b64 = base64.b64encode(content).decode()
    st, j = req("POST", f"/repos/{OWNER}/{REPO}/git/blobs",
                {"content": b64, "encoding": "base64"})
    mode = "100755" if rel.endswith(".sh") else "100644"
    tree.append({"path": rel, "mode": mode, "type": "blob", "sha": j["sha"]})
    local_sha[rel] = j["sha"]
    print("blob", rel, j["sha"][:10])

# tree (fresh full tree, no base_tree)
st, jt = req("POST", f"/repos/{OWNER}/{REPO}/git/trees", {"tree": tree})
new_tree = jt["sha"]
print("TREE", new_tree)

# commit message：版本号 + 最新变更要点，全部从 README 自动读取，避免提交信息过期
VERSION = "Nexus Terminal"
DETAIL = ""
try:
    with open(os.path.join(ROOT, "README.md"), encoding="utf-8") as fh:
        _txt = fh.read()
    _first = _txt.splitlines()[0].strip()
    if _first.startswith("# "):
        VERSION = _first[2:].strip()
    # 取最靠前的「## vX.Y 变更」章节里的第一条要点
    _m = re.search(r"^##\s+v[\d.]+\s*变更[^\n]*\n(.*?)(?=^##\s|\Z)", _txt, re.S | re.M)
    if _m:
        for _l in _m.group(1).splitlines():
            _l = _l.strip()
            if not _l:
                continue
            if _l[0].isdigit() or _l[0] in "*-" or _l.startswith("**"):
                DETAIL = re.sub(r"^\d+[.)]\s*", "", re.sub(r"[*`]", "", _l))
                break
except Exception:
    pass
if len(DETAIL) > 180:
    DETAIL = DETAIL[:180].rstrip() + "…"
MSG = sys.argv[1] if len(sys.argv) > 1 else (VERSION + ("：" + DETAIL if DETAIL else ""))
st, jc = req("POST", f"/repos/{OWNER}/{REPO}/git/commits", {
    "message": MSG,
    "tree": new_tree,
    "parents": [base_commit],
})
commit = jc["sha"]
print("COMMIT", commit)

# update main (force 覆盖整棵树，GitHub 仅作镜像)
# 注意：PATCH 偶尔会「返回 200 但 ref 实际没动」，故必须回读 ref 确认，失败则重试。
moved = False
for attempt in range(1, 4):
    st, _ = req("PATCH", f"/repos/{OWNER}/{REPO}/git/refs/heads/main",
                {"sha": commit, "force": True})
    st2, jref = req("GET", f"/repos/{OWNER}/{REPO}/git/refs/heads/main")
    now = (jref.get("object") or {}).get("sha")
    print(f"PUSH attempt {attempt}: http={st} ref_now={now[:12] if now else None}")
    if now == commit:
        moved = True
        break
if not moved:
    print("FAIL_REF_NOT_MOVED: main 仍指向", now, "期望", commit)
    sys.exit(3)
print("REF_OK main ->", commit)

# verify：① ref 指向新 commit ② 每个文件的 **blob sha**（内容）与本地一致
# 旧版只比「文件名是否存在」——路径不变就恒为真，PATCH 失败也会误报 OK_ALL_FILES_PRESENT。
st, jc2 = req("GET", f"/repos/{OWNER}/{REPO}/git/commits/{commit}")
if jc2.get("tree", {}).get("sha") != new_tree:
    print("FAIL_TREE_MISMATCH:", jc2.get("tree", {}).get("sha"), "!=", new_tree)
    sys.exit(4)
st, jt2 = req("GET", f"/repos/{OWNER}/{REPO}/git/trees/{commit}?recursive=1")
got = {t["path"]: t["sha"] for t in jt2.get("tree", [])}
print("REMOTE FILE COUNT", len(got))
missing = [f[0] for f in files if f[0] not in got]
if missing:
    print("FAIL_MISSING:", missing); sys.exit(2)
diff = [p for p, sha in local_sha.items() if got.get(p) != sha]
if diff:
    print("FAIL_CONTENT_MISMATCH（远端内容与本地不一致）:", diff); sys.exit(5)
print("OK_ALL_FILES_PRESENT_AND_CONTENT_VERIFIED", len(local_sha), "files")
