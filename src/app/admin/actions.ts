'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { basename, extname } from 'node:path';
import { getDb } from '../../lib/db/connection.ts';
import { withWriteTx } from '../../lib/db/driver.ts';
import { webEnv } from '../../lib/config/env.ts';
import { requireSession, endSession } from '../../lib/auth/session.ts';
import { parseBatchJsonl } from '../../lib/importer/importJsonl.ts';
import { createToken } from '../../lib/tokens/token.ts';
import { buildAliasIndex } from '../../lib/matching/aliasIndex.ts';
import { rulesFromEnv } from '../../lib/matching/rules.ts';
import { createAttachmentStore } from '../../lib/ingest/attachmentStore.ts';
import { rematchUnmatched } from '../../lib/ingest/ingestMessage.ts';
import * as aliasesRepo from '../../lib/repositories/aliases.repo.ts';
import * as miscRepo from '../../lib/repositories/misc.repo.ts';
import * as syncRepo from '../../lib/repositories/sync.repo.ts';

/**
 * 每个动作都自己校验会话。
 * middleware 只做 cookie 存在性粗筛，它在 Edge runtime 读不到数据库 ——
 * 少了这一行，伪造一个任意值的 cookie 就能调用这些动作。
 */
async function assertAuthed(): Promise<void> {
  if (!(await requireSession())) redirect('/login');
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect('/login');
}

export interface ImportResult {
  ok: boolean;
  message: string;
  inserted?: number;
  updated?: number;
  failed?: number;
  errors?: Array<{ line: number; reason: string }>;
}

export async function importAction(
  _prev: ImportResult | null,
  formData: FormData,
): Promise<ImportResult> {
  await assertAuthed();

  const pasted = formData.get('emailsText');
  const pastedText = typeof pasted === 'string' ? pasted : '';
  const file = formData.get('file');
  let sourceName: string;
  let buffer: Buffer;
  let format: 'text' | undefined;

  if (pastedText.trim()) {
    if (Buffer.byteLength(pastedText) > 8 * 1024 * 1024) {
      return { ok: false, message: '粘贴内容超过 8MB，请分批导入。' };
    }
    sourceName = 'pasted-aliases.txt';
    buffer = Buffer.from(pastedText);
    format = 'text';
  } else if (file instanceof File && file.size > 0) {
    if (file.size > 8 * 1024 * 1024) {
      return { ok: false, message: '文件超过 8MB，请确认选对了文件。' };
    }
    sourceName = file.name;
    buffer = Buffer.from(await file.arrayBuffer());
    format = extname(file.name).toLowerCase() === '.txt' ? 'text' : undefined;
  } else {
    return { ok: false, message: '请粘贴邮箱地址，或选择一个 jsonl / txt 文件。' };
  }

  const env = webEnv();
  const db = getDb();
  const parsed = parseBatchJsonl(buffer, format);

  if (parsed.records.length === 0) {
    return {
      ok: false,
      message: '没有解析出任何别名。请上传 icloud-hme-cli 的 JSONL，或每行一个邮箱地址的 TXT 文件。',
      failed: parsed.errors.length,
      errors: parsed.errors.slice(0, 10).map((e) => ({ line: e.line, reason: e.reason })),
    };
  }

  const counts = { inserted: 0, updated: 0, failed: parsed.errors.length };

  withWriteTx(db, (tx) => {
    const batchId = miscRepo.createImportBatch(
      tx,
      basename(sourceName),
      parsed.fileSha256,
      parsed.totalLines,
    );
    for (const record of parsed.records) {
      // token 只在首次插入时生成。upsertAlias 的 DO UPDATE 不含 token 列，
      // 所以重复导入不会让已经发出去的取件 URL 失效。
      const token = createToken(env.TOKEN_ENC_KEY);
      const outcome = aliasesRepo.upsertAlias(tx, {
        email: record.email,
        emailNormalized: record.address.normalized,
        localPart: record.address.localPart,
        domain: record.address.domain,
        label: record.label,
        note: record.note,
        batchIndex: record.batchIndex,
        portal: record.portal,
        verified: record.verified,
        sourceCreatedAt: record.sourceCreatedAt,
        importBatchId: batchId,
        metadataProvided: record.metadataProvided,
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        tokenCiphertext: token.ciphertext,
      });
      if (outcome === 'inserted') counts.inserted++;
      else counts.updated++;
    }
    miscRepo.finishImportBatch(tx, batchId, counts, parsed.errors);
  });

  // 导入新别名后立刻回填未匹配的信。
  // 少了这步，「先收到信、后导入 jsonl」的时序竞争会永久丢信 ——
  // 而批量创建别名后过一会儿才导入，这个竞争几乎必然发生。
  let backfilled = 0;
  try {
    const account = db.get<{ id: number }>('SELECT id FROM imap_accounts LIMIT 1');
    if (account) {
      const result = await rematchUnmatched(
        {
          db,
          aliasIndex: buildAliasIndex(aliasesRepo.listForIndex(db)),
          rules: rulesFromEnv(),
          attachmentStore: createAttachmentStore({
            baseDir: env.ATTACHMENT_DIR,
            maxInlineBytes: 262_144,
            maxFileBytes: 10_485_760,
          }),
          clock: () => new Date(),
          maxMessageBytes: 5_242_880,
          retentionDays: env.RETENTION_DAYS,
          unmatchedRetentionDays: env.UNMATCHED_RETENTION_DAYS,
        },
        account.id,
      );
      backfilled = result.resolved;
    }
  } catch {
    // 回填失败不该让导入本身显示为失败；worker 每 30 秒也会再试一次
  }

  revalidatePath('/admin');
  revalidatePath('/admin/aliases');
  revalidatePath('/admin/unmatched');

  const parts = [`新增 ${counts.inserted} 个，更新 ${counts.updated} 个`];
  if (counts.failed > 0) parts.push(`${counts.failed} 行有问题`);
  if (parsed.duplicatesInFile.length > 0) {
    parts.push(`文件内有 ${parsed.duplicatesInFile.length} 个重复地址，保留了后出现的`);
  }
  if (backfilled > 0) parts.push(`回填了 ${backfilled} 封此前无法归属的邮件`);

  return {
    ok: true,
    message: parts.join('；') + '。',
    ...counts,
    errors: parsed.errors.slice(0, 10).map((e) => ({ line: e.line, reason: e.reason })),
  };
}

