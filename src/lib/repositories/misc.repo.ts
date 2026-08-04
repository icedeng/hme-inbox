/**
 * 导入批次、管理会话、取件访问日志。
 * 三张辅助表都很小，合在一个文件里比拆三个文件更好读。
 */
import { type Db, isoNow } from '../db/driver.ts';

// ── 导入批次 ───────────────────────────────────────────────────

export interface ImportBatch {
  id: number;
  filename: string;
  fileSha256: string;
  totalLines: number;
  inserted: number;
  updated: number;
  failed: number;
  errorsJson: string | null;
  createdAt: string;
}

interface ImportBatchRow {
  id: number;
  filename: string;
  file_sha256: string;
  total_lines: number;
  inserted: number;
  updated: number;
  failed: number;
  errors_json: string | null;
  created_at: string;
}

function toBatch(row: ImportBatchRow): ImportBatch {
  return {
    id: row.id,
    filename: row.filename,
    fileSha256: row.file_sha256,
    totalLines: row.total_lines,
    inserted: row.inserted,
    updated: row.updated,
    failed: row.failed,
    errorsJson: row.errors_json,
    createdAt: row.created_at,
  };
}

export function createImportBatch(
  db: Db,
  filename: string,
  fileSha256: string,
  totalLines: number,
): number {
  const r = db.run(
    'INSERT INTO import_batches (filename, file_sha256, total_lines) VALUES (?,?,?)',
    filename,
    fileSha256,
    totalLines,
  );
  return r.lastInsertRowid;
}

export function finishImportBatch(
  db: Db,
  id: number,
  counts: { inserted: number; updated: number; failed: number },
  errors: Array<{ line: number; raw: string; reason: string }>,
): void {
  db.run(
    'UPDATE import_batches SET inserted = ?, updated = ?, failed = ?, errors_json = ? WHERE id = ?',
    counts.inserted,
    counts.updated,
    counts.failed,
    errors.length ? JSON.stringify(errors.slice(0, 100)) : null,
    id,
  );
}

export function listImportBatches(db: Db, limit = 20): ImportBatch[] {
  return db
    .all<ImportBatchRow>('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?', limit)
    .map(toBatch);
}

/** 同一份文件之前导入过没有 —— 只用于 UI 提示，不阻止重复导入。 */
export function findBatchByHash(db: Db, sha256: string): ImportBatch | undefined {
  const row = db.get<ImportBatchRow>(
    'SELECT * FROM import_batches WHERE file_sha256 = ? ORDER BY created_at DESC LIMIT 1',
    sha256,
  );
  return row ? toBatch(row) : undefined;
}

// ── 管理会话 ───────────────────────────────────────────────────

export function createSession(
  db: Db,
  id: string,
  expiresAt: string,
  userAgent: string | null,
  ip: string | null,
): void {
  const now = isoNow();
  db.run(
    'INSERT INTO admin_sessions (id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?,?,?,?,?,?)',
    id,
    now,
    expiresAt,
    now,
    userAgent,
    ip,
  );
}

export function findValidSession(db: Db, id: string): { id: string; expiresAt: string } | undefined {
  const row = db.get<{ id: string; expires_at: string }>(
    'SELECT id, expires_at FROM admin_sessions WHERE id = ? AND expires_at > ?',
    id,
    isoNow(),
  );
  return row ? { id: row.id, expiresAt: row.expires_at } : undefined;
}

export function touchSession(db: Db, id: string): void {
  db.run('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?', isoNow(), id);
}

export function deleteSession(db: Db, id: string): void {
  db.run('DELETE FROM admin_sessions WHERE id = ?', id);
}

export function deleteExpiredSessions(db: Db): number {
  return db.run('DELETE FROM admin_sessions WHERE expires_at < ?', isoNow()).changes;
}

// ── 取件访问日志 ───────────────────────────────────────────────

export type AccessOutcome =
  | 'ok'
  | 'empty'
  | 'token_not_found'
  | 'email_mismatch'
  | 'alias_disabled'
  | 'invalid_parameter';

export interface LogAccessInput {
  aliasId: number | null;
  tokenPrefix: string | null;
  emailParam: string | null;
  statusCode: number;
  outcome: AccessOutcome;
  returned: number;
  ip: string | null;
  userAgent: string | null;
}

/**
 * 记一次取件。存在的唯一理由是排查「客户说没收到」——
 * 能立刻区分「他根本没来取」和「来取了但库里没信」。
 * **只存 token 前缀，绝不存完整 token。**
 */
export function logAccess(db: Db, input: LogAccessInput): void {
  db.run(
    `INSERT INTO access_log
       (alias_id, token_prefix, email_param, status_code, outcome, returned, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?)`,
    input.aliasId,
    input.tokenPrefix,
    input.emailParam,
    input.statusCode,
    input.outcome,
    input.returned,
    input.ip,
    input.userAgent,
  );
}

export interface AccessLogEntry {
  id: number;
  aliasId: number | null;
  tokenPrefix: string | null;
  emailParam: string | null;
  statusCode: number;
  outcome: AccessOutcome;
  returned: number;
  ip: string | null;
  createdAt: string;
}

export function listAccessLog(db: Db, limit = 100, aliasId?: number): AccessLogEntry[] {
  const rows = aliasId
    ? db.all<{
        id: number;
        alias_id: number | null;
        token_prefix: string | null;
        email_param: string | null;
        status_code: number;
        outcome: AccessOutcome;
        returned: number;
        ip: string | null;
        created_at: string;
      }>(
        'SELECT * FROM access_log WHERE alias_id = ? ORDER BY created_at DESC LIMIT ?',
        aliasId,
        limit,
      )
    : db.all<{
        id: number;
        alias_id: number | null;
        token_prefix: string | null;
        email_param: string | null;
        status_code: number;
        outcome: AccessOutcome;
        returned: number;
        ip: string | null;
        created_at: string;
      }>('SELECT * FROM access_log ORDER BY created_at DESC LIMIT ?', limit);

  return rows.map((r) => ({
    id: r.id,
    aliasId: r.alias_id,
    tokenPrefix: r.token_prefix,
    emailParam: r.email_param,
    statusCode: r.status_code,
    outcome: r.outcome,
    returned: r.returned,
    ip: r.ip,
    createdAt: r.created_at,
  }));
}
