/**
 * 取件接口的共享逻辑：凭证校验、参数解析、响应构造。
 *
 * 路由层只负责把 HTTP 的壳剥掉，判断逻辑全在这里，便于测试。
 */
import { type Db, withWriteTx } from '../db/driver.ts';
import { hashToken, tokenPrefix } from '../tokens/token.ts';
import { normalizeAddress } from '../email/address.ts';
import { sleep } from '../util/async.ts';
import * as aliasesRepo from '../repositories/aliases.repo.ts';
import * as messagesRepo from '../repositories/messages.repo.ts';
import * as miscRepo from '../repositories/misc.repo.ts';
import type { Alias } from '../repositories/aliases.repo.ts';

// ── 参数 ───────────────────────────────────────────────────────

export interface PickupParams {
  n: number;
  since: string | null;
  unreadOnly: boolean;
  format: 'json' | 'text' | 'code' | 'html';
  markRead: boolean;
  waitSeconds: number;
  allowImages: boolean;
}

/**
 * 未显式指定 format 时，用 Accept 做内容协商。
 * 只有明确声明接受 text/html 才切到 UI；curl 的默认任意类型请求仍保持 JSON。
 */
export function negotiatePickupFormat(
  parsedFormat: PickupParams['format'],
  search: URLSearchParams,
  accept: string | null,
): PickupParams['format'] {
  if (search.has('format') || parsedFormat !== 'json' || !accept) return parsedFormat;

  const qualities = new Map<string, number>();
  for (const part of accept.split(',')) {
    const [mediaTypeRaw, ...parameters] = part.trim().split(';');
    const mediaType = mediaTypeRaw?.trim().toLowerCase();
    if (!mediaType) continue;
    const qRaw = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.toLowerCase().startsWith('q='))
      ?.slice(2);
    const quality = qRaw === undefined ? 1 : Number(qRaw);
    qualities.set(mediaType, Number.isFinite(quality) ? quality : 0);
  }

  const htmlQuality = qualities.get('text/html') ?? 0;
  const jsonQuality = qualities.get('application/json');
  return htmlQuality > 0 && (jsonQuality === undefined || htmlQuality > jsonQuality)
    ? 'html'
    : parsedFormat;
}

export interface ParamError {
  field: string;
  message: string;
}

const MAX_N = 50;
const MAX_WAIT_SECONDS = 30;
/** 长轮询的检查间隔。只查本地 SQLite，成本可忽略。 */
const WAIT_POLL_MS = 200;

/** 支持 ISO8601 或 `5m` / `2h` / `1d` 这类相对写法。 */
function parseSince(raw: string, now: Date): string | null {
  const relative = /^(\d+)\s*([smhd])$/i.exec(raw.trim());
  if (relative) {
    const value = Number(relative[1]);
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      relative[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'
    ];
    return new Date(now.getTime() - value * unitMs).toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseParams(
  search: URLSearchParams,
  now: Date = new Date(),
): { params: PickupParams } | { error: ParamError } {
  const nRaw = search.get('n');
  let n = 1;
  if (nRaw !== null) {
    n = Number(nRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_N) {
      return { error: { field: 'n', message: `n 必须是 1 到 ${MAX_N} 之间的整数` } };
    }
  }

  let since: string | null = null;
  const sinceRaw = search.get('since');
  if (sinceRaw !== null && sinceRaw !== '') {
    since = parseSince(sinceRaw, now);
    if (since === null) {
      return {
        error: { field: 'since', message: 'since 需要是 ISO8601 时间或 5m / 2h / 1d 这类相对写法' },
      };
    }
  }

  const formatRaw = (search.get('format') ?? 'json').toLowerCase();
  if (formatRaw !== 'json' && formatRaw !== 'text' && formatRaw !== 'code' && formatRaw !== 'html') {
    return { error: { field: 'format', message: 'format 只能是 json、text、code 或 html' } };
  }

  let waitSeconds = 0;
  const waitRaw = search.get('wait');
  if (waitRaw !== null && waitRaw !== '') {
    waitSeconds = Number(waitRaw);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
      return { error: { field: 'wait', message: `wait 必须是 0 到 ${MAX_WAIT_SECONDS} 之间的整数秒` } };
    }
  }

  const truthy = (v: string | null, fallback: boolean): boolean =>
    v === null || v === '' ? fallback : v === '1' || v.toLowerCase() === 'true';

  return {
    params: {
      n,
      since,
      unreadOnly: truthy(search.get('unread'), false),
      format: formatRaw,
      markRead: truthy(search.get('mark_read'), true),
      waitSeconds,
      allowImages: truthy(search.get('images'), false),
    },
  };
}

// ── 凭证校验 ───────────────────────────────────────────────────

export type ResolveResult =
  | { ok: true; alias: Alias }
  | { ok: false; status: 404; outcome: 'token_not_found' | 'email_mismatch' }
  | { ok: false; status: 403; outcome: 'alias_disabled'; alias: Alias };

/**
 * token 是唯一权威凭证，URL 里的 email 段是**校验断言**。
 *
 * token 查不到与 email 不符返回**同样的 404 同样的 code**，
 * 避免拿着有效 token 去枚举它对应的真实地址。
 *
 * email 段挡住的是「把 A 的 token 配了 B 的邮箱」这类复制粘贴事故 ——
 * 静默返回错邮箱的信是本系统最难排查的故障，双段校验把它变成明确的 404。
 */
export function resolveAlias(db: Db, token: string, emailSegment: string): ResolveResult {
  const alias = aliasesRepo.findByTokenHash(db, hashToken(token));
  if (!alias) return { ok: false, status: 404, outcome: 'token_not_found' };

  // 兼容那些坚持对 email 段做 URL 编码的调用方
  let decoded = emailSegment;
  try {
    decoded = decodeURIComponent(emailSegment);
  } catch {
    // 非法编码，按原样比对，下面会失配
  }
  const addr = normalizeAddress(decoded);
  if (!addr || addr.normalized !== alias.emailNormalized) {
    return { ok: false, status: 404, outcome: 'email_mismatch' };
  }

  if (alias.status !== 'active') {
    // 此时调用方已证明持有 token，可以明确告知原因
    return { ok: false, status: 403, outcome: 'alias_disabled', alias };
  }
  return { ok: true, alias };
}

// ── 查询 ───────────────────────────────────────────────────────

export interface MessagePayload {
  id: number;
  from: { name: string | null; address: string | null };
  subject: string | null;
  date: string | null;
  received_at: string;
  text: string | null;
  snippet: string | null;
  verification_code: string | null;
  code_confidence: number | null;
  code_candidates: Array<{ code: string; confidence: number; source: string }>;
  has_attachments: boolean;
  unread: boolean;
  mailbox: string;
  truncated: boolean;
  detail_url: string;
  /** 暴露归属层：调用方能一眼看出「这封是靠正文扫描猜出来的」。 */
  match: { layer: string | null; confidence: number | null };
}

export interface ListPayload {
  email: string;
  alias_label: string;
  count: number;
  server_time: string;
  messages: MessagePayload[];
}

function parseCandidates(json: string | null): MessagePayload['code_candidates'] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as MessagePayload['code_candidates']) : [];
  } catch {
    return [];
  }
}

