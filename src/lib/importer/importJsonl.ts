/**
 * 解析 icloud-hme-cli 产出的 batch*.jsonl，或每行一个地址的纯文本清单。
 * 纯函数，不碰数据库。
 *
 * 关于 `index` 字段：它**不能当主键**。上游 `BatchRunner.run` 里
 * `startingIndex = 已有行数 + 1`，换个输出文件或用 --overwrite 之后
 * index 会从 1 重来，跨文件必然冲突。唯一可靠的自然键是 email。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeAddress, type NormalizedAddress } from '../email/address.ts';

/**
 * 刻意不用 z.string().email()：严格的 email 正则会误拒某些合法本地部分，
 * 而这里的地址是苹果生成的、可信的。只做最低限度检查即可。
 */
const BatchRecordSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  email: z.string().min(3),
  label: z.string().max(256).optional(),
  note: z.string().max(1024).optional(),
  verified: z.boolean().optional(),
  portal: z.string().max(128).optional(),
  created_at: z.string().max(64).optional(),
});

export interface ImportRecord {
  email: string;
  address: NormalizedAddress;
  label: string;
  note: string;
  batchIndex: number | null;
  portal: string;
  verified: boolean;
  sourceCreatedAt: string | null;
  /** 纯文本清单没有标签等元数据，重复导入时应保留已有值。 */
  metadataProvided: boolean;
}

export interface ImportError {
  line: number;
  raw: string;
  reason: string;
}

export interface ImportParseResult {
  records: ImportRecord[];
  errors: ImportError[];
  fileSha256: string;
  totalLines: number;
  /** 文件内部重复的地址（后出现的会覆盖先出现的）。 */
  duplicatesInFile: string[];
}

export type ImportFormat = 'jsonl' | 'text';

/** 截断过长的原始行，避免错误详情把数据库撑爆。 */
function truncate(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * 兼容两种导入文件：
 * - icloud-hme-cli 产出的 JSONL（每行一个 JSON 对象）
 * - 纯文本地址清单（每行一个邮箱地址）
 */
export function parseBatchJsonl(buffer: Buffer, format?: ImportFormat): ImportParseResult {
  const fileSha256 = createHash('sha256').update(buffer).digest('hex');
  const text = buffer.toString('utf8');
  const resolvedFormat = format ?? detectImportFormat(text);

  const records: ImportRecord[] = [];
  const errors: ImportError[] = [];
  const seen = new Map<string, number>();
  const duplicatesInFile: string[] = [];

  function addRecord(record: ImportRecord): void {
    const prev = seen.get(record.address.normalized);
    if (prev !== undefined) {
      duplicatesInFile.push(record.address.normalized);
      // 同一文件里重复出现时保留后者：--append 模式下后写的是更新的
      records.splice(prev, 1);
      // splice 之后其余记录的下标要整体前移
      for (const [key, idx] of seen) {
        if (idx > prev) seen.set(key, idx - 1);
      }
    }

    seen.set(record.address.normalized, records.length);
    records.push(record);
  }

  const lines = text.split('\n');
  let totalLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    totalLines++;
    const lineNo = i + 1;

    if (resolvedFormat === 'text') {
      const address = normalizeAddress(raw);
      if (!address) {
        errors.push({ line: lineNo, raw: truncate(raw), reason: `无法解析为邮件地址：${raw}` });
        continue;
      }

      addRecord({
        email: raw,
        address,
        label: '',
        note: '',
        batchIndex: null,
        portal: '',
        verified: false,
        sourceCreatedAt: null,
        metadataProvided: false,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ line: lineNo, raw: truncate(raw), reason: 'JSON 解析失败' });
      continue;
    }

    const result = BatchRecordSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
        .join('; ');
      errors.push({ line: lineNo, raw: truncate(raw), reason: detail });
      continue;
    }

    const address = normalizeAddress(result.data.email);
    if (!address) {
      errors.push({
        line: lineNo,
        raw: truncate(raw),
        reason: `无法解析为邮件地址：${result.data.email}`,
      });
      continue;
    }

    addRecord({
      email: result.data.email.trim(),
      address,
      label: result.data.label ?? '',
      note: result.data.note ?? '',
      batchIndex: result.data.index ?? null,
      portal: result.data.portal ?? '',
      verified: result.data.verified ?? false,
      sourceCreatedAt: normalizeTimestamp(result.data.created_at),
      metadataProvided: true,
    });
  }

  return {
    records,
    errors,
    fileSha256,
    totalLines,
    duplicatesInFile: [...new Set(duplicatesInFile)],
  };
}

function detectImportFormat(text: string): ImportFormat {
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean);
  return firstLine?.startsWith('{') ? 'jsonl' : 'text';
}

/** 上游写的是秒级 ISO8601（`2026-08-04T21:12:48Z`），统一成毫秒精度 UTC。 */
function normalizeTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
