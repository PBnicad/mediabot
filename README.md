# mediabot

纯 serverless 的 Telegram 链接解析 Bot,运行在 Cloudflare Workers 上,零服务器成本。

- **Bot API + Webhook**:无需 MTProto 账号,一个 Bot Token 即可运行
- **视频上限 50MB**(Bot API 硬限制),媒体原样发送(无转码/分段)

## 功能特性

- **多平台解析**:私聊/群聊发链接即解析,支持 inline 模式(`@bot <链接>`)
- **长文/多图模式**:正文超过 800 字或图片超过 1 张时自动转 Telegraph,bot 只回 Telegraph 链接 + 原文链接(不刷屏,inline 模式也能发图集);配图经 qpic.cn.in 反代(小红书/B站/微信图床)或本站 /proxy(微博等强防盗链)嵌入 Telegraph 页面
- **链接清洗**:外发的原文链接重建为规范地址,剥除分享追踪参数(xsec_token / igsh / t= / spm / vd_source / share_* 等),不带分享者指纹
- **防盗链处理**:URL 直发优先(防盗链视频经本站 /proxy 补 Referer,封 CF 的自动走中继流式转发),失败再回退 Worker 中转下载,超过 50MB 提示限制

## 支持平台

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| 抖音 | ✅ 可用 | 视频(无水印)、图集;走 iesdouyin 分享页提取 `_ROUTER_DATA` |
| TikTok | ✅ 可用 | 视频、图集;详情页 `__UNIVERSAL_DATA_FOR_REHYDRATION__` |
| Twitter/X | ✅ 可用 | 视频、图文;syndication 嵌入端点(无需鉴权) |
| 微博 | ✅ 可用(已配中继) | 视频、图文(含转发微博);蜘蛛 UA 抓 detail 页 `$render_data`;媒体 CDN 封 CF IP,经 Vercel 中继发送 |
| 小红书 | ✅ 可用 | 视频、图文;笔记页 `__INITIAL_STATE__`(依赖新鲜 xsec_token,免签名);支持 xhslink.com/.cn 短链 |
| Instagram | ✅ 封面模式可用 | 免登录走 oEmbed(文案+作者+封面);配置 `INSTAGRAM_COOKIE` 后解锁视频/图集(移动端 API) |
| Bilibili | ✅ 可用(已配中继) | 视频(720p 优先)、动态(视频/画集/图文);api 走 Vercel 中继(vercel-proxy/),视频由 Worker 直连 CDN 中转发送;解析链:bili_ticket/APP 签名/WBI 多线路 |
| 微信公众号 | ✅ 可用 | 图文 → telegra.ph;图片走 qpic.cn.in 反代;个别节点可能被微信环境验证拦截,重试可过 |

> **中继说明**:B站 API 与微博媒体 CDN 都对 Cloudflare IP 做风控,统一经 `MEDIA_RELAY_*` 配置的中继出口。
> 防盗链说明:微博/抖音视频等有 Referer 防盗链的资源,发送时由 Worker 中转(relay)或经本站 `/proxy` 补头。

## 诊断端点

部署后可用 `/debug/parse` 从 Cloudflare 边缘直接测试解析器(排查平台风控时非常有用):

```bash
# 测试解析器
curl "https://<worker域名>/debug/parse?secret=<WEBHOOK_SECRET>&url=<链接>"

# 原始抓取模式:查看状态码/最终 URL/页面标记(可指定 UA: desktop/mobile/googlebot/sogou/micromessenger)
curl "https://<worker域名>/debug/parse?secret=<WEBHOOK_SECRET>&raw=1&ua=mobile&url=<链接>"

# 查看页面中某个标记的上下文(如 $render_data)
curl "https://<worker域名>/debug/parse?secret=<WEBHOOK_SECRET>&raw=1&around=<标记文本>&url=<链接>"
```

## 部署

