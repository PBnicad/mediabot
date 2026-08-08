/**
 * KV 滚动 cookie 罐:平台 cookie 存 KV(cookie:<platform>),每次调完目标 API
 * 把响应 Set-Cookie 合并回罐子,服务端轮换的字段(csrftoken/sessionid 等)自动续期。
 * env 里的静态 secret(如 INSTAGRAM_COOKIE)仅作首次兜底灌入。
 */

function jarKey(platform: string): string {
  return `cookie:${platform}`;
}

/** 把 "a=1; b=2" 形式的 cookie 串解析为 Map(保留原值,含 = 的值不截断) */
export function parseCookieString(cookie: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of cookie.split(';')) {
    const t = pair.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i > 0) map.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return map;
}

/**
 * 合并 Set-Cookie 到既有 cookie 串:新值覆盖,空值/Max-Age=0 删除。
 * setCookies 为 res.headers.getSetCookie() 的原样条目(含属性)。
 */
export function mergeCookieString(jar: string, setCookies: string[]): string {
  const map = parseCookieString(jar);
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    const attrs = sc.toLowerCase();
    if (!value || attrs.includes('max-age=0')) map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 取平台 cookie:KV 优先;KV 没有时用 env 兜底并回灌 KV(首次迁移)。
 * 返回 undefined 表示该平台完全未配置。
 */
export async function getCookie(
  kv: KVNamespace | undefined,
  platform: string,
  envFallback?: string,
): Promise<string | undefined> {
  const fallback = envFallback?.trim();
  if (!kv) return fallback || undefined;

  const key = jarKey(platform);
  const stored = await kv.get(key, 'text');
  if (stored?.trim()) return stored.trim();

  if (fallback) {
    await kv.put(key, fallback).catch(() => undefined);
    return fallback;
  }
  return undefined;
}

/** 把一次响应的 Set-Cookie 合并回平台罐子(读-改-写,个人 bot 并发极低) */
export async function mergeSetCookies(kv: KVNamespace | undefined, platform: string, setCookies: string[]): Promise<void> {
  if (!kv || !setCookies.length) return;
  const key = jarKey(platform);
  const current = (await kv.get(key, 'text')) ?? '';
  const merged = mergeCookieString(current, setCookies);
  if (merged !== current) await kv.put(key, merged).catch(() => undefined);
}
