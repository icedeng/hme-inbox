import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import {
  extractVerificationCode,
  CODE_CONFIDENCE_THRESHOLD,
} from '../src/lib/email/verificationCode.ts';
import { htmlToText, decodeEntities } from '../src/lib/email/htmlToText.ts';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('htmlToText', () => {
  test('整块剔除 style，CSS 不得漏进正文', () => {
    const html = `
      <html><head><style>
        #outlook a { padding: 0; }
        body { font-weight: 400; margin: 0pt; width: 100%; }
      </style></head>
      <body><p>输入此临时验证码以继续：</p><p>935298</p></body></html>`;
    const text = htmlToText(html);
    assert.ok(!text.includes('font-weight'), 'CSS 属性漏进了正文');
    assert.ok(!text.includes('400'), 'CSS 里的 400 漏进了正文');
    assert.ok(!text.includes('outlook'), 'CSS 选择器漏进了正文');
    assert.ok(text.includes('935298'));
  });

  test('未闭合的 style 也要丢弃到末尾，不能放行 CSS', () => {
    const text = htmlToText('<style>body{font-size:400px}<p>hi 123456</p>');
    assert.ok(!text.includes('400'));
  });

  test('块级元素转成换行，保住「独占一行」这个信号', () => {
    const text = htmlToText('<div>Your code</div><div>MJP-0LS</div>');
    assert.match(text, /Your code\n+MJP-0LS/);
    // 「独占一行」是 standalone 层的定位依据，必须真的独占
    assert.ok(text.split('\n').includes('MJP-0LS'));
  });

  test('实体解码', () => {
    assert.equal(decodeEntities('&copy; 2026 &amp; more&nbsp;x'), '© 2026 & more x');
    assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  });
});

describe('验证码提取 — 真实样本形态', () => {
  test('ChatGPT：中文标签 + 全角冒号 + 6 位数字', () => {
    const r = extractVerificationCode({
      subject: '你的 ChatGPT 临时验证码',
      html: '<p>输入此临时验证码以继续：</p><p>935298</p><p>如果并非你本人尝试创建 ChatGPT 帐户，请忽略此电子邮件。</p>',
    });
    assert.equal(r.best?.code, '935298');
    assert.ok(r.best!.confidence >= 0.9, `置信度偏低：${r.best!.confidence}`);
  });

  test('SpaceXAI：分组码 MJP-0LS，且正文里的 © 2026 不得被当成码', () => {
    const r = extractVerificationCode({
      subject: 'SpaceXAI confirmation code: MJP-0LS',
      html:
        '<p>Thank you for creating a SpaceXAI account. Please use the code below to validate your email address.</p>' +
        '<p>MJP-0LS</p>' +
        '<p>If you did not create a new account, please ignore this email.</p>' +
        '<p>&copy; 2026 X.AI LLC For questions contact support@x.ai</p>',
    });
    assert.equal(r.best?.code, 'MJP-0LS');
    const codes = r.candidates.map((c) => c.code);
    assert.ok(!codes.includes('2026'), `年份被当成了候选：${codes.join(', ')}`);
  });

  test('分组码不因中间连字符被拆成两个过短片段', () => {
    const r = extractVerificationCode({
      subject: 'Your verification code: ABC-123',
      text: 'Use ABC-123 to continue.',
    });
    assert.equal(r.best?.code, 'ABC-123');
  });

  test('0 与 O 原样返回，绝不「纠正」', () => {
    const r = extractVerificationCode({
      subject: 'confirmation code: MJP-0LS',
      text: 'code MJP-0LS',
    });
    assert.equal(r.best?.code, 'MJP-0LS');
    assert.ok(!r.candidates.some((c) => c.code === 'MJP-OLS'));
  });
});

