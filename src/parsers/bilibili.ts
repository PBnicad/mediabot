import { ParseError, type ParseResult, type Parser, type ParserEnv } from './types';
import { UA_DESKTOP, expandUrl } from './http';
import { cleanShareUrl } from './clean';

const NAME = 'Bilibili';
const REFERER = 'https://www.bilibili.com/';

/**
 * B站解析 — 移植自 bili-resolver(https://github.com/Yamada-Ryo4/bili-resolver)的反爬方案:
 * - 反爬 Cookie:finger/spi 取 buvid3/buvid4 + HMAC-SHA256 生成 bili_ticket
 * - 多线路取流:APP iOS 签名 → TV 签名 → web WBI 签名(数据中心 IP 上 APP 线容忍度更高)
 * - 视频直链经本站 /proxy 中转(补 Referer),Telegram 可直接抓取
 */

const FALLBACK_BUVID3 = 'FE6D3664-927F-F75B-B7D4-733E5D4B263F69428infoc';

const ERROR_MAP: Record<number, string> = {
  [-400]: '请求错误',
  [-403]: '访问权限不足',
  [-404]: '视频不存在',
  [-10403]: '仅限港澳台地区',
  62002: '视频不可见',
  62004: '审核中',
};

class AntiCrawlError extends Error {
  constructor() {
    super('B站风控拦截,请稍后重试');
    this.name = 'AntiCrawlError';
  }
}

// ── 基础签名工具(Workers 的 WebCrypto 扩展支持 MD5) ──

async function md5(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── API 中继(可选):配置后所有 api.bilibili.com 请求经中继出口(bili-resolver vercel-proxy 格式) ──
let relayBase: string | undefined;
let relayToken: string | undefined;

function relayUrl(url: string): string {
  return relayBase ? relayBase + encodeURIComponent(url) : url;
}

async function biliFetch(url: string, headers: Record<string, string>, method = 'GET'): Promise<Response> {
  const h = { ...headers };
  if (relayBase && relayToken) h['x-proxy-token'] = relayToken;
  return fetch(relayUrl(url), { headers: h, method });
}

async function fetchBiliJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await biliFetch(url, headers);
  const text = await res.text();
  if (!res.ok) throw new AntiCrawlError();
  if (text.trimStart().startsWith('<')) throw new AntiCrawlError();
  let json: { code?: number };
  try {
    json = JSON.parse(text);
  } catch {
    throw new AntiCrawlError();
  }
  if (json.code === -352) throw new AntiCrawlError();
  return json as T;
}

/** 反爬 Cookie:buvid3/buvid4 + 可选 bili_ticket(失败降级不阻断) */
export async function getAntiCrawlCookie(): Promise<string> {
  let buvid3 = FALLBACK_BUVID3;
  let buvid4: string | null = null;
  try {
    const json = await fetchBiliJson<{ data?: { b_3?: string; b_4?: string } }>(
      'https://api.bilibili.com/x/frontend/finger/spi',
      { 'User-Agent': UA_DESKTOP },
    );
    if (json.data?.b_3) buvid3 = json.data.b_3;
    if (json.data?.b_4) buvid4 = json.data.b_4;
  } catch {
    // 保留 fallback buvid3
  }

  let ticket: string | null = null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const hexsign = await hmacSha256Hex('XgwSnGZ1p', `ts${ts}`);
    const json = await fetchBiliJson<{ data?: { ticket?: string } }>(
      `https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=${hexsign}&context[ts]=${ts}&csrf=`,
      { 'User-Agent': UA_DESKTOP },
    );
    if (json.data?.ticket) ticket = json.data.ticket;
  } catch {
    // 降级为仅 buvid
  }

  const parts = [`buvid3=${buvid3}`];
  if (buvid4) parts.push(`buvid4=${buvid4}`);
  if (ticket) parts.push(`bili_ticket=${ticket}`);
  return parts.join('; ');
}

// ── WBI 签名(web 线路) ──

const MIXIN_KEY_ENC_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

function getMixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

