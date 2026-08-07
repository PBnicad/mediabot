import { marked } from 'marked';
import { isProxyableHost } from '../proxy';

/**
 * telegra.ph 匿名 API 与内容格式化管线。
 * formatContent 管线参考 telegram-wechat-to-telegraph-bot:
 * Markdown → marked(HTML) → cleanArticleHtml(白名单) → 块级/内联解析 → Telegraph 节点
 */

const API = 'https://api.telegra.ph';

let cachedToken: string | null = null;

async function ensureToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await fetch(`${API}/createAccount?short_name=Jiexi&author_name=JiexiBot`);
  const json = (await res.json()) as { ok: boolean; result?: { access_token?: string } };
  if (!json.ok || !json.result?.access_token) throw new Error('telegraph 建号失败');
  cachedToken = json.result.access_token;
  return cachedToken;
}

/** Telegraph 节点类型 */
export type TNode = string | { tag: string; attrs?: Record<string, string>; children?: TNode[] };

export async function createPage(title: string, content: TNode[], author?: string): Promise<string> {
  // 新账号建页偶发 ACCOUNT_NOT_FOUND(telegra.ph 复制延迟),重建账号重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureToken();
    const body = new URLSearchParams({
      access_token: token,
      title: title.slice(0, 256),
      content: JSON.stringify(content),
      author_name: (author ?? '').slice(0, 128),
      return_content: 'false',
    });
    const res = await fetch(`${API}/createPage`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json()) as { ok: boolean; result?: { url?: string }; error?: string };
    if (json.ok && json.result?.url) return json.result.url;
    if (json.error?.includes('ACCOUNT_NOT_FOUND') && attempt === 0) {
      cachedToken = null;
      continue;
    }
    throw new Error(`telegraph 建页失败: ${json.error ?? '未知'}`);
  }
  throw new Error('telegraph 建页失败: 未知');
}

/**
 * 用纯文本(可选配图)创建 Telegraph 页面 — 长文转发模式用。
 * 页面结构:作者/原文链接行 → 配图 → 正文段落。
 */
export async function createTextPage(opts: {
  title: string;
  author?: string;
  sourceUrl: string;
  text: string;
  imageUrls?: string[];
}): Promise<string> {
  const nodes: TNode[] = [];

  const meta: TNode[] = [];
  if (opts.author) meta.push(`${opts.author} · `);
  meta.push({ tag: 'a', attrs: { href: opts.sourceUrl }, children: ['原文链接'] });
  nodes.push({ tag: 'p', children: meta });
  nodes.push({ tag: 'hr' });

  for (const u of (opts.imageUrls ?? []).slice(0, 20)) {
    nodes.push({ tag: 'img', attrs: { src: u } });
  }

  for (const line of opts.text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) nodes.push({ tag: 'p', children: [t] });
  }

  return createPage(opts.title.slice(0, 256), nodes, opts.author);
}

/**
 * 图床反代:自建 /proxy 优先(能走自建都走自建),未配置代理域名时回退 qpic.cn.in 公共反代。
 * qpic.cn.in 两种用法:微信(mmbiz.qpic.cn/wx.qlogo.cn)host 前缀形式并补 wxtype 参数
 * (参考实现 WeChatImageUtils.convertImageUrl);小红书(xhscdn 系)/B站(hdslb 系)完整 URL 形式。
 */
