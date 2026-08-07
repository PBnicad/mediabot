import { ParseError, type MediaItem, type ParseResult, type Parser } from './types';
import { UA_DESKTOP, expandUrl, extractScriptJson, fetchText } from './http';

const NAME = 'TikTok';
const REFERER = 'https://www.tiktok.com/';

interface TikTokItem {
  desc?: string;
  author?: { nickname?: string; uniqueId?: string };
  video?: {
    playAddr?: string;
    cover?: string;
    duration?: number;
  };
  imagePost?: {
    images?: { imageURL?: { urlList?: string[] } }[];
  };
}

function pickItem(data: unknown): TikTokItem | null {
  const scope = (data as Record<string, Record<string, unknown>>)['__DEFAULT_SCOPE__'];
  const detail = scope?.['webapp.video-detail'] as { itemInfo?: { itemStruct?: TikTokItem } } | undefined;
  return detail?.itemInfo?.itemStruct ?? null;
}

export const tiktokParser: Parser = {
  id: 'tiktok',
  name: NAME,

  match(url: URL): boolean {
    const h = url.hostname;
    return (
      h === 'www.tiktok.com' ||
      h === 'tiktok.com' ||
      h === 'vt.tiktok.com' ||
      h === 'vm.tiktok.com' ||
      h === 'm.tiktok.com'
    );
  },

  async parse(rawUrl: string): Promise<ParseResult> {
    const { finalUrl } = await expandUrl(rawUrl, { ua: UA_DESKTOP });
    const pageUrl = finalUrl || rawUrl;
    if (!/tiktok\.com\/@[^/]+\/(video|photo)\/\d+/.test(pageUrl)) {
      throw new ParseError(NAME, '未识别到有效的作品链接');
    }

    const { text: html } = await fetchText(pageUrl, { ua: UA_DESKTOP, referer: REFERER });
    const data = extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!data) throw new ParseError(NAME, '页面数据提取失败(平台可能已改版)');

    const item = pickItem(data);
    if (!item) throw new ParseError(NAME, '未找到作品内容(可能已删除或地区受限)');

    const base = {
      platform: 'tiktok',
      platformName: NAME,
      title: item.desc,
      author: item.author?.nickname ?? item.author?.uniqueId,
      sourceUrl: rawUrl,
    };

    if (item.imagePost?.images?.length) {
      const media: MediaItem[] = [];
      for (const img of item.imagePost.images) {
        const u = img.imageURL?.urlList?.[0];
        if (u) media.push({ type: 'image', url: u });
      }
      if (!media.length) throw new ParseError(NAME, '图集图片提取失败');
      return { ...base, type: 'images', media };
    }

    if (item.video?.playAddr) {
      return {
        ...base,
        type: 'video',
        media: [
          {
            type: 'video',
            url: item.video.playAddr,
            coverUrl: item.video.cover,
            duration: item.video.duration,
            referer: REFERER,
          },
        ],
      };
    }

    throw new ParseError(NAME, '未找到可解析的媒体内容');
  },
};
