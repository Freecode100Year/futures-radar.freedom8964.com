import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpen, sessionStatus } from '../src/sessions.js';
import { etToUtc, recurringEvents } from '../src/calendar.js';
import { performance, technicals, pivots, seasonality, correlationMatrix, spreadStats, SPREADS, rsi, atr, notional } from '../src/analytics.js';
import { parseCotRows, cotMetrics, updateCot } from '../src/cot.js';
import { updateDailyBars, tradingDay } from '../src/contracts.js';
import { computeSnapshots } from '../src/futures.js';
import { byKey } from '../src/instruments.js';
import worker from '../src/index.js';
import { makeEnv } from './mock-env.js';

const at = (iso) => new Date(iso);

test('交易时段：Globex 与谷物（含夏令时/冬令时）', () => {
  // 2026-11-02 周一，冬令时 UTC-5
  assert.equal(isOpen('globex', at('2026-11-02T15:00:00Z')), true); // 10:00 ET
  assert.equal(isOpen('grains', at('2026-11-02T15:00:00Z')), true); // 日盘 09:30–14:20
  assert.equal(isOpen('grains', at('2026-11-02T20:00:00Z')), false); // 15:00 ET
  assert.equal(isOpen('globex', at('2026-11-02T22:30:00Z')), false); // 17:30 ET 每日休市
  assert.equal(isOpen('globex', at('2026-11-02T23:30:00Z')), true); // 18:30 ET
  assert.equal(isOpen('grains', at('2026-11-03T01:30:00Z')), true); // 20:30 ET 夜盘
  assert.equal(isOpen('globex', at('2026-11-07T15:00:00Z')), false); // 周六
  assert.equal(isOpen('globex', at('2026-11-08T23:30:00Z')), true); // 周日 18:30 开盘
  assert.equal(isOpen('grains', at('2026-11-08T23:30:00Z')), false); // 谷物周日 20:00 才开
  // 夏令时：2026-07-06 周一 17:30 EDT = 21:30 UTC
  assert.equal(isOpen('globex', at('2026-07-06T21:30:00Z')), false);
  assert.equal(isOpen('globex', at('2026-07-06T20:30:00Z')), true);

  const st = sessionStatus('globex', at('2026-11-02T22:30:00Z'));
  assert.equal(st.open, false);
  assert.equal(st.next_change, '2026-11-02T23:00:00.000Z', '18:00 ET 重新开盘');
  const fri = sessionStatus('globex', at('2026-11-06T21:00:00Z')); // 周五 16:00 ET
  assert.equal(fri.next_change, '2026-11-06T22:00:00.000Z');
});

test('财经日历：美东时间换算与周期性事件', () => {
  assert.equal(new Date(etToUtc(2026, 7, 8, 10, 30)).toISOString(), '2026-07-08T14:30:00.000Z');
  assert.equal(new Date(etToUtc(2026, 12, 9, 10, 30)).toISOString(), '2026-12-09T15:30:00.000Z');
  const ev = recurringEvents(Date.parse('2026-11-01T12:00:00Z'), 7);
  const titles = ev.map((e) => `${e.ts} ${e.title}`);
  assert.ok(titles.includes('2026-11-04T15:30:00.000Z EIA 原油库存周报（WPSR）'));
  assert.ok(titles.includes('2026-11-02T21:00:00.000Z USDA 作物生长报告（Crop Progress）'));
  assert.ok(titles.includes('2026-11-06T20:30:00.000Z CFTC 持仓报告（COT）'));
  assert.ok(ev.every((e, i) => i === 0 || ev[i - 1].ts <= e.ts));
  const dec = recurringEvents(Date.parse('2026-12-06T12:00:00Z'), 3);
  assert.ok(!dec.some((e) => e.title.includes('作物生长')), '作物报告只在 4–11 月');
});

// ---- 合成日线 ----
function bars(n, f, start = '2016-01-04') {
  const out = [];
  let t = Date.parse(start);
  while (out.length < n) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const c = f(out.length, d);
      out.push({ day: d.toISOString().slice(0, 10), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 });
    }
    t += 86400000;
  }
  return out;
}

test('多周期涨跌与 52 周区间', () => {
  const b = bars(300, (i) => 100 + i); // 线性上涨
  const p = performance(b);
  assert.equal(p.last, 399);
  assert.equal(p.d1, Math.round((399 / 398 - 1) * 10000) / 100);
  assert.equal(p.y1, Math.round((399 / 147 - 1) * 10000) / 100);
  assert.ok(p.pos52 > 95);
  assert.ok(p.ytd !== null);
  assert.equal(performance([b[0]]), null);
});