export function convertImageUrl(imageUrl: string, proxyOrigin?: string): string {
  if (!imageUrl) return '';

  const isWechatHost = imageUrl.includes('mmbiz.qpic.cn') || imageUrl.includes('wx.qlogo.cn');

  // 已是本站 /proxy 链接:原样返回(/proxy 自带 Referer,无需 wxtype)
  if (imageUrl.includes('/proxy?url=')) return imageUrl;

  // 已经 qpic.cn.in 反代过:微信图补参数,其余原样返回,不重复代理
  if (imageUrl.includes('qpic.cn.in/')) {
    if (isWechatHost && !imageUrl.includes('wxtype=')) {
      const sep = imageUrl.includes('?') ? '&' : '?';
      return `${imageUrl}${sep}wxtype=jpeg&wxfrom=0`;
    }
    return imageUrl;
  }

  // 自建 /proxy(微信/小红书/B站/微博/抖音/TikTok 图床均在白名单)
  if (proxyOrigin && isProxyableHost(imageUrl)) {
    return `${proxyOrigin}/proxy?url=${encodeURIComponent(imageUrl)}`;
  }

  // 兜底:qpic.cn.in 公共反代(小红书/B站完整 URL 形式)
  if (imageUrl.includes('xhscdn.') || imageUrl.includes('hdslb.')) return `https://qpic.cn.in/${imageUrl}`;

  let out = imageUrl;
  if (out.includes('mmbiz.qpic.cn')) out = out.replace('mmbiz.qpic.cn', 'qpic.cn.in/mmbiz.qpic.cn');
  else if (out.includes('wx.qlogo.cn')) out = out.replace('wx.qlogo.cn', 'qpic.cn.in/wx.qlogo.cn');

  if (out.includes('qpic.cn.in')) {
    const sep = out.includes('?') ? '&' : '?';
    return `${out}${sep}wxtype=jpeg&wxfrom=0`;
  }
  return out;
}

/** 公众号正文图片改写:配置自建代理域名时微信图床完整 URL 经本站 /proxy;否则 qpic.cn.in host 前缀反代 */
export function rewriteArticleImageHosts(markdown: string, proxyOrigin?: string): string {
  if (proxyOrigin) {
    return markdown.replace(
      /https?:\/\/(?:mmbiz\.qpic\.cn|wx\.qlogo\.cn)[^\s)"'\]]+/g,
      (u) => `${proxyOrigin}/proxy?url=${encodeURIComponent(u)}`,
    );
  }
  return markdown
    .replace(/mmbiz\.qpic\.cn/g, 'qpic.cn.in/mmbiz.qpic.cn')
    .replace(/wx\.qlogo\.cn/g, 'qpic.cn.in/wx.qlogo.cn');
}

// ──────────────────────── cleanArticleHtml(白名单清洗) ────────────────────────

/** 规范化 HTML 空白,保留 <pre>/<code> 内的换行 */
function normalizeWhitespace(html: string): string {
  html = html.replace(/ /g, ' ');
  html = html.replace(/(<br\s*\/?>\s*)+/gi, '\n');
  const parts = html.split(/(<pre[^>]*>[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) parts[i] = parts[i].replace(/\s+/g, ' ');
  }
  return parts.join('');
}

/**
 * 清洗 HTML:标签/属性白名单
 * h1→h3,b→strong,h2/h5/h6→h4;移除 <head>;规范化空白
 */
function cleanArticleHtml(html: string): string {
  if (!html) return '';

  let result = html;
  result = result.replace(/<h1/gi, '<h3').replace(/<\/h1>/gi, '</h3>');
  result = result.replace(/<h2/gi, '<h4').replace(/<\/h2>/gi, '</h4>');
  result = result.replace(/<h5/gi, '<h4').replace(/<\/h5>/gi, '</h4>');
  result = result.replace(/<h6/gi, '<h4').replace(/<\/h6>/gi, '</h4>');
  result = result.replace(/<(\/?)b(\s|>)/gi, '<$1strong$2');
  result = result.replace(/<head[^a-z][\s\S]*<\/head>/gi, '');

  const allowedTags = new Set([
    'a', 'aside', 'b', 'blockquote', 'br', 'code', 'em',
    'figcaption', 'figure', 'h3', 'h4', 'hr', 'i', 'img',
    'li', 'ol', 'p', 'pre', 's', 'strong', 'u', 'ul', 'video',
  ]);
  const allowedAttrs: Record<string, string[]> = { img: ['src', 'alt'], a: ['href'] };

  result = result.replace(/<(\w+)([^>]*)>/gi, (_match, tagName: string, attrs: string) => {
    const tag = tagName.toLowerCase();
    if (!allowedTags.has(tag)) return '';
    const allowedForTag = allowedAttrs[tag] ?? [];
    const attrRegex = /(\w+)=["']([^"']*)["']/gi;
    let filtered = '';
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrs)) !== null) {
      if (allowedForTag.includes(attrMatch[1].toLowerCase())) filtered += ` ${attrMatch[1].toLowerCase()}="${attrMatch[2]}"`;
    }
    return `<${tag}${filtered}>`;
  });

  result = result.replace(/<\/(\w+)>/gi, (match, tagName: string) =>
    allowedTags.has(tagName.toLowerCase()) ? match : '',
  );

  return normalizeWhitespace(result).trim();
}

