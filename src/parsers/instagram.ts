import { ParseError, type MediaItem, type ParseResult, type Parser, type ParserEnv } from './types';
import { UA_DESKTOP, UA_MOBILE, fetchJson } from './http';

const NAME = 'Instagram';
const APP_ID = '936619743392459'; // Instagram Web 公开 App ID

/**
 * Instagram 双模式:
 * - 免登录:oEmbed 端点拿文案/作者/封面,仅发封面图(官方无鉴权路径已全部关闭)
 * - 配置 INSTAGRAM_COOKIE:走移动端 media info API,完整支持视频/图集
 */

interface OEmbed {
  title?: string;
  author_name?: string;
  media_id?: string;
  thumbnail_url?: string;
}

interface IgCandidate {
  url?: string;
  width?: number;
  height?: number;
}

interface IgMedia {
  media_type?: number; // 1=image 2=video
  video_duration?: number;
  video_versions?: IgCandidate[];
  image_versions2?: { candidates?: IgCandidate[] };
  carousel_media?: IgMedia[];
}

function pickBest(candidates: IgCandidate[] | undefined): IgCandidate | undefined {
  if (!candidates?.length) return undefined;
  return [...candidates].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
}

function mediaToVideo(item: IgMedia, base: Omit<ParseResult, 'type' | 'media'>): ParseResult | null {
  const best = pickBest(item.video_versions);
  if (!best?.url) return null;
  return {
    ...base,
    type: 'video',
    media: [
      {
        type: 'video',
        url: best.url,
        coverUrl: pickBest(item.image_versions2?.candidates)?.url,
        duration: item.video_duration ? Math.round(item.video_duration) : undefined,
        width: best.width,
        height: best.height,
      },
    ],
  };
}

function mediaToImage(item: IgMedia, base: Omit<ParseResult, 'type' | 'media'>): ParseResult | null {
  const best = pickBest(item.image_versions2?.candidates);
  if (!best?.url) return null;
  return { ...base, type: 'images', media: [{ type: 'image', url: best.url }] };
}

export const instagramParser: Parser = {
  id: 'instagram',
  name: NAME,

  match(url: URL): boolean {
    const h = url.hostname;
    return (h === 'www.instagram.com' || h === 'instagram.com') && /\/(p|reel|reels|tv)\/[\w-]+/.test(url.pathname);
  },

  async parse(rawUrl: string, env: ParserEnv): Promise<ParseResult> {
    const shortcode = new URL(rawUrl).pathname.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/)?.[1];
    if (!shortcode) throw new ParseError(NAME, '未识别到帖子 ID');

    // 1. oEmbed(免登录):标题/作者/封面/media_id
    let oe: OEmbed;
    try {
      oe = await fetchJson<OEmbed>(
        `https://www.instagram.com/api/v1/oembed/?url=${encodeURIComponent(`https://www.instagram.com/p/${shortcode}/`)}`,
        { ua: UA_DESKTOP },
      );
    } catch (e) {
      throw new ParseError(NAME, `帖子获取失败(${e instanceof Error ? e.message : '网络错误'},帖子可能已删除或地区受限)`);
    }

    const base = {
      platform: 'instagram',
      platformName: NAME,
      title: oe.title,
      author: oe.author_name,
      sourceUrl: rawUrl,
    };

    const cookie = env.INSTAGRAM_COOKIE?.trim();

    // 免登录降级:仅封面图
    if (!cookie) {
      if (!oe.thumbnail_url) throw new ParseError(NAME, '帖子不含可用媒体');
      return { ...base, type: 'images', media: [{ type: 'image', url: oe.thumbnail_url }] };
    }

    // 2. 带 cookie:移动端 API 取完整媒体
    const mid = oe.media_id?.split('_')[0];
    if (!mid) throw new ParseError(NAME, 'media_id 获取失败');

    let info: { items?: IgMedia[] };
    try {
      info = await fetchJson<{ items?: IgMedia[] }>(`https://i.instagram.com/api/v1/media/${mid}/info/`, {
        ua: UA_MOBILE,
        headers: { 'X-IG-App-ID': APP_ID, Cookie: cookie },
      });
    } catch (e) {
      throw new ParseError(NAME, `媒体信息获取失败(${e instanceof Error ? e.message : '网络错误'},cookie 可能已失效)`);
    }
    const item = info.items?.[0];
    if (!item) throw new ParseError(NAME, '媒体信息为空(cookie 可能已失效)');

    // 图集:优先视频(Telegram mediaGroup 混合类型处理复杂,v1 取首个视频)
    if (item.carousel_media?.length) {
      for (const node of item.carousel_media) {
        if (node.media_type === 2) {
          const r = mediaToVideo(node, base);
          if (r) return r;
        }
      }
      const images: MediaItem[] = [];
      for (const node of item.carousel_media) {
        const best = pickBest(node.image_versions2?.candidates);
        if (best?.url) images.push({ type: 'image', url: best.url });
      }
      if (images.length) return { ...base, type: 'images', media: images };
      throw new ParseError(NAME, '图集媒体提取失败');
    }

    if (item.media_type === 2) {
      const r = mediaToVideo(item, base);
      if (r) return r;
      throw new ParseError(NAME, '视频地址提取失败');
    }
    const r = mediaToImage(item, base);
    if (r) return r;
    throw new ParseError(NAME, '帖子不包含可解析的媒体内容');
  },
};
