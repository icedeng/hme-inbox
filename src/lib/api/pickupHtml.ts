/**
 * 公开取件页的 HTML 渲染。
 *
 * 这是能力 URL 对外提供的轻量 UI，不依赖管理后台 Layout，也不读取会话状态。
 * 所有来自邮件或数据库的文本都必须先转义；邮件 HTML 还要经过白名单清洗并放入
 * 不带 allow-same-origin 的 sandbox iframe。
 */
import { sanitizeEmailHtml, EMAIL_IFRAME_SANDBOX } from '../email/sanitizeHtml.ts';
import type { Alias } from '../repositories/aliases.repo.ts';
import type { MessageSummary } from '../repositories/messages.repo.ts';

const PICKUP_RESIZE_MESSAGE = 'hme-pickup-email-height';
/** 只允许执行页面自己注入的高度上报脚本，仍然不授予同源权限。 */
const PICKUP_IFRAME_SANDBOX = `${EMAIL_IFRAME_SANDBOX} allow-scripts`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

function formatTime(iso: string | null): string {
  if (!iso) return '时间未知';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function sender(message: MessageSummary): string {
  if (message.fromName && message.fromAddress) return `${message.fromName} <${message.fromAddress}>`;
  return message.fromName ?? message.fromAddress ?? '未知发件人';
}

function renderIframeDocument(htmlBody: string): string {
  const sanitized = sanitizeEmailHtml(htmlBody);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;overflow:hidden}body{min-width:0}</style></head><body>${sanitized}<script>(()=>{const send=()=>{const root=document.documentElement;const body=document.body;parent.postMessage({type:'${PICKUP_RESIZE_MESSAGE}',height:Math.max(root.scrollHeight,root.offsetHeight,body?.scrollHeight??0,body?.offsetHeight??0)},'*')};addEventListener('load',send);new ResizeObserver(send).observe(document.documentElement);requestAnimationFrame(send)})()</script></body></html>`;
}

function renderMessage(message: MessageSummary, htmlBody: string | null): string {
  const subject = escapeHtml(message.subject || '（无主题）');
  const body = htmlBody
    ? `<iframe class="mail-body" sandbox="${PICKUP_IFRAME_SANDBOX}" srcdoc="${escapeHtml(
        renderIframeDocument(htmlBody),
      )}" title="邮件正文" loading="lazy" scrolling="no"></iframe>`
    : `<pre class="mail-text">${escapeHtml(message.textBody ?? message.snippet ?? '（无正文）')}</pre>`;
  const code = message.verificationCode
    ? `<span class="code">${escapeHtml(message.verificationCode)}</span>`
    : '';

  return `<article class="card">
    <div class="message-head">
      <h2>${subject}</h2>
      <time>${escapeHtml(formatTime(message.dateReceived))}</time>
    </div>
    <div class="meta">
      <span>${escapeHtml(sender(message))}</span>
      <span>${escapeHtml(message.mailbox)}</span>
      ${code}
      ${message.hasAttachments ? '<span>有附件</span>' : ''}
      ${message.truncated ? '<span class="warning">仅头部</span>' : ''}
    </div>
    ${body}
  </article>`;
}

export function renderPickupHtml(
  alias: Alias,
  messages: Array<{ summary: MessageSummary; htmlBody: string | null }>,
): string {
  const label = alias.label || '（无标签）';
  const messageMarkup = messages.length
    ? messages.map(({ summary, htmlBody }) => renderMessage(summary, htmlBody)).join('\n')
    : '<div class="empty">还没收到邮件</div>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(alias.email)} · 收件箱</title>
  <style>
    :root { color-scheme: light; --floor:#eeeff1; --raised:#f7f8f9; --ink:#17212b; --soft:#3d4a57; --muted:#6b7885; --rule:#cbd2d8; --rule-soft:#dfe4e8; --transit:#1f4fd8; --transit-soft:#e8edfc; --live:#d98a0b; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--floor); color:var(--ink); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(920px, calc(100% - 32px)); margin:0 auto; padding:40px 0 64px; }
    .intro { margin-bottom:24px; }
    .address { margin:0; font:600 clamp(20px, 4vw, 30px)/1.25 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    .sub { display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:10px; color:var(--muted); font-size:13px; }
    .label { color:var(--soft); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .card { overflow:hidden; margin-top:14px; border:1px solid var(--rule); border-radius:6px; background:var(--raised); }
    .message-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; padding:16px 18px 4px; }
    h2 { margin:0; min-width:0; font-size:17px; overflow-wrap:anywhere; }
    time { flex:none; color:var(--muted); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .meta { display:flex; flex-wrap:wrap; align-items:center; gap:5px 12px; padding:0 18px 14px; color:var(--muted); font-size:12px; }
    .code { padding:1px 6px; border-radius:3px; background:var(--transit-soft); color:var(--transit); font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace; }
    .warning { color:var(--live); }
    .mail-body { display:block; width:100%; min-height:220px; border:0; border-top:1px solid var(--rule-soft); background:#fff; }
    .mail-text { margin:0; padding:18px; border-top:1px solid var(--rule-soft); white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--soft); }
    .empty { padding:48px 20px; border:1px dashed var(--rule); border-radius:6px; color:var(--muted); text-align:center; background:var(--raised); }
    @media (max-width:600px) { main { width:min(100% - 20px, 920px); padding-top:24px; } .message-head { display:block; } time { display:block; margin-top:5px; } }
  </style>
</head>
<body>
  <main>
    <header class="intro">
      <h1 class="address">${escapeHtml(alias.email)}</h1>
      <div class="sub"><span class="label">${escapeHtml(label)}</span><span>${messages.length} 封邮件</span></div>
      ${alias.note ? `<p class="sub">${escapeHtml(alias.note)}</p>` : ''}
    </header>
    ${messageMarkup}
  </main>
  <script>
    addEventListener('message', (event) => {
      if (event.data?.type !== '${PICKUP_RESIZE_MESSAGE}') return;
      const frame = Array.from(document.querySelectorAll('iframe.mail-body'))
        .find((candidate) => candidate.contentWindow === event.source);
      const height = Number(event.data.height);
      if (!frame || !Number.isFinite(height) || height <= 0) return;
      frame.style.height = Math.min(Math.ceil(height), 30000) + 'px';
    });
  </script>
</body>
</html>`;
}
