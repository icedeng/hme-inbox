import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match.js';
import nextConfig from '../next.config.ts';

test('内网直连兼容旧取件链接格式', async () => {
  const rewrites = await nextConfig.rewrites?.();

  assert.ok(rewrites && !Array.isArray(rewrites));
  const { afterFiles } = rewrites;
  assert.ok(afterFiles);
  const matchRewrite = (pathname: string) =>
    afterFiles.find((rewrite) => getPathMatch(rewrite.source)(pathname));

  assert.equal(
    matchRewrite('/legacy-token/alias@icloud.com')?.destination,
    '/m/:token/:email',
  );
  assert.equal(
    matchRewrite('/legacy-token/alias@icloud.com/message-1')?.destination,
    '/m/:token/:email/:messageId',
  );
  assert.equal(
    matchRewrite('/m-prefixed-token/alias@icloud.com')?.destination,
    '/m/:token/:email',
  );
});

test('兼容规则不得拦截现有应用路由', async () => {
  const rewrites = await nextConfig.rewrites?.();

  assert.ok(rewrites && !Array.isArray(rewrites));
  const { afterFiles } = rewrites;
  assert.ok(afterFiles);
  const matchesCompatibilityRewrite = (pathname: string) =>
    afterFiles.some((rewrite) => getPathMatch(rewrite.source)(pathname));

  for (const pathname of [
    '/m/token/alias@icloud.com',
    '/admin/aliases/1',
    '/api/admin/export',
    '/_next/static/file.js',
  ]) {
    assert.equal(matchesCompatibilityRewrite(pathname), false, pathname);
  }
});
