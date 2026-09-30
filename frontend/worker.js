// Nexus Terminal v3 — 前端静态资源 Worker
// 使用 Cloudflare Workers Assets 直接托管 public/ 下的静态文件，
// 无需后端、无需构建。所有请求回退到 ASSETS 绑定（含 index.html 默认页）。
export default {
  async fetch(request, env) {
    // 直接由 Workers Assets 提供服务（自动处理 / -> index.html、MIME、缓存）
    return env.ASSETS.fetch(request);
  },
};
