/**
 * 分享链接清洗:平台分享链接/短链带追踪参数,含分享者指纹
 * (xsec_token、igsh、t=、spm、vd_source、share_* 等,点击可回溯到分享人)。
 * bot 外发的"原链接/原文链接"(result.sourceUrl)统一经此重建为只含内容 ID 的规范链接。
 */

/** 通用追踪参数黑名单(兜底规则用) */
const TRACKING_PARAMS = new Set([
  'spm', 'spm_id_from', 'from_spmid', 'vd_source', 'bshare',
  'share_source', 'share_medium', 'share_plat', 'share_session_id', 'share_tag', 'share_id', 'share_token', 'share_from',
  'from', 'csrc', 'xsec_token', 'xsec_source', 'igsh', 'igshid', 'fbclid', 'gclid',
  'ref', 'ref_src', '_t', '_r', 't', 's', 'si', 'feature', 'tt_from', 'scene', 'chksm', 'pass_ticket', 'clicktime', 'enterid',
]);

function isHost(h: string, ...hosts: string[]): boolean {
  return hosts.some((x) => h === x || h.endsWith(`.${x}`));
}

/** 兜底:剥黑名单参数与 hash,保留路径与其余参数 */
function stripTracking(u: URL): string {
  for (const k of [...u.searchParams.keys()]) {
    const key = k.toLowerCase();
    if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) u.searchParams.delete(k);
  }
  u.hash = '';
  return u.toString();
}

export function cleanShareUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const h = u.hostname.toLowerCase();
  const path = u.pathname;
  let m: RegExpMatchArray | null;

  // 小红书:xsec_token/xsec_source 是分享者指纹,只留笔记 ID
  if (isHost(h, 'xiaohongshu.com', 'xhslink.com', 'xhslink.cn')) {
    m = path.match(/\/(?:explore|discovery\/item)\/([\w-]+)/);
    if (m) return `https://www.xiaohongshu.com/explore/${m[1]}`;
    return stripTracking(u);
  }

  // B站:视频留 BV/av 号(与分 P),动态留 ID
  if (isHost(h, 'bilibili.com', 'b23.tv')) {
    m = path.match(/\/video\/(BV\w+|av\d+)/i);
    if (m) {
      const p = u.searchParams.get('p');
      return `https://www.bilibili.com/video/${m[1]}${p ? `?p=${p}` : ''}`;
    }
    m = path.match(/^\/(\d+)$/) ?? path.match(/\/(?:dynamic|opus)\/(\d+)/);
    if (m) return `https://t.bilibili.com/${m[1]}`;
    return stripTracking(u);
  }

  // 抖音:留 视频/图集 ID(iesdouyin 分享页与短链落地页统一归一到 www.douyin.com)
  if (isHost(h, 'douyin.com', 'iesdouyin.com')) {
    m = path.match(/\/(?:share\/)?(video|note)\/(\d+)/);
    if (m) return `https://www.douyin.com/${m[1]}/${m[2]}`;
    return stripTracking(u);
  }

  // TikTok:留 @用户/类型/ID
  if (isHost(h, 'tiktok.com')) {
    m = path.match(/^(\/@[^/]+\/(?:video|photo)\/\d+)/);
    if (m) return `https://www.tiktok.com${m[1]}`;
    return stripTracking(u);
  }

  // 微博:主页留 uid/bid;视频页只留 fid
  if (isHost(h, 'weibo.com', 'weibo.cn')) {
    if (h === 'video.weibo.com' && path === '/show') {
      const fid = u.searchParams.get('fid');
      if (fid) return `https://video.weibo.com/show?fid=${fid}`;
    }
    return `${u.origin}${path}`;
  }

  // Twitter/X:留 用户/status/ID(t=、s= 是分享追踪)
  if (isHost(h, 'twitter.com', 'x.com')) {
    m = path.match(/^(\/[^/]+\/status\/\d+)/);
    if (m) return `${u.origin}${m[1]}`;
    return stripTracking(u);
  }

  // Instagram:igsh 是分享者指纹,只留帖子 ID
  if (isHost(h, 'instagram.com')) {
    m = path.match(/\/(p|reel|reels|tv)\/([\w-]+)/);
    if (m) return `https://www.instagram.com/${m[1]}/${m[2]}/`;
    return stripTracking(u);
  }

  // 微信公众号:长链只留 __biz/mid/idx/sn 四个内容参数,短链路径原样;剥 #wechat_redirect
  if (h === 'mp.weixin.qq.com') {
    if (path === '/s') {
      const qs = ['__biz', 'mid', 'idx', 'sn']
        .map((k) => [k, u.searchParams.get(k)] as const)
        .filter((kv): kv is readonly [string, string] => !!kv[1]);
      return `https://mp.weixin.qq.com/s${qs.length ? `?${qs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : ''}`;
    }
    return `https://mp.weixin.qq.com${path}`;
  }

  return stripTracking(u);
}
