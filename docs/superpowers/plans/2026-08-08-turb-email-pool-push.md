# Turb Email Pool Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 hme-inbox 的 `/admin/aliases` 页面提供“推送选中”和“全部推送”，把启用邮箱及其取件 URL 幂等导入 turb-gpt-free-register 的通用 API 邮箱池。

**Architecture:** 新增一个只负责读取待推送别名的仓储、一个可注入 `fetch` 的 turb 推送服务，以及 aliases 页面专属的 Server Action。页面通过原生表单提交邮箱 ID，客户端按钮组件只管理选择计数、确认和重复提交保护；turb 鉴权码始终留在服务端。

**Tech Stack:** Next.js 16 Server Components/Server Actions、React 19、TypeScript 7、Node.js 22 test runner、SQLite、Docker Compose、Flask turb WebUI API。

## Global Constraints

- 两个推送入口都只推送 `status = 'active'` 的邮箱。
- “全部推送”读取数据库中的全部启用邮箱，不受页面筛选、分页或 500 条列表上限影响。
- turb 已存在邮箱只计入跳过，不覆盖其 URL、状态或备注。
- turb 鉴权码不得进入客户端 HTML、日志或错误响应。
- 不新增“已推送”数据库字段，不修改邮箱状态、Token 或取件 URL。
- 不修改 turb-gpt-free-register 生产代码，复用 `POST /api/outlook/import`。
- 不引入新依赖，不改动 hme-inbox 工作区现有的无关未提交修改。

---

### Task 1: Web 配置与 turb HTTP 客户端

**Files:**
- Create: `src/lib/turb/emailPoolClient.ts`
- Modify: `src/lib/config/env.ts:98-118`
- Modify: `tests/pushAliases.test.ts:170-190`
- Create: `tests/turbEmailPoolClient.test.ts`

**Interfaces:**
- Produces: `TurbEmailPoolConfig { baseUrl: string; authCode: string }`
- Produces: `TurbImportResult { parsed: number; inserted: number; skipped: number }`
- Produces: `importGenericApiEmails(config, entries, fetchImpl?): Promise<TurbImportResult>`
- Consumes later: Task 3 uses `importGenericApiEmails` to send prepared email/URL pairs.

- [ ] **Step 1: Write failing environment configuration tests**

Extend the existing `隐藏邮箱推送配置` suite:

```ts
test('turb 邮箱池配置可选，空字符串表示禁用', () => {
  const env = loadWebEnv({
    ...BASE_ENV,
    TURB_GPT_BASE_URL: '',
    TURB_GPT_AUTH_CODE: '',
  });
  assert.equal(env.TURB_GPT_BASE_URL, undefined);
  assert.equal(env.TURB_GPT_AUTH_CODE, undefined);
});

test('turb 地址去除末尾斜杠且鉴权码去除空白', () => {
  const env = loadWebEnv({
    ...BASE_ENV,
    TURB_GPT_BASE_URL: ' http://192.168.0.250:5050/// ',
    TURB_GPT_AUTH_CODE: '  test-auth-code  ',
  });
  assert.equal(env.TURB_GPT_BASE_URL, 'http://192.168.0.250:5050');
  assert.equal(env.TURB_GPT_AUTH_CODE, 'test-auth-code');
});
```

- [ ] **Step 2: Run the configuration tests and verify RED**

Run: `npm test -- tests/pushAliases.test.ts`

Expected: FAIL because `TURB_GPT_BASE_URL` and `TURB_GPT_AUTH_CODE` are not present in `WebSchema` output.

- [ ] **Step 3: Implement optional WebSchema fields**

Add a reusable empty-to-undefined preprocessor and these fields to `WebSchema`:

```ts
const OptionalNonEmpty = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.string().trim().min(1).optional(),
);

const OptionalHttpUrl = OptionalNonEmpty.refine(
  (value) => {
    if (!value) return true;
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: '必须是 http 或 https URL' },
);

TURB_GPT_BASE_URL: OptionalHttpUrl.transform((value) => value?.replace(/\/+$/, '')),
TURB_GPT_AUTH_CODE: OptionalNonEmpty,
```

