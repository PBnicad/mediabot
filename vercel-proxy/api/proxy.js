// B站 API 中继(Vercel Node serverless,函数区域香港 hkg1)
// 协议与 bili-resolver 的 vercel-proxy 兼容:{base}?url=<encodeURIComponent(目标)>
// 鉴权:请求头 x-proxy-token 需与环境变量 PROXY_TOKEN 一致
export default async function handler(req, res) {
  const url = new URL(req.url, 'https://localhost');
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    res.status(400).send('Missing URL parameter');
    return;
  }

  const expectedToken = process.env.PROXY_TOKEN;
  if (expectedToken && req.headers['x-proxy-token'] !== expectedToken) {
    res.status(401).send('Unauthorized: Invalid proxy token');
    return;
  }

  try {
    const target = new URL(targetUrl);
    const h = target.hostname;
    // 仅允许转发白名单域名,防止被当开放代理滥用
    const ALLOWED = ['bilibili.com', 'biliapi.net', 'b23.tv', 'bilivideo', 'hdslb', 'weibo.com', 'weibo.cn', 'weibocdn', 'sinaimg'];
    if (!ALLOWED.some((d) => h.includes(d))) {
      res.status(403).send('Forbidden');
      return;
    }

    const headers = {};
    for (const k of ['user-agent', 'referer', 'cookie', 'origin']) {
      if (req.headers[k]) headers[k] = req.headers[k];
    }

    const response = await fetch(targetUrl, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers,
      redirect: 'manual',
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) {
        res.setHeader(key, value);
      }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');

    const buf = Buffer.from(await response.arrayBuffer());
    res.send(buf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
