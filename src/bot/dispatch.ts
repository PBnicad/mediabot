import type { Env } from '../config';
import { findParser, supportedPlatformNames } from '../parsers';
import { ParseError, type ParseResult } from '../parsers/types';
import { createTextPage } from '../parsers/telegraph';
import { buildCaption, buildTelegraphMessage, isLongText, isMultiImage, sendResult, sendTelegraphResult, telegraphImageUrls } from './sender';
import { Telegram, escapeHtml, type TgMessage } from './telegram';

// ── Telegram Update 宽松类型(仅取用到的字段) ──
interface TgUser {
  id: number;
  first_name?: string;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgUpdateMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
}
interface TgInlineQuery {
  id: string;
  from: TgUser;
  query: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgUpdateMessage;
  inline_query?: TgInlineQuery;
}

const HELP_TEXT = `🔗 <b>链接解析 Bot</b>

直接发送链接即可解析,支持:${supportedPlatformNames}

也可以在任意聊天输入 <code>@本Bot用户名 &lt;链接&gt;</code> 使用内联解析。`;

export async function dispatch(update: TgUpdate, env: Env, origin: string): Promise<void> {
  const tg = new Telegram(env);
  try {
    if (update.message) await handleMessage(tg, update.message, env, origin);
    else if (update.inline_query) await handleInline(tg, update.inline_query, env, origin);
  } catch (e) {
    console.error('dispatch error:', e);
  }
}

async function handleMessage(tg: Telegram, msg: TgUpdateMessage, env: Env, origin: string): Promise<void> {
  const text = msg.text ?? msg.caption ?? '';
  if (!text) return;

  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  const found = findParser(text);

  if (!found) {
    // 仅私聊对 /start 或无链接消息回帮助;群聊静默
    if (isPrivate && (text.startsWith('/start') || !text.includes('http'))) {
      await tg.sendMessage(chatId, HELP_TEXT, msg.message_id);
    }
    return;
  }

  const status = await tg
    .sendMessage(chatId, `🔍 ${found.parser.name} 链接,解析中...`, msg.message_id)
    .catch(() => null);

  const reportError = async (e: unknown) => {
    const msgText = e instanceof ParseError ? `❌ ${e.platformName}解析失败:${escapeHtml(e.message)}` : `❌ 解析失败:${escapeHtml(e instanceof Error ? e.message : '未知错误')}`;
    if (status) await tg.editMessageText(chatId, status.message_id, msgText).catch(() => undefined);
    else await tg.sendMessage(chatId, msgText, msg.message_id).catch(() => undefined);
  };

  let result: ParseResult;
  try {
    result = await found.parser.parse(found.url, env);
  } catch (e) {
    console.error('parse error:', e);
    await reportError(e);
    return;
  }

  try {
    if (status) await tg.editMessageText(chatId, status.message_id, '📤 解析完成,发送中...').catch(() => undefined);
    if (isLongText(result) || isMultiImage(result)) {
      // 长文/多图模式:整篇转 Telegraph,只发 Telegraph + 原文双链接
      await sendTelegraphResult(tg, chatId, msg.message_id, result, origin);
    } else {
      await sendResult(tg, chatId, msg.message_id, result, { url: env.MEDIA_RELAY_URL, token: env.MEDIA_RELAY_TOKEN }, origin);
    }
    if (status) await tg.deleteMessage(chatId, status.message_id);
  } catch (e) {
    console.error('send error:', e);
    await reportError(e);
  }
}

// ── Inline ──

function inlineArticle(id: string, title: string, description: string, messageText: string): Record<string, unknown> {
  return {
    type: 'article',
    id,
    title,
    description,
    input_message_content: { message_text: messageText, parse_mode: 'HTML', disable_web_page_preview: false },
  };
}

