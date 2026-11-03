import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CREATE_STATEMENTS, ADD_COLUMNS, ensureSchema, resetSchemaCheck, nameOf } from '../src/schema-guard.js';
import { sessionDate } from '../src/sessions.js';
import { dailyCloses } from '../src/futures.js';
import { tradingDay } from '../src/contracts.js';
import worker, { itemErrors } from '../src/index.js';
import { makeEnv } from './mock-env.js';

test('自动建表清单与迁移 0006–0010 保持一致', () => {
  for (const f of ['0006_market_tools', '0007_opencode_health', '0008_cron_log', '0009_hourly_outlook', '0010_quotes_5m', '0011_direction']) {
    const sql = readFileSync(new URL(`../migrations/${f}.sql`, import.meta.url), 'utf8');
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
      assert.ok(ADD_COLUMNS.some(([t, c]) => t === m[1] && c === m[2]), `${f} 的 ${m[1]}.${m[2]} 不在自动补列清单里`);
    }
    for (const m of sql.matchAll(/CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)) {
      assert.ok(CREATE_STATEMENTS.some((s) => nameOf(s) === m[1]), `${f} 的 ${m[1]} 不在自动建表清单里`);
    }
  }
});

test('漏跑迁移：缺表自动补建、缺列自动补加，报价接口恢复', async () => {
  const env = makeEnv();
  env.DB._db.exec('DROP TABLE quotes; DROP TABLE prices_5m; DROP TABLE hourly_outlook;');
  // 模拟 0009 之前的 prices 表（没有开高低）
  env.DB._db.exec('DROP TABLE prices; CREATE TABLE prices (instrument TEXT NOT NULL, contract TEXT NOT NULL, ts INTEGER NOT NULL, close REAL NOT NULL, PRIMARY KEY (instrument, contract, ts)) WITHOUT ROWID;');
  resetSchemaCheck();
  const r = await (await worker.fetch(new Request('https://x/api/quotes'), env, {})).json();
  assert.equal(r.error, 'quotes_empty', '表已补建，只是还没有数据（503 + 说明，而不是 200 + {}）');
  const st = await (await worker.fetch(new Request('https://x/api/data-status'), env, {})).json();
  assert.deepEqual(st.table_errors, {});
  assert.ok(st.schema_guard.created.includes('quotes') && st.schema_guard.created.includes('prices_5m'));
  assert.deepEqual(st.schema_guard.added.slice(0, 3), ['prices.open', 'prices.high', 'prices.low']);
  assert.ok(st.schema_guard.added.includes('hourly_outlook.p_up'), '刚补建的表也会补上新列');
  assert.equal(st.ok, false, '报价还没更新过 → 总闸为 false');
  assert.ok(st.problems.some((p) => /报价/.test(p)));
  resetSchemaCheck();
});

test('报价表查询失败时 /api/quotes 返回 503，总览带出异常状态', async () => {
  const env = makeEnv();
  resetSchemaCheck();
  await ensureSchema(env);
  env.DB._db.exec('DROP TABLE quotes;'); // 本实例已检查过结构，模拟运行中表被删
  const res = await worker.fetch(new Request('https://x/api/quotes'), env, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'quotes_unavailable');
  const ov = await (await worker.fetch(new Request('https://x/api/overview'), env, {})).json();
  assert.equal(ov.quotes_status.ok, false);
  assert.equal(ov.quotes_status.error, 'quotes_unavailable');
  assert.ok(ov.instruments.every((i) => i.quote === null));
  resetSchemaCheck();
});

test('定时步骤有逐项错误时记为失败', async () => {
  assert.deepEqual(itemErrors([{ instrument: 'wti', error: 'boom' }, { instrument: 'gold', price: 1 }]), ['wti: boom']);
  assert.deepEqual(itemErrors({ daily: [{ instrument: 'zn', error: 'x' }], cot: [{ report: 'tff', error: 'y' }], changed: false }), ['zn: x', 'tff: y']);
  assert.deepEqual(itemErrors(null), []);
  const env = makeEnv();
  globalThis.fetch = async () => new Response('down', { status: 503 });
  await worker.scheduled({ cron: '*/5', scheduledTime: Date.parse('2026-11-03T15:05:00Z') }, env, {});
  const row = env.DB._db.prepare("SELECT ok, detail FROM cron_log WHERE step = 'quotes'").get();
  assert.equal(row.ok, 0, '12 个品种全部抓取失败，不能记为成功');
  assert.match(row.detail, /503/);
});

test('交易日：美东 18:00 起算下一交易日，跨 UTC 零点不拆分', () => {
  assert.equal(sessionDate(Date.UTC(2026, 10, 2, 21, 0) / 1000), '2026-11-02'); // 16:00 ET
  assert.equal(sessionDate(Date.UTC(2026, 10, 2, 23, 0) / 1000), '2026-11-03'); // 18:00 ET 夜盘 → 次日
  assert.equal(sessionDate(Date.UTC(2026, 10, 3, 1, 0) / 1000), '2026-11-03'); // 20:00 ET
  assert.equal(sessionDate(Date.UTC(2026, 6, 7, 22, 0) / 1000), '2026-07-08'); // 夏令时 18:00 ET
  const s = [
    { ts: Date.UTC(2026, 10, 2, 14) / 1000, close: 100 }, // 11-02 09:00 ET
    { ts: Date.UTC(2026, 10, 2, 21) / 1000, close: 110 }, // 11-02 16:00 ET（日盘收盘）
    { ts: Date.UTC(2026, 10, 3, 1) / 1000, close: 105 }, // 11-02 20:00 ET（夜盘，属于 11-03 交易日）
    { ts: Date.UTC(2026, 10, 3, 14) / 1000, close: 120 }, // 11-03 09:00 ET
  ];
  const out = dailyCloses(s);
  assert.deepEqual(out.map((d) => [d.day, d.close]), [['2026-11-02', 110], ['2026-11-03', 120]]);
  // Yahoo 日线：完整日线是交易所午夜时间戳；当天未收盘的那根是实时时间戳，不能被算到第二天
  assert.equal(tradingDay(Date.UTC(2026, 10, 2, 5) / 1000), '2026-11-02');
  assert.equal(tradingDay(Date.UTC(2026, 10, 2, 20, 30) / 1000), '2026-11-02');
});

test('总览不再暴露日线推算的 1 日涨跌', async () => {
  const env = makeEnv();
  env.DB._db.prepare("INSERT INTO instrument_snapshot (instrument, updated_at, payload) VALUES ('wti', 'x', ?)").run(JSON.stringify({ perf: { d1: -7.65, w1: 1 }, stats: { last: 1 } }));
  const ov = await (await worker.fetch(new Request('https://x/api/overview'), env, {})).json();
  const w = ov.instruments.find((i) => i.key === 'wti');
  assert.equal('d1' in w.perf, false);
  assert.equal(w.perf.w1, 1);
});
