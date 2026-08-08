import type { Env } from '../config';

export class TelegramError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

/** Bot API 封装的类型(仅用到字段) */
export interface TgMessage {
  message_id: number;
}

export class Telegram {
  private base: string;

  constructor(env: Env) {
    this.base = `https://api.telegram.org/bot${env.BOT_TOKEN}`;
  }

  async call<T = unknown>(method: string, payload: Record<string, unknown> | FormData): Promise<T> {
    const url = `${this.base}/${method}`;
    const res =
      payload instanceof FormData
        ? await fetch(url, { method: 'POST', body: payload })
        : await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!json.ok) throw new TelegramError(json.description ?? `HTTP ${res.status}`, json.error_code);
    return json.result as T;
  }

  sendMessage(chatId: number | string, text: string, replyTo?: number): Promise<TgMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  editMessageText(chatId: number | string, messageId: number, text: string): Promise<unknown> {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  deleteMessage(chatId: number | string, messageId: number): Promise<unknown> {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => undefined);
  }

  /** 通过 URL 发送视频(Telegram 服务端抓取,≤20MB) */
  sendVideoByUrl(chatId: number | string, videoUrl: string, caption: string, opts: { cover?: string; duration?: number } = {}, replyTo?: number): Promise<TgMessage> {
    return this.call('sendVideo', {
      chat_id: chatId,
      video: videoUrl,
      caption,
      parse_mode: 'HTML',
      supports_streaming: true,
      ...(opts.cover ? { cover: opts.cover } : {}),
      ...(opts.duration ? { duration: opts.duration } : {}),
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  /** multipart 上传视频(≤50MB) */
  sendVideoUpload(chatId: number | string, data: ArrayBuffer, caption: string, opts: { duration?: number } = {}, replyTo?: number): Promise<TgMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('supports_streaming', 'true');
    if (opts.duration) form.append('duration', String(opts.duration));
    if (replyTo) form.append('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    form.append('video', new File([data], 'video.mp4', { type: 'video/mp4' }));
    return this.call('sendVideo', form);
  }

  /** 通过 URL 组图发送(每组 ≤10,支持 photo/video 混合) */
  sendMediaGroupByUrl(
    chatId: number | string,
    items: { type: 'photo' | 'video'; url: string; cover?: string; duration?: number }[],
    caption: string,
    replyTo?: number,
  ): Promise<TgMessage[]> {
    const media = items.map((it, i) => ({
      type: it.type,
      media: it.url,
      ...(it.type === 'video' ? { supports_streaming: true } : {}),
      ...(it.cover ? { cover: it.cover } : {}),
      ...(it.duration ? { duration: it.duration } : {}),
      ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
    }));
    return this.call('sendMediaGroup', {
      chat_id: chatId,
      media,
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  /** multipart 组图上传(每组 ≤10) */
  sendMediaGroupUpload(chatId: number | string, items: { data: ArrayBuffer; contentType: string }[], caption: string, replyTo?: number): Promise<TgMessage[]> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    const media = items.map((_, i) => ({
      type: 'photo',
      media: `attach://photo${i}`,
      ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
    }));
    form.append('media', JSON.stringify(media));
    items.forEach((it, i) => {
      const ext = it.contentType.includes('png') ? 'png' : it.contentType.includes('gif') ? 'gif' : 'jpg';
      form.append(`photo${i}`, new File([it.data], `photo${i}.${ext}`, { type: it.contentType }));
    });
    if (replyTo) form.append('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    return this.call('sendMediaGroup', form);
  }

  sendPhotoByUrl(chatId: number | string, photoUrl: string, caption: string, replyTo?: number): Promise<TgMessage> {
    return this.call('sendPhoto', {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'HTML',
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
  }

  answerInlineQuery(inlineQueryId: string, results: Record<string, unknown>[], cacheTime = 300): Promise<unknown> {
    return this.call('answerInlineQuery', {
      inline_query_id: inlineQueryId,
      results,
      cache_time: cacheTime,
      is_personal: true,
    });
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
