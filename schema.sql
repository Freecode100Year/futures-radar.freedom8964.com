-- News Radar · D1 schema
-- 应用: wrangler d1 execute news-radar --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL UNIQUE,      -- RSS/Atom 地址，或 GDELT 查询 URL
  type            TEXT NOT NULL DEFAULT 'rss', -- 'rss' | 'gdelt'
  lang            TEXT DEFAULT 'en',
  category        TEXT DEFAULT 'geopolitics', -- geopolitics | finance | military | policy
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_fetched_at TEXT,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,            -- 首篇报道标题（原文）
  title_zh         TEXT,                     -- 分析后的中文事件标题
  first_seen_at    TEXT NOT NULL,
  last_updated_at  TEXT NOT NULL,
  article_count    INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'new', -- new | analyzed | irrelevant
  domains          TEXT,                     -- JSON array
  severity         REAL,                     -- 0-100，代码按分项加权计算
  level            TEXT,                     -- 低 / 关注 / 显著 / 严重 / 危急
  confidence       REAL,
  needs_analysis   INTEGER NOT NULL DEFAULT 0,
  last_analyzed_at TEXT,
  triage           TEXT,                     -- JSON：分诊结果
  triaged_count    INTEGER NOT NULL DEFAULT 0, -- 分诊时的报道数
  model_severity   REAL,                     -- 模型原始严重性（未经市场校准）
  market           TEXT,                     -- JSON：市场反应与校准结果
  market_final     INTEGER NOT NULL DEFAULT 0, -- 72 小时窗口结束后不再重算
  market_calibrated_at TEXT,
  analyzed_count   INTEGER NOT NULL DEFAULT 0, -- 上次深度分析时的报道数（重新分析门槛）
  sectors          TEXT                       -- JSON：受影响的期货品类
);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events(last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_pending ON events(needs_analysis, last_analyzed_at);

CREATE TABLE IF NOT EXISTS articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT NOT NULL UNIQUE,
  source_id    INTEGER REFERENCES sources(id),
  source_name  TEXT,
  title        TEXT NOT NULL,
  summary      TEXT,
  content      TEXT,          -- 提取的正文（仅用于分析，前端不展示）
  lang         TEXT,
  published_at TEXT,
  fetched_at   TEXT NOT NULL,
  event_id     INTEGER REFERENCES events(id),
  processed    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_articles_event ON articles(event_id, published_at);

-- 每次深度分析一行 → 严重性历史曲线
CREATE TABLE IF NOT EXISTS analyses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL,
  model      TEXT,
  severity   REAL,
  scores     TEXT,   -- JSON：分项得分
  payload    TEXT    -- JSON：完整分析结果（时间线、影响范围、传导链……）
);
CREATE INDEX IF NOT EXISTS idx_analyses_event ON analyses(event_id, created_at);

-- 行情：小时K线，按合约存储（主力换月前后的合约分开，避免换月价差被当成异动）
CREATE TABLE IF NOT EXISTS prices (
  instrument TEXT NOT NULL,
  contract   TEXT NOT NULL,      -- 例如 CLZ26；'cont' = 连续合约，'spot' = 现货备用源
  ts         INTEGER NOT NULL,   -- unix 秒（完整K线为开盘时刻；最后一根未收盘K线为实时时刻）
  close      REAL NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  PRIMARY KEY (instrument, contract, ts)
) WITHOUT ROWID;

-- 严重性变化日志：深度分析和市场校准都会写入 → 前端趋势线
CREATE TABLE IF NOT EXISTS severity_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  ts       TEXT NOT NULL,
  severity REAL NOT NULL,
  source   TEXT NOT NULL          -- 'analysis' | 'market'
);
CREATE INDEX IF NOT EXISTS idx_sevlog_event ON severity_log(event_id, ts);

-- Claude 调用记账：每天 × 模型 × 用途一行
CREATE TABLE IF NOT EXISTS api_usage (
  day                TEXT NOT NULL,
  model              TEXT NOT NULL,
  purpose            TEXT NOT NULL,   -- triage | analysis
  calls              INTEGER NOT NULL DEFAULT 0,
  failures           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, purpose)
);

-- 各模型提供商的冷却状态（限流、key 无效、服务故障时暂停一段时间）
CREATE TABLE IF NOT EXISTS provider_state (
  provider       TEXT PRIMARY KEY,
  cooldown_until TEXT,
  last_error     TEXT,
  updated_at     TEXT
);

-- OpenCode Zen 每日模型健康检查与免费模型切换状态
CREATE TABLE IF NOT EXISTS opencode_model_state (
  provider    TEXT PRIMARY KEY,
  model       TEXT NOT NULL,
  checked_day TEXT,
  status      TEXT,
  last_error  TEXT,
  updated_at  TEXT
);

