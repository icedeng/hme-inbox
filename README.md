# HME 分拣间

iCloud Hide My Email 收件系统。导入 [icloud-hme-cli](../icloud-hme-cli-v0.2.0) 生成的别名清单，
为每个别名生成一条随机取件 URL，`GET` 一下就能拿到该地址最新的邮件和验证码。

```bash
curl "https://api.example.com/{token}/test@icloud.com?n=5"

# 注册页点了「发送验证码」，直接等着拿：
CODE=$(curl -sf "https://api.example.com/{token}/test@icloud.com?format=code&wait=30") \
  || echo "30 秒内没收到"
```

## 它是怎么工作的

**iCloud 的隐藏邮件地址是转发别名，没有独立的 IMAP 邮箱。** 发给
`basil-trowel-3h@icloud.com` 的信会被苹果转发进创建它的那个 Apple ID 的主收件箱。

所以系统只连**一个** IMAP 账号，把拉下来的每封信按邮件头判断「原本是发给哪个别名的」，
再分发到对应的格口。苹果转发时会带一个专用头：

```
X-ICLOUD-HME: p=cobalt-alibi-1g@icloud.com; d=; f=owner@icloud.com; r=to; s=noreply@x.ai
                ↑ 别名                          ↑ 转发目标       ↑ 关系
```

`p=` 就是权威答案。`r=` 说明别名出现在 to / cc / bcc 哪个位置 ——
这意味着 BCC 投递时 `To` 头里没有别名，但这个头仍然有，所以它比 `To` 更可靠。

归属做了七层降级，最底下一层是拿已知别名集合去扫原始头块，
不依赖任何具体头名。苹果哪天换了实现，这层能兜住，同时「未归属」页会把
陌生头名顶到榜首，加进 `HME_MATCH_EXTRA_HEADERS` 即可恢复，不必改代码。

## 快速开始

需要 Node 22.18+（用到内置的 `node:sqlite` 与原生 TypeScript 支持）。

```bash
npm install
cp .env.example .env

# 生成密钥
openssl rand -base64 32          # → TOKEN_ENC_KEY
openssl rand -base64 32          # → SESSION_SECRET
npm run hash-password -- '你的管理员密码'   # → ADMIN_PASSWORD_HASH

# 填好 .env 里的 HME_IMAP_USER / HME_IMAP_PASS 后：
npm run migrate                  # 建库
npm run import -- ../icloud-hme-cli-v0.2.0/batch0804.jsonl
npm run worker                   # 收信进程，前台运行
npm run dev                      # 另开一个终端跑 Web
```

打开 http://localhost:3000 ，用管理员密码登录。

`HME_IMAP_PASS` 是 **App 专用密码**，在 appleid.apple.com 生成，不是 Apple ID 主密码。
注意改主密码会一次性吊销全部 App 专用密码。

## 部署

```bash
docker compose -f docker/compose.yaml up -d --build
```

三个容器共用一个镜像：`migrate` 先跑完建表，`web` 与 `worker` 才启动。
`web` 只绑 `127.0.0.1:3000`，公网入口交给你自己的反向代理 ——
`docker/nginx.conf.example` 与 `docker/Caddyfile.example` 里有现成的重写配置，
包含**屏蔽含 token 的访问日志**的写法（token 就在 URL 路径里，
默认日志格式会把它原样记下来）。

三条硬性约束，违反任一都可能静默损坏数据：

- 数据库放 **named volume**，不要放 NFS / CIFS / Docker Desktop for Mac 的 bind mount，
  那些文件系统的 fcntl 锁不可靠
- volume 挂**目录**不挂单文件（WAL 要在同目录建 `-wal` 和 `-shm`）
- 不要 `--scale worker=2`，多份 IDLE 会触发 iCloud 的并发连接限制
  （代码里有 DB 互斥锁兜底，第二个实例会自行退出）

## 取件 API

```
GET /{token}/{email}                                    列表
GET /{token}/{email}/{messageId}                        详情（HTML 正文 + 附件）
GET /{token}/{email}/{messageId}/attachments/{id}       附件下载
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `n` | 1 | 取最新 n 封，1–50 |
| `since` | — | ISO8601 时间，或 `5m` / `2h` / `1d` |
| `unread` | 0 | 只返回未读 |
| `format` | `json` | `json` / `text` / `code` |
| `mark_read` | 1 | 是否把本次返回的标记为已读 |
| `wait` | 0 | 无新信时最多等 N 秒（0–30），长轮询 |
| `images` | 0 | 详情接口是否放行 HTML 里的远程图片 |

`format=code` 返回裸验证码纯文本，专为 shell 服务；提取置信度不达标时返回 404 空体，
**不会给一个可疑的值** —— 拿着错码反复重试比拿不到码难排查得多。

错误响应：token 无效与 URL 里 email 段不匹配返回**相同的 404**（防枚举）；
别名被停用返回 403；参数非法返回 400；没有符合条件的邮件返回
**200 加空数组**而不是 404。

## 验证码提取

入库时算一次并存库，不在请求时算 —— 正则一定会迭代，存库后可以全量重跑做回归。

支持纯数字（`935298`）、分组码（`MJP-0LS`）、字母数字块，中英文标签词都覆盖。
**排除规则比匹配规则更重要**，因为误报比漏报危险得多：年份、日期、时间、电话、
金额、百分比、CSS 尺寸与十六进制颜色、URL 内数字、订单号全部屏蔽。
邮件里的 `<style>` 块整块剔除 —— 真实邮件带几 KB 内联 CSS，
里面的 `font-weight: 400`、`0pt`、`100%` 全是误报源。

## 常用命令

```bash
npm test                  # 单元与集成测试，全程不碰网络
npm run typecheck
npm run url -- croak      # 打印匹配别名的取件 URL
npm run probe             # 探测真实邮件头，产出回归固件
npm run redact            # 把探测样本脱敏成可提交的固件
```

## 项目结构

```
src/lib/           纯 Node，不 import next/*，可用 node --test 直接跑
  db/driver.ts       全项目唯一 import node:sqlite 的文件
  matching/          别名归属，matchAlias 是零 IO 的纯函数
  email/             地址规范化、头部解析、验证码提取、HTML 清洗
  ingest/            解析→归属→入库的唯一副作用汇聚点
  imap/              每个邮箱一条连接，各自 IDLE
src/worker/        独立进程，不放进 Next 的 instrumentation
src/app/           路由与管理后台
tests/fixtures/    真实转发样本（已脱敏），归属层回归的基石
```

## 安全说明

- 取件 URL 是**能力 URL**：持有即可读取该地址的邮件。一别名一 token，
  泄露一条不波及其他；后台支持单个轮换与一键全部轮换
- token 用 sha256 建索引，明文另用 AES-256-GCM 加密存储，
  密钥只在环境变量里 —— 数据库文件泄露不等于凭证泄露
- 邮件 HTML 先白名单清洗，后台再放进**不含 `allow-same-origin` 的 sandbox iframe**，
  两层缺一不可；远程图片默认阻断（追踪像素会回传服务器 IP 和查看时刻）
- 附件一律 `application/octet-stream` + `nosniff` 下载，
  否则一个 `.html` 附件就是存储型 XSS
- 详情与附件接口都带别名归属校验，否则任一 token 可遍历全库邮件
- middleware 只做 cookie 存在性粗筛（Edge runtime 读不到数据库），
  真正的会话校验在 Node runtime 的 layout 与 action 里
