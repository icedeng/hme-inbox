/**
 * 原始 MIME → 结构化邮件。封装 mailparser，并加两层自己的处理：
 *
 * 1. 头部走自己的 parseHeaders：归属层的兜底要扫原始头块，
 *    mailparser 只给出它认识的头，用它就等于放弃了那层兜底。
 * 2. 超大邮件只解析头部：simpleParser 会把整封信读进内存，
 *    一封 50MB 的附件邮件足以让 worker OOM。
 */
import { createHash } from 'node:crypto';
import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';
import { splitHeaderBlock, parseHeaders, type HeaderPair, getHeader } from './headers.ts';
import { normalizeAddress } from './address.ts';
import { htmlToText } from './htmlToText.ts';

export interface ParsedAttachment {
  filename: string | null;
  contentType: string | null;
  contentId: string | null;
  disposition: string | null;
  size: number;
  sha256: string;
  content: Buffer;
}

export interface ParsedMessage {
  headers: HeaderPair[];
  rawHeaderBlock: string;
  contentHash: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toRaw: string | null;
  subject: string | null;
  dateSent: string | null;
  textBody: string | null;
  htmlBody: string | null;
  /** html 转出来的纯文本，供归属层与验证码提取使用。 */
  htmlText: string | null;
  snippet: string | null;
  attachments: ParsedAttachment[];
  sizeBytes: number;
  /** 超过上限时只解析了头部。 */
  truncated: boolean;
}

const SNIPPET_LENGTH = 200;

export interface ParseOptions {
  maxBytes: number;
}

export async function parseMessage(raw: Buffer, options: ParseOptions): Promise<ParsedMessage> {
  const sizeBytes = raw.length;
  const contentHash = createHash('sha256').update(raw).digest('hex');

  // 头块无论如何都自己解析一遍：归属层依赖它，而且超大邮件时它是唯一可用信息
  const rawText = raw.toString('utf8');
  const { headerBlock } = splitHeaderBlock(rawText);
  const headers = parseHeaders(headerBlock);

  const base = {
    headers,
    rawHeaderBlock: headerBlock,
    contentHash,
    sizeBytes,
    messageIdHeader: getHeader(headers, 'Message-ID'),
    inReplyTo: getHeader(headers, 'In-Reply-To'),
    toRaw: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
  };

  if (sizeBytes > options.maxBytes) {
    // 超限：不调 simpleParser，避免把整封信读进内存
    const from = normalizeAddress(getHeader(headers, 'From'));
    return {
      ...base,
      fromAddress: from?.fullNormalized ?? null,
      fromName: null,
      dateSent: parseDate(getHeader(headers, 'Date')),
      textBody: null,
      htmlBody: null,
      htmlText: null,
      snippet: `（邮件体积 ${(sizeBytes / 1048576).toFixed(1)}MB 超过上限，仅保存头部）`,
      attachments: [],
      truncated: true,
    };
  }

  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(raw, { skipImageLinks: true });
  } catch (err) {
    // 畸形 MIME 在垃圾邮件里很常见。头部已经拿到了，归属仍然可以进行，
    // 所以退化处理而不是让整封信失败。
    const from = normalizeAddress(getHeader(headers, 'From'));
    return {
      ...base,
      fromAddress: from?.fullNormalized ?? null,
      fromName: null,
      dateSent: parseDate(getHeader(headers, 'Date')),
      textBody: null,
      htmlBody: null,
      htmlText: null,
      snippet: `（MIME 解析失败：${err instanceof Error ? err.message : String(err)}）`,
      attachments: [],
      truncated: true,
    };
  }

  const fromEntry = parsed.from?.value?.[0];
  const fromAddress = normalizeAddress(fromEntry?.address ?? null);
  const htmlBody = typeof parsed.html === 'string' ? parsed.html : null;
  const htmlText = htmlBody ? htmlToText(htmlBody) : null;
  const textBody = parsed.text ?? null;

  const snippetSource = textBody?.trim() || htmlText?.trim() || '';
  const snippet = snippetSource
    ? snippetSource.replace(/\s+/g, ' ').slice(0, SNIPPET_LENGTH)
    : null;

  return {
    ...base,
    // mailparser 解出来的主题已解码，优先用它
    subject: parsed.subject ?? base.subject,
    messageIdHeader: parsed.messageId ?? base.messageIdHeader,
    fromAddress: fromAddress?.fullNormalized ?? null,
    fromName: fromEntry?.name || null,
    dateSent: parsed.date ? parsed.date.toISOString() : parseDate(getHeader(headers, 'Date')),
    textBody,
    htmlBody,
    htmlText,
    snippet,
    attachments: parsed.attachments.map(toParsedAttachment),
    truncated: false,
  };
}

function toParsedAttachment(a: Attachment): ParsedAttachment {
  const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content as Uint8Array);
  return {
    filename: a.filename ?? null,
    contentType: a.contentType ?? null,
    contentId: a.cid ?? null,
    disposition: a.contentDisposition ?? null,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    content,
  };
}

/**
 * Date 头可伪造、可缺失、时钟可能不准，所以它只用于展示。
 * 排序与保留期一律用 IMAP 的 INTERNALDATE。解析失败返回 null 而不是回退到 now。
 */
function parseDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
