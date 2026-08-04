'use client';

import { useState } from 'react';

/**
 * 一键复制。
 *
 * 按钮文案在整个流程里保持同一个词：点「复制」得到「已复制」，
 * 不换说法。失败时说清楚发生了什么和怎么办，而不是道歉。
 */
export function CopyButton({
  value,
  label = '复制',
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
      setTimeout(() => setState('idle'), 1600);
    } catch {
      // 非 HTTPS 或未授权时 clipboard API 不可用，提示用户手动选中
      setState('failed');
      setTimeout(() => setState('idle'), 3000);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`inline-flex items-center gap-1.5 rounded border border-rule bg-floor-raised px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-transit hover:text-transit ${className}`}
      aria-live="polite"
    >
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败，请手动选中' : label}
    </button>
  );
}
