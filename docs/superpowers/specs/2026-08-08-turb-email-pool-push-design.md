# HME 邮箱推送到 turb 邮箱池设计

## 目标

在 `hme-inbox` 的 `/admin/aliases` 页面增加“推送选中”和“全部推送”入口，把启用中的隐藏邮箱及其取件 URL 推送到 `turb-gpt-free-register` 的通用 API 邮箱池。

两个入口都只推送状态为 `active` 的邮箱。`turb-gpt-free-register` 已存在的邮箱保持原数据并计入跳过，不重复新增。

## 方案

复用 `turb-gpt-free-register` 现有的 `POST /api/outlook/import` 接口，不新增 turb 专用接口。`hme-inbox` 在服务端按以下格式组装批量文本：

```text
email----pickup_url
```

请求参数固定为：

```json
{
  "source": "generic_api",
  "as_registered": false,
  "text": "email----pickup_url"
}
```

鉴权使用 turb WebUI 已支持的 `Authorization: Bearer <auth-code>`。

## 配置

`hme-inbox` Web 服务新增两个环境变量：

```env
TURB_GPT_BASE_URL=http://192.168.0.250:5050
TURB_GPT_AUTH_CODE=replace-with-webui-auth-code
```

- `TURB_GPT_BASE_URL` 去除末尾斜杠后使用。
- `TURB_GPT_AUTH_CODE` 仅在服务端读取，不进入页面 HTML、客户端 JavaScript或日志。
- 任一配置缺失时推送功能视为未配置，页面按钮禁用并显示原因。

Compose 配置将这两个变量只传给 Web 容器；Worker 和 Migrate 不需要它们。

## 页面交互

`/admin/aliases` 列表每行增加复选框：

- 启用邮箱可选择。
- 停用邮箱复选框禁用。
- 选择状态只在当前页面保存，不跨搜索或刷新持久化。

工具栏增加：

- “推送选中”：无选择时禁用；提交选中的邮箱 ID。
- “全部推送”：提交前确认将推送数据库中的全部启用邮箱。

推送期间按钮禁用，避免重复提交。完成后在当前页面显示新增数、turb 已存在跳过数和停用跳过数；失败时显示可行动的错误信息，并保留当前筛选条件。

## 服务端数据流

### 推送选中

1. 服务端 Action 校验管理员会话。
2. 解析、去重并限制所提交的邮箱 ID 数量。
3. 从数据库重新查询对应记录，不信任客户端传入的邮箱地址或状态。
4. 只保留当前状态仍为 `active` 的记录，其余计入停用或无效跳过。
5. 解密每个别名现有取件 Token，并使用 `PUBLIC_BASE_URL` 生成取件 URL。
6. 批量调用 turb 导入接口。
7. 返回结构化结果供页面展示。

### 全部推送

1. 服务端 Action 校验管理员会话。
2. 直接从数据库分批读取全部 `active` 邮箱，不复用页面最多 500 条的查询结果。
3. 为每个邮箱生成取件 URL。
4. 批量调用 turb 导入接口并汇总结果。

如果启用邮箱数量超过 turb 单次导入的合理请求大小，hme-inbox 按固定批次发送并汇总新增、跳过数量；任一批次失败时返回已完成批次的统计和失败原因，不修改 hme-inbox 数据。

## 边界与幂等性

- hme-inbox 不新增“已推送”字段，避免两套系统状态耦合。
- turb 的 `import_generic_api_emails` 以邮箱地址判断是否存在；已存在记录直接跳过，不覆盖其取件 URL、状态或备注。
- 无论页面选择状态如何，服务端都会再次过滤停用邮箱。
- 没有可推送邮箱时不发起网络请求，返回明确结果。
- 推送只读取 hme-inbox 数据，不更改邮箱状态、Token 或取件 URL。

## 错误处理与安全

- 网络超时、连接失败、HTTP 非成功状态、401/403 和响应格式异常均转为管理员可读错误。
- HTTP 请求设置有限超时，避免 Server Action 长时间占用。
- 错误内容不包含鉴权码，日志也不输出请求头。
- turb 的鉴权码不返回浏览器；浏览器只向同源 hme-inbox 提交邮箱 ID 或“全部”意图。
- 单次选择数量设置上限，防止伪造表单造成超大查询或请求。

## 测试与验证

自动化测试覆盖：

- 选中推送只发送所选且启用的邮箱。
- 重复 ID、非法 ID、已删除 ID 和停用邮箱被正确去重或跳过。
- 全部推送读取全部启用邮箱，不受页面 500 条限制。
- 生成的邮箱、取件 URL、请求正文及 Bearer 鉴权头正确。
- 未配置时不发起请求。
- turb 返回新增/跳过统计、401、网络失败和异常 JSON 时结果正确。
- 配置解析兼容未配置场景，且不会暴露鉴权码。

完成后执行 hme-inbox 的完整测试、TypeScript 类型检查和生产构建，并针对 turb 现有导入接口运行相关 Python 测试，确认复用接口的兼容性。

## 修改范围

主要修改 `hme-inbox`：

- 管理页选择与按钮交互组件。
- 管理端推送 Server Action。
- turb 客户端与结果类型。
- 环境变量、Compose 和示例配置。
- 对应测试。

`turb-gpt-free-register` 原有导入接口已满足本设计，不计划修改其生产代码；仅运行现有相关测试进行兼容性验证。
