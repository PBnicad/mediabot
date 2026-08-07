import type { MediaItem, ParseResult } from '../parsers/types';
import { convertImageUrl, createTextPage } from '../parsers/telegraph';
import { MAX_RELAY_SIZE, MediaTooBigError, downloadMedia, type RelayConfig } from './media';
import { Telegram, escapeHtml } from './telegram';

const CAPTION_LIMIT = 1024;

/** 正文超过该长度即转 Telegraph(任意平台) */
export const LONG_TEXT_THRESHOLD = 800;

/** 是否长文结果(article 类型本身就走 telegraph,不在此列) */
export function isLongText(result: ParseResult): boolean {
  return result.type !== 'article' && (result.title?.trim().length ?? 0) > LONG_TEXT_THRESHOLD;
}

/** 是否多图结果(图集整篇转 Telegraph:inline 模式发不了相册,一个链接即可浏览全部图) */
export function isMultiImage(result: ParseResult): boolean {
  return result.type === 'images' && result.media.length > 1;
}

/** Telegraph 页可用配图:无防盗链的图床(xhscdn/微信图)经 qpic.cn.in 反代;有防盗链的经本站 /proxy 补 Referer(origin 缺失时丢弃,避免裂图) */
export function telegraphImageUrls(result: ParseResult, origin?: string): string[] {
  if (result.type !== 'images') return [];
  const urls: string[] = [];
  for (const m of result.media) {
    // 无防盗链的直链(xhscdn/微信图床经 qpic.cn.in 反代);有防盗链的经本站 /proxy(origin 缺失时丢弃,避免裂图)
    if (!m.referer) urls.push(convertImageUrl(m.url));
    else if (origin) urls.push(`${origin}/proxy?url=${encodeURIComponent(m.url)}`);
  }
  return urls.slice(0, 20);
}

/** 视频 URL 直发候选:无防盗链用直链;有防盗链经本站 /proxy 补 Referer;rawUrl 存在时 url 已是公开代理链 */
export function videoDirectUrl(v: MediaItem, origin?: string): string | null {
  if (v.rawUrl || !v.referer) return v.url;
  return origin ? `${origin}/proxy?url=${encodeURIComponent(v.url)}` : null;
}

export function buildCaption(result: ParseResult): string {
  const parts: string[] = [];
  if (result.title) parts.push(escapeHtml(result.title.trim()));
  const meta = [result.author ? `👤 ${escapeHtml(result.author)}` : '', `📎 ${result.platformName}`]
    .filter(Boolean)
    .join(' · ');
  if (meta) parts.push(meta);
  parts.push(`<a href="${escapeHtml(result.sourceUrl)}">原链接</a>`);

  let caption = parts.join('\n');
  if (caption.length > CAPTION_LIMIT) caption = `${caption.slice(0, CAPTION_LIMIT - 1)}…`;
  return caption;
}

function buildArticleText(result: ParseResult): string {
  const parts: string[] = [];
  if (result.title) parts.push(`<b>${escapeHtml(result.title.trim())}</b>`);
  const meta: string[] = [];
  if (result.author) meta.push(`👤 ${escapeHtml(result.author)}`);
  if (result.publishTime) meta.push(`📅 ${result.publishTime}`);
  if (result.readingMinutes) meta.push(`⏱ 约 ${result.readingMinutes} 分钟`);
  if (meta.length) parts.push(meta.join(' · '));
  if (result.summary) parts.push(escapeHtml(result.summary));
  parts.push(`📄 <a href="${result.articleUrl}">点击阅读全文(Telegraph)</a>`);
  parts.push(`<a href="${escapeHtml(result.sourceUrl)}">原文链接</a>`);
  return parts.join('\n');
}

/** Telegraph 消息:只发 Telegraph 链接 + 原文链接(长文/图集共用,不带正文) */
export function buildTelegraphMessage(result: ParseResult, pageUrl: string): string {
  const parts: string[] = [];
  const meta = [result.author ? `👤 ${escapeHtml(result.author)}` : '', `📎 ${result.platformName}`]
    .filter(Boolean)
    .join(' · ');
  if (meta) parts.push(meta);
  parts.push(`📄 <a href="${pageUrl}">查看全文(Telegraph)</a>`);
  parts.push(`<a href="${escapeHtml(result.sourceUrl)}">原文链接</a>`);
  return parts.join('\n');
}

