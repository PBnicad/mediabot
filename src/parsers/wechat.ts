import { ParseError, type ParseResult, type Parser } from './types';
import { UA_DESKTOP, fetchText } from './http';
import { convertImageUrl, createPage, formatContent } from './telegraph';
import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';

const NAME = '微信公众号';
const REFERER = 'https://mp.weixin.qq.com/';

/**
 * 微信公众号解析器 — 管线参考 telegram-wechat-to-telegraph-bot:
 * cleanUrl → fetch(指数退避重试) → rich_media 模式提取标题/作者/发布时间
 * → Turndown(linkedom)转 Markdown → qpic.cn.in 域名替换 → telegraph formatContent 建页
 */

// ── Turndown(与参考实现一致的配置与图片规则) ──
const turndownService = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});
turndownService.addRule('wechatImages', {
  filter: 'img',
  replacement: (_content, node) => {
    const el = node as { getAttribute(name: string): string | null };
    const alt = el.getAttribute('alt') ?? '';
    const src = el.getAttribute('data-src') ?? el.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:')) return '';
    return `![${alt}](${src})`;
  },
});

/** 清理 URL:只保留必要参数(与参考实现 cleanUrl 一致) */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const keepParams = ['__biz', 'mid', 'idx', 'sn', 'chksm'];
    const params = new URLSearchParams();
    for (const k of keepParams) {
      if (u.searchParams.has(k)) params.set(k, u.searchParams.get(k)!);
    }
    u.search = params.toString();
    return u.toString();
  } catch {
    return url;
  }
}

function cleanText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 提取文章标题(与参考实现 extractTitle 一致) */
function extractTitle(html: string): string {
  const patterns = [
    /<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>(.*?)<\/h1>/is,
    /<title[^>]*>(.*?)<\/title>/is,
    /<meta[^>]*property="og:title"[^>]*content="([^"]*)"[^>]*>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return cleanText(m[1]);
  }
  return '未知标题';
}

/** 提取作者信息(与参考实现 extractAuthor 一致) */
function extractAuthor(html: string): string {
  const patterns = [
    /<a[^>]*class="[^"]*rich_media_meta_link[^"]*"[^>]*>(.*?)<\/a>/is,
    /<span[^>]*class="[^"]*rich_media_meta[^"]*"[^>]*>(.*?)<\/span>/is,
    /<meta[^>]*name="author"[^>]*content="([^"]*)"[^>]*>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return cleanText(m[1]);
  }
  return '未知作者';
}

/** 提取封面(og:image / msg_cdn_url) */
function extractCover(html: string): string | undefined {
  const m =
    html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"[^>]*>/i) ??
    html.match(/var msg_cdn_url = "([^"]*)"/);
  return m?.[1];
}

/** 提取发布时间(与参考实现 extractPublishTime 一致) */
function extractPublishTime(html: string): string | null {
  const patterns = [
    /<em[^>]*class="[^"]*rich_media_meta[^"]*"[^>]*>(.*?)<\/em>/is,
    /<meta[^>]*property="article:published_time"[^>]*content="([^"]*)"[^>]*>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (!m) continue;
    const text = cleanText(m[1]);
    const d = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (d) return `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
  }
  return null;
}

/** 提取正文 HTML(与参考实现 contentPatterns 一致) */
function extractContentHtml(html: string): string | null {
  const contentPatterns = [
    /<div[^>]*class="[^"]*rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<(?:script|div)/i,
    /<div[^>]*class="[^"]*rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<(?:script|div)/i,
    /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const p of contentPatterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** 清理内容:移除脚本、样式、注释 */
function cleanContent(content: string): string {
  return content
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<!--.*?-->/gis, '')
    .trim();
}

/** HTML → Markdown(linkedom 提供 DOM,与参考实现 htmlToMarkdown 一致) */
function htmlToMarkdown(html: string): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return turndownService.turndown(document.body as unknown as TurndownService.Node);
}

/** 生成摘要(与参考实现 generateSummary 一致) */
function generateSummary(content: string, maxLength = 200): string {
  const plainText = content
    .replace(/!\[.*?\]\(.*?\)/g, '[图片]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/[*`_~]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  if (plainText.length <= maxLength) return plainText;
  return `${plainText.substring(0, maxLength)}...`;
}

/** 计算字数:中文按字符,英文按单词(与参考实现 countWords 一致) */
function countWords(content: string): number {
  const plainText = content
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/[*`_~]/g, '')
    .trim();
  const chineseChars = (plainText.match(/[一-龥]/g) ?? []).length;
  const englishWords = (plainText.match(/[a-zA-Z]+/g) ?? []).length;
  return chineseChars + englishWords;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const wechatParser: Parser = {
  id: 'wechat',
  name: NAME,

  match(url: URL): boolean {
    return url.hostname === 'mp.weixin.qq.com' && (url.pathname.startsWith('/s/') || url.pathname === '/s');
  },

  async parse(rawUrl: string): Promise<ParseResult> {
    const url = cleanUrl(rawUrl);

    // 微信对部分 IP 弹"环境异常"验证页:指数退避重试,换出口 IP 有机会拿到正文
    let html = '';
    let contentHtml: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      html = (await fetchText(url, { ua: UA_DESKTOP, referer: REFERER })).text;
      contentHtml = extractContentHtml(html);
      if (contentHtml) break;
      if (attempt < 2) await sleep(1000 * 2 ** attempt);
    }
    if (!contentHtml) throw new ParseError(NAME, '触发了微信环境验证,请稍后重试(文章也可能已删除)');

    // 提取正文并转 Markdown,域名替换为 qpic.cn.in 反代(与参考实现一致)
    const markdown = htmlToMarkdown(cleanContent(contentHtml))
      .replace(/mmbiz\.qpic\.cn/g, 'qpic.cn.in/mmbiz.qpic.cn')
      .replace(/wx\.qlogo\.cn/g, 'qpic.cn.in/wx.qlogo.cn');
    if (!markdown.trim()) throw new ParseError(NAME, '正文为空');

    const title = extractTitle(html);
    const author = extractAuthor(html);
    const publishTime = extractPublishTime(html);
    const summary = generateSummary(markdown);
    const readingMinutes = Math.max(1, Math.ceil(countWords(markdown) / 300));
    const cover = extractCover(html);

    let pageUrl: string;
    try {
      pageUrl = await createPage(title, formatContent(markdown), author);
    } catch (e) {
      throw new ParseError(NAME, e instanceof Error ? e.message : 'telegraph 建页失败');
    }

    return {
      platform: 'wechat',
      platformName: NAME,
      type: 'article',
      title,
      author,
      sourceUrl: rawUrl,
      media: [],
      articleUrl: pageUrl,
      coverUrl: cover ? convertImageUrl(cover) : undefined,
      summary,
      publishTime: publishTime ?? undefined,
      readingMinutes,
    };
  },
};
