# Chrome 隐藏邮箱推送实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有入口成功预留的新 iCloud 隐藏邮箱均可靠、幂等地推送到 `hme-inbox`，临时失败进入扩展持久化队列自动重试。

**Architecture:** `hme-inbox` 提供带 Bearer Token 鉴权的批量 `POST /api/aliases`，业务处理器通过依赖注入实现可测试的事务写入。Chrome 扩展在 options 与 Service Worker 中加载同一经典脚本，包装 iCloud `/hme/reserve` 的成功响应；仅后台负责持久化队列、API 调用与 alarm 重试，options 追加配置 UI。

**Tech Stack:** TypeScript 7、Next.js 16 Route Handler、Node.js 22 `node:test`/`node:sqlite`、Chrome Extension Manifest V3、原生 JavaScript。

## Global Constraints

- 不改变 iCloud 邮箱生成和预留的现有成功语义。
- `hme-inbox` 推送失败不得让已成功创建的邮箱显示为创建失败。
- `HME_PUSH_TOKEN` 未配置时 API 返回 `503`，旧部署仍可启动。
- 已存在地址的标签、备注、状态和取件 Token 必须保持不变。
- Token 不得出现在仓库、日志、错误状态或 API 响应中。
- 扩展只申请用户配置服务 origin 的可选主机权限。
- 不新增第三方依赖，不修改无关文件。
- 保留 `hme-inbox` 当前未提交改动；特别是不覆盖 `src/lib/repositories/aliases.repo.ts`、`tests/db.test.ts` 和 `README.md` 的用户修改。

---

## 文件结构

### `hme-inbox`

- Create `src/lib/api/pushAliases.ts`：鉴权、请求校验、幂等事务写入和可注入的 HTTP 处理器。
- Create `src/app/api/aliases/route.ts`：把真实数据库和环境配置接到业务处理器。
- Create `tests/pushAliases.test.ts`：使用真实内存 SQLite 测试 API 可观察行为。
- Modify `src/lib/config/env.ts`：增加可选 `HME_PUSH_TOKEN`。
- Modify `.env.example`：说明推送 Token 的生成与用途。
- Modify `compose.yaml`：把可选 Token 传入 web 容器。

### Chrome 扩展

- Create `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/hme-inbox-sync.js`：reserve 捕获、配置、队列、推送和重试控制器。
- Create `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/hme-inbox-options.js`：在 `#forward` 区域挂载配置和状态 UI。
- Create `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/tests/hme-inbox-sync.test.js`：通过 `node:vm` 和受控 Chrome API 测试真实同步脚本。
- Modify `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/options.html`：在现有 bundle 前后加载同步脚本和 UI 脚本。
- Modify `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/background.bundle.js`：文件开头加载共享同步脚本，不改 bundle 内部生成逻辑。
- Modify `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/manifest.json`：声明 HTTP/HTTPS 可选主机权限。

---

### Task 1: `hme-inbox` 幂等推送处理器

**Files:**
- Create: `tests/pushAliases.test.ts`
- Create: `src/lib/api/pushAliases.ts`

**Interfaces:**
- Consumes: `Db`、`withWriteTx()`、`normalizeAddress()`、`createToken()`、`aliasesRepo.findByNormalized()`、`aliasesRepo.upsertAlias()`。
- Produces: `PushAliasesDeps` 和 `createPushAliasesHandler(deps): (request: Request) => Promise<Response>`。

- [ ] **Step 1: 写鉴权和幂等行为的失败测试**

在 `tests/pushAliases.test.ts` 建立真实内存数据库：

