import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitHeaderBlock, parseHeaders, parseICloudHmeHeader, decodeEncodedWords } from '../src/lib/email/headers.ts';
import { normalizeAddress, parseAddressList } from '../src/lib/email/address.ts';
import { buildAliasIndex } from '../src/lib/matching/aliasIndex.ts';
import { matchAlias } from '../src/lib/matching/matchAlias.ts';
import { DEFAULT_RULES } from '../src/lib/matching/rules.ts';
import { parseBatchJsonl } from '../src/lib/importer/importJsonl.ts';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const ALIASES = [
  { id: 1, emailNormalized: 'cobalt-alibi-1g@icloud.com', status: 'active' as const },
  { id: 2, emailNormalized: 'linen_cornel5g@icloud.com', status: 'active' as const },
  { id: 3, emailNormalized: 'mint.cave.4m@icloud.com', status: 'active' as const },
  { id: 4, emailNormalized: 'mintcave4m@icloud.com', status: 'active' as const },
  { id: 5, emailNormalized: '77.hazel_muskier@icloud.com', status: 'active' as const },
  { id: 9, emailNormalized: 'disabled-one-9z@icloud.com', status: 'disabled' as const },
];

const index = buildAliasIndex(ALIASES);

function run(rawMessage: string) {
  const { headerBlock, body } = splitHeaderBlock(rawMessage);
  return matchAlias({
    headers: parseHeaders(headerBlock),
    rawHeaderBlock: headerBlock,
    textBody: body,
    index,
    rules: DEFAULT_RULES,
  });
}

describe('地址规范化', () => {
  test('剥离 display name 与尖括号', () => {
    const a = normalizeAddress('Hide My Email <cobalt-alibi-1g@icloud.com>')!;
    assert.equal(a.normalized, 'cobalt-alibi-1g@icloud.com');
  });

  test('绝不做 dot-stripping —— 去点会造成跨别名错误投递', () => {
    const dotted = normalizeAddress('mint.cave.4m@icloud.com')!;
    const plain = normalizeAddress('mintcave4m@icloud.com')!;
    assert.notEqual(dotted.normalized, plain.normalized);
    assert.equal(dotted.normalized, 'mint.cave.4m@icloud.com');
  });

  test('plus 标签同时给出截断版与完整版', () => {
    const a = normalizeAddress('cobalt-alibi-1g+shop@icloud.com')!;
    assert.equal(a.normalized, 'cobalt-alibi-1g@icloud.com');
    assert.equal(a.fullNormalized, 'cobalt-alibi-1g+shop@icloud.com');
  });

  test('大小写统一，域名去尾点', () => {
    const a = normalizeAddress('  cobalt-alibi-1g@iCloud.COM.  ')!;
    assert.equal(a.normalized, 'cobalt-alibi-1g@icloud.com');
  });

  test('畸形地址返回 null 而不抛异常', () => {
    for (const bad of ['', 'no-at-sign', '@nolocal.com', 'nodomain@', 'a b@c.com', 'x@y']) {
      assert.equal(normalizeAddress(bad), null, `应拒绝：${bad}`);
    }
  });

  test('地址列表切分不被 display name 里的逗号骗到', () => {
    const list = parseAddressList('"Doe, John" <a.one-1x@icloud.com>, Bob <b_two2y@icloud.com>');
    assert.equal(list.length, 2);
    assert.equal(list[0]!.normalized, 'a.one-1x@icloud.com');
    assert.equal(list[1]!.normalized, 'b_two2y@icloud.com');
  });
});

describe('头部解析', () => {
  test('unfold 续行，长地址不被换行切断', () => {
    const headers = parseHeaders('To: Hide My Email\r\n <cobalt-alibi-1g@icloud.com>\r\nSubject: hi');
    assert.equal(headers[0]!.value, 'Hide My Email <cobalt-alibi-1g@icloud.com>');
  });

  test('解码 RFC 2047 encoded-word（实测 ChatGPT 中文主题）', () => {
    const decoded = decodeEncodedWords('=?UTF-8?b?5L2g55qEIENoYXRHUFQg5Li05pe26aqM6K+B56CB?=');
    assert.equal(decoded, '你的 ChatGPT 临时验证码');
  });

  test('解析 X-ICLOUD-HME 结构化头', () => {
    const parsed = parseICloudHmeHeader(
      'p=cobalt-alibi-1g@icloud.com; d=; f=owner@icloud.com; r=to; s=noreply@x.ai',
    );
    assert.equal(parsed.pseudonym, 'cobalt-alibi-1g@icloud.com');
    assert.equal(parsed.forwardTo, 'owner@icloud.com');
    assert.equal(parsed.relation, 'to');
    assert.equal(parsed.sender, 'noreply@x.ai');
    assert.equal(parsed.domain, null, '实测 d= 为空');
  });

  test('CRLF 与 LF 的头/正文分隔都能切', () => {
    assert.equal(splitHeaderBlock('To: a\r\n\r\nbody').body, 'body');
    assert.equal(splitHeaderBlock('To: a\n\nbody').body, 'body');
  });
});

