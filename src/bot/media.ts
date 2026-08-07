import type { MediaItem } from '../parsers/types';
import { UA_DESKTOP } from '../parsers/http';

/** relay 中转大小上限:Bot API 上传 50MB */
export const MAX_RELAY_SIZE = 50 * 1000 * 1000;

/** 这些 CDN 封锁 Cloudflare IP,需经中继出口 */
const CF_BLOCKED_HOSTS = ['weibocdn', 'sinaimg'];

export function isCfBlockedHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return CF_BLOCKED_HOSTS.some((d) => h.includes(d));
  } catch {
    return false;
  }
}

export interface RelayConfig {
  url?: string;
  token?: string;
}

/** 经中继包装 URL(中继协议:{base} + encodeURIComponent(target)) */
export function viaRelay(url: string, relay: RelayConfig): string {
  return relay.url ? relay.url + encodeURIComponent(url) : url;
}

export class MediaTooBigError extends Error {
  constructor(public size?: number) {
    super('媒体超过 50MB 限制');
    this.name = 'MediaTooBigError';
  }
}

export interface DownloadedMedia {
  data: ArrayBuffer;
  contentType: string;
}

/**
 * 下载媒体到内存(带 UA/Referer),超过 50MB 抛 MediaTooBigError。
 * CF 被封的 CDN(微博图床/视频)自动经中继出口下载。
 */
export async function downloadMedia(item: Pick<MediaItem, 'url' | 'referer'>, relay: RelayConfig = {}): Promise<DownloadedMedia> {
  const headers: Record<string, string> = { 'User-Agent': UA_DESKTOP };

  let url = item.url;
  if (isCfBlockedHost(url) && relay.url) {
    url = viaRelay(url, relay);
    if (relay.token) headers['x-proxy-token'] = relay.token;
  }
  if (item.referer) headers['Referer'] = item.referer;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`下载失败(HTTP ${res.status})`);

  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_RELAY_SIZE) throw new MediaTooBigError(len);

  const data = await res.arrayBuffer();
  if (data.byteLength > MAX_RELAY_SIZE) throw new MediaTooBigError(data.byteLength);
  if (data.byteLength === 0) throw new Error('下载内容为空');

  return { data, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