```ts
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/lib/db/driver.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { createPushAliasesHandler } from '../src/lib/api/pushAliases.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const PUSH_TOKEN = 'push-token-for-tests-32-characters';
const opened: Db[] = [];

function harness(pushToken: string | null = PUSH_TOKEN) {
  const db = openDb(':memory:');
  migrate(db);
  opened.push(db);
  return {
    db,
    post: createPushAliasesHandler({
      db,
      pushToken: pushToken ?? undefined,
      tokenEncKey: TOKEN_KEY,
    }),
  };
}

function request(emails: unknown, token = PUSH_TOKEN): Request {
  return new Request('https://inbox.example/api/aliases', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ emails }),
  });
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

describe('隐藏邮箱推送 API', () => {
  test('正确凭证新增缺失地址并对请求内重复项去重', async () => {
    const { db, post } = harness();
    const response = await post(request([
      'New.Alias@icloud.com',
      ' new.alias@icloud.com ',
    ]));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: 2, created: 1, existing: 0 });
    assert.equal(aliasesRepo.countAliases(db), 1);
    assert.equal(aliasesRepo.findByNormalized(db, 'new.alias@icloud.com')!.portal, 'chrome-extension');
  });

  test('重复推送不修改已有记录和取件 Token', async () => {
    const { db, post } = harness();
    await post(request(['stable@icloud.com']));
    const before = aliasesRepo.findByNormalized(db, 'stable@icloud.com')!;
    aliasesRepo.setStatus(db, before.id, 'disabled');

    const response = await post(request(['stable@icloud.com']));
    const after = aliasesRepo.findByNormalized(db, 'stable@icloud.com')!;

    assert.deepEqual(await response.json(), { received: 1, created: 0, existing: 1 });
    assert.equal(after.status, 'disabled');
    assert.equal(after.tokenHash, before.tokenHash);
    assert.equal(after.label, before.label);
  });
});

test('未配置服务端 Token 时接口禁用', async () => {
  const { post } = harness(null);
  const response = await post(request(['x@icloud.com']));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('缺少或错误凭证时拒绝请求', async () => {
  const { post } = harness();
  const missing = await post(new Request('https://inbox.example/api/aliases', { method: 'POST' }));
  const wrong = await post(request(['x@icloud.com'], 'wrong'));
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('cache-control'), 'no-store');
});

test('非法邮箱、空数组和超过上限的数组被拒绝', async () => {
  const { post } = harness();
  for (const emails of [[], ['not-an-email'], ['x@example.com'], Array(101).fill('x@icloud.com')]) {
    assert.equal((await post(request(emails))).status, 400);
  }
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --no-warnings --test tests/pushAliases.test.ts`

Expected: FAIL，错误指向 `src/lib/api/pushAliases.ts` 不存在。

- [ ] **Step 3: 实现最小业务处理器**

在 `src/lib/api/pushAliases.ts` 实现：

```ts
import { safeEqual, hashToken, createToken } from '../tokens/token.ts';
import { normalizeAddress, type NormalizedAddress } from '../email/address.ts';
import { withWriteTx, type Db } from '../db/driver.ts';
import * as aliasesRepo from '../repositories/aliases.repo.ts';

export interface PushAliasesDeps {
  db: Db;
  pushToken: string | undefined;
  tokenEncKey: string;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function authorized(request: Request, configured: string): boolean {
  const value = request.headers.get('authorization') ?? '';
  const provided = value.startsWith('Bearer ') ? value.slice(7) : '';
  // 两侧先固定为同长度 SHA-256，避免直接比较时泄露 Token 长度。
  return safeEqual(hashToken(provided), hashToken(configured));
}

export function createPushAliasesHandler(deps: PushAliasesDeps) {
  return async function POST(request: Request): Promise<Response> {
    if (!deps.pushToken) return json({ error: { code: 'push_disabled' } }, 503);
    if (!authorized(request, deps.pushToken)) {
      return json({ error: { code: 'unauthorized' } }, 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: { code: 'invalid_json' } }, 400);
    }
    const emails = (body as { emails?: unknown })?.emails;
    if (!Array.isArray(emails) || emails.length < 1 || emails.length > 100) {
      return json({ error: { code: 'invalid_emails' } }, 400);
    }

    const addresses: NormalizedAddress[] = [];
    const seen = new Set<string>();
    for (const value of emails) {
      if (typeof value !== 'string') return json({ error: { code: 'invalid_email' } }, 400);
      const address = normalizeAddress(value);
      if (!address || address.domain !== 'icloud.com') {
        return json({ error: { code: 'invalid_email' } }, 400);
      }
      if (!seen.has(address.normalized)) {
        seen.add(address.normalized);
        addresses.push(address);
      }
    }

    const created = withWriteTx(deps.db, (tx) => {
      let count = 0;
      for (const address of addresses) {
        if (aliasesRepo.findByNormalized(tx, address.normalized)) continue;
        const token = createToken(deps.tokenEncKey);
        aliasesRepo.upsertAlias(tx, {
          email: address.raw,
          emailNormalized: address.normalized,
          localPart: address.localPart,
          domain: address.domain,
          label: 'Chrome 扩展',
          note: '',
          batchIndex: null,
          portal: 'chrome-extension',
          verified: true,
          sourceCreatedAt: null,
          importBatchId: null,
          tokenHash: token.hash,
          tokenPrefix: token.prefix,
          tokenCiphertext: token.ciphertext,
        });
        count++;
      }
      return count;
    });

    return json({ received: emails.length, created, existing: addresses.length - created }, 200);
  };
}
```

