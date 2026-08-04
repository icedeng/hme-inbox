/**
 * 附件落盘。
 *
 * 三档策略的理由：小附件放 BLOB 能随消息一起 CASCADE 删掉，省一套清理逻辑；
 * 但大 BLOB 会撑爆 SQLite 的 page cache，拖慢**所有**查询，所以必须落盘；
 * 超大的干脆只留元数据，否则一封垃圾邮件就能把磁盘吃满。
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { AttachmentStorage } from '../repositories/attachments.repo.ts';

export interface AttachmentStoreOptions {
  baseDir: string;
  maxInlineBytes: number;
  maxFileBytes: number;
}

export interface StoredAttachment {
  storage: AttachmentStorage;
  content: Buffer | null;
  filePath: string | null;
}

export interface AttachmentStore {
  store(sha256: string, content: Buffer): StoredAttachment;
  read(filePath: string): Buffer | null;
  remove(filePath: string): boolean;
  /** 扫出已不被任何记录引用的文件。清理顺序决定了孤儿只可能多不可能少。 */
  findOrphans(referenced: Set<string>): string[];
}

/** 按 sha256 前两位分桶，避免单目录堆几万个文件。 */
function relativePathFor(sha256: string): string {
  return join(sha256.slice(0, 2), sha256);
}

export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStore {
  const baseDir = resolve(options.baseDir);

  return {
    store(sha256, content) {
      if (content.length <= options.maxInlineBytes) {
        return { storage: 'inline', content, filePath: null };
      }
      if (content.length > options.maxFileBytes) {
        // 只留元数据。用户在后台仍能看到「有个 30MB 的附件」，只是下不了。
        return { storage: 'dropped', content: null, filePath: null };
      }
      const rel = relativePathFor(sha256);
      const abs = join(baseDir, rel);
      mkdirSync(resolve(abs, '..'), { recursive: true });
      // 内容按 sha256 寻址，已存在就是同一份，不必重写
      if (!existsSync(abs)) writeFileSync(abs, content, { mode: 0o600 });
      return { storage: 'file', content: null, filePath: rel };
    },

    read(filePath) {
      const abs = join(baseDir, filePath);
      // 防目录穿越：拼出来的路径必须仍在 baseDir 之内
      if (!resolve(abs).startsWith(baseDir)) return null;
      try {
        return readFileSync(abs);
      } catch {
        return null;
      }
    },

    remove(filePath) {
      const abs = join(baseDir, filePath);
      if (!resolve(abs).startsWith(baseDir)) return false;
      try {
        unlinkSync(abs);
        return true;
      } catch {
        return false;
      }
    },

    findOrphans(referenced) {
      const orphans: string[] = [];
      let buckets: string[];
      try {
        buckets = readdirSync(baseDir);
      } catch {
        return orphans;
      }
      for (const bucket of buckets) {
        let files: string[];
        try {
          files = readdirSync(join(baseDir, bucket));
        } catch {
          continue;
        }
        for (const file of files) {
          const rel = join(bucket, file);
          if (!referenced.has(rel)) orphans.push(rel);
        }
      }
      return orphans;
    },
  };
}
