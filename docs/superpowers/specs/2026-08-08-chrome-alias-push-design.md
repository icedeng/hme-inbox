# Chrome 隐藏邮箱推送设计

## 目标

当 `icloud-hide-my-email-cn-helper-v1.2.12-chrome` 从任一入口成功预留新的 iCloud 隐藏邮箱后，将邮箱地址可靠地推送到 `hme-inbox`。`hme-inbox` 按规范化邮箱判断是否存在：已存在时保持原记录不变，不存在时新增。

生成入口包括设置页手动批量生成、后台自动任务、右键菜单和自动填充等现有及后续复用 iCloud `/hme/reserve` 的入口。

## 约束

- 不改变 iCloud 邮箱生成和预留的现有成功语义。
- `hme-inbox` 暂时不可用时，不把已经成功创建的邮箱误报为创建失败。
- 推送凭证只保存在扩展本地存储和服务端环境变量中，不写入仓库。
- `HME_PUSH_TOKEN` 未配置时，新 API 保持禁用，旧部署可以继续启动。
- 扩展当前只有发布后的 bundle，没有源工程；修改应尽量避免复制各生成入口的业务逻辑。

## 方案选择

采用“拦截成功预留请求 + 后台持久化队列”方案。

扩展在 options 页面和后台 Service Worker 加载共享同步脚本。同步脚本包装现有 `fetch`，只识别 iCloud `/hme/reserve` 请求；当响应确认预留成功后提取请求中的 `hme` 地址。options 页面把地址交给后台，后台负责写入队列和调用 `hme-inbox`。

该方案比逐个修改生成入口更不容易漏掉右键、自动填充或未来入口，也避免让 `hme-inbox` 持有 iCloud 会话。

## 扩展设计

### 配置

在 `options.html#forward` 所在的“转发地址”区域追加 `hme-inbox` 配置表单：

- 服务地址，例如 `https://api.example.com`
- Bearer Token
- 保存并立即同步按钮
- 待推送数量、最近成功时间和最近错误

配置保存在 `chrome.storage.local`。服务地址保存前移除末尾斜杠；Token 使用密码输入框展示，不在日志中输出。

Manifest 使用 `optional_host_permissions` 声明 HTTP/HTTPS 主机范围。用户点击保存时，只请求当前服务地址对应 origin 的访问权限；权限未授予时不保存为可用配置，并显示明确错误。

### 捕获与入队

仅当以下条件全部满足时入队：

1. 请求目标是 iCloud HME 服务的 `/hme/reserve`；
2. 请求体包含字符串类型的 `data.hme`；
3. HTTP 响应成功；
4. 克隆响应解析出的 JSON 含 `success: true`。

邮箱地址按去除首尾空白并转为小写后的值去重。入队完成后立即安排一次后台刷新；options 页面不直接访问 `hme-inbox`。

### 持久化队列与重试

后台把待推送地址保存在 `chrome.storage.local`。刷新时读取一批地址，调用服务端批量 API：

- 成功：只移除本次已确认的地址，记录成功时间并继续处理剩余队列；
- 网络错误、5xx、401/403 或其他非成功响应：保留队列，记录不含 Token 的错误信息；
- 队列仍非空：创建一次 5 分钟后的专用 alarm；
- 队列为空：清除专用 alarm。

扩展后台启动、配置保存、成功入队和重试 alarm 触发时都会尝试刷新。并发刷新通过单进程 Promise 锁合并，避免同一 Service Worker 内重复发送。

## `hme-inbox` API 设计

### 配置与鉴权

新增可选环境变量 `HME_PUSH_TOKEN`。请求使用：

```http
Authorization: Bearer <token>
```

服务端使用恒定时间比较校验 Token。未配置返回 `503`；缺少或错误凭证返回 `401`。所有响应设置 `Cache-Control: no-store`，日志和错误响应不得包含 Token。

### 接口契约

```http
POST /api/aliases
Content-Type: application/json

{
  "emails": ["example@icloud.com"]
}
```

- `emails` 必须是 1 到 100 个合法邮箱组成的数组；服务端使用现有地址规范化逻辑校验并去重。
- 对每个地址先按 `email_normalized` 查询。
- 已存在地址保持邮箱、标签、备注、状态和取件 Token 不变。
- 不存在地址生成新的取件 Token，使用现有加密方式保存，并写入默认来源标签。
- 整批操作在写事务中完成。

成功响应：

```json
{
  "received": 1,
  "created": 1,
  "existing": 0
}
```

重复推送返回 `200`，因此客户端可以安全重试。非法请求返回 `400`，服务异常返回 `500`。

## 数据流

1. 现有入口调用 iCloud `/hme/generate` 和 `/hme/reserve`。
2. `/hme/reserve` 成功响应被共享同步脚本识别。
3. 地址持久化到后台待推送队列，原创建流程继续完成。
4. 后台携带 Bearer Token 调用 `POST /api/aliases`。
5. `hme-inbox` 在事务中跳过已有地址并新增缺失地址。
6. 客户端收到成功响应后从队列删除本批地址；失败则保留并重试。

## 验证

服务端测试覆盖：

- 未配置、缺少和错误 Token 被拒绝；
- 合法 Token 可以新增地址；
- 重复推送不会新增或修改原记录；
- 单次请求内重复地址被去重；
- 非法邮箱、空数组和超过上限的数组被拒绝。

扩展同步脚本测试覆盖：

- 只捕获成功的 `/hme/reserve`；
- 失败响应和无关请求不入队；
- 队列按规范化地址去重；
- 推送成功删除已确认批次；
- 推送失败保留队列并安排重试；
- Token 不进入错误状态或日志。

此外执行 `hme-inbox` 全量测试、类型检查与构建，并对扩展脚本执行语法检查、Manifest 解析和受控 fetch/storage 行为测试。

## 非目标

- 不回填扩展历史邮箱池或 iCloud 现有全部别名。
- 不让 `hme-inbox` 主动访问 iCloud。
- 不修改邮箱停用、恢复、删除时的 `hme-inbox` 状态。
- 不新增多服务端、多账号或复杂退避策略。