实现时保持上面响应契约，不使用 `any`。

- [ ] **Step 4: 运行处理器测试并确认 GREEN**

Run: `node --no-warnings --test tests/pushAliases.test.ts`

Expected: PASS，且失败响应的 `Cache-Control` 断言通过。

- [ ] **Step 5: 提交 Task 1**

```bash
git add src/lib/api/pushAliases.ts tests/pushAliases.test.ts
git commit -m "feat: add idempotent alias push handler"
```

---

### Task 2: Route Handler 与部署配置

**Files:**
- Create: `src/app/api/aliases/route.ts`
- Modify: `src/lib/config/env.ts`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Test: `tests/pushAliases.test.ts`

**Interfaces:**
- Consumes: `createPushAliasesHandler()`、`getDb()`、`webEnv()`。
- Produces: `POST /api/aliases`；`WebAppEnv.HME_PUSH_TOKEN?: string`。

- [ ] **Step 1: 写环境配置兼容性的失败测试**

在 `tests/pushAliases.test.ts` 添加 `loadWebEnv` 测试，复用固定合法环境：

```ts
import { loadWebEnv } from '../src/lib/config/env.ts';
import { hashPassword } from '../src/lib/auth/password.ts';

const BASE_ENV = {
  ADMIN_PASSWORD_HASH: hashPassword('test-only'),
  SESSION_SECRET: Buffer.alloc(32, 8).toString('base64'),
  PUBLIC_BASE_URL: 'https://inbox.example',
  TOKEN_ENC_KEY: TOKEN_KEY,
};

test('推送 Token 可选且会去除首尾空白', () => {
  assert.equal(loadWebEnv(BASE_ENV).HME_PUSH_TOKEN, undefined);
  assert.equal(loadWebEnv({ ...BASE_ENV, HME_PUSH_TOKEN: '' }).HME_PUSH_TOKEN, undefined);
  assert.equal(
    loadWebEnv({ ...BASE_ENV, HME_PUSH_TOKEN: '  configured-push-token  ' }).HME_PUSH_TOKEN,
    'configured-push-token',
  );
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --no-warnings --test tests/pushAliases.test.ts`

Expected: FAIL，因为 `WebAppEnv` 尚无 `HME_PUSH_TOKEN`。

- [ ] **Step 3: 实现可选环境变量和 Route Handler**

在 `WebSchema` 中加入（Compose 会把未配置值传成空字符串，必须将空白值转换为 `undefined`）：

```ts
HME_PUSH_TOKEN: z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  z.string().trim().min(16).optional(),
),
```

创建 `src/app/api/aliases/route.ts`：

```ts
import { getDb } from '../../../lib/db/connection.ts';
import { webEnv } from '../../../lib/config/env.ts';
import { createPushAliasesHandler } from '../../../lib/api/pushAliases.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const env = webEnv();
  return createPushAliasesHandler({
    db: getDb(),
    pushToken: env.HME_PUSH_TOKEN,
    tokenEncKey: env.TOKEN_ENC_KEY,
  })(request);
}
```

在 `.env.example` 的 Web 段增加：

