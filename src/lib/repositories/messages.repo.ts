/**
 * 邮件表与邮件↔别名关联表访问。
 */
import { type Db, type SqlValue, toBuffer, fromBool, isoNow } from '../db/driver.ts';

export interface MessageSummary {
  id: number;
  mailbox: string;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  dateSent: string | null;
  dateReceived: string;
  textBody: string | null;
  snippet: string | null;
  verificationCode: string | null;
  codeConfidence: number | null;
  codeCandidatesJson: string | null;
  hasAttachments: boolean;
  sizeBytes: number;
  truncated: boolean;
  readAt: string | null;
  matchLayer: string | null;
  matchConfidence: number | null;
}

export interface MessageDetail extends MessageSummary {
  htmlBody: string | null;
  rawHeaders: string;
  messageIdHeader: string | null;
  toRaw: string | null;
}

interface MessageRow {
  id: number;
  mailbox: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  date_sent: string | null;
  date_received: string;
  text_body: string | null;
  html_body: string | null;
  snippet: string | null;
  verification_code: string | null;
  code_confidence: number | null;
  code_candidates_json: string | null;
  has_attachments: number;
  size_bytes: number;
  truncated: number;
  read_at: string | null;
  match_layer: string | null;
  match_confidence: number | null;
  raw_headers: string;
  message_id_header: string | null;
  to_raw: string | null;
}

const SUMMARY_COLUMNS = `
  m.id, m.mailbox, m.from_address, m.from_name, m.subject, m.date_sent, m.date_received,
  m.text_body, m.snippet, m.verification_code, m.code_confidence, m.code_candidates_json,
  m.has_attachments, m.size_bytes, m.truncated, m.read_at, m.match_layer, m.match_confidence`;

function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    mailbox: row.mailbox,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    dateSent: row.date_sent,
    dateReceived: row.date_received,
    textBody: row.text_body,
    snippet: row.snippet,
    verificationCode: row.verification_code,
    codeConfidence: row.code_confidence,
    codeCandidatesJson: row.code_candidates_json,
    hasAttachments: row.has_attachments === 1,
    sizeBytes: row.size_bytes,
    truncated: row.truncated === 1,
    readAt: row.read_at,
    matchLayer: row.match_layer,
    matchConfidence: row.match_confidence,
  };
}

// ── 写入 ───────────────────────────────────────────────────────

export interface InsertMessageInput {
  accountId: number;
  mailbox: string;
  uidvalidity: number;
  uid: number;
  contentHash: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toRaw: string | null;
  subject: string | null;
  dateSent: string | null;
  dateReceived: string;
  textBody: string | null;
  htmlBody: string | null;
  snippet: string | null;
  verificationCode: string | null;
  codeConfidence: number | null;
  codeSource: string | null;
  codeCandidatesJson: string | null;
  hasAttachments: boolean;
  sizeBytes: number;
  truncated: boolean;
  rawMime: Buffer | null;
  rawHeaders: string;
  matchLayer: string | null;
  matchConfidence: number | null;
  expiresAt: string;
}

/**
 * 插入邮件。返回 null 表示被唯一约束挡住（重复）。
 *
 * 用不带 target 的 `ON CONFLICT DO NOTHING`：SQLite 下它对**所有**唯一约束生效，
 * 所以 uid 与 content_hash 两条索引都能挡住重复，不必分别判断。
 */
export function insertMessage(db: Db, input: InsertMessageInput): number | null {
  const result = db.run(
    `INSERT INTO messages (
       account_id, mailbox, uidvalidity, uid, content_hash,
       message_id_header, in_reply_to, from_address, from_name, to_raw, subject,
       date_sent, date_received, text_body, html_body, snippet,
       verification_code, code_confidence, code_source, code_candidates_json,
       has_attachments, size_bytes, truncated, raw_mime, raw_headers,
       match_layer, match_confidence, expires_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING`,
    input.accountId,
    input.mailbox,
    input.uidvalidity,
    input.uid,
    input.contentHash,
    input.messageIdHeader,
    input.inReplyTo,
    input.fromAddress,
    input.fromName,
    input.toRaw,
    input.subject,
    input.dateSent,
    input.dateReceived,
    input.textBody,
    input.htmlBody,
    input.snippet,
    input.verificationCode,
    input.codeConfidence,
    input.codeSource,
    input.codeCandidatesJson,
    fromBool(input.hasAttachments),
    input.sizeBytes,
    fromBool(input.truncated),
    input.rawMime,
    input.rawHeaders,
    input.matchLayer,
    input.matchConfidence,
    input.expiresAt,
  );
  return result.changes > 0 ? result.lastInsertRowid : null;
}

/** 判断重复是被哪条约束挡的，供 ingest 上报准确原因。 */
export function findDuplicateReason(
  db: Db,
  accountId: number,
  mailbox: string,
  uidvalidity: number,
  uid: number,
  contentHash: string,
): 'uid' | 'hash' | null {
  const byUid = db.get<{ id: number }>(
    'SELECT id FROM messages WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid = ?',
    accountId,
    mailbox,
    uidvalidity,
    uid,
  );
  if (byUid) return 'uid';
  const byHash = db.get<{ id: number }>(
    'SELECT id FROM messages WHERE account_id = ? AND content_hash = ?',
    accountId,
    contentHash,
  );
  return byHash ? 'hash' : null;
}

