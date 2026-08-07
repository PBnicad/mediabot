/**
 * 视频流中转(移植自 bili-resolver 的 /proxy):
 * 给 B站 CDN 请求补 Referer/UA,透传 Range,让 Telegram 或浏览器可直接拉流。
 * 仅限 bilivideo/hdslb/akamaized 域名,防止被当开放代理滥用。
 */

const REFERER = 'https://www.bilibili.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function handleProxy(request: Request, url: URL): Promise<Response> {
  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing URL', { status: 400 });

  try {
    const targetUrl = new URL(target);
    const h = targetUrl.hostname;
    if (!h.includes('bilivideo') && !h.includes('hdslb') && !h.includes('akamaized')) {
      return new Response('Forbidden', { status: 403 });
    }
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  const headers = new Headers({
    Referer: REFERER,
    'User-Agent': UA,
    Origin: 'https://www.bilibili.com',
    // identity 避免压缩导致串流问题
    'Accept-Encoding': 'identity',
  });
  // 只转发 Range(不转 If-Range/If-Match,避免强缓存校验失败)
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  try {
    const upstream = await fetch(target, { headers });
    if (upstream.status >= 500) {
      return new Response(`CDN Error: ${upstream.status}`, { status: upstream.status });
    }

    const responseHeaders = new Headers({ 'Access-Control-Allow-Origin': '*' });
    // 剔除 ETag/Last-Modified,避免客户端强缓存后发错误 If-Range
    for (const h of ['Content-Type', 'Content-Length', 'Accept-Ranges', 'Content-Range', 'Cache-Control']) {
      const v = upstream.headers.get(h);
      if (v) responseHeaders.set(h, v);
    }

    if (upstream.status === 204 || upstream.status === 304) {
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return new Response(null, { status: 499 });
    return new Response(`Proxy Error: ${e instanceof Error ? e.message : e}`, { status: 502 });
  }
}