```dotenv
# Chrome 扩展推送新隐藏邮箱使用；留空则 /api/aliases 返回 503。
# openssl rand -hex 32
HME_PUSH_TOKEN=
```

在 `compose.yaml` 的 web environment 增加：

```yaml
HME_PUSH_TOKEN: ${HME_PUSH_TOKEN:-}
```

- [ ] **Step 4: 运行服务端局部验证**

Run: `node --no-warnings --test tests/pushAliases.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS；Route Handler、环境类型和处理器类型均无错误。

- [ ] **Step 5: 提交 Task 2**

```bash
git add src/app/api/aliases/route.ts src/lib/config/env.ts .env.example compose.yaml tests/pushAliases.test.ts
git commit -m "feat: expose authenticated alias push API"
```

---

### Task 3: 扩展同步引擎与持久化重试队列

**Files:**
- Create: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/tests/hme-inbox-sync.test.js`
- Create: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/hme-inbox-sync.js`

**Interfaces:**
- Produces global `HmeInboxSync`：`wrapFetch(fetchImpl, onReserved)`、`createController(chromeApi, fetchImpl)`、`saveConfig(chromeApi, config)`、`getSnapshot(chromeApi)`。
- Storage keys: `hmeInboxConfig`、`hmeInboxPending`、`hmeInboxSyncState`。
- Runtime messages: `hmeInboxEnqueue`、`hmeInboxFlush`、`hmeInboxConfigChanged`。
- Alarm name: `hmeInboxRetry`。

- [ ] **Step 1: 写 reserve 捕获的失败测试**

测试通过 `node:vm` 执行真实经典脚本；production change that breaks it 是“成功 reserve 不再调用 onReserved”：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(extra = {}) {
  const context = vm.createContext({
    URL,
    Request,
    Response,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    ...extra,
  });
  vm.runInContext(fs.readFileSync('hme-inbox-sync.js', 'utf8'), context, {
    filename: 'hme-inbox-sync.js',
  });
  return context.HmeInboxSync;
}

function fakeChrome(initial = {}) {
  const chrome = {
    data: structuredClone(initial),
    alarmsCreated: {},
    messages: [],
    permissionRequests: [],
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((key) => [key, chrome.data[key]]));
        },
        async set(values) {
          Object.assign(chrome.data, values);
        },
      },
    },
    alarms: {
      async create(name, info) {
        chrome.alarmsCreated[name] = info;
      },
      async clear(name) {
        delete chrome.alarmsCreated[name];
        return true;
      },
    },
    permissions: {
      async request(value) {
        chrome.permissionRequests.push(value);
        return chrome.permissionGranted !== false;
      },
    },
    runtime: {
      async sendMessage(message) {
        chrome.messages.push(message);
        return { ok: true };
      },
    },
  };
  return chrome;
}

test('只在 iCloud reserve 成功后报告新地址', async () => {
  const seen = [];
  const sync = load();
  const wrapped = sync.wrapFetch(
    async () => Response.json({ success: true, result: { hme: 'new@icloud.com' } }),
    async (email) => seen.push(email),
  );

  await wrapped('https://p123-maildomainws.icloud.com/hme/reserve', {
    method: 'POST',
    body: JSON.stringify({ data: { hme: 'New@icloud.com' } }),
  });
  await wrapped('https://p123-maildomainws.icloud.com/hme/generate', { method: 'POST' });

  assert.deepEqual(seen, ['New@icloud.com']);
});
```

再添加响应 `success:false` 和 HTTP 500 均不报告地址的用例。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test tests/hme-inbox-sync.test.js`

Working directory: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome`

Expected: FAIL，因为 `hme-inbox-sync.js` 不存在。

- [ ] **Step 3: 实现经典脚本外壳和 `wrapFetch`**

文件必须保持经典脚本格式，不能使用 `import`/`export`：

