/** turb 邮箱池推送所需的最小别名查询。 */
import { type Db, toBuffer } from '../db/driver.ts';
import type { AliasStatus } from './aliases.repo.ts';

export interface AliasPoolPushRow {
  id: number;
  email: string;
  status: AliasStatus;
  tokenCiphertext: Buffer;
}

interface Row {
  id: number;
  email: string;
  status: AliasStatus;
  token_ciphertext: Uint8Array;
}

function mapRow(row: Row): AliasPoolPushRow {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    tokenCiphertext: toBuffer(row.token_ciphertext) ?? Buffer.alloc(0),
  };
}

export function listAliasPoolPushRowsByIds(db: Db, ids: number[]): AliasPoolPushRow[] {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  if (uniqueIds.length > 500) throw new Error('单次最多选择 500 个邮箱');

  const placeholders = uniqueIds.map(() => '?').join(',');
  return db
    .all<Row>(
      `SELECT id, email, status, token_ciphertext
         FROM aliases
        WHERE id IN (${placeholders})
        ORDER BY id`,
      ...uniqueIds,
    )
    .map(mapRow);
}

export function listAllActiveAliasPoolPushRows(db: Db): AliasPoolPushRow[] {
  return db
    .all<Row>(
      `SELECT id, email, status, token_ciphertext
         FROM aliases
        WHERE status = 'active'
        ORDER BY id`,
    )
    .map(mapRow);
}
