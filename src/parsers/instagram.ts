import { ParseError, type MediaItem, type ParseResult, type Parser, type ParserEnv } from './types';
import { UA_DESKTOP, UA_MOBILE, fetchJson } from './http';
import { cleanShareUrl } from './clean';
import { getCookie, mergeSetCookies } from '../cookiejar';

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
      sourceUrl: cleanShareUrl(rawUrl),
    };

    // cookie 罐优先(KV 滚动续期),env 静态 secret 仅首次兜底灌入
    const cookie = await getCookie(env.COOKIE_JAR, 'instagram', env.INSTAGRAM_COOKIE);

    // 免登录降级:仅封面图
    if (!cookie) {
      if (!oe.thumbnail_url) throw new ParseError(NAME, '帖子不含可用媒体');
      return { ...base, type: 'images', media: [{ type: 'image', url: oe.thumbnail_url }] };
    }

    // 2. 带 cookie:移动端 API 取完整媒体
    const mid = oe.media_id?.split('_')[0];
    if (!mid) throw new ParseError(NAME, 'media_id 获取失败');

    let info: { items?: IgMedia[] };
    let setCookies: string[] = [];
    try {
      // 不用 fetchJson:需要响应头里的 Set-Cookie 合并回 cookie 罐(滚动续期)
      const res = await fetch(`https://i.instagram.com/api/v1/media/${mid}/info/`, {
        headers: { 'User-Agent': UA_MOBILE, Accept: 'application/json', 'X-IG-App-ID': APP_ID, Cookie: cookie },
      });
      setCookies = res.headers.getSetCookie();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = (await res.json()) as { items?: IgMedia[] };
    } catch (e) {
      throw new ParseError(NAME, `媒体信息获取失败(${e instanceof Error ? e.message : '网络错误'},cookie 可能已失效)`);
    }
    await mergeSetCookies(env.COOKIE_JAR, 'instagram', setCookies);
    const item = info.items?.[0];
    if (!item) throw new ParseError(NAME, '媒体信息为空(cookie 可能已失效)');

    // 图集:视频+图片全量提取;混合走 mixed(混合相册),纯视频取首个,纯图片全量
    if (item.carousel_media?.length) {
      const media: MediaItem[] = [];
      for (const node of item.carousel_media) {
        if (node.media_type === 2) {
          const best = pickBest(node.video_versions);
          if (best?.url) {
            media.push({
              type: 'video',
              url: best.url,
              coverUrl: pickBest(node.image_versions2?.candidates)?.url,
              duration: node.video_duration ? Math.round(node.video_duration) : undefined,
              width: best.width,
              height: best.height,
            });
          }
        } else {
          const best = pickBest(node.image_versions2?.candidates);
          if (best?.url) media.push({ type: 'image', url: best.url });
        }
      }
      const videos = media.filter((m) => m.type === 'video');
      if (videos.length && media.length > videos.length) return { ...base, type: 'mixed', media };
      if (videos.length) return { ...base, type: 'video', media: [videos[0]] };
      if (media.length) return { ...base, type: 'images', media };
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