```js
(function (root) {
  'use strict';

  const CONFIG_KEY = 'hmeInboxConfig';
  const PENDING_KEY = 'hmeInboxPending';
  const STATE_KEY = 'hmeInboxSyncState';
  const RETRY_ALARM = 'hmeInboxRetry';
  const RETRY_MINUTES = 5;
  const MAX_BATCH = 100;

  function reserveEmail(input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    try {
      if (!url || new URL(url).pathname !== '/hme/reserve') return null;
      const body = JSON.parse(init && init.body);
      return typeof body?.data?.hme === 'string' ? body.data.hme : null;
    } catch {
      return null;
    }
  }

  function wrapFetch(fetchImpl, onReserved) {
    return async function wrappedFetch(input, init) {
      const candidate = reserveEmail(input, init);
      const response = await fetchImpl(input, init);
      if (candidate && response.ok) {
        try {
          const payload = await response.clone().json();
          if (payload && payload.success === true) await onReserved(candidate);
        } catch {
          // iCloud 原响应仍交还现有调用方，捕获失败不能改变创建结果。
        }
      }
      return response;
    };
  }

  root.HmeInboxSync = { wrapFetch };
})(globalThis);
```

- [ ] **Step 4: 运行捕获测试并确认 GREEN**

Run: `node --test tests/hme-inbox-sync.test.js`

Expected: PASS。

- [ ] **Step 5: 写队列成功与失败语义的失败测试**

创建完整 Chrome storage/alarms fake，fake 必须真实保存对象而不是只断言调用次数。加入行为测试：

```js
test('队列去重，推送成功后只删除已发送批次', async () => {
  const chrome = fakeChrome({
    hmeInboxConfig: { baseUrl: 'https://inbox.example', token: 'secret-token-for-tests' },
  });
  const bodies = [];
  const controller = load().createController(chrome, async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ received: 2, created: 2, existing: 0 });
  });

  await controller.enqueue('A@icloud.com');
  await controller.enqueue(' a@icloud.com ');
  await controller.enqueue('b@icloud.com');
  await controller.flush();

  assert.deepEqual(bodies, [{ emails: ['a@icloud.com', 'b@icloud.com'] }]);
  assert.deepEqual(chrome.data.hmeInboxPending, []);
  assert.equal(chrome.data.hmeInboxSyncState.pendingCount, 0);
});

test('推送失败保留队列、记录安全错误并安排五分钟重试', async () => {
  const chrome = fakeChrome({
    hmeInboxConfig: { baseUrl: 'https://inbox.example', token: 'must-not-leak-token' },
  });
  const controller = load().createController(chrome, async () => new Response('', { status: 401 }));
  await controller.enqueue('a@icloud.com');
  await controller.flush();

  assert.deepEqual(chrome.data.hmeInboxPending, ['a@icloud.com']);
  assert.equal(chrome.alarmsCreated.hmeInboxRetry.delayInMinutes, 5);
  assert.doesNotMatch(chrome.data.hmeInboxSyncState.lastError, /must-not-leak-token/);
});
```

- [ ] **Step 6: 运行队列测试并确认 RED**

Run: `node --test tests/hme-inbox-sync.test.js`

Expected: FAIL，因为 `createController` 尚未定义。

- [ ] **Step 7: 实现控制器、配置和运行时安装**

实现时遵循以下精确规则：

