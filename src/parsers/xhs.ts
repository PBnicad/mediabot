import { ParseError, type MediaItem, type ParseResult, type Parser } from './types';
import { UA_DESKTOP, UA_MOBILE, expandUrl, extractInlineJson, fetchText } from './http';
import { cleanShareUrl } from './clean';

const NAME = '小红书';
const REFERER = 'https://www.xiaohongshu.com/';

/**
 * 小红书免签名方案:笔记页 window.__INITIAL_STATE__ 内嵌 noteDetailMap。
 * 必须保留分享链接中的 xsec_token(过期/裸链会被 404 安全页拦截);
 * xhslink 短链可能先跳 /404/sec_*?originalUrl=<真实地址>,需回捞。
 */

interface XhsStream {
  masterUrl?: string;
  backupUrls?: string[];
  videoDuration?: number;
  duration?: number;
  width?: number;
  height?: number;
}

interface XhsNote {
  noteId?: string;
  type?: string; // 'video' | 'normal'
  title?: string;
  desc?: string;
  user?: { nickname?: string };
  imageList?: { urlDefault?: string; urlPre?: string; infoList?: { url?: string }[] }[];
  video?: {
    media?: {
      stream?: { h264?: XhsStream[]; h265?: XhsStream[]; av1?: XhsStream[] };
    };
  };
}

function pickNote(state: unknown): XhsNote | null {
  const map = (state as { note?: { noteDetailMap?: Record<string, { note?: XhsNote }> } }).note?.noteDetailMap;
  if (!map) return null;
  for (const key of Object.keys(map)) {
    const n = map[key]?.note;
    if (n?.noteId) return n;
  }
  return null;
}

/** 安全跳转页(/404/sec_*)的 originalUrl 参数里藏着真实笔记地址 */
function recoverOriginalUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith('/404')) return null;
    const orig = u.searchParams.get('originalUrl');
    return orig ?? null;
  } catch {
    return null;
  }
}

export const xhsParser: Parser = {
  id: 'xhs',
  name: NAME,

  match(url: URL): boolean {
    const h = url.hostname;
    return (
      h === 'xhslink.com' ||
      h === 'xhslink.cn' ||
      h === 'www.xhslink.com' ||
      h === 'www.xiaohongshu.com' ||
      h === 'xiaohongshu.com' ||
      h === 'm.xiaohongshu.com'
    );
  },

  async parse(rawUrl: string): Promise<ParseResult> {
    let url = rawUrl;

    // 1. 短链展开;命中安全跳转页时从 originalUrl 回捞真实地址
    if (new URL(url).hostname.endsWith('xhslink.com') || new URL(url).hostname.endsWith('xhslink.cn')) {
      const { finalUrl } = await expandUrl(url, { ua: UA_MOBILE });
      url = recoverOriginalUrl(finalUrl) ?? finalUrl;
    }
    if (!/xiaohongshu\.com\/(explore|discovery\/item)\//.test(url)) {
      throw new ParseError(NAME, '未识别到有效的笔记链接');
    }

    // 2. 抓笔记页(保留全部 query,xsec_token 是通行证)
    let pageUrl = url;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text: html, finalUrl } = await fetchText(pageUrl, { ua: UA_DESKTOP, referer: REFERER });
      // 又触发安全跳转 → 回捞重试
      const recovered = recoverOriginalUrl(finalUrl);
      if (recovered && recovered !== pageUrl) {
        pageUrl = recovered;
        continue;
      }

      const state = extractInlineJson(html, 'window.__INITIAL_STATE__');
      const note = state ? pickNote(state) : null;
      if (!note) {
        throw new ParseError(NAME, '笔记数据提取失败(链接可能已过期或触发风控,请重新分享后再试)');
      }

      const base = {
        platform: 'xhs',
        platformName: NAME,
        title: note.title || note.desc,
        author: note.user?.nickname,
        sourceUrl: cleanShareUrl(url),
      };

      // 视频笔记
      if (note.type === 'video') {
        const stream = note.video?.media?.stream;
        const pick = stream?.h264?.[0] ?? stream?.h265?.[0] ?? stream?.av1?.[0];
        const videoUrl = pick?.masterUrl ?? pick?.backupUrls?.[0];
        if (!videoUrl) throw new ParseError(NAME, '视频地址提取失败');
        const duration = pick?.videoDuration ?? pick?.duration;
        return {
          ...base,
          type: 'video',
          media: [
            {
              type: 'video',
              url: videoUrl.replace(/^http:/, 'https:'),
              coverUrl: note.imageList?.[0]?.urlDefault,
              duration: duration ? Math.round(duration / 1000) : undefined,
              width: pick?.width,
              height: pick?.height,
              referer: REFERER,
            },
          ],
        };
      }

      // 图文笔记(xhscdn 无防盗链,可直接直发/嵌入 Telegraph)
      if (note.imageList?.length) {
        const media: MediaItem[] = [];
        for (const img of note.imageList) {
          const u = img.urlDefault ?? img.infoList?.[0]?.url;
          if (u) media.push({ type: 'image', url: u.replace(/^http:/, 'https:') });
        }
        if (media.length) return { ...base, type: 'images', media };
      }

      throw new ParseError(NAME, '笔记不包含可解析的媒体内容');
    }

    throw new ParseError(NAME, '触发平台风控,请稍后重试');
  },
};
