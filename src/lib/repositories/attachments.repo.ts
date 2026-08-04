/**
 * 附件表访问。
 *
 * 三档存储：小的进 BLOB（随 message CASCADE 删）、中等落盘、超大只留元数据。
 * 大 BLOB 会撑爆 page cache 并拖慢所有查询，所以不能一律进库。
 */
import { type Db, toBuffer } from '../db/driver.ts';

export type AttachmentStorage = 'inline' | 'file' | 'dropped';

export interface AttachmentMeta {
  id: number;
  messageId: number;
  filename: string | null;
  contentType: string | null;
  contentId: string | null;
  disposition: string | null;
  sizeBytes: number;
  sha256: string;
  storage: AttachmentStorage;
  filePath: string | null;
}

interface AttachmentRow {
  id: number;
  message_id: number;
  filename: string | null;
  content_type: string | null;
  content_id: string | null;
  disposition: string | null;
  size_bytes: number;
  sha256: string;
  storage: AttachmentStorage;
  file_path: string | null;
}

function toMeta(row: AttachmentRow): AttachmentMeta {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.content_type,
    contentId: row.content_id,
    disposition: row.disposition,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storage: row.storage,
    filePath: row.file_path,
  };
}

const META_COLUMNS =
  'id, message_id, filename, content_type, content_id, disposition, size_bytes, sha256, storage, file_path';

export interface InsertAttachmentInput {
  messageId: number;
  partId: string | null;
  filename: string | null;
  contentType: string | null;
  contentId: string | null;
  disposition: string | null;
  sizeBytes: number;
  sha256: string;
  storage: AttachmentStorage;
  content: Buffer | null;
  filePath: string | null;
}

export function insertAttachment(db: Db, input: InsertAttachmentInput): number {
  const r = db.run(
    `INSERT INTO attachments
       (message_id, part_id, filename, content_type, content_id, disposition,
        size_bytes, sha256, storage, content, file_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    input.messageId,
    input.partId,
    input.filename,
    input.contentType,
    input.contentId,
    input.disposition,
    input.sizeBytes,
    input.sha256,
    input.storage,
    input.content,
    input.filePath,
  );
  return r.lastInsertRowid;
}

export function listByMessage(db: Db, messageId: number): AttachmentMeta[] {
  return db
    .all<AttachmentRow>(
      `SELECT ${META_COLUMNS} FROM attachments WHERE message_id = ? ORDER BY id`,
      messageId,
    )
    .map(toMeta);
}

/** 带别名归属校验，防止用 A 的 token 下载 B 的附件。 */
export function getForAlias(
  db: Db,
  aliasId: number,
  messageId: number,
  attachmentId: number,
): (AttachmentMeta & { content: Buffer | null }) | undefined {
  const row = db.get<AttachmentRow & { content: Uint8Array | null }>(
    `SELECT a.${META_COLUMNS.split(', ').join(', a.')}, a.content
       FROM attachments a
       JOIN message_recipients r ON r.message_id = a.message_id
      WHERE r.alias_id = ? AND a.message_id = ? AND a.id = ?`,
    aliasId,
    messageId,
    attachmentId,
  );
  if (!row) return undefined;
  return { ...toMeta(row), content: toBuffer(row.content) };
}

/**
 * 清理前先取出待删的落盘路径。
 *
 * 顺序很关键：必须「先查路径 → 删数据库行 → 最后删文件」。
 * 反过来的话，删文件成功但删行失败会留下指向不存在文件的记录（下载报 500）；
 * 按正确顺序最差只留下孤儿文件，再由孤儿扫描兜底。
 */
export function filePathsForExpiredMessages(db: Db, cutoff: string, limit: number): string[] {
  return db
    .all<{ file_path: string }>(
      `SELECT a.file_path FROM attachments a
         JOIN messages m ON m.id = a.message_id
        WHERE a.storage = 'file' AND a.file_path IS NOT NULL AND m.expires_at < ?
        LIMIT ?`,
      cutoff,
      limit,
    )
    .map((r) => r.file_path);
}

/** 全部仍被引用的文件名，供孤儿扫描比对。 */
export function allReferencedFilePaths(db: Db): Set<string> {
  const rows = db.all<{ file_path: string }>(
    `SELECT file_path FROM attachments WHERE storage = 'file' AND file_path IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.file_path));
}