export function toPayload(
  message: messagesRepo.MessageSummary,
  baseUrl: string,
  token: string,
  email: string,
): MessagePayload {
  return {
    id: message.id,
    from: { name: message.fromName, address: message.fromAddress },
    subject: message.subject,
    date: message.dateSent,
    received_at: message.dateReceived,
    text: message.textBody,
    snippet: message.snippet,
    verification_code: message.verificationCode,
    code_confidence: message.codeConfidence,
    code_candidates: parseCandidates(message.codeCandidatesJson),
    has_attachments: message.hasAttachments,
    unread: message.readAt === null,
    mailbox: message.mailbox,
    truncated: message.truncated,
    detail_url: `${baseUrl}/${token}/${email}/${message.id}`,
    match: { layer: message.matchLayer, confidence: message.matchConfidence },
  };
}

/**
 * 取邮件，支持长轮询。
 *
 * `wait` 是价值最高的一个参数：典型用法是「在注册页点了发验证码，立刻来拉」。
 * 没有它，每个调用方都得自己写 sleep+retry 循环。
 */
export async function fetchMessages(
  db: Db,
  aliasId: number,
  params: PickupParams,
  signal?: AbortSignal,
): Promise<messagesRepo.MessageSummary[]> {
  const query = {
    aliasId,
    limit: params.n,
    ...(params.since ? { since: params.since } : {}),
    unreadOnly: params.unreadOnly,
  };

  let messages = messagesRepo.listByAlias(db, query);
  if (messages.length > 0 || params.waitSeconds === 0) return messages;

  const deadline = Date.now() + params.waitSeconds * 1000;
  while (Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
    messages = messagesRepo.listByAlias(db, query);
    if (messages.length > 0) break;
  }
  return messages;
}

export function markMessagesRead(db: Db, messages: messagesRepo.MessageSummary[]): void {
  const unreadIds = messages.filter((m) => m.readAt === null).map((m) => m.id);
  if (unreadIds.length === 0) return;
  withWriteTx(db, (tx) => messagesRepo.markRead(tx, unreadIds));
}

export function recordAccess(db: Db, input: miscRepo.LogAccessInput): void {
  try {
    withWriteTx(db, (tx) => miscRepo.logAccess(tx, input));
  } catch {
    // 访问日志失败绝不能影响取件本身
  }
}

export function touchAlias(db: Db, aliasId: number): void {
  try {
    withWriteTx(db, (tx) => aliasesRepo.touchAccess(tx, aliasId));
  } catch {
    // 同上，统计数据不值得让请求失败
  }
}

export { tokenPrefix };
