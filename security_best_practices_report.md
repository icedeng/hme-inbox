# hme-inbox 安全与优化审查报告

审查日期：2026-08-08
审查范围：Next.js/React 应用、Route Handlers、Server Actions、SQLite 数据层、IMAP Worker、Docker Compose 与当前内网部署响应头。

## 执行摘要

未发现可直接导致远程代码执行、SQL 注入或已确认存储型 XSS 的严重漏洞，也没有发现硬编码密钥；生产依赖 `npm audit` 当前报告 0 个已知漏洞。项目已有多项扎实的安全设计：SQL 参数化、192 位取件 Token、Token 哈希索引与 AES-256-GCM 加密、邮件 HTML 白名单清洗与无同源权限的 sandbox iframe、Server Action 二次鉴权、敏感响应 `no-store`、非 root 应用容器。

本次审查共发现 2 个高风险、3 个中风险、4 个低风险问题。其中 SEC-001、SEC-002 已完成代码修复，尚需随本版本部署后做线上验证；其余问题仍待处理。当前优先级建议为：

1. 每个后台页面/DAL 自己校验会话，不能只依赖 Layout。
2. 重做登录限速：不要信任任意 `X-Forwarded-For`，并限制限速表大小。
3. 给公开取件入口增加代理层限流，避免随机路径持续写 SQLite。
4. 数据库只保存会话 ID 哈希，并为内网入口提供 HTTPS 或可信网络隔离。

## 高风险

### SEC-001：后台读权限只在 Layout 校验，存在 RSC/缓存 Layout 的鉴权覆盖缺口（已修复，待部署验证）

- 规则：NEXT-AUTH-001 / NEXT-AUTH-002
- 位置：
  - `src/app/admin/layout.tsx:15-18`
  - `src/app/admin/page.tsx:30-41`
  - `src/app/admin/aliases/[id]/messages/[messageId]/page.tsx:24-55`
- 证据：Layout 调用 `requireSession()`，但各后台 Page 直接查询数据库；Middleware 只检查 Cookie 是否存在（`src/middleware.ts:13-22`）。
- 影响：Next.js Layout 在客户端导航时可被缓存，不保证每次 RSC 请求都重新执行。会话过期、后台撤销或伪造任意 `hme_session` Cookie 时，构造/复用 RSC 导航有机会让未重新执行 Layout 的子页面返回敏感邮件、Token 或统计信息。邮件详情页还会在渲染时标记已读。
- 修复：已新增 `src/lib/auth/admin.ts` 与 `src/lib/auth/adminPage.ts`，并在 6 个后台 Page 读取数据库前调用 `await requireAdminPage()`；原有 Layout 鉴权保留作为纵深防御。后续仍建议补充真实 HTTP/RSC 集成测试。
- 验证：`tests/adminAuth.test.ts` 已覆盖无效会话重定向和有效会话放行；部署后需再验证真实 RSC 请求路径。
- 误报说明：具体 RSC 绕过路径依赖 Next.js 16.3 的路由行为，但“Layout 不是可靠鉴权边界”本身是明确的框架安全约束，应按高风险修正。

### SEC-002：登录限速可通过伪造 X-Forwarded-For 绕过，并可造成无界内存增长（已修复，待部署验证）

- 规则：认证端点抗暴力破解与资源上限
- 位置：
  - `src/app/login/page.tsx:14-23`
  - `src/lib/auth/password.ts:70-91`
  - `compose.lan.yaml:1-5`
- 证据：登录以请求头首个 `X-Forwarded-For` 作为限速键；当前内网 Compose 将 Next.js 直接绑定到 `0.0.0.0:3180`，客户端可以自行构造该头。失败记录保存在无大小上限的全局 `Map`，过期项只会在同一个键再次访问时删除。
- 影响：攻击者每次更换伪造 IP 即可绕过 5 次限制，持续触发高成本 scrypt 校验；同时用不同键永久扩大 `Map`，最终可能导致 Web 进程 CPU/内存拒绝服务，并提高管理员密码被爆破的概率。
- 修复：已新增 `src/lib/auth/loginRateLimit.ts`，默认不信任转发头，增加账户级与客户端级双层限速，并对客户端失败记录设置 TTL、容量上限和最旧项淘汰；新增 `TRUST_PROXY_HEADERS=false` 安全默认配置并接入 Compose。入口层限流和密码长度上限仍建议后续补充。
- 验证：`tests/loginRateLimit.test.ts` 已覆盖伪造 IP 不可绕过账户级限制及失败记录有界清理；部署后需确认反向代理拓扑与 `TRUST_PROXY_HEADERS` 配置一致。

## 中风险

### SEC-003：任意无效取件请求都会写 SQLite，公开入口缺少限流

