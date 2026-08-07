'use client';

import { useEffect, useState } from 'react';
import { aliasPoolPushButtonState } from '@/lib/browser/aliasPoolPushControls';

export interface AliasPoolPushControlsProps {
  formId: string;
  configured: boolean;
  activeCount: number;
}

export function AliasPoolPushControls({
  formId,
  configured,
  activeCount,
}: AliasPoolPushControlsProps) {
  const [selectedCount, setSelectedCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    const syncSelection = (): void => {
      setSelectedCount(form.querySelectorAll('input[name="aliasId"]:checked').length);
    };
    const markSubmitting = (): void => setSubmitting(true);
    syncSelection();
    form.addEventListener('change', syncSelection);
    form.addEventListener('submit', markSubmitting);
    return () => {
      form.removeEventListener('change', syncSelection);
      form.removeEventListener('submit', markSubmitting);
    };
  }, [formId]);

  const state = aliasPoolPushButtonState({
    configured,
    activeCount,
    selectedCount,
    submitting,
  });
  const unavailableTitle = configured ? undefined : '未配置 turb 邮箱池服务';

  return (
    <>
      <button
        type="submit"
        form={formId}
        name="pushMode"
        value="selected"
        disabled={state.selectedDisabled}
        title={unavailableTitle ?? '仅推送选中的启用邮箱'}
        className="rounded border border-transit/50 px-3 py-1.5 text-xs text-transit transition-colors hover:bg-transit/10 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? '推送中…' : `推送选中${selectedCount > 0 ? ` ${selectedCount}` : ''}`}
      </button>
      <button
        type="submit"
        form={formId}
        name="pushMode"
        value="all"
        disabled={state.allDisabled}
        title={unavailableTitle ?? `推送全部 ${activeCount} 个启用邮箱`}
        onClick={(event) => {
          if (!confirm(`确定推送全部 ${activeCount} 个启用邮箱到 turb 邮箱池吗？`)) {
            event.preventDefault();
          }
        }}
        className="rounded border border-transit bg-transit px-3 py-1.5 text-xs text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? '推送中…' : `全部推送 ${activeCount}`}
      </button>
    </>
  );
}