async function getMixinKeyFromNav(cookie: string): Promise<string> {
  const json = await fetchBiliJson<{ data?: { wbi_img?: { img_url?: string; sub_url?: string } } }>(
    'https://api.bilibili.com/x/web-interface/nav',
    { 'User-Agent': UA_DESKTOP, Referer: REFERER, Cookie: cookie },
  );
  const img = json.data?.wbi_img;
  if (!img?.img_url || !img.sub_url) throw new AntiCrawlError();
  const raw = `${img.img_url.split('/').pop()!.split('.')[0]}${img.sub_url.split('/').pop()!.split('.')[0]}`;
  return getMixinKey(raw);
}

async function signWbi(params: Record<string, string | number>, mixinKey: string): Promise<string> {
  const all: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(all[k])}`)
    .join('&');
  return `${query}&w_rid=${await md5(query + mixinKey)}`;
}

// ── APP/TV 端签名取流(公开 appkey/appsec,见 bilibili-API-collect) ──

const APP_KEYS = {
  ios: { appkey: 'YvirImLGlLANCLvM', appsec: 'JNlZNgfNGKZEpaDTkCdPQVXntXhuiJEM', platform: 'ios', ua: 'Bilibili/8.0.0 (bbcallen@gmail.com)' },
  tv: { appkey: '4409e2ce8ffd12b8', appsec: '59b43e04ad6965f34319062b478f83dd', platform: 'android', ua: 'Bilibili Freedoooooom/MOD' },
} as const;

async function appSign(params: Record<string, string>, appkey: string, appsec: string): Promise<string> {
  const all: Record<string, string> = { ...params, appkey };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(all[k])}`)
    .join('&');
  return `${query}&sign=${await md5(query + appsec)}`;
}

interface PlayUrlData {
  code?: number;
  message?: string;
  data?: {
    quality?: number;
    durl?: { url: string; size?: number; backup_url?: string[] }[];
  };
}

/** 取流节点优选:cn-* 区域节点对境外/机房出口限速严重(Telegram 抓取超时),
 * 优先 backup_url 里的 upos-* 全球 CDN 节点 */
function pickStreamUrl(durl: { url?: string; backup_url?: string[] }): string | undefined {
  const candidates = [durl.url, ...(durl.backup_url ?? [])].filter((u): u is string => !!u);
  return (
    candidates.find((u) => {
      try {
        return !new URL(u).hostname.startsWith('cn-');
      } catch {
        return false;
      }
    }) ?? candidates[0]
  );
}

