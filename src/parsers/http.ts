export const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

type RequestRedirect = 'follow' | 'error' | 'manual';

export interface HttpOptions {
  ua?: string;
  referer?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

function buildHeaders(opts: HttpOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': opts.ua ?? UA_DESKTOP,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...opts.headers,
  };
  if (opts.referer) headers['Referer'] = opts.referer;
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  return headers;
}

export interface FetchTextResult {
  text: string;
  /** 响应 Set-Cookie 汇总(可直接回带) */
  cookie: string;
  /** 重定向后的最终 URL */
  finalUrl: string;
}

export async function fetchText(url: string, opts: HttpOptions = {}, redirect: RequestRedirect = 'follow'): Promise<FetchTextResult> {
  const res = await fetch(url, { headers: buildHeaders(opts), redirect });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const text = await res.text();
  return { text, cookie, finalUrl: res.url || url };
}

export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { ...buildHeaders(opts), Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return (await res.json()) as T;
}

/**
 * 展开短链:手动跟随重定向,收集沿途 cookie,返回最终 URL 与 cookie。
 */
export async function expandUrl(url: string, opts: HttpOptions = {}, maxHops = 5): Promise<{ finalUrl: string; cookie: string }> {
  let cur = url;
  const cookies: string[] = [];
  if (opts.cookie) cookies.push(opts.cookie);
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(cur, {
      headers: buildHeaders({ ...opts, cookie: cookies.join('; ') }),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) cookies.push(c.split(';')[0]);
    // 消费 body,避免连接悬挂
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      if (!loc) break;
      cur = new URL(loc, cur).href;
      continue;
    }
    break;
  }
  return { finalUrl: cur, cookie: cookies.join('; ') };
}

/** 宽松 JSON 解析:先严格 parse,失败后清洗 JS 字面量(undefined/尾部逗号)重试 */
export function looseJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // fallthrough
  }
  try {
    const cleaned = raw.replace(/\bundefined\b/g, 'null').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/**
 * 从 HTML 中提取 `marker = {...}` 形式的对象原文(括号配平,字符串感知)。
 * marker 例: 'window._ROUTER_DATA ='、'"status":'
 */
export function extractRawObject(html: string, marker: string): string | null {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const objStart = html.indexOf('{', start + marker.length);
  if (objStart === -1) return null;

  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = objStart; i < html.length; i++) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(objStart, i + 1);
    }
  }
  return null;
}

/**
 * 从 HTML 中提取 `marker = {...}` 形式的内嵌 JSON 对象。
 * marker 例: 'window._ROUTER_DATA ='
 */
export function extractInlineJson<T = unknown>(html: string, marker: string): T | null {
  const raw = extractRawObject(html, marker);
  return raw ? looseJsonParse<T>(raw) : null;
}

/** 提取 <script id="..." type="application/json">...</script> 中的 JSON */
export function extractScriptJson<T = unknown>(html: string, scriptId: string): T | null {
  const re = new RegExp(`<script[^>]*id="${scriptId}"[^>]*>([\\s\\S]*?)</script>`);
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as T;
  } catch {
    return null;
  }
}
