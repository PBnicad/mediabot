import { describe, expect, it } from 'vitest';
import { extractUrls, findParser } from '../src/parsers';
import { cleanShareUrl } from '../src/parsers/clean';
import { convertImageUrl, formatContent } from '../src/parsers/telegraph';
import { LONG_TEXT_THRESHOLD, buildTelegraphMessage, isLongText, isMultiImage, telegraphImageUrls, videoDirectUrl } from '../src/bot/sender';
import type { ParseResult } from '../src/parsers/types';

describe('extractUrls', () => {
  it('从纯文本中提取链接', () => {
    expect(extractUrls('看看这个 https://v.douyin.com/abc123/ 很好笑')).toEqual(['https://v.douyin.com/abc123/']);
  });

  it('剥离尾部中英文标点', () => {
    expect(extractUrls('链接:https://www.bilibili.com/video/BV1xx411c7mD。')).toEqual([
      'https://www.bilibili.com/video/BV1xx411c7mD',
    ]);
    expect(extractUrls('https://x.com/user/status/12345,')).toEqual(['https://x.com/user/status/12345']);
  });

  it('提取多个链接', () => {
    const urls = extractUrls('https://v.douyin.com/a/ 和 https://b23.tv/bcd');
    expect(urls).toHaveLength(2);
  });

  it('无链接返回空数组', () => {
    expect(extractUrls('没有链接的文本')).toEqual([]);
  });
});