```js
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅支持 HTTP/HTTPS');
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('服务地址只能填写 origin，不能包含账号或路径');
  }
  return url.origin;
}

function createController(chromeApi, fetchImpl) {
  let queueWrite = Promise.resolve();
  let flushing = null;

function mutateQueue(update) {
    const operation = queueWrite.then(async () => {
      const stored = await chromeApi.storage.local.get(PENDING_KEY);
      const next = update([...(stored[PENDING_KEY] || [])]);
      await chromeApi.storage.local.set({
        [PENDING_KEY]: next,
        [STATE_KEY]: {
          ...(await chromeApi.storage.local.get(STATE_KEY))[STATE_KEY],
          pendingCount: next.length,
        },
      });
      return next;
    });
    queueWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function enqueue(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    await mutateQueue((pending) => [...new Set([...pending, normalized])]);
    await chromeApi.alarms.create(RETRY_ALARM, { delayInMinutes: 0.1 });
  }

  async function doFlush() {
    await queueWrite;
    while (true) {
      const stored = await chromeApi.storage.local.get([CONFIG_KEY, PENDING_KEY, STATE_KEY]);
      const config = stored[CONFIG_KEY];
      const pending = stored[PENDING_KEY] || [];
      if (!pending.length) {
        await chromeApi.alarms.clear(RETRY_ALARM);
        return;
      }
      if (!config?.baseUrl || !config?.token) return;
      const batch = pending.slice(0, MAX_BATCH);
      try {
        const response = await fetchImpl(`${config.baseUrl}/api/aliases`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({ emails: batch }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const sent = new Set(batch);
        const remaining = await mutateQueue((current) => current.filter((email) => !sent.has(email)));
        await chromeApi.storage.local.set({
          [STATE_KEY]: {
            pendingCount: remaining.length,
            lastSuccessAt: new Date().toISOString(),
            lastError: '',
          },
        });
      } catch (error) {
        await chromeApi.storage.local.set({
          [STATE_KEY]: {
            ...(stored[STATE_KEY] || {}),
            pendingCount: pending.length,
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
        await chromeApi.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_MINUTES });
        return;
      }
    }
  }

  function flush() {
    if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }

  return { enqueue, flush };
}
```

安装逻辑只在 `chrome` 存在时运行：后台注册 runtime message/alarm/startup/installed listener；options 中 reserve 成功后发送 `hmeInboxEnqueue`。任何捕获或入队异常只更新不含 Token 的错误，不向 iCloud 调用方抛出。

- [ ] **Step 8: 运行扩展同步测试并确认 GREEN**

Run: `node --test tests/hme-inbox-sync.test.js`

Expected: PASS。

扩展目录没有 Git 元数据，因此本 Task 不创建提交；在最终交付中单独列出文件和校验结果。

---

### Task 4: 扩展配置 UI 与加载接线

**Files:**
- Create: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/hme-inbox-options.js`
- Modify: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/options.html`
- Modify: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/background.bundle.js`
- Modify: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/manifest.json`
- Test: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome/tests/hme-inbox-sync.test.js`

**Interfaces:**
- Consumes: global `HmeInboxSync.saveConfig()`、`HmeInboxSync.getSnapshot()`、runtime message `hmeInboxFlush`。
- Produces: `#hme-inbox-settings` form under the section containing `#forward`。

- [ ] **Step 1: 写配置校验和权限请求的失败测试**

在扩展测试中增加：

```js
test('保存配置只请求当前服务 origin 权限并触发刷新', async () => {
  const chrome = fakeChrome();
  await load().saveConfig(chrome, {
    baseUrl: 'https://inbox.example/',
    token: ' configured-token ',
  });

  assert.deepEqual(chrome.permissionRequests, [{ origins: ['https://inbox.example/*'] }]);
  assert.deepEqual(chrome.data.hmeInboxConfig, {
    baseUrl: 'https://inbox.example',
    token: 'configured-token',
  });
  assert.deepEqual(chrome.messages.at(-1), { type: 'hmeInboxConfigChanged' });
});
```

另加权限拒绝时抛出“未授予服务地址访问权限”且不写配置的用例。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test tests/hme-inbox-sync.test.js`

Expected: FAIL，因为 `saveConfig` 尚未定义。

- [ ] **Step 3: 实现 `saveConfig` 与快照读取**

```js
async function saveConfig(chromeApi, input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const token = String(input.token || '').trim();
  if (token.length < 16) throw new Error('Bearer Token 至少需要 16 个字符');
  const origin = new URL(baseUrl).origin + '/*';
  const granted = await chromeApi.permissions.request({ origins: [origin] });
  if (!granted) throw new Error('未授予服务地址访问权限');
  await chromeApi.storage.local.set({ [CONFIG_KEY]: { baseUrl, token } });
  await chromeApi.runtime.sendMessage({ type: 'hmeInboxConfigChanged' });
}

