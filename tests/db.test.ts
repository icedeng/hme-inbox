import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, withWriteTx, isoNow, type Db } from '../src/lib/db/driver.ts';
import { migrate, currentVersion, assertSchemaCurrent } from '../src/lib/db/migrate.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';
import * as messagesRepo from '../src/lib/repositories/messages.repo.ts';
import * as syncRepo from '../src/lib/repositories/sync.repo.ts';
import * as unmatchedRepo from '../src/lib/repositories/unmatched.repo.ts';
import { createToken } from '../src/lib/tokens/token.ts';
import { normalizeAddress } from '../src/lib/email/address.ts';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function makeAlias(db: Db, email: string, label = 'test', batchIndex: number | null = 1) {
  const addr = normalizeAddress(email)!;
  const token = createToken(TEST_KEY);
  const outcome = aliasesRepo.upsertAlias(db, {
    email,
    emailNormalized: addr.normalized,
    localPart: addr.localPart,
    domain: addr.domain,
    label,
    note: '',
    batchIndex,
    portal: 'macos-system-settings',
    verified: true,
    sourceCreatedAt: '2026-08-04T21:12:48Z',
    importBatchId: null,
    tokenHash: token.hash,
    tokenPrefix: token.prefix,
    tokenCiphertext: token.ciphertext,
  });
  return { token, outcome };
}

describe('迁移', () => {
  test('从零建库并记录版本', () => {
    const db = openDb(':memory:');
    assert.equal(currentVersion(db), 0);
    const r = migrate(db);
    assert.ok(r.to > 0);
    assert.ok(r.applied.length >= 1);
    assertSchemaCurrent(db);
    db.close();
  });

  test('重复迁移是幂等的', () => {
    const db = freshDb();
    const again = migrate(db);
    assert.equal(again.applied.length, 0);
    db.close();
  });
});

describe('别名 UPSERT', () => {
  test('重复导入不新增行，且 token 保持不变', () => {
    const db = freshDb();
    const first = makeAlias(db, 'cobalt-alibi-1g@icloud.com', '标签A');
    assert.equal(first.outcome, 'inserted');

    const before = aliasesRepo.findByNormalized(db, 'cobalt-alibi-1g@icloud.com')!;

    // 模拟同一个 jsonl 被追加后重新导入：标签变了，token 绝不能变
    const second = makeAlias(db, 'cobalt-alibi-1g@icloud.com', '标签B');
    assert.equal(second.outcome, 'updated');

    const after = aliasesRepo.findByNormalized(db, 'cobalt-alibi-1g@icloud.com')!;
    assert.equal(aliasesRepo.countAliases(db), 1);
    assert.equal(after.label, '标签B', '标签应被更新');
    assert.equal(after.tokenHash, before.tokenHash, 'token 被重置会让已发出的取件 URL 失效');
    assert.deepEqual(after.tokenCiphertext, before.tokenCiphertext);
    db.close();
  });

  test('含点的地址不被 dot-strip，不同别名不会互相覆盖', () => {
    const db = freshDb();
    makeAlias(db, 'mint.cave.4m@icloud.com');
    makeAlias(db, 'mintcave4m@icloud.com');
    assert.equal(aliasesRepo.countAliases(db), 2, '去点会把两个不同别名合并，导致跨别名投递');
    db.close();
  });

  test('按 token 哈希查找', () => {
    const db = freshDb();
    const { token } = makeAlias(db, 'orchid.chive.5h@icloud.com');
    const found = aliasesRepo.findByTokenHash(db, token.hash);
    assert.equal(found?.email, 'orchid.chive.5h@icloud.com');
    assert.equal(aliasesRepo.findByTokenHash(db, 'x'.repeat(64)), undefined);
    db.close();
  });

  test('轮换 token 后旧哈希立即失效', () => {
    const db = freshDb();
    const { token } = makeAlias(db, 'linen_cornel5g@icloud.com');
    const alias = aliasesRepo.findByTokenHash(db, token.hash)!;
    const next = createToken(TEST_KEY);
    aliasesRepo.rotateToken(db, alias.id, next.hash, next.prefix, next.ciphertext);

    assert.equal(aliasesRepo.findByTokenHash(db, token.hash), undefined, '旧 token 必须立刻失效');
    assert.equal(aliasesRepo.findByTokenHash(db, next.hash)?.id, alias.id);
    assert.equal(aliasesRepo.findById(db, alias.id)!.tokenVersion, 2);
    db.close();
  });
});

