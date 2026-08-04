/**
 * 把邮件 HTML 转成纯文本，供验证码提取与摘要使用。
 *
 * 这不是安全清洗（那是 sanitizeHtml.ts 的职责），目的只有一个：
 * 拿到人眼实际看得到的文字。
 *
 * 最关键的一条是整块剔除 <style> / <script> / <head>：
 * 真实邮件的 <style> 里全是 `font-weight: 400`、`0pt`、`100%`、`#outlook`
 * 这类 token，只去尖括号不去内容的话，它们会大量污染验证码提取。
 * 实测的 ChatGPT 与 SpaceXAI 邮件都带几 KB 内联 CSS。
 */

/** 需要连内容一起丢弃的元素。 */
const DROP_ELEMENTS = ['style', 'script', 'head', 'title', 'noscript', 'template'];

/** 转成文本时应产生换行的块级元素。 */
const BLOCK_ELEMENTS =
  'p|div|br|tr|li|h[1-6]|table|thead|tbody|section|article|header|footer|blockquote|pre|hr';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  larr: '←',
  rarr: '→',
  harr: '↔',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
};

/** 解码 HTML 实体：命名实体、十进制与十六进制数字实体。 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // 排除代理区与越界码点，避免产生非法字符串
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

export interface HtmlToTextOptions {
  /**
   * 是否把链接的 href 附在链接文字后面。
   * 验证码提取时必须关掉 —— URL 里的数字是主要的误报来源之一。
   */
  includeLinkHrefs?: boolean;
}

/**
 * HTML → 纯文本。块级元素转换为换行，因为「验证码独占一行」是重要的定位信号，
 * 把整篇压成一行会直接毁掉这个信号。
 */
export function htmlToText(html: string, options: HtmlToTextOptions = {}): string {
  if (!html) return '';
  let out = html;

  // 1. 整块丢弃 style/script/head 等，连同其内容
  for (const tag of DROP_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
    // 未闭合的情况：丢弃到文档末尾，宁可少文字也不要放 CSS 进来
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi'), ' ');
  }

  // 2. HTML 注释（含 Outlook 条件注释）
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  out = out.replace(/<!DOCTYPE[^>]*>/gi, ' ');

  if (options.includeLinkHrefs) {
    out = out.replace(
      /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, href: string, inner: string) => `${inner} <${href}>`,
    );
  }

  // 3. 块级元素 → 换行
  out = out.replace(new RegExp(`<\\s*(?:${BLOCK_ELEMENTS})\\b[^>]*>`, 'gi'), '\n');
  out = out.replace(new RegExp(`<\\s*/\\s*(?:${BLOCK_ELEMENTS})\\s*>`, 'gi'), '\n');
  out = out.replace(/<\s*td\b[^>]*>/gi, ' ');
  out = out.replace(/<\s*\/\s*td\s*>/gi, ' ');

  // 4. 剩余标签
  out = out.replace(/<[^>]*>/g, ' ');

  // 5. 实体
  out = decodeEntities(out);

  // 6. 空白规整：保留换行结构，压掉行内多余空白与超过两行的空行
  out = out.replace(/\r\n?/g, '\n');
  out = out.replace(/[ \t 　]+/g, ' ');
  out = out.replace(/ *\n */g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