前置:一个 Cloudflare 账号(免费计划即可)、一个 Telegram Bot Token(向 [@BotFather](https://t.me/BotFather) 申请,并开启 Inline Mode:`/setinline`)。

```bash
npm install

# 1. 登录 Cloudflare
npx wrangler login

# 2. 设置机密(按提示粘贴)
npx wrangler secret put BOT_TOKEN       # Bot Token
npx wrangler secret put WEBHOOK_SECRET  # 随机字符串,自行生成,如 openssl rand -hex 32

# 3. 部署
npm run deploy

# 4. 注册 webhook(浏览器或 curl 访问,替换为你的 worker 域名和密钥)
curl "https://mediabot.<你的子域>.workers.dev/setup?secret=<WEBHOOK_SECRET>"
# 返回 {"ok":true,...} 即完成
```

可选机密:

```bash
# Instagram 完整模式(视频/图集):浏览器登录 instagram.com 后,F12 → Application → Cookies 复制整串
npx wrangler secret put INSTAGRAM_COOKIE   # 未配置时 IG 仅发封面图

# 媒体/API 中继(B站 API 与微博 CDN 对 Cloudflare IP 全系风控,需干净 IP 出口):
npx wrangler secret put MEDIA_RELAY_URL    # 例:https://你的vercel应用/api/proxy?url=
npx wrangler secret put MEDIA_RELAY_TOKEN  # 中继的 x-proxy-token 鉴权串

# 自建 /proxy 的对外独立域名(在 Cloudflare 仪表盘 → Workers → mediabot → Settings → Domains
# 把自定义域名绑到本 worker 后设置;未配置时用 workers.dev 域名拼代理链接):
npx wrangler secret put PROXY_ORIGIN       # 例:https://proxy.example.com
```

**中继部署**(Vercel 免费方案,函数区域 Hong Kong,流式转发大视频):Vercel 项目的 rootDirectory 已设为 `vercel-proxy`,由 CD 流水线随 worker 一起部署(见「CI/CD」节);也可在仓库根目录 `npx vercel deploy --prod` 手动部署。协议兼容 bili-resolver,白名单含 B站/微博域名,把地址和 token 写入上面两个 secret。注意:项目的 Deployment Protection 必须保持仅预览(默认),若对生产部署开启 SSO 保护,worker 服务端调用会被 404 拦截。视频中转(`/proxy`,补 Referer)已内置在本 worker,无需额外部署。

之后给 Bot 私聊发链接即可;群聊中 Bot 需要能读到消息(BotFather `/setprivacy` 关闭,或将 Bot 设为管理员)。

## 开发

```bash
npm run dev        # 本地开发(wrangler dev;首次需允许 workerd 的 postinstall 脚本)
npm run test       # vitest 单元测试
npm run typecheck  # tsc --noEmit
```

本地调试 webhook 需要公网可达,可直接 `wrangler deploy` 后用 Telegram 实测,或使用 `wrangler dev --remote`。

## 架构

```
src/
  index.ts        — 入口:/setup 注册 webhook、/webhook 校验 secret 后 waitUntil 异步分发
  bot/
    telegram.ts   — Bot API 封装(JSON / multipart 上传)
    dispatch.ts   — message / inline_query 分发
    sender.ts     — 发送策略:URL 直发优先 → relay 中转兜底 → 超限提示
    media.ts      — relay 下载(防盗链头、50MB 上限)
  parsers/
    index.ts      — URL 提取、平台注册表
    douyin.ts     — 短链展开 → iesdouyin 分享页 _ROUTER_DATA(避开 www.douyin.com 的 JS 挑战)
    twitter.ts    — syndication tweet-result 嵌入端点
    tiktok.ts     — 详情页 __UNIVERSAL_DATA_FOR_REHYDRATION__
    weibo.ts      — 蜘蛛 UA 抓 detail 页 $render_data(支持转发微博)
    xhs.ts        — xhslink 短链展开 → 笔记页 __INITIAL_STATE__(免签名)
    instagram.ts  — oEmbed(免登录)+ 移动端 API(cookie 完整模式)
    wechat.ts     — mp.weixin.qq.com → Turndown(MD) → qpic.cn.in 反代 → telegra.ph
    telegraph.ts  — telegra.ph API、formatContent 管线(MD→HTML→白名单→Telegraph 节点)
```

## 已知限制

- 网页解析随目标站改版可能失效,表现为解析失败提示,需跟进修复对应 parser
- **无转码**:非 mp4/H.264 视频可能无法在 Telegram 内嵌播放
- 免费版 Workers:CPU 10ms/请求(解析均为 I/O 等待,不受影响)、内存 128MB(relay ≤50MB 安全)
- B站/微博依赖 `MEDIA_RELAY_*` 中继;未配置时这两个平台不可用

## CI/CD

- **CI**(`.github/workflows/ci.yml`):非 main 分支 push 与 PR 触发,跑 `typecheck` + `vitest`
- **CD**(`.github/workflows/deploy.yml`):push 到 main 触发,测试通过后依次部署 Cloudflare Worker(`wrangler deploy`)和 Vercel 中继(`vercel deploy --prebuilt`;未配置 `VERCEL_TOKEN` 时跳过该步)

CD 需要在仓库 **Settings → Secrets and variables → Actions** 配置:

| Secret | 说明 |
| --- | --- |
| `CF_API_TOKEN` | Cloudflare API Token(My Profile → API Tokens,需 Workers 编辑权限) |
| `CF_ACCOUNT_ID` | Cloudflare Account ID(仪表盘右侧可见) |
| `VERCEL_TOKEN` | Vercel Access Token(vercel.com/account/tokens,scope 选本团队;配置后 CD 才部署中继) |
| `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | Vercel 团队/项目 ID(见 `vercel-proxy/.vercel/project.json`) |

可选:在 **Settings → Variables** 配置 `CUSTOM_DOMAIN`(如 `jiexi.example.com`),CD 部署时会用 `wrangler deploy --domains` 绑定该自定义域名;不配置则只使用 workers.dev 域名。

> `BOT_TOKEN` / `WEBHOOK_SECRET` / `INSTAGRAM_COOKIE` 等 Worker secrets 存于 Cloudflare,`wrangler deploy` 不会清除,无需在 CI 重复配置。
>
> 隐私说明:仓库不包含任何个人域名/账号信息;自定义域名通过仪表盘绑定或 `--domains` 参数注入。

## 开源协议

MIT