/** 多线路取流:每个清晰度依次尝试 iOS APP → TV → web WBI,任一成功即返回 */
async function getPlayUrlWithFallback(bvid: string, cid: number, cookie: string): Promise<{ url: string; quality?: number; size?: number }> {
  let mixinKey: string | null = null;
  try {
    mixinKey = await getMixinKeyFromNav(cookie);
  } catch {
    // nav 被风控则跳过 web 线路,APP/TV 不受影响
  }

  const tryAppLine = async (qn: number, conf: (typeof APP_KEYS)[keyof typeof APP_KEYS]) => {
    const signed = await appSign(
      { bvid, cid: String(cid), qn: String(qn), fnval: '1', fnver: '0', fourk: '1', platform: conf.platform, ts: String(Math.floor(Date.now() / 1000)) },
      conf.appkey,
      conf.appsec,
    );
    const data = await fetchBiliJson<PlayUrlData>(`https://api.bilibili.com/x/player/playurl?${signed}`, { 'User-Agent': conf.ua });
    const durl = data.data?.durl?.[0];
    if (data.code === 0 && durl?.url) {
      const url = pickStreamUrl(durl);
      if (url) return { url, quality: data.data?.quality, size: durl.size };
    }
    throw new Error(data.message ?? ERROR_MAP[data.code ?? 0] ?? '取流失败');
  };

  const tryWebLine = async (qn: number) => {
    if (!mixinKey) throw new AntiCrawlError();
    const signed = await signWbi({ bvid, cid, qn, fnval: 1, try_look: 1, platform: 'html5', high_quality: 1 }, mixinKey);
    const data = await fetchBiliJson<PlayUrlData>(`https://api.bilibili.com/x/player/wbi/playurl?${signed}`, {
      'User-Agent': UA_DESKTOP,
      Referer: REFERER,
      Cookie: cookie,
    });
    const durl = data.data?.durl?.[0];
    if (data.code === 0 && durl?.url) {
      const url = pickStreamUrl(durl);
      if (url) return { url, quality: data.data?.quality, size: durl.size };
    }
    throw new Error(data.message ?? ERROR_MAP[data.code ?? 0] ?? '取流失败');
  };

  let lastError: string | null = null;
  let sawAntiCrawl = false;
  // 720p 优先(Telegram 50MB 上限),480p 兜底,1080p 最后
  for (const qn of [64, 32, 80]) {
    const lines = [() => tryAppLine(qn, APP_KEYS.ios), () => tryAppLine(qn, APP_KEYS.tv), () => tryWebLine(qn)];
    for (const line of lines) {
      try {
        return await line();
      } catch (e) {
        if (e instanceof AntiCrawlError) sawAntiCrawl = true;
        else lastError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  if (sawAntiCrawl && !lastError) throw new AntiCrawlError();
  throw new Error(lastError ?? (sawAntiCrawl ? 'B站风控拦截,请稍后重试' : '视频解析失败'));
}

interface ViewData {
  code?: number;
  message?: string;
  data?: {
    title?: string;
    pic?: string;
    duration?: number;
    cid?: number;
    bvid?: string;
    owner?: { name?: string };
  };
}

function extractBvid(url: URL): string | null {
  const m = url.pathname.match(/\/(BV[0-9A-Za-z]+)/);
  if (m) return m[1];
  const av = url.pathname.match(/\/av(\d+)/i);
  return av ? `av${av[1]}` : null;
}

/** 动态链接 ID:t.bilibili.com/{id}、www.bilibili.com/opus/{id}、m.bilibili.com/dynamic/{id} */
function extractDynamicId(url: URL): string | null {
  const h = url.hostname;
  if (h === 't.bilibili.com') return url.pathname.match(/^\/(\d+)/)?.[1] ?? null;
  if (h === 'www.bilibili.com' || h === 'bilibili.com' || h === 'm.bilibili.com') {
    return url.pathname.match(/\/(?:opus|dynamic)\/(\d+)/)?.[1] ?? null;
  }
  return null;
}

interface DynamicData {
  code?: number;
  message?: string;
  data?: {
    item?: {
      modules?: {
        module_author?: { name?: string };
        module_dynamic?: {
          desc?: { text?: string } | null;
          major?: {
            type?: string;
            archive?: { bvid?: string };
            draw?: { items?: { src?: string }[] };
            opus?: { pics?: { url?: string }[]; summary?: { text?: string } };
          } | null;
        };
      };
    };
  };
}

interface OpusDetail {
  code?: number;
  data?: {
    item?: {
      /** 注意:opus/detail 的 modules 是数组(与 v1/detail 的对象不同) */
      modules?: {
        module_type?: string;
        module_content?: {
          paragraphs?: {
            para_type?: number;
            text?: { nodes?: { type?: string; word?: { words?: string }; rich?: { text?: string } }[] };
          }[];
        };
      }[];
    };
  };
}

/** 动态正文:v1/detail 的 desc 常为 null,补拉 opus/detail 的 paragraphs(失败不阻断) */
async function fetchDynamicText(id: string, cookie: string): Promise<string | undefined> {
  try {
    const json = await fetchBiliJson<OpusDetail>(`https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=${id}`, {
      'User-Agent': UA_DESKTOP,
      Referer: REFERER,
      Cookie: cookie,
    });
    const mods = json.data?.item?.modules ?? [];
    const content = mods.find((m) => m.module_type === 'MODULE_TYPE_CONTENT') ?? mods.find((m) => m.module_content?.paragraphs?.length);
    const paragraphs = content?.module_content?.paragraphs ?? [];
    const lines: string[] = [];
    for (const p of paragraphs) {
      const nodes = p.text?.nodes;
      if (!nodes) continue;
      const line = nodes
        .map((n) => n.word?.words ?? n.rich?.text ?? '')
        .join('')
        .trim();
      if (line) lines.push(line);
    }
    return lines.join('\n') || undefined;
  } catch {
    return undefined;
  }
}

/** 视频流(view + 多线路取流) */
async function parseVideo(bvid: string, rawUrl: string, cookie: string): Promise<ParseResult> {
  const idParam = bvid.startsWith('av') ? `aid=${bvid.slice(2)}` : `bvid=${bvid}`;

  let view: ViewData;
  try {
    view = await fetchBiliJson<ViewData>(`https://api.bilibili.com/x/web-interface/view?${idParam}`, {
      'User-Agent': UA_DESKTOP,
      Referer: REFERER,
      Cookie: cookie,
    });
  } catch (e) {
    if (e instanceof AntiCrawlError) throw new ParseError(NAME, 'B站风控拦截,请稍后重试');
    throw e;
  }
  if (view.code !== 0 || !view.data?.cid) {
    throw new ParseError(NAME, view.message ?? ERROR_MAP[view.code ?? 0] ?? '视频信息获取失败');
  }

  const { title, pic, duration, cid, owner } = view.data;
  const bv = view.data.bvid ?? bvid;

  let stream: { url: string; quality?: number; size?: number };
  try {
    stream = await getPlayUrlWithFallback(bv, cid!, cookie);
  } catch (e) {
    throw new ParseError(NAME, e instanceof Error ? e.message : '取流失败');
  }

  // 注:不经本站 /proxy 中转 —— 代理流约 500KB/s,Telegram 直抓会超时(Network connection lost)。
  // 一律走 relay:Worker 直连 upos 下载(带 Referer)→ 上传 Telegram。
  return {
    platform: 'bilibili',
    platformName: NAME,
    type: 'video',
    title,
    author: owner?.name,
    sourceUrl: rawUrl,
    media: [
      {
        type: 'video',
        url: stream.url,
        referer: REFERER,
        size: stream.size,
        coverUrl: pic,
        duration,
      },
    ],
  };
}

/** 动态流(web-dynamic detail,走中继) */
async function parseDynamic(id: string, rawUrl: string, cookie: string): Promise<ParseResult> {
  let detail: DynamicData;
  try {
    detail = await fetchBiliJson<DynamicData>(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${id}`, {
      'User-Agent': UA_DESKTOP,
      Referer: REFERER,
      Cookie: cookie,
    });
  } catch (e) {
    if (e instanceof AntiCrawlError) throw new ParseError(NAME, 'B站风控拦截,请稍后重试');
    throw e;
  }
  if (detail.code !== 0) throw new ParseError(NAME, detail.message ?? `动态获取失败(${detail.code})`);

  const dyn = detail.data?.item?.modules?.module_dynamic;
  const author = detail.data?.item?.modules?.module_author?.name;
  const base = { platform: 'bilibili', platformName: NAME, author, sourceUrl: rawUrl };
  const major = dyn?.major;
  if (!major) throw new ParseError(NAME, '动态内容为空或已删除');

  // 视频动态 → 复用视频流
  if (major.type === 'MAJOR_TYPE_ARCHIVE') {
    const bv = major.archive?.bvid;
    if (!bv) throw new ParseError(NAME, '动态视频信息提取失败');
    return parseVideo(bv, rawUrl, cookie);
  }

  // 正文:desc.text 常缺,补拉 opus/detail 的 paragraphs
  const text = dyn?.desc?.text ?? (await fetchDynamicText(id, cookie)) ?? major.opus?.summary?.text;

  // 画集动态
  if (major.type === 'MAJOR_TYPE_DRAW') {
    const media = (major.draw?.items ?? [])
      .map((i) => i.src)
      .filter((u): u is string => !!u)
      .map((u) => ({ type: 'image' as const, url: u.replace(/^http:/, 'https:') }));
    if (media.length) return { ...base, type: 'images', title: text, media };
    throw new ParseError(NAME, '画集图片提取失败');
  }

  // 图文动态(opus)
  if (major.type === 'MAJOR_TYPE_OPUS') {
    const media = (major.opus?.pics ?? [])
      .map((p) => p.url)
      .filter((u): u is string => !!u)
      .map((u) => ({ type: 'image' as const, url: u.replace(/^http:/, 'https:') }));
    if (media.length) return { ...base, type: 'images', title: text, media };
    // 纯文字动态
    if (text) return { ...base, type: 'text', title: text, media: [] };
    throw new ParseError(NAME, '动态内容为空');
  }

  throw new ParseError(NAME, `暂不支持的动态类型: ${major.type ?? '未知'}`);
}

export const bilibiliParser: Parser = {
  id: 'bilibili',
  name: NAME,

  match(url: URL): boolean {
    const h = url.hostname;
    if (h === 'b23.tv') return true;
    if (h === 't.bilibili.com') return /\/\d+/.test(url.pathname);
    if (h === 'www.bilibili.com' || h === 'bilibili.com' || h === 'm.bilibili.com') {
      return /\/(video\/|BV|av\d)/i.test(url.pathname) || /\/(opus|dynamic)\/\d+/.test(url.pathname);
    }
    return false;
  },

  async parse(rawUrl: string, env: ParserEnv): Promise<ParseResult> {
    // 配置中继(每次解析刷新,env 不变时开销可忽略)
    relayBase = env.MEDIA_RELAY_URL?.trim() || undefined;
    relayToken = env.MEDIA_RELAY_TOKEN?.trim() || undefined;

    let url = rawUrl;
    if (new URL(rawUrl).hostname === 'b23.tv') {
      url = (await expandUrl(rawUrl, { ua: UA_DESKTOP })).finalUrl;
    }
    const u = new URL(url);

    const cookie = await getAntiCrawlCookie();

    // 动态
    const dynId = extractDynamicId(u);
    if (dynId) return parseDynamic(dynId, cleanShareUrl(url), cookie);

    // 视频
    const bvid = extractBvid(u);
    if (!bvid) throw new ParseError(NAME, '未识别到视频 BV 号或动态 ID');
    return parseVideo(bvid, cleanShareUrl(url), cookie);
  },
};

/** 分阶段诊断:报告每个 B站端点在当前出口 IP 的存活状态(供 /debug/parse?bilitest= 使用) */
export async function biliStageTest(bvid: string, fixedCid?: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  const probe = async (name: string, url: string, headers: Record<string, string>, method = 'GET') => {
    try {
      const res = await fetch(url, { headers, method });
      const text = await res.text();
      let code: number | undefined;
      try {
        code = JSON.parse(text).code;
      } catch {
        // 非 JSON
      }
      out[name] = { status: res.status, code, head: text.slice(0, 80) };
    } catch (e) {
      out[name] = { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const cookie = await getAntiCrawlCookie();
  out.cookie = cookie;
  const webHeaders = { 'User-Agent': UA_DESKTOP, Referer: REFERER, Cookie: cookie };

  await probe('finger_spi', 'https://api.bilibili.com/x/frontend/finger/spi', { 'User-Agent': UA_DESKTOP });
  await probe('view', `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, webHeaders);
  await probe('pagelist', `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, webHeaders);

  // 取 cid 测取流线路
  let cid: number | undefined = fixedCid ? Number(fixedCid) : undefined;
  for (const key of ['view', 'pagelist']) {
    const r = out[key] as { head?: string } | undefined;
    if (r?.head) {
      try {
        const j = JSON.parse(r.head);
        cid = j?.data?.cid ?? j?.data?.[0]?.cid;
      } catch {
        // ignore
      }
      if (cid) break;
    }
  }

  if (cid) {
    const ts = String(Math.floor(Date.now() / 1000));
    for (const [name, conf] of Object.entries(APP_KEYS)) {
      const signed = await appSign(
        { bvid, cid: String(cid), qn: '64', fnval: '1', fnver: '0', fourk: '1', platform: conf.platform, ts },
        conf.appkey,
        conf.appsec,
      );
      await probe(`playurl_${name}`, `https://api.bilibili.com/x/player/playurl?${signed}`, { 'User-Agent': conf.ua });
    }
    try {
      const mixinKey = await getMixinKeyFromNav(cookie);
      const signed = await signWbi({ bvid, cid, qn: 64, fnval: 1, try_look: 1, platform: 'html5', high_quality: 1 }, mixinKey);
      await probe('playurl_web_wbi', `https://api.bilibili.com/x/player/wbi/playurl?${signed}`, webHeaders);
    } catch (e) {
      out.playurl_web_wbi = { error: e instanceof Error ? e.message : String(e) };
    }
  } else {
    out.note = 'cid 获取失败,取流线路未测';
  }

  return out;
}