describe('验证码提取 — 误报排除', () => {
  const mustNotExtract = (
    name: string,
    input: Parameters<typeof extractVerificationCode>[0],
    forbidden: string,
  ) => {
    test(name, () => {
      const r = extractVerificationCode(input);
      const codes = r.candidates.map((c) => c.code);
      assert.ok(
        !codes.includes(forbidden),
        `不该提取 ${forbidden}，实际候选：${codes.join(', ') || '(空)'}`,
      );
    });
  };

  mustNotExtract(
    '版权年份 © 2026',
    { subject: 'Welcome', text: 'Thanks for joining. © 2026 Acme Inc.' },
    '2026',
  );
  mustNotExtract(
    'Copyright 2025 写法',
    { subject: 'Hello', text: 'Copyright 2025 Example Corp. All rights reserved.' },
    '2025',
  );
  mustNotExtract(
    '裸年份没有标签时丢弃',
    { subject: 'Newsletter', text: 'Our 2026 roadmap is now live.' },
    '2026',
  );
  mustNotExtract(
    '电话号码',
    { subject: 'Support', text: 'Call us at 555-123-4567 anytime.' },
    '555-123-4567',
  );
  mustNotExtract(
    '日期',
    { subject: 'Receipt', text: 'Your order shipped on 2026-08-05.' },
    '2026',
  );
  mustNotExtract(
    '金额',
    { subject: 'Invoice', text: 'Total due: $12345 by Friday.' },
    '12345',
  );
  mustNotExtract(
    '百分比',
    { subject: 'Report', text: 'Conversion improved 2540 % this quarter.' },
    '2540',
  );
  mustNotExtract(
    'CSS 尺寸',
    { subject: 'Hi', html: '<div style="width:600px">Hello there</div>' },
    '600',
  );
  mustNotExtract(
    '十六进制颜色',
    { subject: 'Hi', text: 'Brand color is #A1B2C3 for headers.' },
    'A1B2C3',
  );
  mustNotExtract(
    'URL 里的数字',
    { subject: 'Link', text: 'Visit https://example.com/track/847266 for status.' },
    '847266',
  );
  mustNotExtract(
    '邮箱地址里的数字',
    { subject: 'Contact', text: 'Reach us at support123@example.com.' },
    '123',
  );
  mustNotExtract(
    '订单号',
    { subject: 'Order', text: 'Your order number: 88431276 has shipped.' },
    '88431276',
  );
  mustNotExtract(
    '全同数字',
    { subject: 'Your code', text: 'Your verification code is 000000' },
    '000000',
  );
  mustNotExtract(
    '连续数字',
    { subject: 'Your code', text: 'Your verification code is 123456' },
    '123456',
  );

  test('纯营销邮件不产生任何 best', () => {
    const r = extractVerificationCode({
      subject: 'Summer sale is here',
      html:
        '<style>.btn{padding:12px;font-size:400}</style>' +
        '<p>Save up to 50 % on 2026 collections. Call 555-123-4567.</p>' +
        '<p>&copy; 2026 Shop Inc.</p>',
    });
    assert.equal(r.best, null, `不该有 best，实际：${JSON.stringify(r.best)}`);
  });
});

describe('验证码提取 — 常见句式', () => {
  test('英文标签直接相邻', () => {
    const r = extractVerificationCode({
      subject: 'Your verification code is 482915',
      text: 'Your verification code is 482915. It expires in 10 minutes.',
    });
    assert.equal(r.best?.code, '482915');
  });

  test('反向句式 “X is your code”', () => {
    const r = extractVerificationCode({
      subject: 'GitHub',
      text: '739204 is your GitHub authentication code.',
    });
    assert.equal(r.best?.code, '739204');
  });

  test('中文「您的验证码为」', () => {
    const r = extractVerificationCode({
      subject: '安全提醒',
      text: '您的验证码为 620173，5 分钟内有效。请勿转发。',
    });
    assert.equal(r.best?.code, '620173');
  });

  test('OTP 缩写', () => {
    const r = extractVerificationCode({
      subject: 'Login',
      text: 'Your OTP: 91824',
    });
    assert.equal(r.best?.code, '91824');
  });

  test('低置信度时不给 best，避免调用方拿到可疑值', () => {
    const r = extractVerificationCode({
      subject: 'Update',
      text: 'Some number 4829 appears in your file.',
    });
    assert.equal(r.best, null);
  });

  test('best 一旦非空，置信度必然达标', () => {
    const r = extractVerificationCode({
      subject: 'Your verification code is 482915',
      text: 'Your verification code is 482915.',
    });
    assert.notEqual(r.best, null);
    assert.ok(r.best!.confidence >= CODE_CONFIDENCE_THRESHOLD);
  });
});

describe('验证码提取 — 真实脱敏固件回归', () => {
  const fixtures = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.redacted.eml'))
    : [];

  test('固件存在', { skip: fixtures.length === 0 ? '还没生成脱敏固件' : false }, () => {
    assert.ok(fixtures.length > 0);
  });

  for (const file of fixtures) {
    test(`${file} 能提到码且不含年份`, async () => {
      const raw = readFileSync(resolve(FIXTURE_DIR, file));
      const parsed = await simpleParser(raw);
      const r = extractVerificationCode({
        subject: parsed.subject,
        text: parsed.text,
        html: typeof parsed.html === 'string' ? parsed.html : null,
      });
      const codes = r.candidates.map((c) => c.code);
      assert.ok(
        !codes.some((c) => /^(19|20)\d{2}$/.test(c)),
        `候选里混进了年份：${codes.join(', ')}`,
      );
      assert.ok(
        r.best !== null,
        `没能提取到码。主题：${parsed.subject}；候选：${codes.join(', ') || '(空)'}`,
      );
    });
  }
});
