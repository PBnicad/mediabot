import type { Parser } from './types';
import { douyinParser } from './douyin';
import { bilibiliParser } from './bilibili';
import { twitterParser } from './twitter';
import { tiktokParser } from './tiktok';
import { weiboParser } from './weibo';
import { wechatParser } from './wechat';
import { xhsParser } from './xhs';
import { instagramParser } from './instagram';

const parsers: Parser[] = [douyinParser, bilibiliParser, twitterParser, tiktokParser, weiboParser, wechatParser, xhsParser, instagramParser];

export const supportedPlatformNames = parsers.map((p) => p.name).join(' / ');

/** 从文本中提取所有 http(s) 链接(已剥离尾部中英文标点) */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'()（）【】\[\]]+/gi) ?? [];
  return matches.map((u) => u.replace(/[.,;:!?。，；：！？、…'”’»]+$/, ''));
}

function tryParseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** 找到第一个支持的平台链接及其 parser */
export function findParser(text: string): { url: string; parser: Parser } | null {
  for (const raw of extractUrls(text)) {
    const u = tryParseUrl(raw);
    if (!u) continue;
    for (const p of parsers) {
      if (p.match(u)) return { url: raw, parser: p };
    }
  }
  return null;
}