export interface RecipientLink {
  aliasId: number;
  matchLayer: string;
  confidence: number;
  matchedVia: string | null;
  isPrimary: boolean;
}

export function linkRecipients(
  db: Db,
  messageId: number,
  dateReceived: string,
  links: RecipientLink[],
): void {
  for (const link of links) {
    db.run(
      `INSERT INTO message_recipients
         (message_id, alias_id, match_layer, confidence, matched_via, is_primary, date_received)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`,
      messageId,
      link.aliasId,
      link.matchLayer,
      link.confidence,
      link.matchedVia,
      fromBool(link.isPrimary),
      dateReceived,
    );
  }
}

// ── 读取 ───────────────────────────────────────────────────────

export interface ListMessagesOptions {
  aliasId: number;
  limit: number;
  since?: string;
  unreadOnly?: boolean;
}

/**
 * 某别名的最新 n 封。
 *
 * 走 ix_recipients_alias_time（alias_id, date_received DESC）先在关联表上
 * 纯索引定位到 n 行，再回表取正文 —— 这正是 date_received 冗余到关联表的原因。
 */
export function listByAlias(db: Db, options: ListMessagesOptions): MessageSummary[] {
  const where = ['r.alias_id = ?'];
  const params: SqlValue[] = [options.aliasId];
  if (options.since) {
    where.push('r.date_received > ?');
    params.push(options.since);
  }
  if (options.unreadOnly) {
    where.push('m.read_at IS NULL');
  }
  params.push(options.limit);

  const rows = db.all<MessageRow>(
    `SELECT ${SUMMARY_COLUMNS}
       FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.date_received DESC, m.id DESC
      LIMIT ?`,
    ...params,
  );
  return rows.map(toSummary);
}

/**
 * 取单封详情。**必须带 aliasId 校验**：
 * 不校验的话，任一 token 都能靠遍历 messageId 读到全库邮件。
 */
export function getForAlias(db: Db, aliasId: number, messageId: number): MessageDetail | undefined {
  const row = db.get<MessageRow>(
    `SELECT ${SUMMARY_COLUMNS}, m.html_body, m.raw_headers, m.message_id_header, m.to_raw
       FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
      WHERE r.alias_id = ? AND m.id = ?`,
    aliasId,
    messageId,
  );
  if (!row) return undefined;
  return {
    ...toSummary(row),
    htmlBody: row.html_body,
    rawHeaders: row.raw_headers,
    messageIdHeader: row.message_id_header,
    toRaw: row.to_raw,
  };
}

export function getRawMime(db: Db, aliasId: number, messageId: number): Buffer | null {
  const row = db.get<{ raw_mime: Uint8Array | null }>(
    `SELECT m.raw_mime FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
      WHERE r.alias_id = ? AND m.id = ?`,
    aliasId,
    messageId,
  );
  return row ? toBuffer(row.raw_mime) : null;
}

export function markRead(db: Db, messageIds: number[]): void {
  if (messageIds.length === 0) return;
  const now = isoNow();
  const placeholders = messageIds.map(() => '?').join(',');
  db.run(
    `UPDATE messages SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`,
    now,
    ...messageIds,
  );
}

export function countByAlias(db: Db, aliasId: number): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM message_recipients WHERE alias_id = ?',
    aliasId,
  );
  return row?.n ?? 0;
}

export function countUnreadByAlias(db: Db, aliasId: number): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
      WHERE r.alias_id = ? AND m.read_at IS NULL`,
    aliasId,
  );
  return row?.n ?? 0;
}

/** 每别名的邮件数与最近到达时间，供后台列表一次查完，避免 N+1。 */
export interface AliasStats {
  aliasId: number;
  total: number;
  unread: number;
  lastReceivedAt: string | null;
}

export function statsByAlias(db: Db): Map<number, AliasStats> {
  const rows = db.all<{
    alias_id: number;
    total: number;
    unread: number;
    last_received: string | null;
  }>(
    `SELECT r.alias_id,
            COUNT(*) AS total,
            SUM(CASE WHEN m.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
            MAX(r.date_received) AS last_received
       FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
      GROUP BY r.alias_id`,
  );
  const out = new Map<number, AliasStats>();
  for (const r of rows) {
    out.set(r.alias_id, {
      aliasId: r.alias_id,
      total: r.total,
      unread: r.unread ?? 0,
      lastReceivedAt: r.last_received,
    });
  }
  return out;
}

/**
 * 归属层健康度：最近若干封信各走了哪一层。
 * `header:icloud-hme` 占比骤降是苹果改了转发实现的最早信号。
 */
export function matchLayerDistribution(db: Db, limit = 200): Array<{ layer: string; count: number }> {
  return db.all<{ layer: string; count: number }>(
    `SELECT COALESCE(match_layer, '(空)') AS layer, COUNT(*) AS count
       FROM (SELECT match_layer FROM messages ORDER BY id DESC LIMIT ?)
      GROUP BY layer ORDER BY count DESC`,
    limit,
  );
}
