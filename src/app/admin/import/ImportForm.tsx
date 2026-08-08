'use client';

import { useActionState } from 'react';
import { importAction, type ImportResult } from '../actions.ts';

export function ImportForm() {
  const [result, formAction, pending] = useActionState<ImportResult | null, FormData>(
    importAction,
    null,
  );

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-3">
        <div className="rounded border border-rule bg-floor-raised p-4">
          <label htmlFor="emailsText" className="block text-sm font-medium">
            批量粘贴收件地址
          </label>
          <p className="mt-1 text-sm text-muted">每行一个邮箱地址；空行会自动忽略。</p>
          <textarea
            id="emailsText"
            name="emailsText"
            rows={10}
            placeholder={'violet-ember-7x@icloud.com\nmint.cave.4m@icloud.com'}
            className="mt-3 block w-full rounded border border-rule bg-floor px-3 py-2 font-mono text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-transit"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="rounded bg-transit px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? '导入中…' : '导入粘贴内容'}
        </button>
      </form>

      <form action={formAction} className="space-y-3">
        <label
          htmlFor="file"
          className="block cursor-pointer rounded border border-dashed border-rule bg-floor-raised px-6 py-10 text-center transition-colors hover:border-transit"
        >
          <span className="block font-medium">选择 jsonl 或 txt 文件</span>
          <span className="mt-1 block text-sm text-muted">
            支持 icloud-hme-cli 的 JSONL，或每行一个邮箱地址的纯文本文件
          </span>
          <input
            id="file"
            name="file"
            type="file"
            accept=".jsonl,.json,.txt,application/json,text/plain"
            required
            className="mt-4 block w-full text-sm file:mr-3 file:rounded file:border file:border-rule file:bg-floor file:px-3 file:py-1.5 file:text-sm file:text-ink-soft"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded bg-transit px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? '导入中…' : '上传并导入'}
        </button>
      </form>

      {result && (
        <div
          className={`rounded border px-4 py-3 ${
            result.ok ? 'border-transit/30 bg-transit-soft' : 'border-alert/30 bg-alert-soft'
          }`}
        >
          <p className={`text-sm font-medium ${result.ok ? 'text-transit' : 'text-alert'}`}>
            {result.message}
          </p>
          {result.errors && result.errors.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-ink-soft">
              {result.errors.map((e, i) => (
                <li key={i}>
                  第 {e.line} 行：{e.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
