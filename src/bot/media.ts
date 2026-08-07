import type { MediaItem } from '../parsers/types';
import { UA_DESKTOP } from '../parsers/http';

/** relay 中转大小上限:Bot API 上传 50MB */
export const MAX_RELAY_SIZE = 50 * 1000 * 1000;

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

/** 下载媒体到内存(带 UA/Referer),超过 50MB 抛 MediaTooBigError */
export async function downloadMedia(item: Pick<MediaItem, 'url' | 'referer'>): Promise<DownloadedMedia> {
  const headers: Record<string, string> = { 'User-Agent': UA_DESKTOP };
  if (item.referer) headers['Referer'] = item.referer;

  const res = await fetch(item.url, { headers });
  if (!res.ok) throw new Error(`下载失败(HTTP ${res.status})`);

  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_RELAY_SIZE) throw new MediaTooBigError(len);

  const data = await res.arrayBuffer();
  if (data.byteLength > MAX_RELAY_SIZE) throw new MediaTooBigError(data.byteLength);
  if (data.byteLength === 0) throw new Error('下载内容为空');

  return { data, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