describe('邮件去重', () => {
  function insert(db: Db, accountId: number, over: Partial<messagesRepo.InsertMessageInput> = {}) {
    return messagesRepo.insertMessage(db, {
      accountId,
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 100,
      contentHash: 'a'.repeat(64),
      messageIdHeader: '<x@example.com>',
      inReplyTo: null,
      fromAddress: 'noreply@x.ai',
      fromName: 'SpaceXAI',
      toRaw: 'Hide My Email <cobalt-alibi-1g@icloud.com>',
      subject: 'SpaceXAI confirmation code: MJP-0LS',
      dateSent: '2026-08-04T21:52:50.000Z',
      dateReceived: '2026-08-04T21:52:50.000Z',
      textBody: null,
      htmlBody: null,
      snippet: null,
      verificationCode: 'MJP-0LS',
      codeConfidence: 0.95,
      codeSource: 'subject:labeled',
      codeCandidatesJson: null,
      hasAttachments: false,
      sizeBytes: 20110,
      truncated: false,
      rawMime: null,
      rawHeaders: 'To: x',
      matchLayer: 'header:icloud-hme',
      matchConfidence: 1,
      expiresAt: '2026-09-03T21:52:50.000Z',
      ...over,
    });
  }

  test('同一 UID 重复插入被挡下', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    assert.ok(insert(db, acct.id));
    assert.equal(insert(db, acct.id), null);
    assert.equal(
      messagesRepo.findDuplicateReason(db, acct.id, 'INBOX', 1, 100, 'a'.repeat(64)),
      'uid',
    );
    db.close();
  });

  test('UIDVALIDITY 变化后全量重拉，靠 content_hash 挡住', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    assert.ok(insert(db, acct.id));
    // UID 空间重建：uidvalidity 与 uid 都变了，但内容字节完全相同
    assert.equal(insert(db, acct.id, { uidvalidity: 2, uid: 7 }), null);
    assert.equal(
      messagesRepo.findDuplicateReason(db, acct.id, 'INBOX', 2, 7, 'a'.repeat(64)),
      'hash',
    );
    db.close();
  });

  test('同一封信同时出现在 INBOX 与 Junk 只入库一次', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    assert.ok(insert(db, acct.id, { mailbox: 'INBOX' }));
    assert.equal(insert(db, acct.id, { mailbox: 'Junk', uid: 55 }), null);
    db.close();
  });

  test('一封信可归属多个别名，两边都能查到', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    makeAlias(db, 'a.one-1x@icloud.com');
    makeAlias(db, 'b_two2y@icloud.com');
    const a = aliasesRepo.findByNormalized(db, 'a.one-1x@icloud.com')!;
    const b = aliasesRepo.findByNormalized(db, 'b_two2y@icloud.com')!;

    const id = insert(db, acct.id)!;
    messagesRepo.linkRecipients(db, id, '2026-08-04T21:52:50.000Z', [
      { aliasId: a.id, matchLayer: 'header:icloud-hme', confidence: 1, matchedVia: 'p', isPrimary: true },
      { aliasId: b.id, matchLayer: 'header:to', confidence: 0.95, matchedVia: 'To', isPrimary: false },
    ]);

    assert.equal(messagesRepo.listByAlias(db, { aliasId: a.id, limit: 10 }).length, 1);
    assert.equal(messagesRepo.listByAlias(db, { aliasId: b.id, limit: 10 }).length, 1);
    db.close();
  });

  test('详情查询必须带别名归属校验，否则可遍历全库', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    makeAlias(db, 'owner.a-1x@icloud.com');
    makeAlias(db, 'other.b-2y@icloud.com');
    const owner = aliasesRepo.findByNormalized(db, 'owner.a-1x@icloud.com')!;
    const other = aliasesRepo.findByNormalized(db, 'other.b-2y@icloud.com')!;

    const id = insert(db, acct.id)!;
    messagesRepo.linkRecipients(db, id, '2026-08-04T21:52:50.000Z', [
      { aliasId: owner.id, matchLayer: 'header:to', confidence: 1, matchedVia: 'To', isPrimary: true },
    ]);

    assert.ok(messagesRepo.getForAlias(db, owner.id, id));
    assert.equal(
      messagesRepo.getForAlias(db, other.id, id),
      undefined,
      '别的别名不该读到这封信',
    );
    db.close();
  });
});

describe('worker 单实例互斥', () => {
  test('第二个 worker 抢不到锁', () => {
    const db = freshDb();
    assert.equal(syncRepo.acquireWorkerLock(db, 111, 'host-a'), true);
    assert.equal(
      syncRepo.acquireWorkerLock(db, 222, 'host-b'),
      false,
      '双 worker 会开出两份 IDLE，触发 iCloud 连接限制',
    );
    db.close();
  });

  test('释放后可被接管', () => {
    const db = freshDb();
    syncRepo.acquireWorkerLock(db, 111, 'host-a');
    syncRepo.releaseWorkerLock(db, 111);
    assert.equal(syncRepo.acquireWorkerLock(db, 222, 'host-b'), true);
    db.close();
  });

  test('心跳新鲜度判定', () => {
    const db = freshDb();
    assert.equal(syncRepo.isWorkerAlive(db), false);
    syncRepo.acquireWorkerLock(db, 111, 'host-a');
    assert.equal(syncRepo.isWorkerAlive(db), true);
    // 100 秒后心跳过期
    assert.equal(syncRepo.isWorkerAlive(db, new Date(Date.now() + 100_000)), false);
    db.close();
  });
});

