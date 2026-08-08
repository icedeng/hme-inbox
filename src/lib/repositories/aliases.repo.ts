/**
 * 别名表访问。只有 SQL，没有业务逻辑。
 */
import { type Db, type SqlValue, toBuffer, toBool, fromBool, isoNow } from '../db/driver.ts';

export type AliasStatus = 'active' | 'disabled';

export interface Alias {
  id: number;
  email: string;
  emailNormalized: string;
  localPart: string;
  domain: string;
  label: string;
  note: string;
  batchIndex: number | null;
  portal: string;
  verified: boolean;
  sourceCreatedAt: string | null;
  importBatchId: number | null;
  status: AliasStatus;
  tokenHash: string;
  tokenPrefix: string;
  tokenCiphertext: Buffer;
  tokenVersion: number;
  tokenRotatedAt: string | null;
  lastAccessAt: string | null;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

interface AliasRow {
  id: number;
  email: string;
  email_normalized: string;
  local_part: string;
  domain: string;
  label: string;
  note: string;
  batch_index: number | null;
  portal: string;
  verified: number;
  source_created_at: string | null;
  import_batch_id: number | null;
  status: AliasStatus;
  token_hash: string;
  token_prefix: string;
  token_ciphertext: Uint8Array;
  token_version: number;
  token_rotated_at: string | null;
  last_access_at: string | null;
  access_count: number;
  created_at: string;
  updated_at: string;
}

function toAlias(row: AliasRow): Alias {
  return {
    id: row.id,
    email: row.email,
    emailNormalized: row.email_normalized,
    localPart: row.local_part,
    domain: row.domain,
    label: row.label,
    note: row.note,
    batchIndex: row.batch_index,
    portal: row.portal,
    verified: toBool(row.verified),
    sourceCreatedAt: row.source_created_at,
    importBatchId: row.import_batch_id,
    status: row.status,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    tokenCiphertext: toBuffer(row.token_ciphertext) ?? Buffer.alloc(0),
    tokenVersion: row.token_version,
    tokenRotatedAt: row.token_rotated_at,
    lastAccessAt: row.last_access_at,
    accessCount: row.access_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = 'SELECT * FROM aliases';

export interface UpsertAliasInput {
  email: string;
  emailNormalized: string;
  localPart: string;
  domain: string;
  label: string;
  note: string;
  batchIndex: number | null;
  portal: string;
  verified: boolean;
  sourceCreatedAt: string | null;
  importBatchId: number | null;
  /** 纯文本导入没有元数据时，更新已有别名不应清空原有字段。 */
  metadataProvided?: boolean;
  /** 仅在首次插入时使用；已存在的别名绝不覆盖 token。 */
  tokenHash: string;
  tokenPrefix: string;
  tokenCiphertext: Buffer;
}

export type UpsertOutcome = 'inserted' | 'updated';

/**
 * 按 email_normalized 幂等 UPSERT。
 *
 * **DO UPDATE 里刻意不含 token 三列。** 同一个 jsonl 会被反复追加后重新导入
 * （实测文件在一次会话内从 20 行长到 40 行），如果重复导入重置了 token，
 * 昨天发出去的取件 URL 今天就 404 了，而且症状很难联想到导入操作。
 */
export function upsertAlias(db: Db, input: UpsertAliasInput): UpsertOutcome {
  const before = db.get<{ id: number }>(
    'SELECT id FROM aliases WHERE email_normalized = ?',
    input.emailNormalized,
  );

  const updateMetadata = input.metadataProvided !== false;
  db.run(
    `INSERT INTO aliases (
       email, email_normalized, local_part, domain, label, note,
       batch_index, portal, verified, source_created_at, import_batch_id,
       token_hash, token_prefix, token_ciphertext
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(email_normalized) DO UPDATE SET
       label           = CASE WHEN ? THEN excluded.label ELSE label END,
       note            = CASE WHEN ? THEN excluded.note ELSE note END,
       batch_index     = CASE WHEN ? THEN excluded.batch_index ELSE batch_index END,
       portal          = CASE WHEN ? THEN excluded.portal ELSE portal END,
       verified        = CASE WHEN ? THEN excluded.verified ELSE verified END,
       import_batch_id = excluded.import_batch_id,
       updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    input.email,
    input.emailNormalized,
    input.localPart,
    input.domain,
    input.label,
    input.note,
    input.batchIndex,
    input.portal,
    fromBool(input.verified),
    input.sourceCreatedAt,
    input.importBatchId,
    input.tokenHash,
    input.tokenPrefix,
    input.tokenCiphertext,
    fromBool(updateMetadata),
    fromBool(updateMetadata),
    fromBool(updateMetadata),
    fromBool(updateMetadata),
    fromBool(updateMetadata),
  );

  return before ? 'updated' : 'inserted';
}

export function findByTokenHash(db: Db, tokenHash: string): Alias | undefined {
  const row = db.get<AliasRow>(`${SELECT} WHERE token_hash = ?`, tokenHash);
  return row ? toAlias(row) : undefined;
}

export function findById(db: Db, id: number): Alias | undefined {
  const row = db.get<AliasRow>(`${SELECT} WHERE id = ?`, id);
  return row ? toAlias(row) : undefined;
}

export function findByNormalized(db: Db, normalized: string): Alias | undefined {
  const row = db.get<AliasRow>(`${SELECT} WHERE email_normalized = ?`, normalized);
  return row ? toAlias(row) : undefined;
}

export interface ListAliasOptions {
  status?: AliasStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

export function listAliases(db: Db, options: ListAliasOptions = {}): Alias[] {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.search) {
    where.push('(email LIKE ? OR label LIKE ? OR note LIKE ?)');
    const like = `%${options.search}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  params.push(options.limit ?? 500, options.offset ?? 0);
  const rows = db.all<AliasRow>(
    `${SELECT}${clause} ORDER BY batch_index IS NULL, batch_index, email LIMIT ? OFFSET ?`,
    ...params,
  );
  return rows.map(toAlias);
}

export function countAliases(db: Db, status?: AliasStatus): number {
  const row = status
    ? db.get<{ n: number }>('SELECT COUNT(*) AS n FROM aliases WHERE status = ?', status)
    : db.get<{ n: number }>('SELECT COUNT(*) AS n FROM aliases');
  return row?.n ?? 0;
}

/** 归属层用的索引数据：只取匹配必需的字段，避免把 BLOB 全捞进内存。 */
export interface AliasIndexRow {
  id: number;
  emailNormalized: string;
  status: AliasStatus;
}

export function listForIndex(db: Db): AliasIndexRow[] {
  return db
    .all<{ id: number; email_normalized: string; status: AliasStatus }>(
      'SELECT id, email_normalized, status FROM aliases',
    )
    .map((r) => ({ id: r.id, emailNormalized: r.email_normalized, status: r.status }));
}

/** 索引失效检测：worker 每 30 秒比对一次，变了才重建。 */
export function indexFingerprint(db: Db): string {
  const row = db.get<{ n: number; t: string | null }>(
    'SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM aliases',
  );
  return `${row?.n ?? 0}:${row?.t ?? ''}`;
}

export function setStatus(db: Db, id: number, status: AliasStatus): boolean {
  const r = db.run(
    `UPDATE aliases SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    status,
    id,
  );
  return r.changes > 0;
}

export function rotateToken(
  db: Db,
  id: number,
  tokenHash: string,
  tokenPrefix: string,
  tokenCiphertext: Buffer,
): boolean {
  const r = db.run(
    `UPDATE aliases
        SET token_hash = ?, token_prefix = ?, token_ciphertext = ?,
            token_version = token_version + 1,
            token_rotated_at = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    tokenHash,
    tokenPrefix,
    tokenCiphertext,
    isoNow(),
    id,
  );
  return r.changes > 0;
}

/** 取件成功后记一笔。故意不放在事务里 —— 统计数据不值得为它阻塞读路径。 */
export function touchAccess(db: Db, id: number): void {
  db.run(
    'UPDATE aliases SET last_access_at = ?, access_count = access_count + 1 WHERE id = ?',
    isoNow(),
    id,
  );
}