- 规则：公开端点资源滥用防护
- 位置：
  - `src/app/m/[token]/[email]/route.ts:72-88`
  - `src/lib/api/pickup.ts:247-253`
  - `src/lib/repositories/misc.repo.ts:161-174`
  - `docker/nginx.deploy.conf:56-59`
- 证据：Token 不存在时仍同步写入 `access_log`；公网 Nginx 将除应用固定路径外的所有随机路径重写为取件路径，且没有 `limit_req`/应用层限流。
- 影响：扫描器或攻击者不需要有效 Token，即可制造持续 SQLite 写锁、WAL 增长和日志表膨胀，干扰邮件入库与后台读取。
- 修复：入口层按 IP/路径限流；无效 Token 日志做采样或内存聚合；限制访问日志增长；对长轮询设置每 Token/IP 并发上限。

### SEC-004：数据库明文保存管理员会话 ID

- 规则：NEXT-SESS-002
- 位置：
  - `src/lib/auth/session.ts:25-31`
  - `src/lib/repositories/misc.repo.ts:95-120`
- 证据：随机会话 ID 原样写入 `admin_sessions.id`，浏览器 Cookie 也使用相同值。
- 影响：数据库文件、卷快照或备份泄露时，攻击者可在会话过期前直接重放 Cookie 获取管理员权限。项目已把取件 Token 做哈希索引，管理员会话应采用同样思路。
- 修复：Cookie 保存原始随机值，数据库只保存 SHA-256/HMAC 哈希；查询、触碰和注销均使用哈希值。发布时使现有会话失效。

### SEC-005：当前内网入口使用明文 HTTP 并监听所有网卡

- 规则：传输安全 / 会话 Cookie 安全
- 位置：
  - `compose.lan.yaml:1-5`
  - `src/lib/auth/session.ts:68-83`
- 运行证据：`http://192.168.0.250:3180/login` 可访问；响应没有 TLS，基于 `PUBLIC_BASE_URL` 的 Cookie 在 HTTP 模式下不带 `Secure`。
- 影响：同一无线网络、被攻陷的网关/交换设备或本机恶意软件可窃听管理员密码、会话 Cookie 和能力 URL。若该 LAN 完全可信，风险下降；一旦端口被路由到更大网络，风险显著上升。
- 修复：优先在 3180 前增加 TLS 终止；或仅绑定 `127.0.0.1` 并通过受控反向代理/VPN 访问；至少用防火墙限定可信网段。

## 低风险

### SEC-006：详细健康状态公开暴露

- 规则：最小信息披露
- 位置：`src/app/api/health/route.ts:15-54`
- 证据：未鉴权接口返回数据库、Worker、邮箱名称、连接状态和最后错误详情。
- 影响：帮助攻击者识别内部组件、故障窗口和邮箱布局；错误文本未来也可能包含更多内部信息。
- 修复：公开 `/api/health` 只返回 `{ok}`；详细诊断放到管理员页面或仅允许容器网络访问的端点。

### SEC-007：安全响应头覆盖不完整，且泄露框架指纹

- 规则：NEXT-HEADERS-001 / NEXT-CSP-001
- 位置：
  - `next.config.ts:31-52`
  - `src/app/layout.tsx:25-29`