describe('findParser 平台识别', () => {
  const cases: [string, string][] = [
    ['https://v.douyin.com/abc123/', 'douyin'],
    ['https://www.douyin.com/video/7123456789', 'douyin'],
    ['https://www.douyin.com/note/7123456789', 'douyin'],
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili'],
    ['https://b23.tv/abc123', 'bilibili'],
    ['https://www.bilibili.com/video/av170001', 'bilibili'],
    ['https://t.bilibili.com/953619104940425225', 'bilibili'],
    ['https://www.bilibili.com/opus/953619104940425225', 'bilibili'],
    ['https://m.bilibili.com/dynamic/953619104940425225', 'bilibili'],
    ['https://twitter.com/user/status/1234567890', 'twitter'],
    ['https://x.com/user/status/1234567890', 'twitter'],
    ['https://www.tiktok.com/@user/video/7123456789', 'tiktok'],
    ['https://vt.tiktok.com/abc123/', 'tiktok'],
    ['https://weibo.com/1234567890/AbCdEfGh', 'weibo'],
    ['https://m.weibo.cn/status/AbCdEfGh', 'weibo'],
    ['https://video.weibo.com/show?fid=1034:5327932424388664', 'weibo'],
    ['https://mp.weixin.qq.com/s/abcdefg', 'wechat'],
    ['http://xhslink.com/o/7ncNUxICbbN', 'xhs'],
    ['http://xhslink.cn/o/3qZDxC8KQUI', 'xhs'],
    ['https://www.xiaohongshu.com/explore/68dd2cc5000000000302f847?xsec_token=abc', 'xhs'],
    ['https://www.xiaohongshu.com/discovery/item/68dd2cc5000000000302f847', 'xhs'],
    ['https://www.instagram.com/reel/C6yfrbXskx4/', 'instagram'],
    ['https://www.instagram.com/p/ABC123def/', 'instagram'],
  ];

  for (const [url, expected] of cases) {
    it(`${url} → ${expected}`, () => {
      const found = findParser(url);
      expect(found?.parser.id).toBe(expected);
    });
  }

  it('从混合文本中找到支持的链接', () => {
    const found = findParser('复制打开抖音 https://v.douyin.com/abc123/ 01/23 复制此段');
    expect(found?.parser.id).toBe('douyin');
    expect(found?.url).toBe('https://v.douyin.com/abc123/');
  });

  it('不支持的链接返回 null', () => {
    expect(findParser('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(findParser('https://example.com/')).toBeNull();
    expect(findParser('没有链接')).toBeNull();
  });
});

describe('telegraph formatContent', () => {
  it('Markdown 段落/加粗/标题转换', () => {
    const nodes = formatContent('# 标题\n\n你好**世界**');
    expect(nodes).toEqual([
      { tag: 'h3', children: ['标题'] },
      { tag: 'p', children: ['你好', { tag: 'b', children: ['世界'] }] },
    ]);
  });

  it('Markdown 图片转 img 节点并保留 src', () => {
    const nodes = formatContent('![alt](https://qpic.cn.in/mmbiz.qpic.cn/a/b.jpg)');
    expect(nodes).toContainEqual({ tag: 'img', attrs: { src: 'https://qpic.cn.in/mmbiz.qpic.cn/a/b.jpg?wxtype=jpeg&wxfrom=0', alt: 'alt' } });
  });

  it('h1/h2 清洗后映射为 h3/h4', () => {
    const nodes = formatContent('<h1>大标题</h1><h2>小标题</h2>');
    expect(nodes).toEqual([
      { tag: 'h3', children: ['大标题'] },
      { tag: 'h4', children: ['小标题'] },
    ]);
  });

  it('链接保留 href', () => {
    const nodes = formatContent('[链接](https://example.com)');
    expect(nodes).toEqual([{ tag: 'p', children: [{ tag: 'a', attrs: { href: 'https://example.com' }, children: ['链接'] }] }]);
  });

  it('丢弃非法标签(iframe),保留正文', () => {
    const nodes = formatContent('<p>正文</p><iframe src="https://x.com"></iframe>');
    expect(nodes).toEqual([{ tag: 'p', children: ['正文'] }]);
  });
});

describe('convertImageUrl', () => {
  it('mmbiz 域名替换并补参数', () => {
    expect(convertImageUrl('https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg')).toBe(
      'https://qpic.cn.in/mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg&wxtype=jpeg&wxfrom=0',
    );
  });

  it('wx.qlogo.cn 域名替换', () => {
    expect(convertImageUrl('https://wx.qlogo.cn/mmhead/abc/0')).toBe(
      'https://qpic.cn.in/wx.qlogo.cn/mmhead/abc/0?wxtype=jpeg&wxfrom=0',
    );
  });

  it('已代理的只补参数不重复代理', () => {
    expect(convertImageUrl('https://qpic.cn.in/mmbiz.qpic.cn/abc/640')).toBe(
      'https://qpic.cn.in/mmbiz.qpic.cn/abc/640?wxtype=jpeg&wxfrom=0',
    );
  });

  it('非微信图床原样返回', () => {
    expect(convertImageUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });
});

function makeResult(overrides: Partial<ParseResult>): ParseResult {
  return {
    platform: 'test',
    platformName: '测试平台',
    type: 'video',
    sourceUrl: 'https://example.com/post/1',
    media: [],
    ...overrides,
  };
}

describe('长文模式', () => {
  it(`标题超过 ${LONG_TEXT_THRESHOLD} 字符判定为长文`, () => {
    expect(isLongText(makeResult({ title: 'a'.repeat(LONG_TEXT_THRESHOLD + 1) }))).toBe(true);
    expect(isLongText(makeResult({ title: 'a'.repeat(LONG_TEXT_THRESHOLD) }))).toBe(false);
    expect(isLongText(makeResult({ title: '短标题' }))).toBe(false);
    expect(isLongText(makeResult({ title: undefined }))).toBe(false);
  });

  it('article 类型不参与长文判定(本身就走 telegraph)', () => {
    expect(isLongText(makeResult({ type: 'article', title: 'a'.repeat(2000) }))).toBe(false);
  });

  it('长文消息只含 Telegraph 与原文链接,不含正文', () => {
    const longTitle = `开头一句话。${'长'.repeat(900)}`;
    const msg = buildTelegraphMessage(makeResult({ title: longTitle, author: '作者' }), 'https://telegra.ph/abc-01-01');
    expect(msg).toContain('https://telegra.ph/abc-01-01');
    expect(msg).toContain('原文链接');
    expect(msg).toContain('作者');
    expect(msg).not.toContain('长');
    expect(msg.length).toBeLessThan(300);
  });
});

describe('多图模式', () => {
  const img = (url: string, referer?: string) => ({ type: 'image' as const, url, referer });

  it('图片超过 1 张判定为多图', () => {
    expect(isMultiImage(makeResult({ type: 'images', media: [img('https://a/1.jpg'), img('https://a/2.jpg')] }))).toBe(true);
    expect(isMultiImage(makeResult({ type: 'images', media: [img('https://a/1.jpg')] }))).toBe(false);
    expect(isMultiImage(makeResult({ type: 'video', media: [{ type: 'video', url: 'https://a/v.mp4' }] }))).toBe(false);
  });

  it('Telegraph 配图:防盗链图无 origin 时丢弃,有 origin 时经本站代理', () => {
    const result = makeResult({
      type: 'images',
      media: [img('https://a/1.jpg'), img('https://wx.sinaimg.cn/2.jpg', 'https://weibo.com/')],
    });
    expect(telegraphImageUrls(result)).toEqual(['https://a/1.jpg']);
    expect(telegraphImageUrls(result, 'https://bot.example.com')).toEqual([
      'https://a/1.jpg',
      `https://bot.example.com/proxy?url=${encodeURIComponent('https://wx.sinaimg.cn/2.jpg')}`,
    ]);
    expect(telegraphImageUrls(makeResult({ type: 'video' }))).toEqual([]);
  });

  it('配置自建代理后,xhscdn/hdslb 图集优先进本站 /proxy', () => {
    const result = makeResult({
      type: 'images',
      media: [img('https://sns-webpic-qc.xhscdn.com/a.jpg'), img('https://i0.hdslb.com/bfs/x.jpg')],
    });
    expect(telegraphImageUrls(result, 'https://proxy.example.com')).toEqual([
      `https://proxy.example.com/proxy?url=${encodeURIComponent('https://sns-webpic-qc.xhscdn.com/a.jpg')}`,
      `https://proxy.example.com/proxy?url=${encodeURIComponent('https://i0.hdslb.com/bfs/x.jpg')}`,
    ]);
  });

  it('小红书 xhscdn / B站 hdslb 图经 qpic.cn.in 反代(完整 URL 形式)', () => {
    const result = makeResult({
      type: 'images',
      media: [
        img('https://sns-webpic-qc.xhscdn.com/2026/a/1040g2sg323f0ad450a4g!nd_dft_wlteh_jpg_3'),
        img('https://i0.hdslb.com/bfs/archive/4a2bc8cd.jpg'),
      ],
    });
    expect(telegraphImageUrls(result)).toEqual([
      'https://qpic.cn.in/https://sns-webpic-qc.xhscdn.com/2026/a/1040g2sg323f0ad450a4g!nd_dft_wlteh_jpg_3',
      'https://qpic.cn.in/https://i0.hdslb.com/bfs/archive/4a2bc8cd.jpg',
    ]);
  });
});

describe('视频直发候选', () => {
  it('防盗链视频有 origin 时经本站代理,无 origin 时放弃直发', () => {
    const v = { type: 'video' as const, url: 'https://f.video.weibocdn.com/x.mp4', referer: 'https://weibo.com/' };
    expect(videoDirectUrl(v)).toBeNull();
    expect(videoDirectUrl(v, 'https://bot.example.com')).toBe(
      `https://bot.example.com/proxy?url=${encodeURIComponent('https://f.video.weibocdn.com/x.mp4')}`,
    );
  });

  it('无防盗链或已有公开代理链(rawUrl)时用原 url', () => {
    expect(videoDirectUrl({ type: 'video', url: 'https://a/v.mp4' })).toBe('https://a/v.mp4');
    expect(
      videoDirectUrl(
        { type: 'video', url: 'https://bot.example.com/proxy?url=x', rawUrl: 'https://upos.cn/v.mp4', referer: 'https://b.com/' },
        'https://bot.example.com',
      ),
    ).toBe('https://bot.example.com/proxy?url=x');
  });
});

describe('分享链接清洗(去用户指纹)', () => {
  const cases: [string, string, string][] = [
    ['小红书', 'https://www.xiaohongshu.com/explore/66e1c2d5000000001e023456?xsec_token=ABcd1234&xsec_source=pc_share', 'https://www.xiaohongshu.com/explore/66e1c2d5000000001e023456'],
    ['小红书discovery', 'https://www.xiaohongshu.com/discovery/item/66e1c2d5000000001e023456?xsec_token=ABcd1234', 'https://www.xiaohongshu.com/explore/66e1c2d5000000001e023456'],
    ['抖音分享页', 'https://www.iesdouyin.com/share/video/7510234567890123456/?region=CN&share_id=999&u_code=abc', 'https://www.douyin.com/video/7510234567890123456'],
    ['抖音图集', 'https://www.douyin.com/note/7510234567890123456?share_token=xyz', 'https://www.douyin.com/note/7510234567890123456'],
    ['B站视频', 'https://www.bilibili.com/video/BV1xx411c7mD?t=1&spm_id_from=333.999&vd_source=abc123', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ['B站分P保留', 'https://www.bilibili.com/video/BV1xx411c7mD?p=3&vd_source=abc123', 'https://www.bilibili.com/video/BV1xx411c7mD?p=3'],
    ['B站动态', 'https://t.bilibili.com/987654321?spm_id_from=333.999', 'https://t.bilibili.com/987654321'],
    ['B站opus', 'https://www.bilibili.com/opus/987654321?from=share', 'https://t.bilibili.com/987654321'],
    ['TikTok', 'https://www.tiktok.com/@user999/video/7510234567890123456?_t=8abc&_r=1', 'https://www.tiktok.com/@user999/video/7510234567890123456'],
    ['微博主页', 'https://weibo.com/6915061973/PAbCdEfGh?share_token=xyz&from=page', 'https://weibo.com/6915061973/PAbCdEfGh'],
    ['微博视频页', 'https://video.weibo.com/show?fid=1034:5327932424388664&from=share', 'https://video.weibo.com/show?fid=1034:5327932424388664'],
    ['X', 'https://x.com/someuser/status/1987654321098765432?s=20&t=AbCdEf', 'https://x.com/someuser/status/1987654321098765432'],
    ['Twitter', 'https://twitter.com/someuser/status/1987654321098765432?s=20', 'https://twitter.com/someuser/status/1987654321098765432'],
    ['Instagram', 'https://www.instagram.com/reel/DQcdEfGhIj/?igsh=MTkxYmY0abc==&utm_source=share', 'https://www.instagram.com/reel/DQcdEfGhIj/'],
    ['微信长链', 'https://mp.weixin.qq.com/s?__biz=MzA3xx&mid=224748&idx=1&sn=abcdef&chksm=1a2b3c&scene=21#wechat_redirect', 'https://mp.weixin.qq.com/s?__biz=MzA3xx&mid=224748&idx=1&sn=abcdef'],
    ['微信短链', 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOp#wechat_redirect', 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMnOp'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(cleanShareUrl(input)).toBe(expected);
    });
  }

  it('非法 URL 原样返回', () => {
    expect(cleanShareUrl('not a url')).toBe('not a url');
  });
});

describe('convertImageUrl 图床反代(自建优先,qpic 兜底)', () => {
  const PROXY = 'https://proxy.example.com';

  it('配置自建代理域名后,微信/小红书/B站图床优先走本站 /proxy', () => {
    expect(convertImageUrl('https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg', PROXY)).toBe(
      `${PROXY}/proxy?url=${encodeURIComponent('https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg')}`,
    );
    expect(convertImageUrl('https://sns-webpic-qc.xhscdn.com/a.jpg', PROXY)).toBe(
      `${PROXY}/proxy?url=${encodeURIComponent('https://sns-webpic-qc.xhscdn.com/a.jpg')}`,
    );
    expect(convertImageUrl('https://i0.hdslb.com/bfs/archive/x.jpg', PROXY)).toBe(
      `${PROXY}/proxy?url=${encodeURIComponent('https://i0.hdslb.com/bfs/archive/x.jpg')}`,
    );
  });

  it('未配置代理域名时回退 qpic.cn.in(微信 host 前缀 + wxtype)', () => {
    expect(convertImageUrl('https://mmbiz.qpic.cn/mmbiz_jpg/abc/640')).toBe(
      'https://qpic.cn.in/mmbiz.qpic.cn/mmbiz_jpg/abc/640?wxtype=jpeg&wxfrom=0',
    );
  });

  it('已是 /proxy 链接的原样返回(不补 wxtype、不重复代理)', () => {
    const u = `${PROXY}/proxy?url=${encodeURIComponent('https://mmbiz.qpic.cn/a/640')}`;
    expect(convertImageUrl(u, PROXY)).toBe(u);
  });

  it('未知图床不代理', () => {
    expect(convertImageUrl('https://pbs.twimg.com/media/x.jpg', PROXY)).toBe('https://pbs.twimg.com/media/x.jpg');
  });
});
