import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

type GuardFactory = (deps: {
  requireSession: () => Promise<string | null>;
  redirect: (path: string) => never;
}) => () => Promise<string>;

async function loadGuardFactory(): Promise<GuardFactory | null> {
  const modulePath = '../src/lib/auth/admin.ts';
  const module = (await import(modulePath).catch(() => null)) as {
    createAdminPageGuard?: GuardFactory;
  } | null;
  return module?.createAdminPageGuard ?? null;
}

describe('后台页面鉴权边界', () => {
  test('所有读取后台数据的 Page 都先执行独立守卫', async () => {
    const pageFiles = [
      '../src/app/admin/page.tsx',
      '../src/app/admin/aliases/page.tsx',
      '../src/app/admin/aliases/[id]/page.tsx',
      '../src/app/admin/aliases/[id]/messages/[messageId]/page.tsx',
      '../src/app/admin/import/page.tsx',
      '../src/app/admin/unmatched/page.tsx',
    ];

    for (const pageFile of pageFiles) {
      const source = await readFile(new URL(pageFile, import.meta.url), 'utf8');
      const guardCall = source.indexOf('await requireAdminPage()');
      const firstDbRead = source.indexOf('getDb(');
      assert.ok(guardCall >= 0, `${pageFile} 缺少独立后台鉴权`);
      assert.ok(firstDbRead < 0 || guardCall < firstDbRead, `${pageFile} 在鉴权前读取了数据库`);
    }
  });

  test('会话无效时页面守卫必须在读取数据前重定向登录', async () => {
    const createGuard = await loadGuardFactory();
    assert.ok(createGuard, '缺少可供每个后台页面独立调用的鉴权守卫');

    const redirectError = new Error('redirected');
    let redirectedTo: string | null = null;
    const guard = createGuard({
      requireSession: async () => null,
      redirect(path): never {
        redirectedTo = path;
        throw redirectError;
      },
    });

    await assert.rejects(guard(), (error) => error === redirectError);
    assert.equal(redirectedTo, '/login');
  });

  test('会话有效时页面守卫返回会话 ID', async () => {
    const createGuard = await loadGuardFactory();
    assert.ok(createGuard, '缺少可供每个后台页面独立调用的鉴权守卫');

    const guard = createGuard({
      requireSession: async () => 'session-123',
      redirect(): never {
        throw new Error('不应重定向');
      },
    });

    assert.equal(await guard(), 'session-123');
  });
});
