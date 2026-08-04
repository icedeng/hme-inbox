/**
 * 原始邮件头解析。
 *
 * 为什么不直接用 mailparser 的 headers Map：归属层的最后一道兜底（L6）要扫描
 * **原始头块**，才能发现苹果将来新增的、我们还不认识的头名。
 * mailparser 只给出它认识的那些头，用它就等于放弃了这层兜底。
 */

export interface HeaderPair {
  /** 原样大小写，展示与上报用。 */
  name: string;
  /** 小写，比对用。 */
  lower: string;
  /** 已 unfold 且已解码 encoded-word 的值。 */
  value: string;
  /** 未解码的原始值，扫描地址时用（编码过的头里不会有明文地址）。 */
  rawValue: string;
}

/** 切出头块与正文。兼容 CRLF 与 LF。 */
export function splitHeaderBlock(raw: string): { headerBlock: string; body: string } {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  let idx: number;
  let sepLen: number;

  if (crlf === -1 && lf === -1) return { headerBlock: raw, body: '' };
  if (crlf === -1) {
    idx = lf;
    sepLen = 2;
  } else if (lf === -1 || crlf < lf) {
    idx = crlf;
    sepLen = 4;
  } else {
    idx = lf;
    sepLen = 2;
  }
  return { headerBlock: raw.slice(0, idx), body: raw.slice(idx + sepLen) };
}

/**
 * RFC 5322 unfold + 解析。
 *
 * 续行以空白开头，必须折回上一行 —— 长地址常被折行，
 * 不 unfold 会让地址被换行切成两半，扫描直接失配。
 */
export function parseHeaders(headerBlock: string): HeaderPair[] {
  const out: HeaderPair[] = [];
  const lines = headerBlock.split(/\r?\n/);
  let current: string | null = null;

  const flush = (): void => {
    if (current === null) return;
    const colon = current.indexOf(':');
    if (colon > 0) {
      const name = current.slice(0, colon).trim();
      const rawValue = current.slice(colon + 1).trim();
      out.push({
        name,
        lower: name.toLowerCase(),
        value: decodeEncodedWords(rawValue),
        rawValue,
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (line === '') continue;
    if (/^[ \t]/.test(line)) {
      // 折叠成单空格：RFC 规定 unfold 时去掉 CRLF 保留空白
      if (current !== null) current += ' ' + line.trim();
    } else {
      flush();
      current = line;
    }
  }
  flush();
  return out;
}

/**
 * 解码 RFC 2047 encoded-word（`=?UTF-8?B?...?=`）。
 * 实测 ChatGPT 的中文主题就是这个形式。
 */
export function decodeEncodedWords(input: string): string {
  if (!input.includes('=?')) return input;

  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s*)(?==\?|$|[^\s])?/g,
    (match, charset: string, encoding: string, text: string, trailing: string) => {
      try {
        let bytes: Buffer;
        if (encoding.toUpperCase() === 'B') {
          bytes = Buffer.from(text, 'base64');
        } else {
          // Q 编码：下划线代表空格，=XX 是十六进制字节
          const q = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          );
          bytes = Buffer.from(q, 'binary');
        }
        const decoded = decodeWithCharset(bytes, charset);
        // 相邻 encoded-word 之间的空白按 RFC 应当丢弃
        return decoded + (trailing && /\S/.test(trailing) ? trailing : '');
      } catch {
        return match;
      }
    },
  );
}

function decodeWithCharset(bytes: Buffer, charset: string): string {
  const cs = charset.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const alias: Record<string, BufferEncoding> = {
    'utf-8': 'utf8',
    utf8: 'utf8',
    'us-ascii': 'ascii',
    ascii: 'ascii',
    'iso-8859-1': 'latin1',
    latin1: 'latin1',
    'windows-1252': 'latin1',
  };
  const enc = alias[cs];
  if (enc) return bytes.toString(enc);
  // 其余字符集交给 TextDecoder；不认识就退回 utf8，宁可乱码也不丢内容
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

// ── X-ICLOUD-HME ───────────────────────────────────────────────

/**
 * 苹果转发 Hide My Email 时加的专用头，Phase 0 实测 100% 出现：
 *
 *   X-ICLOUD-HME: p=alias@icloud.com; d=; f=owner@icloud.com; r=to; s=noreply@x.ai
 *
 * 各字段含义（由实测推断，苹果无公开文档）：
 *   p = pseudonym，即别名本身 —— 这是全系统最权威的归属信号
 *   d = 自定义域，实测为空
 *   f = forward-to，转发目标（主邮箱）
 *   r = relation，别名出现在 to / cc / bcc 哪个位置
 *   s = sender，原始发件人
 *
 * `r` 字段的存在很关键：BCC 投递时 To 头里不会有别名，但 p= 仍然在，
 * 所以这个头严格强于 To。
 */
export interface ICloudHmeHeader {
  pseudonym: string | null;
  domain: string | null;
  forwardTo: string | null;
  relation: string | null;
  sender: string | null;
}

export function parseICloudHmeHeader(value: string): ICloudHmeHeader {
  const fields = new Map<string, string>();
  for (const segment of value.split(';')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    const val = segment.slice(eq + 1).trim();
    if (key) fields.set(key, val);
  }
  return {
    pseudonym: fields.get('p') || null,
    domain: fields.get('d') || null,
    forwardTo: fields.get('f') || null,
    relation: fields.get('r') || null,
    sender: fields.get('s') || null,
  };
}

// ── 扫描时必须排除的头 ─────────────────────────────────────────

/**
 * L6 原始头扫描前必须排除这些头。
 *
 * 前七个是发件人类：别名之间互发邮件时，发件人恰好是库里的另一个别名，
 * 不排除就会把信归属到发件人身上 —— 这类 bug 极难在使用中被发现。
 *
 * 后两个是 Phase 0 实测发现的「假朋友」：
 *   Original-recipient: rfc822;owner@icloud.com   ← 主邮箱，不是别名
 *   Received: ... for <owner@icloud.com>          ← 同样是主邮箱
 * 它们看起来像收件人信号，实际记录的是转发目标，永远匹配不到别名。
 */
export const SCAN_EXCLUDED_HEADERS = new Set([
  'from',
  'sender',
  'reply-to',
  'return-path',
  'message-id',
  'references',
  'in-reply-to',
  'disposition-notification-to',
  'original-recipient',
  'received',
]);

/** 取指定头的值（大小写不敏感），可能有多个同名头。 */
export function getHeaders(headers: HeaderPair[], name: string): HeaderPair[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.lower === lower);
}

export function getHeader(headers: HeaderPair[], name: string): string | null {
  return getHeaders(headers, name)[0]?.value ?? null;
}
