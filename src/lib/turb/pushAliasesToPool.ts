/** 从 hme-inbox 读取启用别名并批量推送到 turb 通用 API 邮箱池。 */
import type { Db } from '../db/driver.ts';
import { buildPickupUrl, decryptToken } from '../tokens/token.ts';
import {
  listAliasPoolPushRowsByIds,
  listAllActiveAliasPoolPushRows,
} from '../repositories/aliasPoolPush.repo.ts';
import {
  importGenericApiEmails,
  type TurbEmailEntry,
  type TurbEmailPoolConfig,
  type TurbImportResult,
} from './emailPoolClient.ts';

const BATCH_SIZE = 500;

export interface AliasPoolPushRequest {
  mode: 'selected' | 'all';
  ids: number[];
}

export interface AliasPoolPushResult {
  requested: number;
  pushed: number;
  inserted: number;
  existing: number;
  skippedInactive: number;
  skippedMissing: number;
}

type ImportEntries = (
  config: TurbEmailPoolConfig,
  entries: TurbEmailEntry[],
) => Promise<TurbImportResult>;

export interface PushAliasesToPoolDeps {
  db: Db;
  publicBaseUrl: string;
  tokenEncKey: string;
  turb: TurbEmailPoolConfig;
  importEntries?: ImportEntries;
}

export async function pushAliasesToPool(
  deps: PushAliasesToPoolDeps,
  request: AliasPoolPushRequest,
): Promise<AliasPoolPushResult> {
  let requested: number;
  let skippedInactive = 0;
  let skippedMissing = 0;
  let rows;

  if (request.mode === 'all') {
    rows = listAllActiveAliasPoolPushRows(deps.db);
    requested = rows.length;
  } else {
    const ids = [
      ...new Set(request.ids.filter((id) => Number.isInteger(id) && id > 0)),
    ];
    if (ids.length > BATCH_SIZE) throw new Error('单次最多选择 500 个邮箱');

    const selectedRows = listAliasPoolPushRowsByIds(deps.db, ids);
    requested = ids.length;
    skippedMissing = ids.length - selectedRows.length;
    skippedInactive = selectedRows.filter((row) => row.status !== 'active').length;
    rows = selectedRows.filter((row) => row.status === 'active');
  }

  const entries = rows.map((row) => ({
    email: row.email,
    pickupUrl: buildPickupUrl(
      deps.publicBaseUrl,
      decryptToken(row.tokenCiphertext, deps.tokenEncKey),
      row.email,
    ),
  }));
  const result: AliasPoolPushResult = {
    requested,
    pushed: entries.length,
    inserted: 0,
    existing: 0,
    skippedInactive,
    skippedMissing,
  };
  if (entries.length === 0) return result;

  const importEntries = deps.importEntries ?? importGenericApiEmails;
  for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
    const remote = await importEntries(deps.turb, entries.slice(offset, offset + BATCH_SIZE));
    result.inserted += remote.inserted;
    result.existing += remote.skipped;
  }
  return result;
}