- 运行证据：`/login` 响应带 `X-Powered-By: Next.js`，但没有 CSP、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy` 或 `Permissions-Policy`；这些头目前只覆盖 `/m/*` 和 `/admin/*`。
- 影响：降低针对点击劫持、DOM XSS 和第三方资源被滥用的纵深防御；Google Fonts 也扩大了外部请求与隐私面。
- 修复：全局设置基线头，关闭 `poweredByHeader`；制定兼容 Next.js 的 nonce/hash CSP；可自托管字体以收紧 `font-src`。

### SEC-008：CSV 导出存在公式注入风险

- 规则：不可信数据导出安全
- 位置：`src/app/api/admin/export/route.ts:58-64`
- 证据：CSV 仅做双引号转义；标签若以 `=`, `+`, `-`, `@` 开头，Excel/表格软件仍可能按公式执行。
- 影响：管理员打开恶意标签产生的 CSV 时，可能触发公式、外链请求或数据外带。当前标签主要来自管理员导入，实际风险较低。
- 修复：对公式触发字符开头的单元格加前导单引号，或提供不含自由文本字段的安全 CSV 模式。

### SEC-009：畸形 since 相对时间可触发未捕获 RangeError

- 规则：NEXT-INPUT-001
- 位置：`src/lib/api/pickup.ts:38-48`
- 证据：极长数字加单位（例如数百位数字后接 `d`）会变成 `Infinity`，随后 `toISOString()` 抛出 `RangeError: Invalid time value`。已通过本地命令复现。
- 影响：未授权请求可稳定制造 500 响应和错误日志；单次成本低，但可与请求洪泛组合造成噪音/可用性问题。
- 修复：在日期计算前校验 `Number.isSafeInteger(value)` 和最大时间范围，并捕获日期格式化异常。

## 非安全优化建议

### OPT-001：使用不可变发布物，避免服务器再次出现“部分新、部分旧”

本次服务器曾是混合代码快照：部分文件已更新，导入表单及后端仍旧。建议 CI 构建带提交 SHA 标签的镜像（例如 `hme-inbox:f4d4f72`），服务器只拉取并切换完整镜像；同时暴露 `/api/version` 或镜像 Label，便于确认当前提交。不要再按文件手工覆盖。

### OPT-002：减少高频 SQLite 写锁与自检锁

- `src/lib/auth/session.ts:42-55` 每次会话校验都写 `last_seen_at`；可按 5 分钟节流，显著减少 WAL 与锁竞争。
- `src/app/api/health/route.ts:42-45` 每次健康检查都运行文件锁自检；`checkLockingSupport` 会打开两个连接并取得 `BEGIN IMMEDIATE`。应在启动时检查一次并缓存，健康请求只读缓存结果。

### OPT-003：降低长轮询查询放大

`src/lib/api/pickup.ts:232-237` 每 200ms 查询一次 SQLite；单个 30 秒请求最多 150 次查询。可提高到 500-1000ms，或在单进程内用事件通知唤醒；同时限制每 Token/IP 的长轮询并发。

### OPT-004：把大导入和未匹配回填移出 Web 请求

`src/app/admin/actions.ts:56-151` 可同步解析 8MB 内容、在一个写事务内逐条 UPSERT，并立即回填未匹配邮件。数据增长后会阻塞 Node 事件循环和 SQLite 写锁。建议改成后台任务、分批事务和进度状态；Worker 已有回填逻辑，可避免 Web 端重复执行重任务。

### OPT-005：附件下载文档和返回 URL 与实际路由不一致

`README.md:101` 和 `src/app/m/[token]/[email]/[messageId]/route.ts:102-109` 都声明/返回附件下载 URL，但 `src/app/m/**/attachments/[id]/route.ts` 实际不存在。客户端拿到的链接会 404。应补齐带 Alias 归属校验的下载路由，或在实现前不返回不可用 URL。

### OPT-006：全量 Token 轮换只处理前 10,000 个地址

`src/app/admin/actions.ts:187-195` 使用固定 `limit: 10_000`，超过后界面仍表现为完成。应分页直到处理完，记录处理数量，并使用分批事务避免长时间独占写锁。

### OPT-007：工程与运维

- 为 SEC-001/002/003 增加真实 HTTP/Playwright 集成测试，而不只测试纯函数。
- CI 固定执行 `typecheck`、完整测试、`npm audit --omit=dev`、镜像构建和镜像扫描。
- 当前可升级 3 个补丁版本：`@types/node 26.2.0`、`imapflow 1.6.6`、`mailparser 3.9.15`。
- 为 SQLite 数据卷建立自动备份、异机保存与恢复演练；监控 WAL 大小、Worker 心跳、未匹配率和容器重启次数。
- 为 Web/迁移容器补充内存/CPU 限制、`no-new-privileges`、能力删除和只读根文件系统（需为必要目录保留可写挂载）。

## 已验证的安全基线

- `npm audit --omit=dev --registry=https://registry.npmjs.org`：0 个已知生产依赖漏洞。
- `npm run typecheck`：通过。
- `npm test`：156/156 通过。
- `npm run build`：本地沙箱禁止 Turbopack 创建进程/绑定端口，未能完成；不是代码或类型错误，需在允许构建进程的 CI/服务器环境重跑。
- Git 跟踪文件中未发现 `.env`、私钥或常见 Token 特征；`.env.example` 是唯一被跟踪的环境文件。
- SQL 查询对外部值普遍使用参数绑定，未发现可利用的 SQL 注入。
- 邮件 HTML 使用 `sanitize-html` 白名单，并在不含 `allow-same-origin` 的 sandbox iframe 中展示。
- 取件 Token 使用 192 位随机值、SHA-256 查询索引和 AES-256-GCM 加密存储。

## 建议实施顺序

1. 部署并线上验证 SEC-001/SEC-002 的修复。
2. SEC-003 + OPT-003：入口限流、无效访问日志采样、长轮询并发控制。
3. SEC-004：会话 ID 哈希化。
4. SEC-005：HTTPS/VPN/防火墙隔离。
5. SEC-006 至 SEC-009 与性能、发布流程优化。