test('技术指标：RSI / ATR / 状态描述 / 枢轴点', () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 100);
  const zig = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  assert.ok(Math.abs(rsi(zig) - 50) < 5);
  const flatRange = bars(50, () => 100);
  assert.ok(Math.abs(atr(flatRange) - 2) < 1e-9, '高低差恒为 2');

  const up = bars(260, (i) => 100 * 1.002 ** i);
  const t = technicals(up);
  assert.ok(t.rsi14 > 70);
  assert.ok(t.states.includes('RSI 处于超买区域（≥70）'));
  assert.ok(t.states.includes('价格在 200 日均线上方'));
  assert.ok(t.states.includes('50 日均线高于 200 日均线'));
  assert.ok(t.dist_sma200_pct > 0);
  assert.equal(technicals(up.slice(0, 20)), null);
  assert.ok(!t.states.some((s) => /买入|卖出/.test(s)), '只描述状态，不给买卖建议');

  const pv = pivots({ day: 'x', high: 110, low: 90, close: 100 });
  assert.equal(pv.p, 100);
  assert.equal(pv.r1, 110);
  assert.equal(pv.s1, 90);
  assert.equal(pv.r2, 120);
});

test('季节性：每年 3 月固定上涨 5%', () => {
  let level = 100;
  let lastMonth = null;
  const b = bars(2600, (i, d) => {
    const m = d.getUTCMonth();
    if (m !== lastMonth) {
      if (m === 2) level *= 1.05; // 进入 3 月时跳涨
      if (m === 3) level /= 1.05 / 1.0; // 4 月回到原位
      lastMonth = m;
    }
    return level;
  });
  const s = seasonality(b);
  assert.ok(s.years >= 9);
  const mar = s.monthly[2];
  assert.ok(Math.abs(mar.mean - 5) < 0.01, String(mar.mean));
  assert.equal(mar.win_rate, 100);
  assert.ok(s.monthly[3].mean < -4, '4 月回落');
  assert.equal(s.path.avg5.length, 53);
  assert.equal(seasonality(b.slice(0, 100)), null);
});

test('相关性矩阵与价差/比价', () => {
  const a = bars(120, (i) => 100 * Math.exp(0.01 * Math.sin(i)));
  const inv = a.map((x) => ({ ...x, close: 1e4 / x.close }));
  const m = correlationMatrix({ gold: a, silver: a, zn: inv }, ['gold', 'silver', 'zn'], 60);
  assert.equal(m.matrix[0][1], 1);
  assert.equal(m.matrix[0][2], -1);
  assert.equal(m.matrix[1][1], 1);

  const gold = bars(300, (i) => 2000 + i), silver = gold.map((x) => ({ ...x, close: x.close / 80 }));
  const gs = spreadStats({ gold, silver }, SPREADS.find((d) => d.key === 'gold_silver'));
  assert.equal(gs.value, 80);
  assert.equal(gs.percentile_1y, 100);
  assert.equal(gs.series.length, 252);
  assert.equal(spreadStats({ gold }, SPREADS.find((d) => d.key === 'gold_silver')), null);
  assert.equal(notional(2650, byKey.gold.spec), 265000);
  assert.equal(notional(1050, byKey.soybeans.spec), 52500, '大豆报价单位为美分：1050 美分 × 5000 蒲式耳 = 52,500 美元');
});

test('CFTC：字段兼容、未知合约忽略、COT 指数', () => {
  const rows = parseCotRows([
    { cftc_contract_market_code: '088691', report_date_as_yyyy_mm_dd: '2026-10-27T00:00:00.000', m_money_positions_long_all: '200000', m_money_positions_short_all: '50000', open_interest_all: '500000' },
    { cftc_contract_market_code: '999999', report_date_as_yyyy_mm_dd: '2026-10-27T00:00:00.000', m_money_positions_long_all: '1', m_money_positions_short_all: '1' },
  ], 'disagg');
  assert.deepEqual(rows, [{ instrument: 'gold', report_date: '2026-10-27', open_interest: 500000, long: 200000, short: 50000 }]);
  const tff = parseCotRows([{ cftc_contract_market_code: '13874A', report_date_as_yyyy_mm_dd: '2026-10-27T00:00:00.000', lev_money_positions_long: '100', lev_money_positions_short: '300', open_interest_all: '1000' }], 'tff');
  assert.equal(tff[0].instrument, 'es');

  const series = Array.from({ length: 160 }, (_, i) => ({ report_date: `w${String(i).padStart(3, '0')}`, long: 1000 + i * 10, short: 1000, open_interest: 10000 }));
  const m = cotMetrics(series);
  assert.equal(m.cot_index, 100);
  assert.equal(m.state, '多头拥挤（接近历史高位）');
  assert.equal(m.net_change, 10);
  assert.equal(m.weeks, 156);
  assert.equal(cotMetrics(series.slice(0, 10)).state, '历史数据不足');
});