async function handleInline(tg: Telegram, iq: TgInlineQuery, env: Env, origin: string): Promise<void> {
  const query = iq.query.trim();
  const found = query ? findParser(query) : null;

  if (!found) {
    await tg.answerInlineQuery(
      iq.id,
      [inlineArticle('help', '输入链接开始解析', `支持:${supportedPlatformNames}`, HELP_TEXT)],
      5,
    );
    return;
  }

  let result: ParseResult;
  try {
    result = await found.parser.parse(found.url, env);
  } catch (e) {
    const msgText = e instanceof ParseError ? `${e.platformName}解析失败:${e.message}` : '解析失败,请稍后重试';
    await tg.answerInlineQuery(iq.id, [inlineArticle('error', '解析失败', msgText, `❌ ${escapeHtml(msgText)}`)], 5);
    return;
  }

  const caption = buildCaption(result);
  const results: Record<string, unknown>[] = [];

  // 长文/多图模式:整篇转 Telegraph,只给 Telegraph + 原文双链接
  if (isLongText(result) || isMultiImage(result)) {
    const gallery = !isLongText(result);
    try {
      const pageUrl = await createTextPage({
        title: result.title?.trim().slice(0, 200) || `${result.platformName} 内容`,
        author: result.author,
        sourceUrl: result.sourceUrl,
        text: result.title ?? '',
        imageUrls: telegraphImageUrls(result, origin),
      });
      results.push(
        inlineArticle(
          'telegraph',
          result.title?.trim().slice(0, 64) || (gallery ? `${result.platformName} 图集` : `${result.platformName} 内容`),
          gallery ? `🖼 共 ${result.media.length} 张图,点击查看 Telegraph 图集` : '📄 长文,点击查看 Telegraph 全文',
          buildTelegraphMessage(result, pageUrl),
        ),
      );
    } catch {
      results.push(inlineArticle('error', 'Telegraph 建页失败', '请稍后重试', `❌ Telegraph 建页失败\n<a href="${escapeHtml(result.sourceUrl)}">原文链接</a>`));
    }
    await tg.answerInlineQuery(iq.id, results, 300);
    return;
  }

  if (result.type === 'video') {
    const v = result.media[0];
    // 防盗链平台经本站 /proxy 补 Referer 供 Telegram 抓取;
    // 微博 CDN 连 CF 也封,由 /proxy 自动改走中继出口
    const proxied = !!v?.referer;
    const videoUrl = v ? (proxied ? `${origin}/proxy?url=${encodeURIComponent(v.url)}` : v.url) : null;
    const thumbUrl = v?.coverUrl ? (proxied ? `${origin}/proxy?url=${encodeURIComponent(v.coverUrl)}` : v.coverUrl) : null;

    if (v && videoUrl && thumbUrl && (!v.referer || proxied)) {
      results.push({
        type: 'video',
        id: 'v0',
        video_url: videoUrl,
        mime_type: 'video/mp4',
        thumb_url: thumbUrl,
        title: result.title?.slice(0, 64) || `${result.platformName} 视频`,
        caption,
        parse_mode: 'HTML',
        ...(v.duration ? { video_duration: v.duration } : {}),
        ...(v.width && v.height ? { video_width: v.width, video_height: v.height } : {}),
      });
    } else if (v) {
      // 微博等 CF 全封平台:引导私聊
      results.push(
        inlineArticle(
          'relay',
          `${result.platformName} 视频需回源下载`,
          '该平台视频有防盗链,请私聊 Bot 发送此链接获取视频',
          `${caption}\n\n⚠️ 该平台视频有防盗链,请私聊 Bot 发送链接解析`,
        ),
      );
    }
  } else if (result.type === 'images') {
    for (const [i, m] of result.media.slice(0, 10).entries()) {
      // 防盗链图片(微博等)经本站 /proxy(封 CF 的由代理自动走中继)
      const imgUrl = m.referer ? `${origin}/proxy?url=${encodeURIComponent(m.url)}` : m.url;
      results.push({
        type: 'photo',
        id: `p${i}`,
        photo_url: imgUrl,
        thumb_url: imgUrl,
        title: result.title?.slice(0, 64) || `${result.platformName} 图片`,
        caption: i === 0 ? caption : '',
        parse_mode: 'HTML',
      });
    }
  } else if (result.type === 'article' && result.articleUrl) {
    results.push(
      inlineArticle(
        'article',
        result.title?.slice(0, 64) || '微信文章',
        `📄 ${result.platformName} · Telegraph`,
        `<b>${escapeHtml(result.title ?? '微信文章')}</b>\n📄 <a href="${result.articleUrl}">点击阅读全文(Telegraph)</a>\n<a href="${escapeHtml(result.sourceUrl)}">原文链接</a>`,
      ),
    );
  } else if (result.type === 'text') {
    // 纯文字内容(长文已在上方拦截转 Telegraph)
    results.push(
      inlineArticle(
        'text',
        result.title?.trim().slice(0, 64) || `${result.platformName} 内容`,
        `📝 ${result.platformName} · 文字`,
        caption,
      ),
    );
  }

  if (!results.length) {
    results.push(inlineArticle('empty', '未找到可发送的内容', '换个链接试试', '❌ 未找到可发送的内容'));
  }

  await tg.answerInlineQuery(iq.id, results, 300);
}

export type { TgMessage };
