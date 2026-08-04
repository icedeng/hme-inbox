/**
 * 入库编排 —— 全系统唯一的副作用汇聚点：解析 → 归属 → 入库 → 附件。
 *
 * 依赖全部从参数注入，测试时用 :memory: 的真 SQLite 加 .eml 固件
 * 就能跑完整回归，完全不碰网络。
 */
import { type Db, withWriteTx, isoNow } from '../db/driver.ts';
import { parseMessage } from '../email/parse.ts';
import { extractVerificationCode } from '../email/verificationCode.ts';
import { matchAlias } from '../matching/matchAlias.ts';
import type { AliasIndex } from '../matching/aliasIndex.ts';
import type { MatchRules, MatchLayer } from '../matching/rules.ts';
import type { AttachmentStore } from './attachmentStore.ts';
import * as messagesRepo from '../repositories/messages.repo.ts';
import * as attachmentsRepo from '../repositories/attachments.repo.ts';
import * as unmatchedRepo from '../repositories/unmatched.repo.ts';

export interface IngestDeps {
  db: Db;
  aliasIndex: AliasIndex;
  rules: MatchRules;
  attachmentStore: AttachmentStore;
  clock: () => Date;
  maxMessageBytes: number;
  retentionDays: number;
  unmatchedRetentionDays: number;
}

export interface IngestInput {
  accountId: number;
  mailbox: string;
  uidvalidity: number;
  uid: number;
  raw: Buffer;
  /** IMAP 的 INTERNALDATE。排序与保留期一律用它，不用可伪造的 Date 头。 */
  internalDate: Date;
}

export type IngestOutcome =
  | { kind: 'inserted'; messageId: number; aliasIds: number[]; layer: MatchLayer }
  | { kind: 'duplicate'; reason: 'uid' | 'hash' }
  | { kind: 'unmatched'; unmatchedId: number | null; reason: string }
  | { kind: 'error'; error: Error };

function addDays(base: Date, days: number): string {
  return new Date(base.getTime() + days * 86_400_000).toISOString();
}

