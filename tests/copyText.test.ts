import { test } from 'node:test';
import assert from 'node:assert/strict';

type CopyText = (
  value: string,
  environment: { clipboard: null; document: Document },
) => Promise<void>;

test('Clipboard API 不可用时回退到浏览器原生复制命令', async () => {
  const modulePath = '../src/lib/browser/copyText.ts';
  const copyModule = (await import(modulePath).catch(() => null)) as {
    copyText: CopyText;
  } | null;
  assert.ok(copyModule, '缺少非安全上下文的复制回退实现');

  const calls: string[] = [];
  const textArea = {
    value: '',
    style: {},
    setAttribute(name: string, value: string) {
      calls.push(`attribute:${name}=${value}`);
    },
    select() {
      calls.push('select');
    },
    setSelectionRange(start: number, end: number) {
      calls.push(`selection:${start}-${end}`);
    },
    remove() {
      calls.push('remove');
    },
  } as unknown as HTMLTextAreaElement;
  const document = {
    createElement(tagName: string) {
      calls.push(`create:${tagName}`);
      return textArea;
    },
    body: {
      appendChild() {
        calls.push('append');
        return textArea;
      },
    },
    execCommand(command: string) {
      calls.push(`command:${command}`);
      return true;
    },
  } as unknown as Document;

  await copyModule.copyText('alias@icloud.com', { clipboard: null, document });

  assert.equal(textArea.value, 'alias@icloud.com');
  assert.deepEqual(calls, [
    'create:textarea',
    'attribute:readonly=',
    'append',
    'select',
    'selection:0-16',
    'command:copy',
    'remove',
  ]);
});