-- 期货：主力合约、期限结构、品种快照、每日 AI 解读
CREATE TABLE IF NOT EXISTS instrument_state (
  instrument      TEXT PRIMARY KEY,
  active_contract TEXT,
  active_symbol   TEXT,
  rolled_at       TEXT
);
CREATE TABLE IF NOT EXISTS curves (
  instrument TEXT NOT NULL,
  day        TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (instrument, day)
);
CREATE TABLE IF NOT EXISTS instrument_snapshot (
  instrument TEXT PRIMARY KEY,
  updated_at TEXT,
  payload    TEXT
);
CREATE TABLE IF NOT EXISTS market_briefs (
  instrument TEXT NOT NULL,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model      TEXT,
  payload    TEXT NOT NULL,
  PRIMARY KEY (instrument, day)
);

-- 连续合约日线（OHLCV），用于多周期涨跌、技术指标、季节性、价差、相关性
CREATE TABLE IF NOT EXISTS daily_bars (
  instrument TEXT NOT NULL,
  day        TEXT NOT NULL,     -- 交易日 YYYY-MM-DD
  open REAL, high REAL, low REAL,
  close      REAL NOT NULL,
  volume     REAL,
  PRIMARY KEY (instrument, day)
) WITHOUT ROWID;

-- CFTC 持仓报告：商品为管理基金，金融期货为杠杆基金
CREATE TABLE IF NOT EXISTS cot (
  instrument    TEXT NOT NULL,
  report_date   TEXT NOT NULL,
  open_interest REAL,
  long          REAL NOT NULL,
  short         REAL NOT NULL,
  PRIMARY KEY (instrument, report_date)
) WITHOUT ROWID;

-- 财经日历（手动添加的一次性事件，如 FOMC、WASDE、CPI；周期性事件由代码生成）
CREATE TABLE IF NOT EXISTS calendar_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,      -- ISO 时间（UTC）
  title      TEXT NOT NULL,
  instruments TEXT,              -- JSON 数组
  importance INTEGER NOT NULL DEFAULT 2,
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_calendar_ts ON calendar_events(ts);

-- 总览页的跨品种数据（相关性矩阵、价差），每小时计算一次
CREATE TABLE IF NOT EXISTS overview_snapshot (
  id         INTEGER PRIMARY KEY,
  updated_at TEXT,
  payload    TEXT
);
CREATE TABLE IF NOT EXISTS cron_log (
  step TEXT PRIMARY KEY,
  ran_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);

-- 未来一小时风险展望：统计区间（每整点生成）+ 事后核对
CREATE TABLE IF NOT EXISTS hourly_outlook (
  instrument   TEXT NOT NULL,
  window_start INTEGER NOT NULL,  -- 展望窗口 [window_start, window_start+3600)，unix 秒
  made_at      INTEGER NOT NULL,
  contract     TEXT,
  base_price   REAL NOT NULL,
  base_ts      INTEGER NOT NULL,  -- 基准价对应的时间（数据有延迟，通常早于 made_at）
  horizon_h    INTEGER NOT NULL,
  sigma_pct    REAL NOT NULL,
  lo68 REAL, hi68 REAL, lo95 REAL, hi95 REAL,
  events       TEXT,              -- JSON：窗口内的数据发布
  regime       REAL,
  actual       REAL,
  actual_ts    INTEGER,
  hit68        INTEGER,
  hit95        INTEGER,
  evaluated_at INTEGER,
  PRIMARY KEY (instrument, window_start)
);
CREATE INDEX IF NOT EXISTS idx_outlook_pending ON hourly_outlook (evaluated_at, window_start);

-- 每小时一次的 AI 情景解读（12 个品种合并为一次请求）
CREATE TABLE IF NOT EXISTS hourly_commentary (
  window_start INTEGER PRIMARY KEY,
  payload      TEXT NOT NULL,
  model        TEXT,
  created_at   INTEGER NOT NULL
);

-- 每 5 分钟更新：5 分钟K线（保留 7 天）与各品种最新报价
CREATE TABLE IF NOT EXISTS prices_5m (
  instrument TEXT NOT NULL,
  contract   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  open REAL, high REAL, low REAL,
  close      REAL NOT NULL,
  volume     INTEGER,
  PRIMARY KEY (instrument, contract, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS quotes (
  instrument  TEXT PRIMARY KEY,
  contract    TEXT,
  price       REAL NOT NULL,
  prev_close  REAL,              -- 前一交易日结算/收盘，用于当日涨跌
  market_time INTEGER,           -- 行情时间（交易所延迟后的时间）
  updated_at  INTEGER NOT NULL   -- 本站抓取时间
);