// ──────────────────────── formatContent(MD/HTML → Telegraph 节点) ────────────────────────

export function formatContent(content: string | TNode[]): TNode[] {
  if (!content) return [{ tag: 'p', children: ['内容为空'] }];
  if (Array.isArray(content)) return content;

  // Step 1: Markdown → HTML
  let html: string;
  const looksLikeHtml = /<\s*\w+[^>]*>/i.test(content);
  if (looksLikeHtml) {
    html = content;
  } else {
    html = marked.parse(content, { async: false });
  }

  // Step 2: 清洗(白名单)
  html = cleanArticleHtml(html);

  // Step 3: 移除脚本/样式/注释
  html = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const elements: TNode[] = [];
  const blockRegex = /<(h[1-6]|p|blockquote|ul|ol|pre|figure|div)[^>]*>([\s\S]*?)<\/\1>/gi;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = blockRegex.exec(html)) !== null) {
    const before = html.slice(last, m.index);
    pushInlineFragments(before, elements);

    const tag = m[1].toLowerCase();
    const inner = m[2];

    if (tag.startsWith('h')) {
      const level = parseInt(tag.substring(1), 10);
      // cleanArticleHtml 已将 h1→h3、h2/h5/h6→h4,此处保留其映射(参考实现 level<=2 会把 h3 误压为 h4)
      elements.push({ tag: level <= 3 ? 'h3' : 'h4', children: parseInlineHtml(inner) });
    } else if (tag === 'p' || tag === 'div') {
      pushParagraph(inner, elements);
    } else if (tag === 'blockquote') {
      const paras = inner.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [];
      if (paras.length) {
        elements.push({
          tag: 'blockquote',
          children: paras.map((p) => ({ tag: 'p', children: parseInlineHtml(p.replace(/<\/?p[^>]*>/gi, '')) })),
        });
      } else {
        elements.push({ tag: 'blockquote', children: [{ tag: 'p', children: parseInlineHtml(inner) }] });
      }
    } else if (tag === 'ul' || tag === 'ol') {
      const lis = inner.match(/<li[^>]*>[\s\S]*?<\/li>/gi) ?? [];
      const items = lis.map((li) => ({
        tag: 'li',
        children: parseInlineHtml(li.replace(/<\/?li[^>]*>/gi, '')),
      }));
      if (items.length) elements.push({ tag, children: items });
    } else if (tag === 'pre') {
      const codeMatch = inner.match(/<code[^>]*>([\s\S]*?)<\/code>/i);
      const codeText = decodeEntities((codeMatch ? codeMatch[1] : inner).replace(/<[^>]+>/g, ''));
      elements.push({ tag: 'pre', children: [codeText.trim()] });
    } else if (tag === 'figure') {
      const imgMatch = inner.match(/<img[^>]*src=["']([^"']+)["'][^>]*>/i);
      const src = imgMatch ? convertImageUrl(imgMatch[1]) : null;
      if (src && !/^data:/i.test(src)) elements.push({ tag: 'img', attrs: { src } });
      const cap = inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
      if (cap) elements.push({ tag: 'figcaption', children: parseInlineHtml(cap[1]) });
    }

    last = blockRegex.lastIndex;
  }

  const tail = html.slice(last);
  pushInlineFragments(tail, elements);

  return elements.length > 0 ? elements : [{ tag: 'p', children: ['内容解析失败'] }];
}

