/** 解析出的单个媒体项 */
export interface MediaItem {
  type: 'video' | 'image';
  /** 直链 URL(可能是本站代理 URL,供 Telegram 直抓) */
  url: string;
  /** relay 中转下载用的原始 URL(与 url 不同时设置,如 B站 upos 直链) */
  rawUrl?: string;
  /** 视频封面图 URL */
  coverUrl?: string;
  width?: number;
  height?: number;
  /** 视频时长(秒) */
  duration?: number;
  /** 文件大小(字节,解析端已知时带上,用于提前判断超限) */
  size?: number;
  /** 下载/引用该 URL 时必须携带的 Referer(防盗链) */
  referer?: string;
}

export type ResultType = 'video' | 'images' | 'article' | 'text';

export interface ParseResult {
  /** 平台 ID,如 douyin / bilibili */
  platform: string;
  /** 平台显示名,如 抖音 */
  platformName: string;
  type: ResultType;
  title?: string;
  author?: string;
  /** 原始链接(用于 caption) */
  sourceUrl: string;
  /** video 类型取第一个;images 类型为图集;article 类型为空 */
  media: MediaItem[];
  /** article 类型的 telegraph 页面链接 */
  articleUrl?: string;
  /** article 封面图 */
  coverUrl?: string;
  /** article 内容摘要 */
  summary?: string;
  /** article 发布日期(YYYY-MM-DD) */
  publishTime?: string;
  /** article 预计阅读分钟数 */
  readingMinutes?: number;
}

/** 解析器可用的环境配置(与 Env 结构兼容) */
export interface ParserEnv {
  INSTAGRAM_COOKIE?: string;
  /** 媒体/API 中继(bili-resolver vercel-proxy 格式:base + encodeURIComponent(url)),用于 CF 被封的平台(B站 API、微博 CDN) */
  MEDIA_RELAY_URL?: string;
  /** 中继鉴权 token(x-proxy-token 头) */
  MEDIA_RELAY_TOKEN?: string;
  /** 自建 /proxy 的对外独立域名(图床反代优先走自建,缺省回退 qpic.cn.in) */
  PROXY_ORIGIN?: string;
}

export interface Parser {
  id: string;
  name: string;
  /** 判断是否支持该 URL(已展开短链后的最终 URL 与原始 URL 都会传入尝试) */
  match(url: URL): boolean;
  parse(url: string, env: ParserEnv): Promise<ParseResult>;
}

export class ParseError extends Error {
  constructor(
    public platformName: string,
    message: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}
