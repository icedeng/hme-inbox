import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/lib/db/driver.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { normalizeAddress } from '../src/lib/email/address.ts';
import { createToken, buildPickupUrl } from '../src/lib/tokens/token.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';
import {
  pushAliasesToPool,
  type PushAliasesToPoolDeps,
} from '../src/lib/turb/pushAliasesToPool.ts';
import type { TurbEmailEntry } from '../src/lib/turb/emailPoolClient.ts';

const TOKEN_KEY = Buffer.alloc(32, 17).toString('base64');
const opened: Db[] = [];

function harness() {
  const db = openDb(':memory:');
  migrate(db);
  opened.push(db);
  const batches: TurbEmailEntry[][] = [];
  const deps: PushAliasesToPoolDeps = {
    db,
    publicBaseUrl: 'https://hme.test',
    tokenEncKey: TOKEN_KEY,
    turb: { baseUrl: 'http://turb.test', authCode: 'secret' },
    importEntries: async (_config, entries) => {
      batches.push(entries);
      return { parsed: entries.length, inserted: entries.length, skipped: 0 };
    },
  };
  return { db, batches, deps };
}

function insertAlias(db: Db, email: string, index: number) {
  const address = normalizeAddress(email)!;
  const token = createToken(TOKEN_KEY);
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
    tokenHash: token.hash,
    tokenPrefix: token.prefix,
    tokenCiphertext: token.ciphertext,
  });
  return {
    alias: aliasesRepo.findByNormalized(db, address.normalized)!,
    pickupUrl: buildPickupUrl('https://hme.test', token.token, address.raw),
  };
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

describe('推送别名到 turb 邮箱池', () => {
  test('选择推送去重 ID 并只发送启用邮箱', async () => {
    const { db, batches, deps } = harness();
    const active = insertAlias(db, 'active@icloud.com', 1);
    const disabled = insertAlias(db, 'disabled@icloud.com', 2);
    aliasesRepo.setStatus(db, disabled.alias.id, 'disabled');

    const result = await pushAliasesToPool(deps, {
      mode: 'selected',
      ids: [active.alias.id, active.alias.id, disabled.alias.id, 99999],
    });

    assert.deepEqual(batches.flat(), [
      { email: active.alias.email, pickupUrl: active.pickupUrl },
    ]);
    assert.deepEqual(result, {
      requested: 3,
      pushed: 1,
      inserted: 1,
      existing: 0,
      skippedInactive: 1,
      skippedMissing: 1,
    });
  });

  test('全部推送忽略传入 ID 并发送数据库全部启用邮箱', async () => {
    const { db, batches, deps } = harness();
    const activeA = insertAlias(db, 'a@icloud.com', 1);
    const activeB = insertAlias(db, 'b@icloud.com', 2);
    const disabled = insertAlias(db, 'disabled@icloud.com', 3);
    aliasesRepo.setStatus(db, disabled.alias.id, 'disabled');

    const result = await pushAliasesToPool(deps, {
      mode: 'all',
      ids: [disabled.alias.id],
    });

    assert.deepEqual(
      batches.flat().map((entry) => entry.email),
      [activeA.alias.email, activeB.alias.email],
    );
    assert.equal(result.requested, 2);
    assert.equal(result.pushed, 2);
    assert.equal(result.skippedInactive, 0);
    assert.equal(result.skippedMissing, 0);
  });

  test('全部推送按 500 条分批并汇总远端新增与已存在数量', async () => {
    const { db, batches, deps } = harness();
    for (let i = 1; i <= 501; i++) insertAlias(db, `batch-${i}@icloud.com`, i);
    deps.importEntries = async (_config, entries) => {
      batches.push(entries);
      return {
        parsed: entries.length,
        inserted: entries.length - 1,
        skipped: 1,
      };
    };

    const result = await pushAliasesToPool(deps, { mode: 'all', ids: [] });

    assert.deepEqual(batches.map((batch) => batch.length), [500, 1]);
    assert.equal(result.inserted, 499);
    assert.equal(result.existing, 2);
    assert.equal(result.pushed, 501);
  });

  test('没有启用邮箱时不调用远端', async () => {
    const { batches, deps } = harness();

    const result = await pushAliasesToPool(deps, { mode: 'all', ids: [] });

    assert.equal(batches.length, 0);
    assert.deepEqual(result, {
      requested: 0,
      pushed: 0,
      inserted: 0,
      existing: 0,
      skippedInactive: 0,
      skippedMissing: 0,
    });
  });

  test('选择推送拒绝超过 500 个唯一 ID', async () => {
    const { deps } = harness();

    await assert.rejects(
      () =>
        pushAliasesToPool(deps, {
          mode: 'selected',
          ids: Array.from({ length: 501 }, (_, i) => i + 1),
        }),
      /500/,
    );
  });
});
