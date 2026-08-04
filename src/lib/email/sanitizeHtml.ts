/**
 * 邮件 HTML 清洗。
 *
 * 邮件正文是**攻击者完全可控的输入**，而管理后台的会话 cookie 就在同源下。
 * 所以这里是白名单制，且默认阻断远程图片 —— 追踪像素会把服务器 IP
 * 和「取件的确切时刻」回传给发件人。
 *
 * 光靠这一层还不够：后台渲染必须放进 **不带 allow-same-origin 的
 * sandbox iframe**，两层叠加才安全。
 */
import sanitize from 'sanitize-html';

/** 1x1 透明 PNG，用于替换被阻断的远程图片，保持排版不塌。 */
const BLOCKED_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export interface SanitizeOptions {
  /** 放行远程图片。默认 false —— 见上文追踪像素。 */
  allowRemoteImages?: boolean;
}

export function sanitizeEmailHtml(html: string | null, options: SanitizeOptions = {}): string {
  if (!html) return '';

  return sanitize(html, {
    allowedTags: [
      'p', 'div', 'span', 'br', 'hr',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
      'a', 'img', 'figure', 'figcaption', 'center', 'font',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      td: ['colspan', 'rowspan', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'align', 'valign'],
      table: ['width', 'align', 'cellpadding', 'cellspacing', 'border'],
      font: ['color', 'size', 'face'],
      '*': ['style'],
    },
    // 只允许这几种协议。data: 与 javascript: 都被排除在外 ——
    // data:text/html 是一条完整的 XSS 通路。
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      img: options.allowRemoteImages ? ['http', 'https', 'cid'] : ['cid'],
    },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    // style 属性只放行纯排版属性，挡住 position/behavior/expression 之类
    allowedStyles: {
      '*': {
        color: [/^.*$/],
        'background-color': [/^.*$/],
        'text-align': [/^(left|right|center|justify)$/],
        'font-size': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
        'font-weight': [/^(normal|bold|lighter|bolder|[1-9]00)$/],
        'font-family': [/^.*$/],
        'font-style': [/^(normal|italic|oblique)$/],
        'text-decoration': [/^(none|underline|line-through|overline)$/],
        padding: [/^[\d\s.a-z%]+$/],
        margin: [/^[\d\s.a-z%]+$/],
        border: [/^[\d\s.a-z%#()]+$/],
        width: [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
        'max-width': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
        'line-height': [/^[\d.]+(px|pt|em|rem|%)?$/],
      },
    },
    transformTags: {
      // 外链一律新窗口打开且切断 opener，防反向操纵后台页面
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      img: (tagName, attribs) => {
        if (options.allowRemoteImages) return { tagName, attribs };
        const src = attribs.src ?? '';
        if (/^cid:/i.test(src)) return { tagName, attribs };
        return {
          tagName,
          attribs: { ...attribs, src: BLOCKED_IMAGE, 'data-blocked-src': src, alt: attribs.alt ?? '（远程图片已阻断）' },
        };
      },
    },
    // 这几个标签连内容一起丢弃
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
    disallowedTagsMode: 'discard',
  });
}

/**
 * 后台渲染邮件正文用的 iframe sandbox 属性。
 *
 * **绝不能含 allow-same-origin** —— 加上它等于把邮件 HTML 放进同源，
 * 后台的会话 cookie 立刻暴露。allow-popups 也不给，避免弹窗骚扰。
 */
export const EMAIL_IFRAME_SANDBOX = 'allow-popups-to-escape-sandbox';