describe('UIDVALIDITY 处理', () => {
  test('变化时重置 last_seen_uid', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    syncRepo.ensureMailbox(db, acct.id, 'INBOX');

    syncRepo.recordUidValidity(db, acct.id, 'INBOX', 1);
    syncRepo.advanceUid(db, acct.id, 'INBOX', 2456);
    assert.equal(syncRepo.listMailboxes(db)[0]!.lastSeenUid, 2456);

    const r = syncRepo.recordUidValidity(db, acct.id, 'INBOX', 99);
    assert.equal(r.changed, true);
    assert.equal(syncRepo.listMailboxes(db)[0]!.lastSeenUid, 0, 'UID 空间重建后必须从头重搜');
    db.close();
  });

  test('sync_since 在重启后保持不变，否则会漏掉停机期间的信', () => {
    const db = freshDb();
    const first = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', '2026-08-01T00:00:00.000Z');
    const second = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', '2026-08-05T00:00:00.000Z');
    assert.equal(second.syncSince, first.syncSince);
    db.close();
  });
});

describe('事务', () => {
  test('抛错时回滚', () => {
    const db = freshDb();
    assert.throws(() => {
      withWriteTx(db, (tx) => {
        makeAlias(tx, 'rollback.test-1a@icloud.com');
        throw new Error('故意失败');
      });
    });
    assert.equal(aliasesRepo.countAliases(db), 0);
    db.close();
  });

  test('嵌套调用复用外层事务', () => {
    const db = freshDb();
    withWriteTx(db, (tx) => {
      withWriteTx(tx, (inner) => {
        makeAlias(inner, 'nested.test-2b@icloud.com');
      });
    });
    assert.equal(aliasesRepo.countAliases(db), 1);
    db.close();
  });
});

describe('未匹配留档', () => {
  test('插入后可按 content_hash 去重', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    const input = {
      accountId: acct.id,
      mailbox: 'INBOX',
      uidvalidity: 1,
      uid: 5,
      contentHash: 'b'.repeat(64),
      messageIdHeader: null,
      fromAddress: 'x@y.com',
      subject: '未知收件人',
      dateReceived: isoNow(),
      reason: 'address_not_in_alias_table' as const,
      headerNames: ['To', 'X-ICLOUD-HME', 'X-Apple-UUID'],
      candidates: ['unknown-alias@icloud.com'],
      rawHeaders: 'To: unknown-alias@icloud.com',
      rawMime: null,
      expiresAt: '2026-10-04T00:00:00.000Z',
    };
    assert.ok(unmatchedRepo.insertUnmatched(db, input));
    assert.equal(unmatchedRepo.insertUnmatched(db, input), null);
    assert.equal(unmatchedRepo.countPending(db), 1);

    // 高频头名与候选地址是发现「苹果换头名」「漏导入别名」的依据
    assert.ok(unmatchedRepo.topHeaderNames(db).some((h) => h.name === 'X-ICLOUD-HME'));
    assert.ok(
      unmatchedRepo.topCandidateAddresses(db).some((c) => c.address === 'unknown-alias@icloud.com'),
    );
    db.close();
  });

  test('未匹配率不得把已回填的记录算进去', () => {
    const db = freshDb();
    const acct = syncRepo.ensureAccount(db, 'imap.mail.me.com', 993, 'o@icloud.com', isoNow());
    const since = new Date(Date.now() - 3600e3).toISOString();

    const addUnmatched = (uid: number) =>
      unmatchedRepo.insertUnmatched(db, {
        accountId: acct.id,
        mailbox: 'INBOX',
        uidvalidity: 1,
        uid,
        contentHash: String(uid).padStart(64, 'c'),
        messageIdHeader: null,
        fromAddress: 'x@y.com',
        subject: `第 ${uid} 封`,
        dateReceived: isoNow(),
        reason: 'address_not_in_alias_table' as const,
        headerNames: ['To'],
        candidates: [],
        rawHeaders: 'To: x',
        rawMime: null,
        expiresAt: '2026-10-04T00:00:00.000Z',
      })!;

    // 4 封先到、别名后导入 —— 这是常规流程，随后会被自动回填
    const backfilled = [1, 2, 3, 4].map(addUnmatched);
    // 1 封是真的不属于任何别名（例如 Sign in with Apple 的私密转发）
    addUnmatched(5);

    // 未回填时：5 未决，0 已入库
    assert.equal(unmatchedRepo.recentUnmatchedRatio(db, since).unmatched, 5);

    // 回填成功
    for (const id of backfilled) {
      unmatchedRepo.markResolved(db, id, null, isoNow());
    }

    const r = unmatchedRepo.recentUnmatchedRatio(db, since);
    assert.equal(
      r.unmatched,
      1,
      '把已回填的算进未匹配率，等于每次回填成功都报一次「归属规则失效」，' +
        '恰好把系统正常工作报成故障，告警很快会被无视',
    );
    assert.equal(unmatchedRepo.countPending(db), 1);
    db.close();
  });
});
