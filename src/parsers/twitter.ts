import { ParseError, type MediaItem, type ParseResult, type Parser } from './types';
import { fetchJson } from './http';
import { cleanShareUrl } from './clean';

const NAME = 'Twitter/X';

/**
 * Twitter 官方嵌入(syndication)端点:无需鉴权,v1.1 statuses/show 已下线后的可用方案。
 * token 为公开的嵌入令牌算法(与官方 embed.js 一致)。
 */
interface SyndicationMedia {
  type?: string;
  media_url_https?: string;
  video_info?: {
    duration_millis?: number;
    variants?: { content_type?: string; bitrate?: number; url?: string }[];
  };
}

interface SyndicationTweet {
  __typename?: string;
  text?: string;
  user?: { name?: string; screen_name?: string };
  mediaDetails?: SyndicationMedia[];
  video?: {
    durationMs?: number;
    variants?: { type?: string; src?: string }[];
    poster?: string;
  };
}

function embedToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export const twitterParser: Parser = {
  id: 'twitter',
  name: NAME,

  match(url: URL): boolean {
    const h = url.hostname;
    return (
      (h === 'twitter.com' || h === 'www.twitter.com' || h === 'x.com' || h === 'www.x.com' || h === 'mobile.twitter.com') &&
      /\/status\/\d+/.test(url.pathname)
    );
  },

  async parse(rawUrl: string): Promise<ParseResult> {
    const id = new URL(rawUrl).pathname.match(/\/status\/(\d+)/)?.[1];
    if (!id) throw new ParseError(NAME, '未识别到推文 ID');

    const api = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${embedToken(id)}&lang=en`;
    let tweet: SyndicationTweet;
    try {
      tweet = await fetchJson<SyndicationTweet>(api, { referer: 'https://platform.twitter.com/' });
    } catch (e) {
      throw new ParseError(NAME, `推文获取失败(${e instanceof Error ? e.message : '网络错误'},推文可能受限或已删除)`);
    }
    if (tweet.__typename !== 'Tweet' && !tweet.text) throw new ParseError(NAME, '推文获取失败(可能受限或已删除)');

    const base = {
      platform: 'twitter',
      platformName: NAME,
      title: tweet.text,
      author: tweet.user?.name ? `${tweet.user.name} (@${tweet.user.screen_name})` : undefined,
      sourceUrl: cleanShareUrl(rawUrl),
    };

    const mediaList = tweet.mediaDetails ?? [];
    const videos = mediaList.filter((m) => m.type === 'video' || m.type === 'animated_gif');
    if (videos.length) {
      const v = videos[0];
      const variants = (v.video_info?.variants ?? []).filter((x) => x.content_type === 'video/mp4' && x.url);
      variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      const best = variants[0];
      if (!best?.url) throw new ParseError(NAME, '视频地址提取失败');
      return {
        ...base,
        type: 'video',
        media: [
          {
            type: 'video',
            url: best.url,
            coverUrl: v.media_url_https,
            duration: v.video_info?.duration_millis ? Math.round(v.video_info.duration_millis / 1000) : undefined,
          },
        ],
      };
    }

    // 部分视频只在顶层 video 字段
    if (tweet.video?.variants?.length) {
      const v = tweet.video.variants.find((x) => x.type === 'video/mp4' && x.src) ?? tweet.video.variants[0];
      if (v?.src) {
        return {
          ...base,
          type: 'video',
          media: [
            {
              type: 'video',
              url: v.src,
              coverUrl: tweet.video.poster,
              duration: tweet.video.durationMs ? Math.round(tweet.video.durationMs / 1000) : undefined,
            },
          ],
        };
      }
    }

    const photos = mediaList.filter((m) => m.type === 'photo' && m.media_url_https);
    if (photos.length) {
      const media: MediaItem[] = photos.map((p) => ({ type: 'image', url: `${p.media_url_https}?name=orig` }));
      return { ...base, type: 'images', media };
    }

    // 纯文字推文
    if (tweet.text) return { ...base, type: 'text', media: [] };

    throw new ParseError(NAME, '推文内容为空');
  },
};