export async function ingestMessage(
  deps: IngestDeps,
  input: IngestInput,
): Promise<IngestOutcome> {
  try {
    const parsed = await parseMessage(input.raw, { maxBytes: deps.maxMessageBytes });

    const match = matchAlias({
      headers: parsed.headers,
      rawHeaderBlock: parsed.rawHeaderBlock,
      textBody: parsed.textBody ?? undefined,
      htmlText: parsed.htmlText ?? undefined,
      index: deps.aliasIndex,
      rules: deps.rules,
    });

    const dateReceived = input.internalDate.toISOString();
    const now = deps.clock();

    // ── 未匹配：全量留档，等导入新别名后回填 ──────────────
    if (match.matches.length === 0) {
      const unmatchedId = withWriteTx(deps.db, (tx) =>
        unmatchedRepo.insertUnmatched(tx, {
          accountId: input.accountId,
          mailbox: input.mailbox,
          uidvalidity: input.uidvalidity,
          uid: input.uid,
          contentHash: parsed.contentHash,
          messageIdHeader: parsed.messageIdHeader,
          fromAddress: parsed.fromAddress,
          subject: parsed.subject,
          dateReceived,
          reason: match.unmatchedReason ?? 'address_not_in_alias_table',
          headerNames: match.observedHeaderNames,
          candidates: match.candidateAddresses.map((c) => c.address),
          rawHeaders: parsed.rawHeaderBlock,
          rawMime: parsed.truncated ? null : input.raw,
          expiresAt: addDays(now, deps.unmatchedRetentionDays),
        }),
      );
      return {
        kind: 'unmatched',
        unmatchedId,
        reason: match.unmatchedReason ?? 'address_not_in_alias_table',
      };
    }

    // ── 验证码提取：入库时算一次并存下来 ──────────────────
    // 不在请求时算：正则一定会迭代，存库后可以全量重跑做回归；
    // 请求时算既贵又无法回归。
    const code = extractVerificationCode({
      subject: parsed.subject,
      text: parsed.textBody,
      html: parsed.htmlBody,
    });

    const primary = match.primary!;

    return withWriteTx(deps.db, (tx) => {
      const messageId = messagesRepo.insertMessage(tx, {
        accountId: input.accountId,
        mailbox: input.mailbox,
        uidvalidity: input.uidvalidity,
        uid: input.uid,
        contentHash: parsed.contentHash,
        messageIdHeader: parsed.messageIdHeader,
        inReplyTo: parsed.inReplyTo,
        fromAddress: parsed.fromAddress,
        fromName: parsed.fromName,
        toRaw: parsed.toRaw,
        subject: parsed.subject,
        dateSent: parsed.dateSent,
        dateReceived,
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody,
        snippet: parsed.snippet,
        verificationCode: code.best?.code ?? null,
        codeConfidence: code.best?.confidence ?? null,
        codeSource: code.best?.source ?? null,
        codeCandidatesJson: code.candidates.length ? JSON.stringify(code.candidates) : null,
        hasAttachments: parsed.attachments.length > 0,
        sizeBytes: parsed.sizeBytes,
        truncated: parsed.truncated,
        rawMime: parsed.truncated ? null : input.raw,
        rawHeaders: parsed.rawHeaderBlock,
        matchLayer: primary.layer,
        matchConfidence: primary.confidence,
        expiresAt: addDays(now, deps.retentionDays),
      });

      if (messageId === null) {
        const reason =
          messagesRepo.findDuplicateReason(
            tx,
            input.accountId,
            input.mailbox,
            input.uidvalidity,
            input.uid,
            parsed.contentHash,
          ) ?? 'hash';
        return { kind: 'duplicate', reason } as const;
      }

      messagesRepo.linkRecipients(
        tx,
        messageId,
        dateReceived,
        match.matches.map((m) => ({
          aliasId: m.aliasId,
          matchLayer: m.layer,
          confidence: m.confidence,
          matchedVia: m.matchedVia,
          isPrimary: m.aliasId === primary.aliasId,
        })),
      );

      for (const att of parsed.attachments) {
        const stored = deps.attachmentStore.store(att.sha256, att.content);
        attachmentsRepo.insertAttachment(tx, {
          messageId,
          partId: null,
          filename: att.filename,
          contentType: att.contentType,
          contentId: att.contentId,
          disposition: att.disposition,
          sizeBytes: att.size,
          sha256: att.sha256,
          storage: stored.storage,
          content: stored.content,
          filePath: stored.filePath,
        });
      }

      return {
        kind: 'inserted',
        messageId,
        aliasIds: match.matches.map((m) => m.aliasId),
        layer: primary.layer,
      } as const;
    });
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * 重扫未匹配邮件。
 *
 * **导入新别名后必须调用。** 没有这一步，「先收到信、后导入 jsonl」
 * 的时序竞争会永久丢信 —— 而这个竞争在实际使用中几乎必然发生
 * （批量创建别名后总要过一会儿才导入）。
 */
export async function rematchUnmatched(
  deps: IngestDeps,
  accountId: number,
  limit = 500,
): Promise<{ examined: number; resolved: number }> {
  const pending = unmatchedRepo.listPending(deps.db, limit);
  let resolved = 0;

  for (const item of pending) {
    const raw = unmatchedRepo.getRawMime(deps.db, item.id);
    if (!raw) {
      // 原文没留下（超限被裁剪过），只能靠人工归属
      withWriteTx(deps.db, (tx) => unmatchedRepo.recordRematchAttempt(tx, item.id, isoNow()));
      continue;
    }

    const outcome = await ingestMessage(deps, {
      accountId,
      mailbox: item.mailbox,
      uidvalidity: item.uidvalidity,
      uid: item.uid,
      raw,
      internalDate: new Date(item.dateReceived),
    });

    withWriteTx(deps.db, (tx) => {
      if (outcome.kind === 'inserted') {
        unmatchedRepo.markResolved(tx, item.id, outcome.messageId, isoNow());
        resolved++;
      } else if (outcome.kind === 'duplicate') {
        // 已经以别的途径入库了，这条留档可以收工
        unmatchedRepo.markResolved(tx, item.id, 0, isoNow());
        resolved++;
      } else {
        unmatchedRepo.recordRematchAttempt(tx, item.id, isoNow());
      }
    });
  }

  return { examined: pending.length, resolved };
}