test('updateCot：按合约代码查询两个数据集并入库', async () => {
  const env = makeEnv();
  const urls = [];
  const fetcher = async (url) => {
    urls.push(decodeURIComponent(url));
    const isTff = url.includes('gpe5-46if');
    return Response.json(isTff
      ? [{ cftc_contract_market_code: '043602', report_date_as_yyyy_mm_dd: '2026-10-27T00:00:00.000', lev_money_positions_long_all: '10', lev_money_positions_short_all: '90', open_interest_all: '4000000' }]
      : [{ cftc_contract_market_code: '067651', report_date_as_yyyy_mm_dd: '2026-10-27T00:00:00.000', m_money_positions_long_all: '300', m_money_positions_short_all: '100', open_interest_all: '2000000' }]);
  };
  const r = await updateCot(env, { fetcher, nowSec: Date.parse('2026-11-01') / 1000 });
  assert.ok(urls[0].includes("'067651'") && urls[0].includes("'088691'") && urls[0].includes('72hh-3qpy'));
  assert.ok(urls[1].includes("'13874A'") && urls[1].includes('gpe5-46if'));
  assert.ok(urls[0].includes(">= '2023-"), '首次回填约 3 年');
  assert.equal(r[0].rows, 1);
  assert.ok(r[0].missing.includes('gold'), '报告缺少的品种会列出来');
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) n FROM cot').get().n, 2);
});

test('日线回填 → 快照 → 总览 / 品种详情 / 日历接口', async () => {
  const env = makeEnv();
  const now = Date.now();
  const fetcher = async (symbol, { interval, range }) => {
    assert.equal(interval, '1d');
    assert.equal(range, '10y', '首次拉 10 年');
    const base = { 'GC=F': 2000, 'SI=F': 25, 'BZ=F': 80, 'CL=F': 76 }[symbol] || 100;
    const out = [];
    for (let i = 2600; i >= 0; i--) {
      const ts = Math.floor((now - i * 86400000) / 1000);
      const d = new Date(ts * 1000).getUTCDay();
      if (d === 0 || d === 6) continue;
      const c = base * (1 + 0.1 * Math.sin(i / 40 + base));
      out.push({ ts, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 10 });
    }
    return out;
  };
  const rep = await updateDailyBars(env, { fetcher });
  assert.equal(rep.length, 12);
  assert.equal(tradingDay(Date.UTC(2026, 10, 2, 5) / 1000), '2026-11-02');
  for (let w = 0; w < 160; w++) {
    env.DB._db.prepare("INSERT INTO cot VALUES ('gold', ?, 500000, ?, 50000)").run(new Date(now - (160 - w) * 7 * 86400000).toISOString().slice(0, 10), 100000 + w * 500);
  }
  await computeSnapshots(env, Math.floor(now / 1000));

  const ov = await (await worker.fetch(new Request('https://x/api/overview'), env, {})).json();
  assert.equal(ov.sessions.length, 2);
  assert.equal(ov.instruments.length, 12);
  const gold = ov.instruments.find((i) => i.key === 'gold');
  assert.ok(gold.perf && Number.isFinite(gold.perf.ytd));
  assert.equal(gold.cot.cot_index, 100);
  assert.ok(gold.notional > 100000);
  assert.equal(ov.spreads.length, 4);
  assert.equal(ov.correlation.keys.length, 12);
  assert.ok(ov.calendar.some((e) => e.title.includes('EIA')));

  const d = await (await worker.fetch(new Request('https://x/api/instruments/gold'), env, {})).json();
  assert.equal(d.instrument.spec.tickValue, 10);
  assert.match(d.instrument.session_hours, /Globex/);
  assert.ok(typeof d.session.open === 'boolean');
  assert.ok(d.snapshot.tech.rsi14 >= 0);
  assert.equal(d.snapshot.seasonality.monthly.length, 12);
  assert.equal(d.snapshot.cot.group, '管理基金');
  assert.equal(d.snapshot.cot.series.length, 156);
  assert.ok(d.snapshot.pivots.p > 0);
  assert.ok(d.snapshot.daily.length >= 20, '小时线不足时用日线画图');

  // 日历：管理员添加 / 删除自定义事件
  const admin = { authorization: 'Bearer secret', 'content-type': 'application/json' };
  const add = await worker.fetch(new Request('https://x/api/admin/calendar', { method: 'POST', headers: admin, body: JSON.stringify({ ts: new Date(now + 86400000).toISOString(), title: 'FOMC 利率决议', instruments: ['es', 'zn', 'gold'], importance: 3 }) }), env, {});
  const { id } = await add.json();
  let cal = await (await worker.fetch(new Request('https://x/api/calendar?days=3'), env, {})).json();
  assert.ok(cal.some((e) => e.title === 'FOMC 利率决议' && e.source === 'custom'));
  assert.equal((await worker.fetch(new Request('https://x/api/admin/calendar', { method: 'POST', headers: admin, body: '{"title":"x"}' }), env, {})).status, 400);
  await worker.fetch(new Request(`https://x/api/admin/calendar/${id}`, { method: 'DELETE', headers: admin }), env, {});
  cal = await (await worker.fetch(new Request('https://x/api/calendar?days=3'), env, {})).json();
  assert.ok(!cal.some((e) => e.title === 'FOMC 利率决议'));
  assert.equal((await worker.fetch(new Request(`https://x/api/admin/calendar/1`, { method: 'DELETE' }), env, {})).status, 401);
});

