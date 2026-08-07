export interface Env {
  /** Telegram Bot Token(@BotFather 申请) */
  BOT_TOKEN: string;
  /** webhook 校验密钥,注册 webhook 与 /setup 共用 */
  WEBHOOK_SECRET: string;
  /** 可选:Instagram 登录 cookie(浏览器 F12 复制整串),配置后可解析 IG 视频/图集 */
  INSTAGRAM_COOKIE?: string;
  /** 可选:B站 API 中继地址(bili-resolver vercel-proxy 格式),例:https://xxx.vercel.app/api/proxy?url= */
  BILI_API_RELAY?: string;
  /** 可选:中继鉴权 token */
  BILI_RELAY_TOKEN?: string;
}