/** 长文/图集结果处理:建 Telegraph 页(正文+配图,防盗链图经本站 /proxy),只回双链接消息 */
export async function sendTelegraphResult(
  tg: Telegram,
  chatId: number,
  replyTo: number | undefined,
  result: ParseResult,
  origin?: string,
): Promise<string> {
  const pageUrl = await createTextPage({
    title: result.title?.trim().slice(0, 200) || `${result.platformName} 内容`,
    author: result.author,
    sourceUrl: result.sourceUrl,
    text: result.title ?? '',
    imageUrls: telegraphImageUrls(result, origin),
  });
  await tg.sendMessage(chatId, buildTelegraphMessage(result, pageUrl), replyTo);
  return pageUrl;
}

/** 将解析结果发送到聊天 */
export async function sendResult(
  tg: Telegram,
  chatId: number,
  replyTo: number | undefined,
  result: ParseResult,
  relay: RelayConfig = {},
  origin?: string,
): Promise<void> {
  if (result.type === 'article') {
    const text = buildArticleText(result);
    if (result.coverUrl) {
      await tg.sendPhotoByUrl(chatId, result.coverUrl, text, replyTo).catch(async () => {
        await tg.sendMessage(chatId, text, replyTo);
      });
    } else {
      await tg.sendMessage(chatId, text, replyTo);
    }
    return;
  }

  // 纯文本内容(长文已在 dispatch 拦截转 Telegraph,此处为 ≤800 字)
  if (result.type === 'text') {
    await tg.sendMessage(chatId, buildCaption(result), replyTo);
    return;
  }

  const caption = buildCaption(result);

  if (result.type === 'video') {
    const v = result.media[0];
    if (!v) throw new Error('解析结果中没有视频');

    // 解析端已知超过 50MB:直接提示,不做无谓尝试
    if (v.size && v.size > MAX_RELAY_SIZE) {
      await tg.sendMessage(chatId, `${caption}\n\n⚠️ 视频约 ${Math.round(v.size / 1000 / 1000)}MB,超过 Bot API 50MB 上传限制,无法发送`, replyTo);
      return;
    }

    // URL 直发优先(Telegram 服务端抓取,Worker 零流量,不占 waitUntil 的 30s 墙钟预算):
    // 防盗链视频(微博等)经本站 /proxy 补 Referer;封 CF 的 CDN 由 proxy 自动走中继流式转发
    const directUrl = videoDirectUrl(v, origin);
    if (directUrl) {
      // 防盗链封面同样经 /proxy,避免 Telegram 抓封面失败导致整个 sendVideo 被拒
      const cover = v.coverUrl && v.referer && origin ? `${origin}/proxy?url=${encodeURIComponent(v.coverUrl)}` : v.coverUrl;
      try {
        await tg.sendVideoByUrl(chatId, directUrl, caption, { cover, duration: v.duration }, replyTo);
        return;
      } catch {
        // 直发失败(超 20MB 等),落入 relay
      }
    }

    // relay:Worker 直连 CDN 下载(rawUrl 优先,带防盗链头;封 CF 的走中继)→ 上传(≤50MB)
    try {
      const { data } = await downloadMedia({ url: v.rawUrl ?? v.url, referer: v.referer }, relay);
      await tg.sendVideoUpload(chatId, data, caption, { duration: v.duration }, replyTo);
    } catch (e) {
      if (e instanceof MediaTooBigError) {
        await tg.sendMessage(
          chatId,
          `${caption}\n\n⚠️ 视频超过 Bot API 50MB 上传限制,无法发送`,
          replyTo,
        );
        return;
      }
      throw e;
    }
    return;
  }

  // images
  const urls = result.media.map((m) => m.url).filter(Boolean);
  if (!urls.length) throw new Error('解析结果中没有图片');

  if (urls.length === 1) {
    try {
      await tg.sendPhotoByUrl(chatId, urls[0], caption, replyTo);
      return;
    } catch {
      // 落入 relay
    }
  } else {
    try {
      for (let i = 0; i < urls.length; i += 10) {
        await tg.sendMediaGroupByUrl(chatId, urls.slice(i, i + 10), i === 0 ? caption : '', replyTo);
      }
      return;
    } catch {
      // 落入 relay
    }
  }

  // relay:逐张下载(带各自的防盗链头;封 CF 的走中继)再上传
  const items: { data: ArrayBuffer; contentType: string }[] = [];
  for (const m of result.media.slice(0, 10)) {
    try {
      const d = await downloadMedia({ url: m.url, referer: m.referer }, relay);
      items.push(d);
    } catch {
      // 跳过下载失败的图片
    }
  }
  if (!items.length) throw new Error('图片下载失败(目标站可能拦截了服务器 IP)');
  await tg.sendMediaGroupUpload(chatId, items, caption, replyTo);
}
