export interface CopyTextEnvironment {
  clipboard: Pick<Clipboard, 'writeText'> | null;
  document: Document;
}

function legacyCopyText(value: string, document: Document): void {
  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.opacity = '0';
  textArea.style.pointerEvents = 'none';
  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, value.length);

  try {
    if (!document.execCommand('copy')) {
      throw new Error('浏览器拒绝了复制命令');
    }
  } finally {
    textArea.remove();
  }
}

/**
 * 复制文本。局域网 HTTP 页面没有 Clipboard API 时，回退到同步复制命令。
 */
export async function copyText(
  value: string,
  environment?: CopyTextEnvironment,
): Promise<void> {
  const clipboard = environment ? environment.clipboard : navigator.clipboard;
  const document = environment?.document ?? window.document;

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return;
    } catch {
      // 权限拒绝时继续尝试用户点击事件内的同步复制。
    }
  }

  legacyCopyText(value, document);
}
