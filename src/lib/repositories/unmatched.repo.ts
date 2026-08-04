/**
 * 未匹配邮件表访问。
 *
 * 这张表的存在意义是防「先收到信、后导入 jsonl」的时序竞争 ——
 * 那个竞争在实际使用中几乎必然发生，没有留档就是永久丢信。
 * 所以保留期（60 天）刻意长于正常邮件（30 天）。
 */
import { type Db, toBuffer } from '../db/driver.ts';

export type UnmatchedReason =
  | 'no_icloud_address'
  | 'address_not_in_alias_table'
  | 'alias_disabled'
  | 'parse_error';

export interface UnmatchedMessage {
  id: number;
  mailbox: string;
  uidvalidity: number;
  uid: number;
  contentHash: string;
  fromAddress: string | null;
  subject: string | null;
  dateReceived: string;
  reason: UnmatchedReason;
  headerNames: string[];
  candidates: string[];
  rawHeaders: string;
  rematchAttempts: number;
  resolvedAt: string | null;
  createdAt: string;
}

interface UnmatchedRow {
  id: number;
  mailbox: string;
  uidvalidity: number;
  uid: number;
  content_hash: string;
  from_address: string | null;
  subject: string | null;
  date_received: string;
  reason: UnmatchedReason;
  header_names_json: string;
  candidates_json: string;
  raw_headers: string;
  rematch_attempts: number;
  resolved_at: string | null;
  created_at: string;
}

function parseJsonArray(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toUnmatched(row: UnmatchedRow): UnmatchedMessage {
  return {
    id: row.id,
    mailbox: row.mailbox,
    uidvalidity: row.uidvalidity,
    uid: row.uid,
    contentHash: row.content_hash,
    fromAddress: row.from_address,
    subject: row.subject,
    dateReceived: row.date_received,
    reason: row.reason,
    headerNames: parseJsonArray(row.header_names_json),
    candidates: parseJsonArray(row.candidates_json),
    rawHeaders: row.raw_headers,
    rematchAttempts: row.rematch_attempts,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

const COLUMNS = `id, mailbox, uidvalidity, uid, content_hash, from_address, subject,
  date_received, reason, header_names_json, candidates_json, raw_headers,
  rematch_attempts, resolved_at, created_at`;

export interface InsertUnmatchedInput {
  accountId: number;
  mailbox: string;
  uidvalidity: number;
  uid: number;
  contentHash: string;
  messageIdHeader: string | null;
  fromAddress: string | null;
  subject: string | null;
  dateReceived: string;
  reason: UnmatchedReason;
  headerNames: string[];
  candidates: string[];
  rawHeaders: string;
  rawMime: Buffer | null;
  expiresAt: string;
}

export function insertUnmatched(db: Db, input: InsertUnmatchedInput): number | null {
  const r = db.run(
    `INSERT INTO unmatched_messages
       (account_id, mailbox, uidvalidity, uid, content_hash, message_id_header,
        from_address, subject, date_received, reason, header_names_json,
        candidates_json, raw_headers, raw_mime, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING`,
    input.accountId,
    input.mailbox,
    input.uidvalidity,
    input.uid,
    input.contentHash,
    input.messageIdHeader,
    input.fromAddress,
    input.subject,
    input.dateReceived,
    input.reason,
    JSON.stringify(input.headerNames),
    JSON.stringify(input.candidates),
    input.rawHeaders,
    input.rawMime,
    input.expiresAt,
  );
  return r.changes > 0 ? r.lastInsertRowid : null;
}

export function listPending(db: Db, limit = 200, offset = 0): UnmatchedMessage[] {
  return db
    .all<UnmatchedRow>(
      `SELECT ${COLUMNS} FROM unmatched_messages
        WHERE resolved_at IS NULL
        ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      limit,
      offset,
    )
    .map(toUnmatched);
}

export function countPending(db: Db): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM unmatched_messages WHERE resolved_at IS NULL',
  );
  return row?.n ?? 0;
}

/** 重扫时需要原文；这里单独取，避免列表查询把 BLOB 全捞出来。 */
export function getRawMime(db: Db, id: number): Buffer | null {
  const row = db.get<{ raw_mime: Uint8Array | null }>(
    'SELECT raw_mime FROM unmatched_messages WHERE id = ?',
    id,
  );
  return row ? toBuffer(row.raw_mime) : null;
}

/**
 * 标记为已处理。
 *
 * `messageId` 允许为 null：重扫时可能发现这封信已经由别的途径入库了，
 * 此时留档该收工但没有「本次新建的 message」可指。
 * `resolved_message_id` 有指向 messages(id) 的外键，传 0 会直接违反约束、
 * 整个事务回滚，留档记录反而永久卡住。
 */
export function markResolved(db: Db, id: number, messageId: number | null, at: string): void {
  db.run(
    'UPDATE unmatched_messages SET resolved_at = ?, resolved_message_id = ? WHERE id = ?',
    at,
    messageId,
    id,
  );
}

export function recordRematchAttempt(db: Db, id: number, at: string): void {
  db.run(
    'UPDATE unmatched_messages SET rematch_attempts = rematch_attempts + 1, last_rematch_at = ? WHERE id = ?',
    at,
    id,
  );
}

/**
 * 未匹配邮件里最常见的头名。
 * 苹果换了头名时，新头名会在这个榜单上冒头 —— 加进 rules 配置即可恢复归属。
 */
export function topHeaderNames(db: Db, limit = 20): Array<{ name: string; count: number }> {
  const rows = db.all<{ header_names_json: string }>(
    'SELECT header_names_json FROM unmatched_messages WHERE resolved_at IS NULL LIMIT 500',
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of parseJsonArray(row.header_names_json)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** 未匹配邮件头里出现最多的 icloud 地址 —— 高频者多半是漏导入的别名。 */
export function topCandidateAddresses(db: Db, limit = 20): Array<{ address: string; count: number }> {
  const rows = db.all<{ candidates_json: string }>(
    'SELECT candidates_json FROM unmatched_messages WHERE resolved_at IS NULL LIMIT 500',
  );
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const addr of parseJsonArray(row.candidates_json)) {
      counts.set(addr, (counts.get(addr) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([address, count]) => ({ address, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * 近一小时未匹配占比，超阈值就在后台首页告警。
 *
 * **必须排除已回填的记录**（`resolved_at IS NULL`）。
 * 「先收到信、后导入别名」是常规流程，那批信会先落进这张表、
 * 随后被自动回填认领。把它们算进未匹配率，等于每次回填成功
 * 都要报一次「归属规则失效」—— 恰好把系统正常工作报成了故障，
 * 告警很快就会被无视，那这条告警也就白设了。
 */
export function recentUnmatchedRatio(db: Db, sinceIso: string): { unmatched: number; matched: number } {
  const u = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM unmatched_messages WHERE created_at > ? AND resolved_at IS NULL',
    sinceIso,
  );
  const m = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM messages WHERE ingested_at > ?',
    sinceIso,
  );
  return { unmatched: u?.n ?? 0, matched: m?.n ?? 0 };
}
