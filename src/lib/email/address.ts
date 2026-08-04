/**
 * 邮件地址规范化。
 *
 * 这个模块只有一件事最重要：**绝对不做 dot-stripping**。
 *
 * 只有 Gmail 忽略本地部分里的点，iCloud 不忽略。而本批别名大量含点
 * （orchid.chive.5h、77.hazel_muskier、mint.cave.4m）。去点会让
 * `mint.cave.4m` 和 `mintcave4m` 混为一谈，制造**跨别名的错误投递** ——
 * 把 A 的验证码发给 B 是本系统最严重的一类故障，而且极难被发现。
 */

export interface NormalizedAddress {
  /** 原始输入，去掉 display name 与尖括号后的地址本体。 */
  raw: string;
  /** 小写本地部分，保留点与其他分隔符。 */
  localPart: string;
  /** 小写域名，punycode 转 ASCII。 */
  domain: string;
  /** 匹配主键：去掉 plus 标签后的完整地址。 */
  normalized: string;
  /** 保留 plus 标签的完整地址。 */
  fullNormalized: string;
}

/**
 * 解析并规范化单个地址。
 *
 * 畸形地址在垃圾邮件里非常常见，所以返回 null 而不是抛异常 ——
 * 一个坏地址不该让整封信的处理中断。
 */
export function normalizeAddress(input: string | null | undefined): NormalizedAddress | null {
  if (!input) return null;

  let s = input.trim();
  if (!s) return null;

  // 剥离 display name 与尖括号：`Hide My Email <x@icloud.com>` → `x@icloud.com`
  const angle = /<([^<>]*)>\s*$/.exec(s);
  if (angle && angle[1] !== undefined) {
    s = angle[1].trim();
  }
  s = s.replace(/^mailto:/i, '').trim();
  // 去掉包裹的引号
  s = s.replace(/^["']|["']$/g, '').trim();
  if (!s) return null;

  // 按最后一个 @ 切分：本地部分理论上可以含引号内的 @
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;

  const localRaw = s.slice(0, at);
  let domainRaw = s.slice(at + 1);

  if (!localRaw || !domainRaw) return null;
  // 地址里不该有空白；出现说明解析出了问题
  if (/\s/.test(localRaw) || /\s/.test(domainRaw)) return null;

  // 域名：小写、去尾点、punycode
  domainRaw = domainRaw.toLowerCase().replace(/\.+$/, '');
  if (!domainRaw.includes('.')) return null;
  let domain: string;
  try {
    // URL 构造器会顺带做 IDNA/punycode 转换
    domain = new URL(`http://${domainRaw}`).hostname;
  } catch {
    return null;
  }
  if (!domain) return null;

  // 本地部分：只小写。RFC 5321 说它大小写敏感，但包括 iCloud 在内的
  // 所有主流服务实际都不敏感，统一小写以便匹配。
  const localPart = localRaw.toLowerCase();

  // plus-addressing：同时产出截断版与完整版，匹配时先试完整再试截断
  const plus = localPart.indexOf('+');
  const localNoTag = plus > 0 ? localPart.slice(0, plus) : localPart;

  return {
    raw: s,
    localPart,
    domain,
    normalized: `${localNoTag}@${domain}`,
    fullNormalized: `${localPart}@${domain}`,
  };
}

/**
 * 从一个头值里解析出所有地址（To / Cc 可能有多个，以逗号分隔）。
 *
 * 不能简单 split(',')：display name 里可能带引号包裹的逗号
 * （`"Doe, John" <j@x.com>`）。所以按引号与尖括号状态切分。
 */
export function parseAddressList(headerValue: string | null | undefined): NormalizedAddress[] {
  if (!headerValue) return [];

  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  for (let i = 0; i < headerValue.length; i++) {
    const ch = headerValue[i]!;
    if (ch === '"' && headerValue[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '<' && !inQuotes) {
      inAngle = true;
      current += ch;
    } else if (ch === '>' && !inQuotes) {
      inAngle = false;
      current += ch;
    } else if ((ch === ',' || ch === ';') && !inQuotes && !inAngle) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  const out: NormalizedAddress[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const addr = normalizeAddress(part);
    if (addr && !seen.has(addr.fullNormalized)) {
      seen.add(addr.fullNormalized);
      out.push(addr);
    }
  }
  return out;
}

/** 从任意文本里抽出所有形似邮件地址的串，用于发现漏导入的别名。 */
export function extractAddresses(text: string, domainFilter?: string): string[] {
  const re = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  const out = new Set<string>();
  for (const match of text.match(re) ?? []) {
    const addr = normalizeAddress(match);
    if (!addr) continue;
    if (domainFilter && addr.domain !== domainFilter) continue;
    out.add(addr.fullNormalized);
  }
  return [...out];
}