test('自动补齐：每次补 3 个品种的日线；持仓过期才拉；日线回填前用小时线估算', async () => {
  const { ensureHistory, dataStatus } = await import('../src/futures.js');
  const { synthSeries } = await import('./mock-env.js');
  const env = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  // 只有小时线（例如刚部署）：快照里涨跌和 RSI 应该用小时线估算出来，季节性为空
  const pts = synthSeries({ start: now - 100 * 86400, end: now, base: 80, seed: 3 });
  const st = env.DB._db.prepare("INSERT INTO prices (instrument, contract, ts, close) VALUES ('brent', 'BZF27', ?, ?)");
  for (const p of pts) st.run(p.ts, p.close);
  await computeSnapshots(env, now);
  let ov = await (await worker.fetch(new Request('https://x/api/overview'), env, {})).json();
  const brent = ov.instruments.find((i) => i.key === 'brent');
  assert.equal(brent.bars_source, 'hourly');
  assert.ok(Number.isFinite(brent.perf.w1) && Number.isFinite(brent.rsi14), '小时线估算出 1 周涨跌和 RSI');
  assert.equal(ov.history_ready, 0);
  const det = await (await worker.fetch(new Request('https://x/api/instruments/brent'), env, {})).json();
  assert.equal(det.snapshot.seasonality, null);

  const dailyCalls = [];
  const fetcher = async (symbol) => {
    dailyCalls.push(symbol);
    return Array.from({ length: 600 }, (_, k) => ({ ts: now - (600 - k) * 86400, open: 1, high: 1, low: 1, close: 1 + k / 1000, volume: 1 }));
  };
  let cotCalls = 0;
  const cotFetcher = async () => (cotCalls++, Response.json([]));
  const r1 = await ensureHistory(env, { nowSec: now, fetcher, cotFetcher });
  assert.equal(r1.daily.length, 3);
  assert.equal(cotCalls, 2, '持仓表为空 → 两个数据集各拉一次');
  for (let i = 0; i < 3; i++) await ensureHistory(env, { nowSec: now, fetcher, cotFetcher });
  assert.equal(new Set(dailyCalls).size, 12, '4 轮补完 12 个品种');
  const before = dailyCalls.length;
  await ensureHistory(env, { nowSec: now, fetcher, cotFetcher });
  assert.equal(dailyCalls.length, before, '日线已齐不再请求');

  env.DB._db.prepare("INSERT INTO cot VALUES ('gold', ?, 1, 2, 1)").run(new Date((now - 5 * 86400) * 1000).toISOString().slice(0, 10));
  cotCalls = 0;
  await ensureHistory(env, { nowSec: now, fetcher, cotFetcher });
  assert.equal(cotCalls, 0, '最新报告 5 天前 → 不拉');

  await computeSnapshots(env, now);
  ov = await (await worker.fetch(new Request('https://x/api/overview'), env, {})).json();
  assert.equal(ov.history_ready, 12);
  assert.equal(ov.instruments.find((i) => i.key === 'brent').bars_source, 'daily');

  const ds = await (await worker.fetch(new Request('https://x/api/data-status'), env, {})).json();
  assert.deepEqual(ds.table_errors, {});
  const b = ds.instruments.find((i) => i.key === 'brent');
  assert.ok(b.hourly_bars > 1000 && b.daily_bars === 600);
  assert.equal(ds.instruments.find((i) => i.key === 'gold').cot_weeks, 1);
});

