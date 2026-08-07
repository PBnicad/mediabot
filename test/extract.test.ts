import { describe, expect, it } from 'vitest';
import { extractUrls, findParser } from '../src/parsers';
import { convertImageUrl, formatContent } from '../src/parsers/telegraph';
import { LONG_TEXT_THRESHOLD, buildLongTextMessage, isLongText } from '../src/bot/sender';
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
    ['https://twitter.com/user/status/1234567890', 'twitter'],
    ['https://x.com/user/status/1234567890', 'twitter'],
    ['https://www.tiktok.com/@user/video/7123456789', 'tiktok'],
    ['https://vt.tiktok.com/abc123/', 'tiktok'],
    ['https://weibo.com/1234567890/AbCdEfGh', 'weibo'],
    ['https://m.weibo.cn/status/AbCdEfGh', 'weibo'],
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
    const msg = buildLongTextMessage(makeResult({ title: longTitle, author: '作者' }), 'https://telegra.ph/abc-01-01');
    expect(msg).toContain('https://telegra.ph/abc-01-01');
    expect(msg).toContain('原文链接');
    expect(msg).toContain('作者');
    expect(msg).not.toContain('长');
    expect(msg.length).toBeLessThan(300);
  });
});