describe('别名归属 — 命中', () => {
  test('L1：X-ICLOUD-HME 的 p= 字段优先级最高', () => {
    const r = run(
      [
        'From: SpaceXAI <noreply@x.ai>',
        'To: Hide My Email <cobalt-alibi-1g@icloud.com>',
        'X-ICLOUD-HME: p=cobalt-alibi-1g@icloud.com; d=; f=owner@icloud.com; r=to; s=noreply@x.ai',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(r.primary?.aliasId, 1);
    assert.equal(r.primary?.layer, 'header:icloud-hme');
    assert.equal(r.primary?.confidence, 1);
    assert.equal(r.primary?.matchedVia, 'X-ICLOUD-HME[p]');
  });

  test('BCC 投递：To 里没有别名，仍靠 X-ICLOUD-HME 命中', () => {
    const r = run(
      [
        'From: Sender <s@example.com>',
        'To: undisclosed-recipients:;',
        'X-ICLOUD-HME: p=linen_cornel5g@icloud.com; d=; f=owner@icloud.com; r=bcc; s=s@example.com',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(r.primary?.aliasId, 2, 'BCC 场景正是这个头强于 To 的原因');
    assert.equal(r.primary?.layer, 'header:icloud-hme');
  });

  test('L2：没有专用头时回落到 To', () => {
    const r = run(['From: x@y.com', 'To: cobalt-alibi-1g@icloud.com', '', 'body'].join('\r\n'));
    assert.equal(r.primary?.aliasId, 1);
    assert.equal(r.primary?.layer, 'header:to');
  });

  test('L6：未知头名靠原始头扫描兜底', () => {
    const r = run(
      [
        'From: x@y.com',
        'To: someone-else@example.com',
        'X-Apple-Future-Header: delivered-for=linen_cornel5g@icloud.com',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(r.primary?.aliasId, 2);
    assert.equal(r.primary?.layer, 'raw_header_scan');
    assert.equal(
      r.primary?.matchedVia,
      'X-Apple-Future-Header',
      '必须记录具体哪个头命中，否则无法把新头名升级进配置',
    );
  });

  test('一封信同时发给两个别名，两个都归属', () => {
    const r = run(
      [
        'From: x@y.com',
        'To: cobalt-alibi-1g@icloud.com, mint.cave.4m@icloud.com',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(r.matches.length, 2);
    assert.deepEqual(r.matches.map((m) => m.aliasId).sort(), [1, 3]);
  });
});

describe('别名归属 — 必须不命中', () => {
  test('Received 的 for 子句是主邮箱，不得命中（Phase 0 实测否掉的信号）', () => {
    const r = run(
      [
        'Received: from mx.example.com by p01.icloud.com for <linen_cornel5g@icloud.com>; Tue, 4 Aug 2026 21:52:14 +0000',
        'From: x@y.com',
        'To: someone-else@example.com',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(
      r.matches.length,
      0,
      'Received 已在排除表里；真实邮件中它记的是转发目标而非别名',
    );
  });

  test('Original-recipient 是主邮箱，不得命中', () => {
    const r = run(
      [
        'Original-recipient: rfc822;linen_cornel5g@icloud.com',
        'From: x@y.com',
        'To: someone-else@example.com',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(r.matches.length, 0);
  });

  test('Return-path 的 VERP 编码不得命中（= 而非 @）', () => {
    const r = run(
      [
        'Return-path: <bounces+20216706-2653-cobalt-alibi-1g=icloud.com@em7877.example.com>',
        'From: x@y.com',
        'To: someone-else@example.com',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(r.matches.length, 0, '按完整地址匹配才挡得住 VERP 变体');
  });

  test('别名之间互发：发件人不得被当成收件人', () => {
    const r = run(
      [
        'From: cobalt-alibi-1g@icloud.com',
        'Reply-To: cobalt-alibi-1g@icloud.com',
        'To: someone-else@example.com',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.equal(
      r.matches.length,
      0,
      '不排除发件人类头，就会把信归属到发件人身上，这类 bug 极难发现',
    );
  });

  test('完全无关的邮件落未匹配，并给出原因', () => {
    const r = run(['From: x@y.com', 'To: nobody@example.com', '', 'body'].join('\r\n'));
    assert.equal(r.matches.length, 0);
    assert.equal(r.unmatchedReason, 'no_icloud_address');
  });

  test('地址是 icloud 但不在别名表里 —— 原因要能区分开', () => {
    const r = run(['From: x@y.com', 'To: never-imported-8k@icloud.com', '', 'body'].join('\r\n'));
    assert.equal(r.unmatchedReason, 'address_not_in_alias_table');
    assert.ok(
      r.candidateAddresses.some((c) => c.address === 'never-imported-8k@icloud.com'),
      '候选地址要留档，高频出现者就是漏导入的别名',
    );
  });

  test('别名已禁用时给出专门的原因', () => {
    const r = run(['From: x@y.com', 'To: disabled-one-9z@icloud.com', '', 'body'].join('\r\n'));
    assert.equal(r.matches.length, 0);
    assert.equal(r.unmatchedReason, 'alias_disabled');
  });
});

describe('别名归属 — 证据收集', () => {
  test('匹配成功时也要收集证据，否则规则退化后无历史可比', () => {
    const r = run(
      [
        'From: x@y.com',
        'To: Hide My Email <cobalt-alibi-1g@icloud.com>',
        'X-ICLOUD-HME: p=cobalt-alibi-1g@icloud.com; d=; f=owner@icloud.com; r=to; s=x@y.com',
        'X-Apple-UUID: abc',
        '',
        'body',
      ].join('\r\n'),
    );
    assert.ok(r.primary);
    assert.ok(r.observedHeaderNames.includes('X-ICLOUD-HME'));
    assert.ok(r.observedHeaderNames.includes('X-Apple-UUID'));
    assert.ok(r.candidateAddresses.length > 0);
  });
});

describe('jsonl 导入解析', () => {
  test('解析真实格式并规范化', () => {
    const jsonl = [
      '{"created_at":"2026-08-04T21:12:53Z","email":"cobalt-alibi-1g@icloud.com","index":2,"label":"batch0804-002","note":"","portal":"macos-system-settings","verified":true}',
      '{"created_at":"2026-08-04T21:12:59Z","email":"orchid.chive.5h@icloud.com","index":3,"label":"batch0804-003","note":"","portal":"macos-system-settings","verified":true}',
    ].join('\n');
    const r = parseBatchJsonl(Buffer.from(jsonl));
    assert.equal(r.records.length, 2);
    assert.equal(r.errors.length, 0);
    assert.equal(r.records[0]!.address.normalized, 'cobalt-alibi-1g@icloud.com');
    assert.equal(r.records[0]!.label, 'batch0804-002');
    assert.equal(r.records[0]!.sourceCreatedAt, '2026-08-04T21:12:53.000Z');
    assert.equal(r.fileSha256.length, 64);
  });

  test('坏行被跳过并记录，不影响其他行', () => {
    const jsonl = [
      '{"email":"good-line-1a@icloud.com","index":1}',
      'not json at all',
      '{"email":"","index":2}',
      '{"index":3}',
      '{"email":"good-line-2b@icloud.com","index":4}',
    ].join('\n');
    const r = parseBatchJsonl(Buffer.from(jsonl));
    assert.equal(r.records.length, 2);
    assert.equal(r.errors.length, 3);
    assert.equal(r.errors[0]!.line, 2);
  });

  test('文件内重复地址保留后者', () => {
    const jsonl = [
      '{"email":"dup-1a@icloud.com","index":1,"label":"旧"}',
      '{"email":"other-2b@icloud.com","index":2,"label":"其他"}',
      '{"email":"dup-1a@icloud.com","index":3,"label":"新"}',
    ].join('\n');
    const r = parseBatchJsonl(Buffer.from(jsonl));
    assert.equal(r.records.length, 2);
    assert.deepEqual(r.duplicatesInFile, ['dup-1a@icloud.com']);
    assert.equal(r.records.find((x) => x.address.normalized === 'dup-1a@icloud.com')!.label, '新');
    assert.ok(r.records.some((x) => x.address.normalized === 'other-2b@icloud.com'));
  });

  test('空文件与纯空行', () => {
    assert.equal(parseBatchJsonl(Buffer.from('')).records.length, 0);
    assert.equal(parseBatchJsonl(Buffer.from('\n\n  \n')).records.length, 0);
  });

  test('相同内容的文件哈希一致，可用于识别重复导入', () => {
    const a = parseBatchJsonl(Buffer.from('{"email":"x-1a@icloud.com"}'));
    const b = parseBatchJsonl(Buffer.from('{"email":"x-1a@icloud.com"}'));
    assert.equal(a.fileSha256, b.fileSha256);
  });
});

describe('真实固件归属回归', () => {
  const manifestPath = resolve(FIXTURE_DIR, 'fixtures.json');
  const hasFixtures = existsSync(manifestPath);
  const manifest = hasFixtures
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { aliases: string[] })
    : { aliases: [] };

  const fixtureIndex = buildAliasIndex(
    manifest.aliases.map((email, i) => ({
      id: 100 + i,
      emailNormalized: email,
      status: 'active' as const,
    })),
  );

  const files = hasFixtures
    ? readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.redacted.eml'))
    : [];

  for (const file of files) {
    test(`${file} 走 X-ICLOUD-HME 层命中`, () => {
      const raw = readFileSync(resolve(FIXTURE_DIR, file), 'utf8');
      const { headerBlock, body } = splitHeaderBlock(raw);
      const r = matchAlias({
        headers: parseHeaders(headerBlock),
        rawHeaderBlock: headerBlock,
        textBody: body,
        index: fixtureIndex,
        rules: DEFAULT_RULES,
      });
      assert.ok(r.primary, `未能归属。候选：${JSON.stringify(r.candidateAddresses)}`);
      assert.equal(
        r.primary.layer,
        'header:icloud-hme',
        `应走专用头层，实际走了 ${r.primary.layer}`,
      );
      assert.equal(r.primary.confidence, 1);
    });
  }

  test('固件已生成', { skip: files.length === 0 ? '尚未生成脱敏固件' : false }, () => {
    assert.ok(files.length > 0);
  });
});
