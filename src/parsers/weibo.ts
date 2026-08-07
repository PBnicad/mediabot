import { ParseError, type MediaItem, type ParseResult, type Parser, type ParserEnv } from './types';
import { extractRawObject, looseJsonParse, fetchJson, fetchText, UA_MOBILE } from './http';
import { cleanShareUrl } from './clean';

const NAME = '微博';

/**
 * 微博对机房 IP 的拦截:m.weibo.cn API 走 Sina Visitor 系统(403/JS 验证),
 * 但搜索引擎蜘蛛 UA 抓 detail 页可正常返回且带 $render_data;
 * detail 页不认纯数字 mid 时,退回 statuses/show API(经中继出口)。
 */
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** statuses/show JSON API 经媒体中继取数(detail 页失败时的备用路径) */
async function viaStatusApi(id: string, env: ParserEnv): Promise<WeiboStatus | null> {
  const relayBase = env.MEDIA_RELAY_URL?.trim();
  if (!relayBase) return null;
  try {
    const headers: Record<string, string> = {
      'User-Agent': UA_MOBILE,
      Referer: 'https://m.weibo.cn/',
    };
    if (env.MEDIA_RELAY_TOKEN) headers['x-proxy-token'] = env.MEDIA_RELAY_TOKEN;
    const res = await fetch(relayBase + encodeURIComponent(`https://m.weibo.cn/statuses/show?id=${encodeURIComponent(id)}`), { headers });
    const json = (await res.json()) as { ok?: number; data?: WeiboStatus };
    return json.ok === 1 && json.data ? json.data : null;
  } catch {
    return null;
  }
}

interface PlayInfoResponse {
  code?: string;
  data?: {
    Component_Play_Playinfo?: {
      title?: string;
      text?: string;
      nickname?: string;
      author?: string;
      urls?: Record<string, string>;
      stream_url?: string;
      cover_image?: string;
      display_duration?: string;
    };
  };
}

/** "03:21" → 秒 */
function parseDuration(s?: string): number | undefined {
  if (!s) return undefined;
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return undefined;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/** video.weibo.com/show?fid= 视频页:H5 playinfo 组件 API(CF 直连可行) */
async function viaPlayInfo(fid: string, rawUrl: string): Promise<ParseResult> {
  const data = encodeURIComponent(JSON.stringify({ Component_Play_Playinfo: { oid: fid } }));
  const api = `https://h5.video.weibo.com/api/component?page=${encodeURIComponent(`/show/${fid}`)}&data=${data}`;

  let json: PlayInfoResponse;
  try {
    json = await fetchJson<PlayInfoResponse>(api, {
      ua: UA_MOBILE,
      referer: `https://h5.video.weibo.com/show/${fid}`,
    });
  } catch (e) {
    throw new ParseError(NAME, `视频信息获取失败(${e instanceof Error ? e.message : '网络错误'})`);
  }
  const info = json.data?.Component_Play_Playinfo;
  if (json.code !== '100000' || !info) throw new ParseError(NAME, '视频信息获取失败(可能已删除或受限)');

  // 多清晰度里选最高(键名含 1080P/720P 等)
  const entries = Object.entries(info.urls ?? {});
  entries.sort((a, b) => Number(b[0].match(/\d+/)?.[0] ?? 0) - Number(a[0].match(/\d+/)?.[0] ?? 0));
  let videoUrl = entries[0]?.[1] ?? info.stream_url;
  if (!videoUrl) throw new ParseError(NAME, '视频地址提取失败');
  if (videoUrl.startsWith('//')) videoUrl = `https:${videoUrl}`;

  const rawTitle = info.text ?? info.title;

  return {
    platform: 'weibo',
    platformName: NAME,
    type: 'video',
    title: rawTitle?.replace(/<[^>]+>/g, '').trim(),
    author: info.nickname ?? info.author,
    sourceUrl: cleanShareUrl(rawUrl),
    media: [
      {
        type: 'video',
        url: videoUrl.replace(/^http:/, 'https:'),
        coverUrl: info.cover_image ? info.cover_image.replace(/^\/\//, 'https://') : undefined,
        duration: parseDuration(info.display_duration),
        referer: 'https://weibo.com/',
      },
    ],
  };
}

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

  async parse(rawUrl: string, env: ParserEnv): Promise<ParseResult> {
    const u = new URL(rawUrl);

    // video.weibo.com/show?fid= 视频页:走 H5 playinfo 组件 API
    if (u.hostname === 'video.weibo.com') {
      const fid = u.searchParams.get('fid');
      if (!fid) throw new ParseError(NAME, '未识别到视频 fid');
      return viaPlayInfo(fid, rawUrl);
    }

    const pathSeg = u.pathname.split('/').filter(Boolean);
    const id = pathSeg[pathSeg.length - 1];
    if (!id || !/^[\w]+$/.test(id)) throw new ParseError(NAME, '未识别到微博 ID');

    // 主路径:googlebot UA 抓 detail 页(CF 直连可行)
    const { text: html } = await fetchText(`https://m.weibo.cn/detail/${encodeURIComponent(id)}`, {
      ua: UA_BOT,
      referer: 'https://m.weibo.cn/',
    });
    let status = statusFromRenderData(html);

    // 备用路径:statuses/show JSON API 经中继(detail 页出错/被拦时,如纯数字 mid)
    if (!status) status = await viaStatusApi(id, env);

    if (!status) throw new ParseError(NAME, '微博内容获取失败(可能已删除或触发风控)');

    const base = {
      platform: 'weibo',
      platformName: NAME,
      title: status.text_raw ?? status.text?.replace(/<[^>]+>/g, ''),
      author: status.user?.screen_name,
      sourceUrl: cleanShareUrl(rawUrl),
    };

    // 转发微博:本体无媒体时取被转发那条
    const candidates = [status, ...(status.retweeted_status ? [status.retweeted_status] : [])];
    for (const st of candidates) {
      const result = statusToResult(st, base);
      if (result) return result;
    }

    // 纯文字微博(转发的取被转发那条的正文)
    const text = base.title ?? (status.retweeted_status ? (status.retweeted_status.text_raw ?? status.retweeted_status.text?.replace(/<[^>]+>/g, '')) : undefined);
    if (text) return { ...base, type: 'text', title: text, media: [] };

    throw new ParseError(NAME, '微博内容为空');
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
