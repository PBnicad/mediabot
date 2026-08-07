export interface Env {
  /** Telegram Bot Token(@BotFather 申请) */
  BOT_TOKEN: string;
  /** webhook 校验密钥,注册 webhook 与 /setup 共用 */
  WEBHOOK_SECRET: string;
  /** 可选:Instagram 登录 cookie(浏览器 F12 复制整串),配置后可解析 IG 视频/图集 */
  INSTAGRAM_COOKIE?: string;
  /** 可选:媒体/API 中继地址(vercel-proxy 协议),例:https://xxx.vercel.app/api/proxy?url= */
  MEDIA_RELAY_URL?: string;
  /** 可选:中继鉴权 token */
  MEDIA_RELAY_TOKEN?: string;
  /** 可选:自建 /proxy 的对外独立域名(如 https://proxy.example.com);缺省用请求来源域名(workers.dev) */
  PROXY_ORIGIN?: string;
}
