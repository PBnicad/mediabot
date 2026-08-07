import { ParseError, type MediaItem, type ParseResult, type Parser } from './types';
import { UA_MOBILE, expandUrl, extractInlineJson, fetchText } from './http';

const NAME = '抖音';
const REFERER = 'https://www.douyin.com/';

/** _ROUTER_DATA 中 item 的宽松结构 */
interface AwemeItem {
  desc?: string;
  author?: { nickname?: string };
  images?: { url_list?: string[] }[] | null;
  video?: {
    play_addr?: { url_list?: string[] };
    cover?: { url_list?: string[] };
    duration?: number;
  };
}

function pickAwemeItem(routerData: unknown): AwemeItem | null {
  const loaderData = (routerData as { loaderData?: Record<string, unknown> }).loaderData;
  if (!loaderData) return null;
  for (const key of Object.keys(loaderData)) {
    if (!key.includes('/page')) continue;
    const page = loaderData[key] as { videoInfoRes?: { item_list?: AwemeItem[] } };
    const item = page?.videoInfoRes?.item_list?.[0];
    if (item) return item;
  }
  return null;
}

export const douyinParser: Parser = {
  id: 'douyin',
  name: NAME,

  match(url: URL): boolean {
    const h = url.hostname;
    return (
      h === 'v.douyin.com' ||
      h === 'www.douyin.com' ||
      h === 'douyin.com' ||
      h === 'www.iesdouyin.com' ||
      h === 'haohuo.jinritemai.com'
    );
  },

  async parse(rawUrl: string): Promise<ParseResult> {
    // 1. 展开短链,拿到落地页与 ttwid cookie。
    //    注意:www.douyin.com 详情页对机房 IP 有 JS 挑战(__ac_nonce),
    //    而 iesdouyin.com 分享页带 _ROUTER_DATA 且风控宽松,必须移动 UA 抓分享页。
    const { finalUrl, cookie } = await expandUrl(rawUrl, { ua: UA_MOBILE });
    const pageUrl = finalUrl || rawUrl;
    if (!/douyin\.com\/(video|note|share\/(video|note))\//.test(pageUrl) && !/iesdouyin\.com/.test(pageUrl)) {
      throw new ParseError(NAME, '未识别到有效的作品链接');
    }

    // 2. 抓取落地页,提取 _ROUTER_DATA;失败时带上新 cookie 重试一次
    let { text: html, cookie: pageCookie } = await fetchText(pageUrl, { ua: UA_MOBILE, cookie, referer: REFERER });
    let routerData = extractInlineJson(html, 'window._ROUTER_DATA =');
    if (!routerData) {
      const retry = await fetchText(pageUrl, { ua: UA_MOBILE, cookie: pageCookie || cookie, referer: REFERER });
      html = retry.text;
      routerData = extractInlineJson(html, 'window._ROUTER_DATA =');
    }
    if (!routerData) throw new ParseError(NAME, '页面数据提取失败(触发了平台风控或已改版)');

    const item = pickAwemeItem(routerData);
    if (!item) throw new ParseError(NAME, '未找到作品内容(可能已删除或需要登录)');

    const base = {
      platform: 'douyin',
      platformName: NAME,
      title: item.desc,
      author: item.author?.nickname,
      sourceUrl: rawUrl,
    };

    // 图集
    if (item.images?.length) {
      const media: MediaItem[] = [];
      for (const img of item.images) {
        const u = img.url_list?.[0];
        if (u) media.push({ type: 'image', url: u.replace(/^http:/, 'https:') });
      }
      if (!media.length) throw new ParseError(NAME, '图集图片提取失败');
      return { ...base, type: 'images', media };
    }

    // 视频
    const playUrls = item.video?.play_addr?.url_list ?? [];
    // playwm → play: 无水印地址
    const videoUrl = playUrls.map((u) => u.replace('playwm', 'play')).find((u) => u.includes('/play/')) ?? playUrls[0];
    if (!videoUrl) throw new ParseError(NAME, '视频地址提取失败');
    return {
      ...base,
      type: 'video',
      media: [
        {
          type: 'video',
          url: videoUrl.replace(/^http:/, 'https:'),
          coverUrl: item.video?.cover?.url_list?.[0],
          duration: item.video?.duration ? Math.round(item.video.duration / 1000) : undefined,
          referer: REFERER,
        },
      ],
    };
  },
};
