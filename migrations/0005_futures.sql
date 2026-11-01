-- v0.4 → v0.5（期货版）：wrangler d1 execute news-radar --remote --file=migrations/0005_futures.sql
ALTER TABLE events ADD COLUMN sectors TEXT;   -- JSON：受影响的期货品类

-- prices 增加 contract 列（主键变化，需重建表）。旧数据记为连续合约 'cont'；已移除品种的数据删除
CREATE TABLE prices_new (
  instrument TEXT NOT NULL,
  contract   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  close      REAL NOT NULL,
  PRIMARY KEY (instrument, contract, ts)
) WITHOUT ROWID;
INSERT INTO prices_new (instrument, contract, ts, close)
  SELECT instrument, 'cont', ts, close FROM prices WHERE instrument IN ('wti', 'brent', 'natgas', 'gold', 'copper');
DROP TABLE prices;
ALTER TABLE prices_new RENAME TO prices;

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
