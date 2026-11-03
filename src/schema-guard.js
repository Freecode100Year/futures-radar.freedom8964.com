// 运行时自检数据库结构：缺表就建、缺列就加。
// 生产库漏跑迁移（例如 0010 没执行）时，新功能不会整块失效，而是第一次请求时自动补上。
// 只包含"新增表/列"类的迁移（0006 起）；改写数据的迁移（如 0005 重建 prices）仍需手动执行。
// 由 migrations/0006–0010 生成，test/schema.test.js 会检查两边是否一致。

export const CREATE_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS daily_bars (\n instrument TEXT NOT NULL,\n day TEXT NOT NULL,\n open REAL, high REAL, low REAL,\n close REAL NOT NULL,\n volume REAL,\n PRIMARY KEY (instrument, day)\n) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS cot (\n instrument TEXT NOT NULL,\n report_date TEXT NOT NULL,\n open_interest REAL,\n long REAL NOT NULL,\n short REAL NOT NULL,\n PRIMARY KEY (instrument, report_date)\n) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS calendar_events (\n id INTEGER PRIMARY KEY AUTOINCREMENT,\n ts TEXT NOT NULL,\n title TEXT NOT NULL,\n instruments TEXT,\n importance INTEGER NOT NULL DEFAULT 2,\n note TEXT\n)",
  "CREATE INDEX IF NOT EXISTS idx_calendar_ts ON calendar_events(ts)",
  "CREATE TABLE IF NOT EXISTS overview_snapshot (\n id INTEGER PRIMARY KEY,\n updated_at TEXT,\n payload TEXT\n)",
  "CREATE TABLE IF NOT EXISTS opencode_model_state (\n provider TEXT PRIMARY KEY,\n model TEXT NOT NULL,\n checked_day TEXT,\n status TEXT,\n last_error TEXT,\n updated_at TEXT\n)",
  "CREATE TABLE IF NOT EXISTS cron_log (\n step TEXT PRIMARY KEY,\n ran_at INTEGER NOT NULL,\n ok INTEGER NOT NULL,\n detail TEXT\n)",
  "CREATE TABLE IF NOT EXISTS hourly_outlook (\n instrument TEXT NOT NULL,\n window_start INTEGER NOT NULL,\n made_at INTEGER NOT NULL,\n contract TEXT,\n base_price REAL NOT NULL,\n base_ts INTEGER NOT NULL,\n horizon_h INTEGER NOT NULL,\n sigma_pct REAL NOT NULL,\n lo68 REAL, hi68 REAL, lo95 REAL, hi95 REAL,\n events TEXT,\n regime REAL,\n actual REAL,\n actual_ts INTEGER,\n hit68 INTEGER,\n hit95 INTEGER,\n evaluated_at INTEGER,\n PRIMARY KEY (instrument, window_start)\n)",
  "CREATE INDEX IF NOT EXISTS idx_outlook_pending ON hourly_outlook (evaluated_at, window_start)",
  "CREATE TABLE IF NOT EXISTS hourly_commentary (\n window_start INTEGER PRIMARY KEY,\n payload TEXT NOT NULL,\n model TEXT,\n created_at INTEGER NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS prices_5m (\n instrument TEXT NOT NULL,\n contract TEXT NOT NULL,\n ts INTEGER NOT NULL,\n open REAL, high REAL, low REAL,\n close REAL NOT NULL,\n volume INTEGER,\n PRIMARY KEY (instrument, contract, ts)\n) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS quotes (\n instrument TEXT PRIMARY KEY,\n contract TEXT,\n price REAL NOT NULL,\n prev_close REAL,\n market_time INTEGER,\n updated_at INTEGER NOT NULL\n)"
];

// 需要补的列：[表, 列, 类型]
export const ADD_COLUMNS = [
  ['prices', 'open', 'REAL'],
  ['prices', 'high', 'REAL'],
  ['prices', 'low', 'REAL'],
];

let ensured = null; // 每个 Worker 实例只检查一次

/** 返回 { created: [...], added: [...], errors: [...] } */
export function ensureSchema(env) {
  if (!ensured) {
    ensured = runEnsure(env).catch((e) => {
      ensured = null; // 失败了下次请求再试
      return { created: [], added: [], errors: [String(e?.message || e)] };
    });
  }
  return ensured;
}

export function resetSchemaCheck() {
  ensured = null;
}

async function runEnsure(env) {
  const out = { created: [], added: [], errors: [] };
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all();
  const have = new Set(results.map((r) => r.name));
  const missing = CREATE_STATEMENTS.filter((s) => !have.has(nameOf(s)));
  for (const s of missing) {
    try {
      await env.DB.prepare(s).run();
      out.created.push(nameOf(s));
    } catch (e) {
      out.errors.push(`${nameOf(s)}: ${e.message}`);
    }
  }
  for (const table of [...new Set(ADD_COLUMNS.map((c) => c[0]))]) {
    if (!have.has(table)) continue;
    const { results: cols } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const names = new Set(cols.map((c) => c.name));
    for (const [t, col, type] of ADD_COLUMNS.filter((c) => c[0] === table)) {
      if (names.has(col)) continue;
      try {
        await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`).run();
        out.added.push(`${t}.${col}`);
      } catch (e) {
        out.errors.push(`${t}.${col}: ${e.message}`);
      }
    }
  }
  if (out.created.length || out.added.length || out.errors.length) console.log(JSON.stringify({ schema_guard: out }));
  return out;
}

export function nameOf(sql) {
  return sql.match(/CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/i)?.[1];
}
