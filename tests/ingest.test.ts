import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../src/lib/db/driver.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { buildAliasIndex } from '../src/lib/matching/aliasIndex.ts';
import { DEFAULT_RULES } from '../src/lib/matching/rules.ts';
import { createAttachmentStore } from '../src/lib/ingest/attachmentStore.ts';
import { ingestMessage, rematchUnmatched, type IngestDeps } from '../src/lib/ingest/ingestMessage.ts';
import { runCleanup } from '../src/lib/retention/cleanup.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';
import * as messagesRepo from '../src/lib/repositories/messages.repo.ts';
import * as unmatchedRepo from '../src/lib/repositories/unmatched.repo.ts';
import * as syncRepo from '../src/lib/repositories/sync.repo.ts';
import { createToken } from '../src/lib/tokens/token.ts';
import { normalizeAddress } from '../src/lib/email/address.ts';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TEST_KEY = Buffer.alloc(32, 3).toString('base64');

const manifestPath = resolve(FIXTURE_DIR, 'fixtures.json');
const manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { aliases: string[] })
  : { aliases: [] };
const fixtureFiles = existsSync(FIXTURE_DIR)
  ? readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.redacted.eml'))
  : [];

interface Harness {
  db: Db;
  deps: IngestDeps;
  accountId: number;
  aliasIds: number[];
  cleanup(): void;
}

