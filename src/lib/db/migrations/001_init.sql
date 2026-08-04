-- 初始 schema。
--
-- 时间一律存 ISO8601 UTC 字符串（YYYY-MM-DDTHH:MM:SS.sssZ）：
-- 字典序等于时间序，可以直接用 < > 比较和排序，也不受时区影响。
-- 布尔用 INTEGER 0/1，SQLite 没有布尔类型。

-- ── 导入批次 ────────────────────────────────────────────────
CREATE TABLE import_batches (
  id          INTEGER PRIMARY KEY,
  filename    TEXT    NOT NULL,
  file_sha256 TEXT    NOT NULL,
  total_lines INTEGER NOT NULL,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- file_sha256 刻意不做 UNIQUE：重传同一文件是合法的幂等操作，只在 UI 上提示
CREATE INDEX ix_import_batches_created ON import_batches(created_at DESC);

-- ── 别名 ────────────────────────────────────────────────────
CREATE TABLE aliases (
  id                INTEGER PRIMARY KEY,
  email             TEXT    NOT NULL,          -- 原样，展示用
  email_normalized  TEXT    NOT NULL,          -- 匹配键（小写）
  local_part        TEXT    NOT NULL,
  domain            TEXT    NOT NULL,
  label             TEXT    NOT NULL DEFAULT '',
  note              TEXT    NOT NULL DEFAULT '',
  batch_index       INTEGER,                   -- jsonl 的 index，非唯一且会跨文件重复
  portal            TEXT    NOT NULL DEFAULT '',
  verified          INTEGER NOT NULL DEFAULT 0,
  source_created_at TEXT,
  import_batch_id   INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  status            TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','disabled')),
  -- 取件凭证：hash 建索引供 O(1) 查找，密文供后台展示与复制
  token_hash        TEXT    NOT NULL,
  token_prefix      TEXT    NOT NULL,          -- 前 8 字符，日志与 UI 识别用
  token_ciphertext  BLOB    NOT NULL,          -- AES-256-GCM: iv(12) || tag(16) || ct
  token_version     INTEGER NOT NULL DEFAULT 1,
  token_rotated_at  TEXT,
  last_access_at    TEXT,
  access_count      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uk_aliases_normalized ON aliases(email_normalized);
CREATE UNIQUE INDEX uk_aliases_token_hash ON aliases(token_hash);
CREATE INDEX        ix_aliases_status     ON aliases(status);
CREATE INDEX        ix_aliases_batch      ON aliases(import_batch_id);

-- ── IMAP 账号 ───────────────────────────────────────────────
-- 单个 Apple ID。密码只从环境变量读，绝不入库。
CREATE TABLE imap_accounts (
  id         INTEGER PRIMARY KEY,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL,
  username   TEXT NOT NULL,
  sync_since TEXT NOT NULL,                    -- 只收此时间点之后的信
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uk_imap_accounts ON imap_accounts(username);

-- ── 每邮箱的同步状态 ────────────────────────────────────────
-- 验证码邮件常被判为垃圾，所以要同时盯 INBOX 与 Junk；
-- imapflow 一个连接只能锁一个邮箱，故每个邮箱一行、一条连接。
CREATE TABLE mailbox_sync (
  account_id           INTEGER NOT NULL REFERENCES imap_accounts(id) ON DELETE CASCADE,
  mailbox              TEXT    NOT NULL,
  uidvalidity          INTEGER,
  last_seen_uid        INTEGER NOT NULL DEFAULT 0,
  connection_state     TEXT    NOT NULL DEFAULT 'disconnected'
                         CHECK (connection_state IN
                           ('disconnected','connecting','authenticated','idling','syncing','error')),
  idle_since           TEXT,
  last_event_at        TEXT,
  last_poll_at         TEXT,
  last_success_at      TEXT,
  last_error           TEXT,
  last_error_at        TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  reconnect_count      INTEGER NOT NULL DEFAULT 0,
  messages_ingested    INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (account_id, mailbox)
);

-- ── worker 单实例互斥 ───────────────────────────────────────
-- 单行表。心跳超时后其他 worker 才能抢占，防 `--scale worker=2` 开出双 IDLE。
CREATE TABLE worker_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  worker_pid   INTEGER,
  hostname     TEXT,
  heartbeat_at TEXT,
  command      TEXT,                           -- 'reconnect' | NULL，后台下发
  started_at   TEXT
);
INSERT INTO worker_lock (id) VALUES (1);

-- ── 邮件 ────────────────────────────────────────────────────
CREATE TABLE messages (
  id                   INTEGER PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES imap_accounts(id) ON DELETE CASCADE,
  mailbox              TEXT    NOT NULL,
  uidvalidity          INTEGER NOT NULL,
  uid                  INTEGER NOT NULL,
  content_hash         TEXT    NOT NULL,       -- sha256(原始 MIME)，绝对幂等
  message_id_header    TEXT,
  in_reply_to          TEXT,
  from_address         TEXT,
  from_name            TEXT,
  to_raw               TEXT,                   -- 原始 To 头，排查用
  subject              TEXT,
  date_sent            TEXT,                   -- Date 头，可伪造，仅展示
  date_received        TEXT    NOT NULL,       -- INTERNALDATE，排序与保留期基准
  ingested_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  text_body            TEXT,
  html_body            TEXT,
  snippet              TEXT,
  verification_code    TEXT,
  code_confidence      REAL,
  code_source          TEXT,
  code_candidates_json TEXT,
  has_attachments      INTEGER NOT NULL DEFAULT 0,
  size_bytes           INTEGER NOT NULL DEFAULT 0,
  truncated            INTEGER NOT NULL DEFAULT 0,
  raw_mime             BLOB,
  raw_headers          TEXT    NOT NULL,       -- raw_mime 被裁剪后仍可排查
  match_layer          TEXT,
  match_confidence     REAL,
  read_at              TEXT,
  expires_at           TEXT    NOT NULL
);
-- 双唯一约束：UID 挡同批重复拉取，content_hash 挡 UIDVALIDITY 重置后的全量重拉，
-- 也挡住同一封信同时出现在 INBOX 与 Junk 的情况。
CREATE UNIQUE INDEX uk_messages_uid   ON messages(account_id, mailbox, uidvalidity, uid);
CREATE UNIQUE INDEX uk_messages_hash  ON messages(account_id, content_hash);
CREATE INDEX        ix_messages_recv  ON messages(date_received DESC);
CREATE INDEX        ix_messages_exp   ON messages(expires_at);
CREATE INDEX        ix_messages_msgid ON messages(message_id_header);

-- ── 邮件↔别名（多对多）─────────────────────────────────────
-- 一封信可能同时发给多个别名，不强行归一。
CREATE TABLE message_recipients (
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  alias_id      INTEGER NOT NULL REFERENCES aliases(id)  ON DELETE CASCADE,
  match_layer   TEXT    NOT NULL,
  confidence    REAL    NOT NULL,
  matched_via   TEXT,                          -- 'X-ICLOUD-HME[p]' / 'To' 等
  is_primary    INTEGER NOT NULL DEFAULT 0,
  -- 冗余列：取件热查询是「某别名最新 n 封」，有它可纯索引扫描定位后再回表，
  -- 否则要 join messages 全表排序。写入后永不更新，无一致性风险。
  date_received TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (message_id, alias_id)
) WITHOUT ROWID;
CREATE INDEX ix_recipients_alias_time ON message_recipients(alias_id, date_received DESC);

-- ── 附件 ────────────────────────────────────────────────────
CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id      TEXT,
  filename     TEXT,
  content_type TEXT,
  content_id   TEXT,                           -- cid:，内联图
  disposition  TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT    NOT NULL,
  -- 三档：小的进 BLOB 随消息 CASCADE 删；中等落盘；超大只留元数据。
  -- 大 BLOB 会撑爆 page cache 拖慢所有查询。
  storage      TEXT    NOT NULL CHECK (storage IN ('inline','file','dropped')),
  content      BLOB,
  file_path    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_attachments_message ON attachments(message_id);

-- ── 未匹配邮件 ──────────────────────────────────────────────
-- 保留期比正常邮件长：「先收到信、后导入 jsonl」的时序竞争必然发生，
-- 导入后要能回填。没有这张表就会永久丢信。
CREATE TABLE unmatched_messages (
  id                  INTEGER PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES imap_accounts(id) ON DELETE CASCADE,
  mailbox             TEXT    NOT NULL,
  uidvalidity         INTEGER NOT NULL,
  uid                 INTEGER NOT NULL,
  content_hash        TEXT    NOT NULL,
  message_id_header   TEXT,
  from_address        TEXT,
  subject             TEXT,
  date_received       TEXT    NOT NULL,
  reason              TEXT    NOT NULL,
  header_names_json   TEXT    NOT NULL,        -- 该信出现的全部头名，用于发现新头
  candidates_json     TEXT    NOT NULL,        -- 头里的全部 icloud 地址，用于发现漏导入的别名
  raw_headers         TEXT    NOT NULL,
  raw_mime            BLOB,
  rematch_attempts    INTEGER NOT NULL DEFAULT 0,
  last_rematch_at     TEXT,
  resolved_at         TEXT,
  resolved_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  expires_at          TEXT    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX uk_unmatched_hash     ON unmatched_messages(account_id, content_hash);
CREATE INDEX        ix_unmatched_pending  ON unmatched_messages(resolved_at, created_at DESC);
CREATE INDEX        ix_unmatched_expires  ON unmatched_messages(expires_at);

-- ── 管理会话 ────────────────────────────────────────────────
CREATE TABLE admin_sessions (
  id           TEXT PRIMARY KEY,               -- randomBytes(32) hex
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX ix_admin_sessions_expires ON admin_sessions(expires_at);

-- ── 取件访问日志 ────────────────────────────────────────────
-- 存在的唯一理由：排查「客户说没收到」时，能立刻区分
-- 「他根本没来取」和「来取了但库里没信」。只存 token 前缀，绝不存全 token。
CREATE TABLE access_log (
  id           INTEGER PRIMARY KEY,
  alias_id     INTEGER REFERENCES aliases(id) ON DELETE SET NULL,
  token_prefix TEXT,
  email_param  TEXT,
  status_code  INTEGER NOT NULL,
  outcome      TEXT    NOT NULL,
  returned     INTEGER NOT NULL DEFAULT 0,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ix_access_log_created ON access_log(created_at DESC);
CREATE INDEX ix_access_log_alias   ON access_log(alias_id, created_at DESC);
