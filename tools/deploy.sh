#!/usr/bin/env bash
# Nexus Terminal 一键部署编排（v3.38）
# 前置：1) 已 `wrangler login`（或设置 CF_API_TOKEN 环境变量）；2) node 可用
# 用法：bash tools/deploy.sh
# 说明：本脚本只负责"把本地已验证的代码推上 Cloudflare"，不做任何代码改动。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 选 wrangler：优先 PATH，其次本机托管路径（WorkBuddy 管理的 node workspace）
if command -v wrangler >/dev/null 2>&1; then WR="wrangler"
elif [ -x "$HOME/.workbuddy/binaries/node/workspace/node_modules/.bin/wrangler" ]; then WR="$HOME/.workbuddy/binaries/node/workspace/node_modules/.bin/wrangler"
else echo "❌ 未找到 wrangler，请先安装：npm i -g wrangler（或 npx wrangler）"; exit 1; fi
echo "==> 使用 wrangler: $WR ($("$WR" --version 2>/dev/null | head -1))"

echo "==> 校验 Cloudflare 登录"
if ! "$WR" whoami >/dev/null 2>&1; then
  echo "❌ 请先登录 Cloudflare：wrangler login （或在环境变量设置 CF_API_TOKEN）"; exit 1
fi

echo "==> 创建/绑定 KV namespace：NEXUS_KV（离线告警 + FRED 缓存存储）"
if grep -q 'NEXUS_KV' worker/wrangler.toml && ! grep -q '在此填入' worker/wrangler.toml; then
  echo "    worker/wrangler.toml 已含 NEXUS_KV id，跳过创建"
else
  # wrangler v4：--json 已移除；改用 --binding + --update-config 自动写回配置
  ( cd worker && "$WR" kv namespace create NEXUS_KV --binding NEXUS_KV --update-config ) 2>&1 | grep -vE "Warning|macOS|DevContainer|Workers runtime|Consider|⚠️|wrangler 4|────|Getting|Logs were" || true
  if ! grep -q 'kv_namespaces' worker/wrangler.toml; then
    echo "⚠️  自动写回失败。请手动在 worker/wrangler.toml 加："
    echo '   kv_namespaces = [ { binding = "NEXUS_KV", id = "你的_id" } ]'
  fi
fi

echo "==> 部署数据 Worker：nexus-proxy"
( cd worker && "$WR" deploy )

echo "==> 部署前端 Worker：nexus-frontend（Workers Assets 托管 ./public）"
( cd frontend && "$WR" deploy )

echo "==> 可选：配置群机器人 Webhook 外部推送（不填则保持纯本地提醒方案）"
ANS=""
if [ -t 0 ]; then
  read -r -p "是否配置 NOTIFY_WEBHOOK？(y/N) " ANS || ANS=""
else
  echo "    非交互模式，跳过 Webhook 配置（默认保持纯本地提醒方案）"
fi
if [ "$ANS" = "y" ] || [ "$ANS" = "Y" ]; then
  ( cd worker && "$WR" secret put NOTIFY_WEBHOOK )
  ( cd worker && "$WR" secret put NOTIFY_TOKEN )
fi

echo "==> 验证健康检查"
curl -sS https://nexus-api.uichain.org/health || echo "⚠️  health 检查失败（请确认 nexus-api.uichain.org 已解析到 Cloudflare）"
echo

echo "✅ 部署完成。"
echo "   前端：https://nexus.uichain.org"
echo "   数据：https://nexus-api.uichain.org"
echo "   部署后：scheduled 每 30 分钟跑宏观+crypto 双哨兵，页面关闭期间也能记录 RED（重开页面 + 开启 ☁️云同步 即回收）。"
