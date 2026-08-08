// 计时探针:weibocdn 视频各链路速度对比
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const RELAY = process.env.RELAY; // https://vercel-proxy-eight-red.vercel.app/api/proxy?url=
const RELAY_TOKEN = process.env.RELAY_TOKEN;

const fid = '1034:5327932424388664';
const data = encodeURIComponent(JSON.stringify({ Component_Play_Playinfo: { oid: fid } }));
const api = `https://h5.video.weibo.com/api/component?page=${encodeURIComponent(`/show/${fid}`)}&data=${data}`;
const pj = await (await fetch(api, { headers: { 'User-Agent': UA, Referer: `https://h5.video.weibo.com/show/${fid}` } })).json();
const info = pj.data.Component_Play_Playinfo;
const entries = Object.entries(info.urls).sort((a, b) => Number(b[0].match(/\d+/)?.[0] ?? 0) - Number(a[0].match(/\d+/)?.[0] ?? 0));
let videoUrl = entries[0][1];
if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
console.log('清晰度:', entries.map(([k]) => k).join(', '), '| 选最高:', entries[0][0]);

async function time(label, url, headers = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    if (!r.ok && r.status !== 206) { console.log(`${label}: HTTP ${r.status}`); return; }
    const reader = r.body.getReader();
    let total = 0, firstAt = 0;
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      if (!firstAt) firstAt = Date.now();
      total += c.value.length;
    }
    const ms = Date.now() - t0;
    console.log(`${label}: ${r.status} ${(total / 1e6).toFixed(1)}MB in ${(ms / 1000).toFixed(1)}s (TTFB ${firstAt - t0}ms, ${(total / 1024 / (ms / 1000)).toFixed(0)}KB/s)`);
  } catch (e) {
    console.log(`${label}: ${e.message}(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

// 0. 不带 Referer 直连(Telegram 抓取场景:它不带 Referer)
await time('直连无Referer(前1MB)', videoUrl, { 'User-Agent': UA, Range: 'bytes=0-1048575' });
// 1. 直连全量(基线)
await time('直连全量        ', videoUrl, { 'User-Agent': UA, Referer: 'https://weibo.com/' });
// 2. 经 Vercel 中继全量
if (RELAY && RELAY_TOKEN) {
  await time('经中继全量      ', RELAY + encodeURIComponent(videoUrl), { 'User-Agent': UA, Referer: 'https://weibo.com/', 'x-proxy-token': RELAY_TOKEN });
}
// 3. 经 worker /proxy 全量(Telegram 实际走的链)
await time('经proxy.nicad.top', `https://proxy.nicad.top/proxy?url=${encodeURIComponent(videoUrl)}`);