export async function rotateTokenAction(formData: FormData): Promise<void> {
  await assertAuthed();
  const id = Number(formData.get('aliasId'));
  if (!Number.isInteger(id)) return;

  const env = webEnv();
  const token = createToken(env.TOKEN_ENC_KEY);
  withWriteTx(getDb(), (tx) =>
    aliasesRepo.rotateToken(tx, id, token.hash, token.prefix, token.ciphertext),
  );
  revalidatePath('/admin/aliases');
  revalidatePath(`/admin/aliases/${id}`);
}

/** 疑似数据库泄露时的一键止血。旧 URL 全部立即失效，需要重新分发。 */
export async function rotateAllTokensAction(): Promise<void> {
  await assertAuthed();
  const env = webEnv();
  const db = getDb();
  withWriteTx(db, (tx) => {
    for (const alias of aliasesRepo.listAliases(tx, { limit: 10_000 })) {
      const token = createToken(env.TOKEN_ENC_KEY);
      aliasesRepo.rotateToken(tx, alias.id, token.hash, token.prefix, token.ciphertext);
    }
  });
  revalidatePath('/admin/aliases');
}

export async function setAliasStatusAction(formData: FormData): Promise<void> {
  await assertAuthed();
  const id = Number(formData.get('aliasId'));
  const status = String(formData.get('status'));
  if (!Number.isInteger(id) || (status !== 'active' && status !== 'disabled')) return;

  withWriteTx(getDb(), (tx) => aliasesRepo.setStatus(tx, id, status));
  revalidatePath('/admin/aliases');
  revalidatePath(`/admin/aliases/${id}`);
}

export async function requestReconnectAction(): Promise<void> {
  await assertAuthed();
  withWriteTx(getDb(), (tx) => syncRepo.setCommand(tx, 'reconnect'));
  revalidatePath('/admin');
}
