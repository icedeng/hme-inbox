import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPickupViewDefaults,
  negotiatePickupFormat,
  parseParams,
} from '../src/lib/api/pickup.ts';
import { renderPickupHtml } from '../src/lib/api/pickupHtml.ts';
import type { Alias } from '../src/lib/repositories/aliases.repo.ts';
import type { MessageSummary } from '../src/lib/repositories/messages.repo.ts';

function alias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: 1,
    email: 'sample@icloud.com',
    emailNormalized: 'sample@icloud.com',
    localPart: 'sample',
    domain: 'icloud.com',
    label: '测试',
    note: '',
    batchIndex: null,
    portal: '',
    verified: true,
    sourceCreatedAt: null,
    importBatchId: null,
    status: 'active',
    tokenHash: '',
    tokenPrefix: '',
    tokenCiphertext: Buffer.alloc(0),
    tokenVersion: 1,
    tokenRotatedAt: null,
    lastAccessAt: null,
    accessCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id: 1,
    mailbox: 'INBOX',
    fromAddress: 'sender@example.com',
    fromName: 'Sender',
    subject: '验证码',
    dateSent: null,
    dateReceived: '2026-01-01T00:00:00.000Z',
    textBody: '验证码是 123456',
    snippet: '验证码是 123456',
    verificationCode: '123456',
    codeConfidence: 1,
    codeCandidatesJson: null,
    hasAttachments: false,
    sizeBytes: 100,
    truncated: false,
    readAt: null,
    matchLayer: null,
    matchConfidence: null,
    ...overrides,
  };
}

describe('公开取件 HTML', () => {
  test('format=html 可用，默认格式仍为 json', () => {
    const html = parseParams(new URLSearchParams('format=html'));
    const defaults = parseParams(new URLSearchParams());

    assert.equal('params' in html && html.params.format, 'html');
    assert.equal('params' in defaults && defaults.params.format, 'json');
  });

  test('浏览器导航自动返回 HTML，API 请求和显式 format 保持可控', () => {
    assert.equal(
      negotiatePickupFormat('json', new URLSearchParams(), 'text/html,application/xhtml+xml,*/*;q=0.8'),
      'html',
    );
    assert.equal(negotiatePickupFormat('json', new URLSearchParams(), '*/*'), 'json');
    assert.equal(
      negotiatePickupFormat('json', new URLSearchParams(), 'application/json, text/html;q=0.8'),
      'json',
    );
    assert.equal(
      negotiatePickupFormat('json', new URLSearchParams('format=json'), 'text/html'),
      'json',
    );
  });

  test('HTML 默认展示最近 50 封，但尊重显式 n 且不改变 JSON 默认值', () => {
    const defaults = parseParams(new URLSearchParams());
    assert.ok('params' in defaults);

    assert.equal(
      applyPickupViewDefaults({ ...defaults.params, format: 'html' }, new URLSearchParams()).n,
      50,
    );
    assert.equal(
      applyPickupViewDefaults(
        { ...defaults.params, format: 'html', n: 3 },
        new URLSearchParams('n=3'),
      ).n,
      3,
    );
    assert.equal(applyPickupViewDefaults(defaults.params, new URLSearchParams()).n, 1);
  });

  test('转义不可信文本，并在 sandbox iframe 中渲染已清洗正文', () => {
    const output = renderPickupHtml(
      alias({ label: '<img src=x onerror=alert(1)>' }),
      [{
        summary: message({ subject: '<script>alert(1)</script>', fromName: '" onclick="alert(1)' }),
        htmlBody: '<p>安全正文</p><script>alert(1)</script>',
      }],
    );

    assert.ok(output.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(output.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(output.includes('<details class="card">'));
    assert.ok(!output.includes('<details class="card" open>'));
    assert.ok(output.includes('sandbox="allow-popups-to-escape-sandbox allow-scripts"'));
    assert.ok(!output.includes('allow-same-origin'));
    assert.ok(output.includes('hme-pickup-email-height'));
    assert.ok(output.includes("frame.style.height = Math.min(Math.ceil(height), 30000) + 'px'"));
    assert.ok(output.includes('&lt;p&gt;安全正文&lt;/p&gt;'));
    assert.ok(!output.includes('<script>alert(1)</script>'));
  });
});
