import type { Env } from './config';
import { dispatch, type TgUpdate } from './bot/dispatch';
import { Telegram } from './bot/telegram';
import { findParser } from './parsers';
import { handleProxy } from './proxy';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('mediabot is running');
    }

    // 视频流中转(B站等防盗链 CDN 补 Referer;微博等封 CF 的经中继)
    if (url.pathname === '/proxy') {
      return handleProxy(request, url, { url: env.MEDIA_RELAY_URL, token: env.MEDIA_RELAY_TOKEN });
    }

    // 注册/更新 webhook:GET /setup?secret=<WEBHOOK_SECRET>
    if (url.pathname === '/setup') {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const tg = new Telegram(env);
      const webhookUrl = `${url.origin}/webhook`;
      try {
        await tg.call('setWebhook', {
          url: webhookUrl,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ['message', 'inline_query'],
          drop_pending_updates: true,
        });
        return Response.json({ ok: true, webhook: webhookUrl });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }

    // 诊断端点:GET /debug/parse?secret=<WEBHOOK_SECRET>&url=<链接>,从 CF 边缘直接测试解析器
    // 附加模式: &raw=1 时直接抓取目标 URL,返回状态码与内容片段(用于探测风控)
    if (url.pathname === '/debug/parse') {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      // B站分阶段诊断:&bilitest=<bvid> 依次测 finger/spi、view、pagelist、APP取流、WBI取流
      const bilitest = url.searchParams.get('bilitest');
      if (bilitest) {
        const { biliStageTest } = await import('./parsers/bilibili');
        return Response.json(await biliStageTest(bilitest, url.searchParams.get('cid') ?? undefined));
      }
      const target = url.searchParams.get('url');
      if (!target) return Response.json({ ok: false, error: 'missing url param' }, { status: 400 });
      if (url.searchParams.get('raw')) {
        const UA_MAP: Record<string, string> = {
          desktop:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          mobile:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          twitterbot: 'Twitterbot/1.0',
          sogou: 'Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)',
          micromessenger:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x1800312b) NetType/WIFI Language/zh_CN',
        };
        const MARKERS = ['_ROUTER_DATA', '__INITIAL_STATE__', '__UNIVERSAL_DATA_FOR_REHYDRATION__', 'js_content', 'msg_title', '环境异常', 'Sina Visitor', '$render_data', 'video-info'];
        const headers: Record<string, string> = { 'User-Agent': UA_MAP[url.searchParams.get('ua') ?? 'desktop'] ?? UA_MAP.desktop };
        const referer = url.searchParams.get('referer');
        if (referer) headers['Referer'] = referer;
        // &bilicookie=1 时生成 B站反爬 cookie 并随请求携带,响应里回显便于分阶段排查
        let biliCookie: string | undefined;
        if (url.searchParams.get('bilicookie')) {
          const { getAntiCrawlCookie } = await import('./parsers/bilibili');
          biliCookie = await getAntiCrawlCookie();
          headers['Cookie'] = biliCookie;
        }
        const res = await fetch(target, { headers });
        const body = await res.text();
        const around = url.searchParams.get('around');
        const aroundIdx = around ? body.indexOf(around) : -1;
        const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim().slice(0, 100);
        return Response.json({
          status: res.status,
          finalUrl: res.url,
          setCookie: res.headers.getSetCookie().map((c) => c.split(';')[0]),
          bodyLen: body.length,
          title,
          ...(biliCookie ? { biliCookie } : {}),
          markers: MARKERS.filter((m) => body.includes(m)),
          ...(aroundIdx >= 0 ? { around: body.slice(Math.max(0, aroundIdx - 100), aroundIdx + 900) } : {}),
          bodyHead: body.slice(0, 300),
        });
      }
      const found = findParser(target);
      if (!found) return Response.json({ ok: false, error: 'unsupported platform' });
      try {
        const result = await found.parser.parse(found.url, env);
        return Response.json({ ok: true, result });
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // webhook 入口:校验 secret,立即 200,异步处理
    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      let update: TgUpdate;
      try {
        update = (await request.json()) as TgUpdate;
      } catch {
        return new Response('bad request', { status: 400 });
      }
      ctx.waitUntil(dispatch(update, env, url.origin));
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