Reject a URL that cannot be parsed as `http:` or `https:`. Keep both fields optional so existing deployments continue to start with the buttons disabled.

- [ ] **Step 4: Run configuration tests and verify GREEN**

Run: `npm test -- tests/pushAliases.test.ts`

Expected: all tests in `pushAliases.test.ts` PASS.

- [ ] **Step 5: Write failing turb client tests**

Create `tests/turbEmailPoolClient.test.ts` with a recording `fetch` implementation and cover:

```ts
test('批量导入使用 generic_api 正文和 Bearer 鉴权', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await importGenericApiEmails(
    { baseUrl: 'http://turb.test', authCode: 'secret-auth' },
    [
      { email: 'a@icloud.com', pickupUrl: 'https://hme.test/token-a/a@icloud.com' },
      { email: 'b@icloud.com', pickupUrl: 'https://hme.test/token-b/b@icloud.com' },
    ],
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({ ok: true, parsed: 2, inserted: 1, skipped: 1 });
    },
  );
  assert.equal(calls[0]?.url, 'http://turb.test/api/outlook/import');
  assert.equal(new Headers(calls[0]?.init.headers).get('authorization'), 'Bearer secret-auth');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    source: 'generic_api',
    as_registered: false,
    text: 'a@icloud.com----https://hme.test/token-a/a@icloud.com\nb@icloud.com----https://hme.test/token-b/b@icloud.com',
  });
  assert.deepEqual(result, { parsed: 2, inserted: 1, skipped: 1 });
});
```

Also cover an empty entry list (no fetch call), HTTP 401, non-JSON response, malformed success payload, and network failure. Assertions must confirm thrown messages do not contain `secret-auth`.

- [ ] **Step 6: Run the turb client tests and verify RED**

Run: `npm test -- tests/turbEmailPoolClient.test.ts`

Expected: FAIL with module-not-found for `src/lib/turb/emailPoolClient.ts`.

- [ ] **Step 7: Implement the minimal turb client**

Implement:

```ts
export interface TurbEmailPoolConfig {
  baseUrl: string;
  authCode: string;
}

export interface TurbEmailEntry {
  email: string;
  pickupUrl: string;
}

export interface TurbImportResult {
  parsed: number;
  inserted: number;
  skipped: number;
}

export async function importGenericApiEmails(
  config: TurbEmailPoolConfig,
  entries: TurbEmailEntry[],
  fetchImpl: typeof fetch = fetch,
): Promise<TurbImportResult>
```

Use `POST`, JSON content type, `Authorization: Bearer ...`, and `AbortSignal.timeout(15_000)`. Parse only non-negative integer `parsed`, `inserted`, and `skipped`; translate all failures into a `TurbEmailPoolError` with sanitized Chinese messages.

- [ ] **Step 8: Run Task 1 tests and verify GREEN**

Run: `npm test -- tests/pushAliases.test.ts tests/turbEmailPoolClient.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/lib/config/env.ts src/lib/turb/emailPoolClient.ts tests/pushAliases.test.ts tests/turbEmailPoolClient.test.ts
git commit -m "feat: add turb email pool client"
```

---

### Task 2: 精确选择启用别名

**Files:**
- Create: `src/lib/repositories/aliasPoolPush.repo.ts`
- Create: `tests/aliasPoolPushRepo.test.ts`

**Interfaces:**
- Produces: `AliasPoolPushRow { id: number; email: string; status: AliasStatus; tokenCiphertext: Buffer }`
- Produces: `listAliasPoolPushRowsByIds(db, ids): AliasPoolPushRow[]`
- Produces: `listAllActiveAliasPoolPushRows(db): AliasPoolPushRow[]`
- Consumes later: Task 3 uses both queries; SQL remains isolated from orchestration.

- [ ] **Step 1: Write failing repository tests**

Use an in-memory migrated DB and existing token helpers. Create active and disabled aliases, then assert:

```ts
test('按 ID 查询返回存在记录并保留状态', () => {
  const rows = listAliasPoolPushRowsByIds(db, [active.id, disabled.id, 99999]);
  assert.deepEqual(rows.map((row) => [row.id, row.status]), [
    [active.id, 'active'],
    [disabled.id, 'disabled'],
  ]);
});

test('全部查询只返回启用邮箱且不带页面上限', () => {
  // 插入 501 个 active 和 1 个 disabled。
  const rows = listAllActiveAliasPoolPushRows(db);
  assert.equal(rows.length, 501);
  assert.ok(rows.every((row) => row.status === 'active'));
});
```

- [ ] **Step 2: Run repository tests and verify RED**

Run: `npm test -- tests/aliasPoolPushRepo.test.ts`

Expected: FAIL because the repository module does not exist.

- [ ] **Step 3: Implement focused repository queries**

Select only `id`, `email`, `status`, and `token_ciphertext`. Deduplicate IDs before SQL, return an empty array for no IDs, cap selected IDs at 500, and use deterministic `ORDER BY id`. The all-active query must have no `LIMIT`.

- [ ] **Step 4: Run repository tests and verify GREEN**

Run: `npm test -- tests/aliasPoolPushRepo.test.ts`

Expected: PASS with both disabled filtering and 501-row coverage proven.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/repositories/aliasPoolPush.repo.ts tests/aliasPoolPushRepo.test.ts
git commit -m "feat: query aliases for pool push"
```

---

### Task 3: 推送编排与服务端 Action

**Files:**
- Create: `src/lib/turb/pushAliasesToPool.ts`
- Create: `src/app/admin/aliases/actions.ts`
- Create: `tests/pushAliasesToPool.test.ts`

**Interfaces:**
- Consumes: Task 1 `importGenericApiEmails` and Task 2 repository queries.
- Produces: `AliasPoolPushRequest { mode: 'selected' | 'all'; ids: number[] }`
- Produces: `AliasPoolPushResult { requested: number; pushed: number; inserted: number; existing: number; skippedInactive: number; skippedMissing: number }`
- Produces: `pushAliasesToPool(deps, request): Promise<AliasPoolPushResult>`
- Produces: Server Action `pushAliasesToPoolAction(formData): Promise<void>`.

- [ ] **Step 1: Write failing orchestration tests**

Create an in-memory DB with two active aliases and one disabled alias. Inject a recording import function. Cover:

```ts
test('选择推送去重 ID 并只发送启用邮箱', async () => {
  const result = await pushAliasesToPool(deps, {
    mode: 'selected',
    ids: [activeA.id, activeA.id, disabled.id, 99999],
  });
  assert.deepEqual(sent.map((entry) => entry.email), [activeA.email]);
  assert.equal(result.skippedInactive, 1);
  assert.equal(result.skippedMissing, 1);
});

test('全部推送忽略传入 ID 并发送数据库全部启用邮箱', async () => {
  const result = await pushAliasesToPool(deps, { mode: 'all', ids: [disabled.id] });
  assert.deepEqual(sent.map((entry) => entry.email), [activeA.email, activeB.email]);
  assert.equal(result.pushed, 2);
});
```

Also assert decrypted pickup URLs match `buildPickupUrl`, batches are at most 500 entries, empty active sets make no request, and remote inserted/skipped counts are summed across batches.

- [ ] **Step 2: Run orchestration tests and verify RED**

Run: `npm test -- tests/pushAliasesToPool.test.ts`

Expected: FAIL because `pushAliasesToPool.ts` does not exist.

- [ ] **Step 3: Implement minimal push orchestration**

Define dependencies explicitly:

```ts
export interface PushAliasesToPoolDeps {
  db: Db;
  publicBaseUrl: string;
  tokenEncKey: string;
  turb: TurbEmailPoolConfig;
  importEntries?: typeof importGenericApiEmails;
}
```

For selected mode, normalize integer IDs, enforce at most 500 unique IDs, query records, calculate missing/inactive counts, and push only active records. For all mode, use the unlimited active query. Decrypt tokens only after filtering. Split into 500-entry batches and sum results.

- [ ] **Step 4: Run orchestration tests and verify GREEN**

Run: `npm test -- tests/pushAliasesToPool.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Implement the aliases-page Server Action**

In `src/app/admin/aliases/actions.ts`:

```ts
'use server';

export async function pushAliasesToPoolAction(formData: FormData): Promise<void>
```

The action must call `requireSession()` directly and redirect to `/login` if absent. Parse `pushMode`, `aliasId`, `q`, and `status`; preserve only valid `q/status` values in the return URL. If turb config is missing, redirect with `poolPush=unconfigured`. On success, add numeric result query parameters; on failure, add `poolPush=error` plus a fixed safe error code/message. Call `redirect()` only after the `try/catch` so Next.js redirect exceptions are not swallowed.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- tests/pushAliasesToPool.test.ts && npm run typecheck`

Expected: PASS and TypeScript exit code 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/lib/turb/pushAliasesToPool.ts src/app/admin/aliases/actions.ts tests/pushAliasesToPool.test.ts
git commit -m "feat: push active aliases to turb pool"
```

---

### Task 4: 管理页选择与推送入口

**Files:**
- Create: `src/components/AliasPoolPushControls.tsx`
- Create: `src/lib/browser/aliasPoolPushControls.ts`
- Modify: `src/app/admin/aliases/page.tsx:25-193`
- Create: `tests/aliasPoolPushControls.test.ts`

**Interfaces:**
- Consumes: Task 3 form action at form id `alias-pool-push-form`.
- Produces: disabled/configured button states, confirmation, selection count, and duplicate-submit protection.

- [ ] **Step 1: Write failing control-state tests**

Create `tests/aliasPoolPushControls.test.ts` for a pure state helper:

```ts
test('未配置时两个按钮都禁用且不暴露配置值', () => {
  assert.deepEqual(
    aliasPoolPushButtonState({
      configured: false,
      activeCount: 10,
      selectedCount: 2,
      submitting: false,
    }),
    { selectedDisabled: true, allDisabled: true },
  );
});

test('已配置时选中按钮依赖选择数，全部按钮依赖启用总数', () => {
  assert.deepEqual(
    aliasPoolPushButtonState({
      configured: true,
      activeCount: 10,
      selectedCount: 0,
      submitting: false,
    }),
    { selectedDisabled: true, allDisabled: false },
  );
});
```

Also cover `submitting: true` and `activeCount: 0`.

- [ ] **Step 2: Run control-state tests and verify RED**

Run: `node --no-warnings --test tests/aliasPoolPushControls.test.ts`

Expected: FAIL because `src/lib/browser/aliasPoolPushControls.ts` does not exist.

- [ ] **Step 3: Implement the pure state helper and client controls**

Create:

```ts
export function aliasPoolPushButtonState(input: {
  configured: boolean;
  activeCount: number;
  selectedCount: number;
  submitting: boolean;
}): { selectedDisabled: boolean; allDisabled: boolean }
```

Use the helper from `AliasPoolPushControls` so the tested rules drive the rendered `disabled` attributes.

Implement `AliasPoolPushControls` with props:

```ts
interface AliasPoolPushControlsProps {
  formId: string;
  configured: boolean;
  activeCount: number;
}
```

The component listens for `change` events on the target form and counts checked `input[name="aliasId"]`. Render two submit buttons associated through the HTML `form` attribute:

- `pushMode=selected`: disabled when unconfigured, submitting, or selected count is zero; label includes selected count.
- `pushMode=all`: disabled when unconfigured, submitting, or active count is zero; asks `confirm('确定推送全部 N 个启用邮箱到 turb 邮箱池吗？')` before submit.

Both buttons set submitting state only after validation/confirmation succeeds. The component receives only `configured: boolean`, never the auth code.

- [ ] **Step 4: Run control-state tests and verify GREEN**

Run: `node --no-warnings --test tests/aliasPoolPushControls.test.ts`

Expected: PASS with all state combinations covered.

- [ ] **Step 5: Wire the controls and form into the page**

Update search params to accept only the result fields needed to render a success/error banner. Add `AliasPoolPushControls` to the existing toolbar. Compute `activeCount` with `aliasesRepo.countAliases(db, 'active')` and `configured` from the two optional env fields.

Wrap the alias `<ul>` in:

