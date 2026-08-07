import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/lib/db/driver.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { normalizeAddress } from '../src/lib/email/address.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';
import {
  listAliasPoolPushRowsByIds,
  listAllActiveAliasPoolPushRows,
} from '../src/lib/repositories/aliasPoolPush.repo.ts';

const opened: Db[] = [];

function harness(): Db {
  const db = openDb(':memory:');
  migrate(db);
  opened.push(db);
  return db;
}

function insertAlias(db: Db, email: string, index: number) {
  const address = normalizeAddress(email)!;
  aliasesRepo.upsertAlias(db, {
    email: address.raw,
    emailNormalized: address.normalized,
    localPart: address.localPart,
    domain: address.domain,
    label: '',
    note: '',
    batchIndex: index,
    portal: 'test',
    verified: true,
    sourceCreatedAt: null,
    importBatchId: null,
    tokenHash: `pool-push-hash-${index}`,
    tokenPrefix: `p${index}`,
    tokenCiphertext: Buffer.from(`cipher-${index}`),
  });
  return aliasesRepo.findByNormalized(db, address.normalized)!;
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

describe('邮箱池推送别名查询', () => {
  test('按 ID 查询去重并返回存在记录及状态', () => {
    const db = harness();
    const active = insertAlias(db, 'active@icloud.com', 1);
    const disabled = insertAlias(db, 'disabled@icloud.com', 2);
    aliasesRepo.setStatus(db, disabled.id, 'disabled');

    const rows = listAliasPoolPushRowsByIds(db, [disabled.id, active.id, active.id, 99999]);

    assert.deepEqual(
      rows.map((row) => [row.id, row.status]),
      [
        [active.id, 'active'],
        [disabled.id, 'disabled'],
      ],
    );
    assert.deepEqual(rows[0]?.tokenCiphertext, active.tokenCiphertext);
  });

  test('空 ID 列表不执行非法 IN 查询', () => {
    assert.deepEqual(listAliasPoolPushRowsByIds(harness(), []), []);
  });

  test('选择查询拒绝超过 500 个唯一 ID', () => {
    assert.throws(
      () => listAliasPoolPushRowsByIds(harness(), Array.from({ length: 501 }, (_, i) => i + 1)),
      /500/,
    );
  });

  test('全部查询只返回启用邮箱且不受页面 500 条上限影响', () => {
    const db = harness();
    for (let i = 1; i <= 502; i++) insertAlias(db, `active-${i}@icloud.com`, i);
    const disabled = aliasesRepo.findByNormalized(db, 'active-502@icloud.com')!;
    aliasesRepo.setStatus(db, disabled.id, 'disabled');

    const rows = listAllActiveAliasPoolPushRows(db);

    assert.equal(rows.length, 501);
    assert.ok(rows.every((row) => row.status === 'active'));
    assert.equal(rows.at(-1)?.email, 'active-501@icloud.com');
  });
});
