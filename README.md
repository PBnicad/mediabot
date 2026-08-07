# mediabot

纯 serverless 的 Telegram 链接解析 Bot,运行在 Cloudflare Workers 上,零服务器成本。

- **Bot API + Webhook**:无需 MTProto 账号,一个 Bot Token 即可运行
- **视频上限 50MB**(Bot API 硬限制),媒体原样发送(无转码/分段)

## 功能特性

- **多平台解析**:私聊/群聊发链接即解析,支持 inline 模式(`@bot <链接>`)
- **长文模式**:任意平台正文超过 800 字自动转 Telegraph,bot 只回 Telegraph 链接 + 原文链接(不刷屏);图文帖的可直链配图会一并嵌入 Telegraph 页面
- **防盗链处理**:URL 直发优先,微博/抖音视频等由 Worker 中转(relay),超过 50MB 提示限制

## 支持平台

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| 抖音 | ✅ 可用 | 视频(无水印)、图集;走 iesdouyin 分享页提取 `_ROUTER_DATA` |
| TikTok | ✅ 可用 | 视频、图集;详情页 `__UNIVERSAL_DATA_FOR_REHYDRATION__` |
| Twitter/X | ✅ 可用 | 视频、图文;syndication 嵌入端点(无需鉴权) |
| 微博 | ✅ 解析可用,⚠️ 媒体被 CDN 封 CF IP | 视频、图文(含转发微博);蜘蛛 UA 抓 detail 页 `$render_data`;媒体发送需中继 |
| 小红书 | ✅ 可用 | 视频、图文;笔记页 `__INITIAL_STATE__`(依赖新鲜 xsec_token,免签名);支持 xhslink.com/.cn 短链 |
| Instagram | ✅ 封面模式可用 | 免登录走 oEmbed(文案+作者+封面);配置 `INSTAGRAM_COOKIE` 后解锁视频/图集(移动端 API) |
| Bilibili | ✅ 可用(已配中继) | api 走 Vercel 中继(vercel-proxy/),视频由 Worker 直连 CDN 中转发送(720p 优先);解析链:bili_ticket/APP 签名/WBI 多线路 |
| 微信公众号 | ✅ 可用 | 图文 → telegra.ph;图片走 qpic.cn.in 反代;个别节点可能被微信环境验证拦截,重试可过 |

> **关于微博媒体/B站**:微博解析可用但 CDN(sinaimg/weibocdn)封 Cloudflare IP,媒体发不出;
> B站 api 全端点对 CF IP 返回 412(实测 iOS/TV app 签名、bili_ticket、WBI 均无效,纯 IP 封锁)。
> 两者都需要干净 IP 的 HTTP 中继才能恢复。
>
> 防盗链说明:微博/抖音视频有 Referer 防盗链,发送时由 Worker 中转(relay);内联(inline)模式下此类平台会引导私聊使用。

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

# B站 API 中继(B站对 Cloudflare IP 全系 412,需干净 IP 出口):
npx wrangler secret put BILI_API_RELAY     # 例:https://你的vercel应用/api/proxy?url=
npx wrangler secret put BILI_RELAY_TOKEN   # 中继的 x-proxy-token 鉴权串
```

**B站中继部署**(Vercel 免费方案,函数区域建议 Hong Kong):把 [bili-resolver 的 vercel-proxy](https://github.com/Yamada-Ryo4/bili-resolver/tree/main/vercel-proxy) 部署到你的 Vercel,改掉代码里硬编码的 token,然后把地址和 token 写入上面两个 secret。视频中转(`/proxy`,补 Referer)已内置在本 worker,无需额外部署。

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
- **微博媒体发不出**:CDN(sinaimg/weibocdn)对 Cloudflare 机房 IP 做风控,恢复需自建 HTTP 中继
- 无转码:非 mp4/H.264 视频可能无法在 Telegram 内嵌播放
- 免费版 Workers:CPU 10ms/请求(解析均为 I/O 等待,不受影响)、内存 128MB(relay ≤50MB 安全)

## CI/CD

- **CI**(`.github/workflows/ci.yml`):非 main 分支 push 与 PR 触发,跑 `typecheck` + `vitest`
- **CD**(`.github/workflows/deploy.yml`):push 到 main 触发,测试通过后 `wrangler deploy` 自动部署

CD 需要在仓库 **Settings → Secrets and variables → Actions** 配置:

| Secret | 说明 |
| --- | --- |
| `CF_API_TOKEN` | Cloudflare API Token(My Profile → API Tokens,需 Workers 编辑权限) |
| `CF_ACCOUNT_ID` | Cloudflare Account ID(仪表盘右侧可见) |

可选:在 **Settings → Variables** 配置 `CUSTOM_DOMAIN`(如 `jiexi.example.com`),CD 部署时会用 `wrangler deploy --domains` 绑定该自定义域名;不配置则只使用 workers.dev 域名。

> `BOT_TOKEN` / `WEBHOOK_SECRET` / `INSTAGRAM_COOKIE` 等 Worker secrets 存于 Cloudflare,`wrangler deploy` 不会清除,无需在 CI 重复配置。
>
> 隐私说明:仓库不包含任何个人域名/账号信息;自定义域名通过仪表盘绑定或 `--domains` 参数注入。

## 开源协议

MIT