test('数据状态接口能报告缺失的表；快照在缺表时照样刷新', async () => {
  const { dataStatus } = await import('../src/futures.js');
  const env = makeEnv();
  env.DB._db.exec('DROP TABLE daily_bars; DROP TABLE cot;');
  const ds = await dataStatus(env);
  assert.match(ds.table_errors.daily_bars, /no such table/);
  const rep = await computeSnapshots(env);
  assert.equal(rep.length, 12, '缺 0006 的表也不会中断快照');
});

test('定时任务：某一步失败不影响后续步骤', async () => {
  const env = makeEnv();
  env.QUEUE.sendBatch = async () => {
    throw new Error('queue down');
  };
  globalThis.fetch = async () => new Response('down', { status: 503 });
  const logs = [];
  const orig = console.log;
  console.log = (x) => logs.push(x);
  try {
    // group 3（分钟 45）：行情失败、补齐失败也要继续刷新快照
    await worker.scheduled({ cron: 't', scheduledTime: Date.UTC(2026, 10, 2, 15, 45) }, env, {});
  } finally {
    console.log = orig;
  }
  const log = JSON.parse(logs.at(-1));
  assert.equal(log.group, 3);
  assert.ok(log.market_errors.length > 0);
  assert.ok(env.DB._db.prepare('SELECT COUNT(*) n FROM instrument_snapshot').get().n === 12, '快照照样刷新');
});

test('定时任务：每 15 分钟补日线，补到数据立即刷新快照；持仓只在整点组检查', async () => {
  const env = makeEnv();
  const urls = [];
  const now = Date.now();
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('interval=1d&range=10y')) {
      const ts = Array.from({ length: 600 }, (_, k) => Math.floor(now / 1000) - (600 - k) * 86400);
      return Response.json({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: ts.map((_, k) => 100 + k / 10), open: ts.map(() => 100), high: ts.map(() => 101), low: ts.map(() => 99), volume: ts.map(() => 1) }] } }] } });
    }
    return new Response('down', { status: 503 });
  };
  await worker.scheduled({ cron: 't', scheduledTime: Date.UTC(2026, 10, 2, 15, 0) }, env, {}); // group 0
  assert.equal(env.DB._db.prepare('SELECT COUNT(DISTINCT instrument) n FROM daily_bars').get().n, 3);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) n FROM instrument_snapshot').get().n, 12, '补到数据立即刷新快照');
  assert.ok(!urls.some((u) => u.includes('publicreporting.cftc.gov')), '非整点组不拉持仓');
  await worker.scheduled({ cron: 't', scheduledTime: Date.UTC(2026, 10, 2, 15, 45) }, env, {}); // group 3
  assert.equal(env.DB._db.prepare('SELECT COUNT(DISTINCT instrument) n FROM daily_bars').get().n, 6);
  assert.ok(urls.some((u) => u.includes('publicreporting.cftc.gov')), '整点组检查持仓');
});

test('数据状态：返回各定时步骤最近一次结果', async () => {
  const env = makeEnv();
  globalThis.fetch = async () => new Response('down', { status: 503 });
  await worker.scheduled({ cron: 't', scheduledTime: Date.UTC(2026, 10, 2, 15, 45) }, env, {});
  const st = await (await worker.fetch(new Request('https://x/api/data-status'), env, {})).json();
  assert.ok(st.cron_steps.ensure_history, '记录了补数据步骤');
  assert.ok(st.cron_steps.snapshots.ran_at);
});