async function getSnapshot(chromeApi) {
  const stored = await chromeApi.storage.local.get([CONFIG_KEY, PENDING_KEY, STATE_KEY]);
  return {
    config: stored[CONFIG_KEY] || { baseUrl: '', token: '' },
    pendingCount: (stored[PENDING_KEY] || []).length,
    state: stored[STATE_KEY] || {},
  };
}
```

- [ ] **Step 4: 运行配置测试并确认 GREEN**

Run: `node --test tests/hme-inbox-sync.test.js`

Expected: PASS。

- [ ] **Step 5: 创建无框架 options UI**

`hme-inbox-options.js` 使用 `MutationObserver` 等待 `#forward` 出现，只挂载一次。表单必须包含：

```html
<div id="hme-inbox-settings">
  <h4>同步到 hme-inbox</h4>
  <input name="baseUrl" type="url" placeholder="https://inbox.example">
  <input name="token" type="password" autocomplete="off" placeholder="Bearer Token">
  <button type="submit">保存并立即同步</button>
  <p data-role="status"></p>
</div>
```

提交处理器直接在用户点击事件中调用 `HmeInboxSync.saveConfig(chrome, values)`，保证 `chrome.permissions.request()` 有用户手势。成功后显示待推送数量和最近成功时间；失败只显示 `error.message`。不得把 Token拼入 DOM 状态、控制台或错误文本。

- [ ] **Step 6: 接入现有发布物**

将 `options.html` 改成按顺序加载：

```html
<script defer src="/hme-inbox-sync.js"></script>
<script defer src="/options.bundle.js"></script>
<script defer src="/hme-inbox-options.js"></script>
```

在 `background.bundle.js` 第一个现有语句之前只增加：

```js
importScripts('hme-inbox-sync.js');
```

在 `manifest.json` 顶层增加：

```json
"optional_host_permissions": ["http://*/*", "https://*/*"]
```

不要把 `<all_urls>` 加入 `host_permissions`，不要重新格式化整个 Manifest 或 bundle。

- [ ] **Step 7: 执行扩展静态与行为验证**

Run: `node --check hme-inbox-sync.js`

Run: `node --check hme-inbox-options.js`

Run: `node --check background.bundle.js`

Run: `node -e "JSON.parse(require('node:fs').readFileSync('manifest.json', 'utf8'))"`

Run: `node --test tests/hme-inbox-sync.test.js`

Working directory: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome`

Expected: 全部退出码为 0；行为测试 PASS。

扩展目录没有 Git 元数据，因此本 Task 不创建提交。

---

### Task 5: 全量回归与交付核对

**Files:**
- None（本 Task 只执行验证；发现失败则回到对应 Task 的 RED/GREEN 循环）。

**Interfaces:**
- Consumes: completed server API and extension integration.
- Produces: evidence-backed verification report.

- [ ] **Step 1: 运行 `hme-inbox` 全量测试**

Run: `npm test`

Expected: 全部 PASS；若现有用户改动导致失败，记录具体失败并区分是否与本功能相关，不修改无关代码。

- [ ] **Step 2: 运行类型检查和生产构建**

Run: `npm run typecheck`

Run: `npm run build`

Expected: 两者退出码为 0。

- [ ] **Step 3: 重跑扩展完整验证**

Run: `node --check hme-inbox-sync.js && node --check hme-inbox-options.js && node --check background.bundle.js && node --test tests/hme-inbox-sync.test.js`

Working directory: `/Users/dengbing/work/icloud-hide-my-email-cn-helper-v1.2.12-chrome`

Expected: 全部退出码为 0。

- [ ] **Step 4: 检查变更范围和敏感信息**

在 `hme-inbox`：

```bash
git status --short
git diff --check
git diff --name-only HEAD~2..HEAD
```

在扩展目录：

```bash
rg -n "must-not-leak-token|push-token-for-tests|configured-token" . -g '!tests/**'
```

Expected: 生产文件不含测试 Token；`hme-inbox` 用户原有未提交文件仍存在且未被功能提交夹带。

- [ ] **Step 5: 按 verification-before-completion 技能复核并交付**

最终报告分为假设、修改、验证和风险；明确扩展目录不是 Git 仓库，无法提供扩展侧提交记录。不得声称未执行的浏览器真人交互已验证。