function harness(aliasEmails: string[]): Harness {
  const db = openDb(':memory:');
  migrate(db);
  const tmp = mkdtempSync(resolve(tmpdir(), 'hme-att-'));

  const aliasIds: number[] = [];
  for (const email of aliasEmails) {
    const addr = normalizeAddress(email)!;
    const token = createToken(TEST_KEY);
    aliasesRepo.upsertAlias(db, {
      email,
      emailNormalized: addr.normalized,
      localPart: addr.localPart,
      domain: addr.domain,
      label: '',
      note: '',
      batchIndex: null,
      portal: '',
      verified: true,
      sourceCreatedAt: null,
      importBatchId: null,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      tokenCiphertext: token.ciphertext,
    });
    aliasIds.push(aliasesRepo.findByNormalized(db, addr.normalized)!.id);
  }

  const account = syncRepo.ensureAccount(
    db,
    'imap.mail.me.com',
    993,
    'owner@icloud.com',
    '2026-08-01T00:00:00.000Z',
  );

  const deps: IngestDeps = {
    db,
    aliasIndex: buildAliasIndex(aliasesRepo.listForIndex(db)),
    rules: DEFAULT_RULES,
    attachmentStore: createAttachmentStore({
      baseDir: tmp,
      maxInlineBytes: 1024,
      maxFileBytes: 1_048_576,
    }),
    clock: () => new Date('2026-08-05T00:00:00.000Z'),
    maxMessageBytes: 5_242_880,
    retentionDays: 30,
    unmatchedRetentionDays: 60,
  };

  return {
    db,
    deps,
    accountId: account.id,
    aliasIds,
    cleanup() {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function buildEml(headers: string[], body: string): Buffer {
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

describe('入库编排', () => {
  test('归属成功后建立别名关联并提取验证码', async () => {
    const h = harness(['cobalt-alibi-1g@icloud.com']);
    const raw = buildEml(
      [
        'From: SpaceXAI <noreply@x.ai>',
        'To: Hide My Email <cobalt-alibi-1g@icloud.com>',
        'X-ICLOUD-HME: p=cobalt-alibi-1g@icloud.com; d=; f=owner@icloud.com; r=to; s=noreply@x.ai',
        'Subject: SpaceXAI confirmation code: MJP-0LS',
        'Content-Type: text/plain; charset=utf-8',
      ],
      'Please use the code below.\r\n\r\nMJP-0LS\r\n\r\n(c) 2026 X.AI LLC',
    );

    const outcome = await ingestMessage(h.deps, {
      accountId: h.accountId,
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 2456,
      raw,
      internalDate: new Date('2026-08-04T21:52:50.000Z'),
    });

    assert.equal(outcome.kind, 'inserted');
    assert.equal(outcome.kind === 'inserted' && outcome.layer, 'header:icloud-hme');

    const list = messagesRepo.listByAlias(h.db, { aliasId: h.aliasIds[0]!, limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.verificationCode, 'MJP-0LS');
    assert.notEqual(list[0]!.verificationCode, '2026', '年份不得被当成验证码');
    // 保留期从 INTERNALDATE 起算，不是从 Date 头
    assert.ok(list[0]!.dateReceived.startsWith('2026-08-04T21:52:50'));
    h.cleanup();
  });

  test('重复投递被幂等挡下', async () => {
    const h = harness(['cobalt-alibi-1g@icloud.com']);
    const raw = buildEml(
      ['To: cobalt-alibi-1g@icloud.com', 'Subject: hi', 'Message-ID: <a@b>'],
      'body',
    );
    const input = {
      accountId: h.accountId,
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 10,
      raw,
      internalDate: new Date('2026-08-04T12:00:00.000Z'),
    };
    assert.equal((await ingestMessage(h.deps, input)).kind, 'inserted');
    assert.equal((await ingestMessage(h.deps, input)).kind, 'duplicate');

    // 同一封信在 Junk 里再出现一次：UID 不同，靠 content_hash 挡住
    const second = await ingestMessage(h.deps, { ...input, mailbox: 'Junk', uid: 99 });
    assert.equal(second.kind, 'duplicate');
    assert.equal(second.kind === 'duplicate' && second.reason, 'hash');
    assert.equal(messagesRepo.countByAlias(h.db, h.aliasIds[0]!), 1);
    h.cleanup();
  });

  test('未匹配邮件全量留档，含头名与候选地址', async () => {
    const h = harness(['cobalt-alibi-1g@icloud.com']);
    const raw = buildEml(
      [
        'From: x@y.com',
        'To: never-imported-8k@icloud.com',
        'X-ICLOUD-HME: p=never-imported-8k@icloud.com; d=; f=owner@icloud.com; r=to; s=x@y.com',
        'Subject: 未知别名',
      ],
      'body',
    );
    const outcome = await ingestMessage(h.deps, {
      accountId: h.accountId,
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 20,
      raw,
      internalDate: new Date('2026-08-04T12:00:00.000Z'),
    });

    assert.equal(outcome.kind, 'unmatched');
    const pending = unmatchedRepo.listPending(h.db);
    assert.equal(pending.length, 1);
    assert.ok(pending[0]!.headerNames.includes('X-ICLOUD-HME'));
    assert.ok(pending[0]!.candidates.includes('never-imported-8k@icloud.com'));
    h.cleanup();
  });

  test('后导入别名后能回填未匹配的信 —— 否则时序竞争会永久丢信', async () => {
    const h = harness([]);
    const raw = buildEml(
      [
        'From: x@y.com',
        'To: late-import-3c@icloud.com',
        'X-ICLOUD-HME: p=late-import-3c@icloud.com; d=; f=owner@icloud.com; r=to; s=x@y.com',
        'Subject: 先到的信',
      ],
      'Your verification code is 447291',
    );
    // 信先到，此时别名还没导入
    assert.equal(
      (
        await ingestMessage(h.deps, {
          accountId: h.accountId,
          mailbox: 'INBOX',
          uidvalidity: 1,
          uid: 30,
          raw,
          internalDate: new Date('2026-08-04T12:00:00.000Z'),
        })
      ).kind,
      'unmatched',
    );
    assert.equal(unmatchedRepo.countPending(h.db), 1);

    // 现在才导入别名
    const addr = normalizeAddress('late-import-3c@icloud.com')!;
    const token = createToken(TEST_KEY);
    aliasesRepo.upsertAlias(h.db, {
      email: addr.raw,
      emailNormalized: addr.normalized,
      localPart: addr.localPart,
      domain: addr.domain,
      label: '',
      note: '',
      batchIndex: null,
      portal: '',
      verified: true,
      sourceCreatedAt: null,
      importBatchId: null,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      tokenCiphertext: token.ciphertext,
    });
    const aliasId = aliasesRepo.findByNormalized(h.db, addr.normalized)!.id;

    const refreshed: IngestDeps = {
      ...h.deps,
      aliasIndex: buildAliasIndex(aliasesRepo.listForIndex(h.db)),
    };
    const result = await rematchUnmatched(refreshed, h.accountId);

    assert.equal(result.resolved, 1);
    assert.equal(unmatchedRepo.countPending(h.db), 0);
    const list = messagesRepo.listByAlias(h.db, { aliasId, limit: 10 });
    assert.equal(list.length, 1, '回填后这封信必须能被取到');
    assert.equal(list[0]!.verificationCode, '447291');
    h.cleanup();
  });

  test('畸形 MIME 不让整封信失败，头部仍可归属', async () => {
    const h = harness(['cobalt-alibi-1g@icloud.com']);
    const raw = Buffer.concat([
      Buffer.from(
        'To: cobalt-alibi-1g@icloud.com\r\nSubject: 坏 MIME\r\nContent-Type: multipart/mixed; boundary="nope"\r\n\r\n',
      ),
      Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    ]);
    const outcome = await ingestMessage(h.deps, {
      accountId: h.accountId,
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 40,
      raw,
      internalDate: new Date('2026-08-04T12:00:00.000Z'),
    });
    assert.equal(outcome.kind, 'inserted');
    h.cleanup();
  });

  test('超大邮件只存头部，不把整封读进内存', async () => {
    const h = harness(['cobalt-alibi-1g@icloud.com']);
    const big = Buffer.concat([
      Buffer.from('To: cobalt-alibi-1g@icloud.com\r\nSubject: 大附件\r\n\r\n'),
      Buffer.alloc(300_000, 0x41),
    ]);
    const outcome = await ingestMessage(
      { ...h.deps, maxMessageBytes: 100_000 },
      {
        accountId: h.accountId,
        mailbox: 'INBOX',
        uidvalidity: 1,
        uid: 50,
        raw: big,
        internalDate: new Date('2026-08-04T12:00:00.000Z'),
      },
    );
    assert.equal(outcome.kind, 'inserted');
    const list = messagesRepo.listByAlias(h.db, { aliasId: h.aliasIds[0]!, limit: 10 });
    assert.equal(list[0]!.truncated, true);
    h.cleanup();
  });

  test('一封信发给两个别名时只存一份原文，两边都能取到', async () => {
    const h = harness(['a.one-1x@icloud.com', 'b_two2y@icloud.com']);
    const raw = buildEml(
      ['From: x@y.com', 'To: a.one-1x@icloud.com, b_two2y@icloud.com', 'Subject: 群发'],
      'body',
    );
    const outcome = await ingestMessage(h.deps, {
      accountId: h.accountId,
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 60,
      raw,
      internalDate: new Date('2026-08-04T12:00:00.000Z'),
    });
    assert.equal(outcome.kind, 'inserted');
    assert.equal(outcome.kind === 'inserted' && outcome.aliasIds.length, 2);
    assert.equal(messagesRepo.listByAlias(h.db, { aliasId: h.aliasIds[0]!, limit: 5 }).length, 1);
    assert.equal(messagesRepo.listByAlias(h.db, { aliasId: h.aliasIds[1]!, limit: 5 }).length, 1);
    const total = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages');
    assert.equal(total?.n, 1, '原文只该存一份');
    h.cleanup();
  });
});

describe('真实固件端到端入库', () => {
  for (const file of fixtureFiles) {
    test(`${file} 完整走通解析→归属→入库`, async () => {
      const h = harness(manifest.aliases);
      const raw = readFileSync(resolve(FIXTURE_DIR, file));
      const outcome = await ingestMessage(h.deps, {
        accountId: h.accountId,
        mailbox: 'INBOX',
        uidvalidity: 1,
        uid: 1000 + fixtureFiles.indexOf(file),
        raw,
        internalDate: new Date('2026-08-04T21:52:50.000Z'),
      });

      assert.equal(
        outcome.kind,
        'inserted',
        `未能入库：${outcome.kind === 'unmatched' ? outcome.reason : JSON.stringify(outcome)}`,
      );
      assert.equal(outcome.kind === 'inserted' && outcome.layer, 'header:icloud-hme');

      const aliasId = outcome.kind === 'inserted' ? outcome.aliasIds[0]! : 0;
      const list = messagesRepo.listByAlias(h.db, { aliasId, limit: 1 });
      assert.equal(list.length, 1);
      assert.ok(list[0]!.verificationCode, '真实验证码邮件应能提到码');
      assert.ok(
        !/^(19|20)\d{2}$/.test(list[0]!.verificationCode!),
        `提到的是年份：${list[0]!.verificationCode}`,
      );
      h.cleanup();
    });
  }
});

describe('保留期清理', () => {
  test('过期邮件被删，未过期的保留', async () => {
    const h = harness(['cobalt-alibi-1g@icloud.com']);
    for (const [uid, days] of [
      [1, -40],
      [2, -1],
    ] as const) {
      const raw = buildEml(
        ['To: cobalt-alibi-1g@icloud.com', `Subject: 第 ${uid} 封`, `Message-ID: <${uid}@x>`],
        `body ${uid}`,
      );
      await ingestMessage(
        {
          ...h.deps,
          // 用 clock 控制 expires_at：过期的那封 expires_at 已在过去
          clock: () => new Date(new Date('2026-08-05T00:00:00.000Z').getTime() + days * 86_400_000),
        },
        {
          accountId: h.accountId,
          mailbox: 'INBOX',
          uidvalidity: 1,
          uid,
          raw,
          internalDate: new Date('2026-07-01T00:00:00.000Z'),
        },
      );
    }
    assert.equal(messagesRepo.countByAlias(h.db, h.aliasIds[0]!), 2);

    const result = await runCleanup(h.db, {
      attachmentStore: h.deps.attachmentStore,
      accessLogRetentionDays: 7,
      clock: () => new Date('2026-08-05T00:00:00.000Z'),
    });

    assert.equal(result.messagesDeleted, 1);
    assert.equal(messagesRepo.countByAlias(h.db, h.aliasIds[0]!), 1, '未过期的必须留下');
    h.cleanup();
  });
});