```tsx
<form id="alias-pool-push-form" action={pushAliasesToPoolAction}>
  <input type="hidden" name="q" value={params.q ?? ''} />
  <input type="hidden" name="status" value={params.status ?? ''} />
  {/* list */}
</form>
```

Add each row checkbox before the address:

```tsx
<input
  type="checkbox"
  name="aliasId"
  value={alias.id}
  disabled={alias.status !== 'active'}
  aria-label={`选择 ${alias.email}`}
/>
```

Render a green result banner for inserted/existing/skipped counts and an alert banner for unconfigured or failed pushes. Do not render remote response bodies or auth values.

- [ ] **Step 6: Run typecheck and production build**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0; no nested-form or Server/Client Component error appears.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/components/AliasPoolPushControls.tsx src/lib/browser/aliasPoolPushControls.ts src/app/admin/aliases/page.tsx tests/aliasPoolPushControls.test.ts
git commit -m "feat: add alias pool push controls"
```

---

### Task 5: Deployment configuration and complete verification

**Files:**
- Modify: `.env.example:34-49`
- Modify: `compose.yaml:41-50`
- Modify: `README.md` Web configuration section

**Interfaces:**
- Consumes: `TURB_GPT_BASE_URL` and `TURB_GPT_AUTH_CODE` from Task 1.
- Produces: deployable Web container configuration; no variables are added to Worker or Migrate.

- [ ] **Step 1: Document and wire the optional variables**

Add to `.env.example` and README:

```env
# turb-gpt-free-register 通用 API 邮箱池；任一项留空则管理页推送功能禁用。
TURB_GPT_BASE_URL=http://192.168.0.250:5050
TURB_GPT_AUTH_CODE=
```

Add only to the `web.environment` block in `compose.yaml`:

```yaml
TURB_GPT_BASE_URL: ${TURB_GPT_BASE_URL:-}
TURB_GPT_AUTH_CODE: ${TURB_GPT_AUTH_CODE:-}
```

- [ ] **Step 2: Run full local verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all Node tests pass, typecheck/build exit 0, and `git diff --check` produces no output.

- [ ] **Step 3: Verify turb endpoint compatibility without modifying turb**

From `/Users/dengbing/work/uxlabs/turb-gpt-free-register`, run the existing focused tests that cover WebUI authentication and generic API import behavior. If no existing import test covers `/api/outlook/import`, first add a focused test only when a regression gap is proven; do not alter turb production code.

Run: `python -m unittest tests.test_webui_auth -v`

Expected: PASS. Then run the repository's documented full test command if its environment dependencies are already installed.

- [ ] **Step 4: Commit configuration and documentation**

```bash
git add .env.example compose.yaml README.md
git commit -m "docs: configure turb email pool push"
```

- [ ] **Step 5: Configure and deploy hme-inbox**

On `root@192.168.0.250`, preserve the existing `/opt/hme-inbox/.env`. Set `TURB_GPT_BASE_URL=http://192.168.0.250:5050` and copy the existing turb WebUI auth code into `TURB_GPT_AUTH_CODE` without printing it. Upload the verified source while excluding `.env`, data, `.git`, `node_modules`, build output, `.DS_Store`, and `._*` AppleDouble files.

Run:

```bash
docker compose -f compose.yaml -f compose.lan.yaml config --quiet
docker compose -f compose.yaml -f compose.lan.yaml up -d --build migrate web worker
docker compose -f compose.yaml -f compose.lan.yaml ps
docker compose -f compose.yaml -f compose.lan.yaml logs --tail=100 migrate web worker
```

Expected: migrate exits 0; web and worker report healthy.

- [ ] **Step 6: Verify the live page and push behavior**

Verify `GET http://192.168.0.250:3180/api/health` returns 200. Open `/admin/aliases`, confirm disabled rows cannot be selected, select one active email, push it, then verify the response banner and turb generic API pool entry. Repeat the same selected push and confirm turb reports it as skipped. Do not run “全部推送” as a smoke test unless the user explicitly confirms the resulting bulk external write.

- [ ] **Step 7: Final handoff**

Report exact test counts, build result, deployed container health, live selected-push result, any unexecuted bulk-write verification, and the commits created. Preserve all unrelated pre-existing worktree changes.
