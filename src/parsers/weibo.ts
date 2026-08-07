import { ParseError, type MediaItem, type ParseResult, type Parser } from './types';
import { extractRawObject, looseJsonParse, fetchText } from './http';

const NAME = '微博';

/**
 * 微博对机房 IP 的拦截:m.weibo.cn API 走 Sina Visitor 系统(403/JS 验证),
 * 但搜索引擎蜘蛛 UA 抓 detail 页可正常返回且带 $render_data。
 */
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

interface WeiboStatus {
  text_raw?: string;
  text?: string;
  user?: { screen_name?: string };
  pics?: { large?: { url?: string }; url?: string }[];
  retweeted_status?: WeiboStatus;
  page_info?: {
    type?: string;
    media_info?: {
      stream_url_hd?: string;
      stream_url?: string;
      mp4_hd_url?: string;
      mp4_sd_url?: string;
      duration?: number;
    };
    page_pic?: { url?: string };
  };
}

function statusFromRenderData(html: string): WeiboStatus | null {
  // var $render_data = [{...,"status": {...}}][0] — 整棵树含 JS 字面量时严格 parse 会崩,
  // 先取容器对象原文,再精准提取其中的 "status" 子对象做宽松解析
  const container = extractRawObject(html, 'var $render_data =');
  if (!container) return null;
  const statusRaw = extractRawObject(container, '"status":');
  if (!statusRaw) return null;
  return looseJsonParse<WeiboStatus>(statusRaw);
}

export const weiboParser: Parser = {
  id: 'weibo',
  name: NAME,

  match(url: URL): boolean {
    const h = url.hostname;
    return (
      ((h === 'weibo.com' || h === 'www.weibo.com') && /\/\d+\/[0-9A-Za-z]+/.test(url.pathname)) ||
      (h === 'm.weibo.cn' && /\/(status|detail)\//.test(url.pathname)) ||
      h === 'video.weibo.com'
    );
  },

  async parse(rawUrl: string): Promise<ParseResult> {
    const pathSeg = new URL(rawUrl).pathname.split('/').filter(Boolean);
    const id = pathSeg[pathSeg.length - 1];
    if (!id) throw new ParseError(NAME, '未识别到微博 ID');

    const { text: html } = await fetchText(`https://m.weibo.cn/detail/${encodeURIComponent(id)}`, {
      ua: UA_BOT,
      referer: 'https://m.weibo.cn/',
    });
    const status = statusFromRenderData(html);
    if (!status) throw new ParseError(NAME, '微博内容获取失败(可能已删除或触发风控)');

    const base = {
      platform: 'weibo',
      platformName: NAME,
      title: status.text_raw ?? status.text?.replace(/<[^>]+>/g, ''),
      author: status.user?.screen_name,
      sourceUrl: rawUrl,
    };

    // 转发微博:本体无媒体时取被转发那条
    const candidates = [status, ...(status.retweeted_status ? [status.retweeted_status] : [])];
    for (const st of candidates) {
      const result = statusToResult(st, base);
      if (result) return result;
    }

    throw new ParseError(NAME, '微博不包含可解析的媒体内容');
  },
};

function statusToResult(
  status: WeiboStatus,
  base: { platform: string; platformName: string; title?: string; author?: string; sourceUrl: string },
): ParseResult | null {
  // 转发场景:作者与正文用被转发那条的
  const effectiveBase = status.user?.screen_name
    ? { ...base, author: status.user.screen_name, title: status.text_raw ?? status.text?.replace(/<[^>]+>/g, '') ?? base.title }
    : base;

  const mi = status.page_info?.media_info;
  if (status.page_info?.type === 'video' && mi) {
    const videoUrl = mi.stream_url_hd || mi.stream_url || mi.mp4_hd_url || mi.mp4_sd_url;
    if (!videoUrl) return null;
    return {
      ...effectiveBase,
      type: 'video',
      media: [
        {
          type: 'video',
          url: videoUrl.replace(/^http:/, 'https:'),
          coverUrl: status.page_info?.page_pic?.url,
          duration: mi.duration,
          referer: 'https://weibo.com/',
        },
      ],
    };
  }

  if (status.pics?.length) {
    const media: MediaItem[] = [];
    for (const pic of status.pics) {
      const u = pic.large?.url ?? pic.url;
      // sinaimg 强制 Referer 防盗链
      if (u) media.push({ type: 'image', url: u.replace(/^http:/, 'https:'), referer: 'https://weibo.com/' });
    }
    if (media.length) return { ...effectiveBase, type: 'images', media };
  }

  return null;
}