// ==== 辅助函数:内联解析与实体解码(与参考实现一致) ====

function pushInlineFragments(fragment: string, out: TNode[]): void {
  if (!fragment) return;
  for (const im of fragment.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const src = convertImageUrl(im[1]);
    if (src && !/^data:/i.test(src)) out.push({ tag: 'img', attrs: { src } });
  }
  const children = parseInlineHtml(fragment.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, ''));
  const paragraphKids = children.filter((n) => !(typeof n === 'object' && n.tag === 'img'));
  if (paragraphKids.some((n) => (typeof n === 'string' ? n.trim() : true))) {
    out.push({ tag: 'p', children: paragraphKids.length ? paragraphKids : [' '] });
  }
}

function pushParagraph(inner: string, out: TNode[]): void {
  const children = parseInlineHtml(inner);
  const textChildren = children.filter((n) => !(typeof n === 'object' && n.tag === 'img'));
  if (textChildren.length) out.push({ tag: 'p', children: textChildren });
  for (const n of children) {
    if (typeof n === 'object' && n.tag === 'img') {
      const src = n.attrs?.src;
      if (src && !/^data:/i.test(src)) out.push(n);
    }
  }
}

function parseInlineHtml(fragment: string): TNode[] {
  const kids: TNode[] = [];
  let s = fragment
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  while (s.length) {
    const m = s.match(/<(br|img|a|b|strong|i|em|code)[^>]*>/i);
    if (!m) {
      const text = stripRemainingTags(s);
      if (text) kids.push(text);
      break;
    }

    const before = s.slice(0, m.index);
    const beforeText = stripRemainingTags(before);
    if (beforeText) kids.push(beforeText);

    const tag = m[1].toLowerCase();
    const open = m[0];
    s = s.slice((m.index ?? 0) + open.length);

    if (tag === 'br') {
      kids.push({ tag: 'br' });
      continue;
    }

    if (tag === 'img') {
      const srcMatch = open.match(/src=["']([^"']+)["']/i);
      const altMatch = open.match(/alt=["']([^"']+)["']/i);
      const src = srcMatch ? convertImageUrl(srcMatch[1]) : '';
      if (src && !/^data:/i.test(src)) {
        kids.push({ tag: 'img', attrs: altMatch ? { src, alt: altMatch[1] } : { src } });
      }
      continue;
    }

    const close = s.match(new RegExp(`</${tag}\\s*>`, 'i'));
    const inner = close ? s.slice(0, close.index) : '';
    s = close ? s.slice((close.index ?? 0) + close[0].length) : s;

    const nested = parseInlineHtml(inner);

    if (tag === 'a') {
      const href = (open.match(/href=["']([^"']+)["']/i) ?? [null, ''])[1];
      kids.push({ tag: 'a', attrs: { href }, children: nested.length ? nested : [stripRemainingTags(inner)] });
    } else if (tag === 'b' || tag === 'strong') {
      kids.push({ tag: 'b', children: nested.length ? nested : [stripRemainingTags(inner)] });
    } else if (tag === 'i' || tag === 'em') {
      kids.push({ tag: 'i', children: nested.length ? nested : [stripRemainingTags(inner)] });
    } else if (tag === 'code') {
      kids.push({ tag: 'code', children: [decodeEntities(inner.replace(/<[^>]+>/g, ''))] });
    }
  }

  return kids.filter((n) => !(typeof n === 'string' && !n.trim()));
}

function stripRemainingTags(s: string): string {
  return decodeEntities(
    s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' '),
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
