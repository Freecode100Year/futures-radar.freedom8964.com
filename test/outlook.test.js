import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourlyCandles, hourStats, computeOutlook, priceTime, getOutlook, getHourly } from '../src/outlook.js';
import { byKey } from '../src/instruments.js';
import { isOpen } from '../src/sessions.js';
import worker from '../src/index.js';
import { makeEnv, drainQueue } from './mock-env.js';

const H = 3600;
// 可复现的高斯随机数
function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return () => Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(2 * Math.PI * u());
}
/** 只在 Globex 开盘小时生成整点K线；美东 10 点的波动是平常的 3 倍（模拟数据发布时段） */
function globexBars(start, end, { sigma = 0.002, seed = 7, base = 100, hot = 3 } = {}) {
  const g = rng(seed);
  const out = [];
  let p = base;
  for (let t = Math.floor(start / H) * H; t < end; t += H) {
    if (!isOpen('globex', new Date((t + 1800) * 1000))) continue;
    const etH = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t * 1000)));
    const o = p;
    p *= Math.exp(g() * sigma * (etH === 10 ? hot : 1));
    out.push({ ts: t, open: o, high: Math.max(o, p) * 1.0005, low: Math.min(o, p) * 0.9995, close: p });
  }
  return out;
}

test('小时K线：完整K线 + 最后一根未收盘K线，旧数据缺开高低时用前收补齐', () => {
  const rows = [
    { ts: 7200, open: null, high: null, low: null, close: 100 },
    { ts: 10800, open: null, high: null, low: null, close: 101 },
    { ts: 14400, open: 101, high: 102.5, low: 100.5, close: 102 },
    { ts: 9000 + 59 * 60, close: 100.8 }, // 过去的实时点：被完整K线取代，不单独成K线
    { ts: 14400 + 3600 + 1799, open: 102, high: 103, low: 101.9, close: 102.4 }, // 进行中的这一小时
  ].sort((a, b) => a.ts - b.ts);
  const c = hourlyCandles(rows);
  assert.equal(c.length, 4);
  assert.deepEqual(c[1], { t: 10800, o: 100, h: 101, l: 100, c: 101, chg_pct: 1 });
  assert.equal(c[2].h, 102.5);
  assert.equal(c[3].partial, true);
  assert.equal(c[3].t, 18000, '未收盘K线归到它所在的小时');
  assert.equal(priceTime({ ts: 14400 }), 18000, '整点K线的价格时间是收盘时刻');
  assert.equal(priceTime({ ts: 19999 }), 19999);
});

test('风险展望：按时段估计波动率，周末休市不给区间，数据发布时段区间更宽', () => {
  const now = Date.UTC(2026, 10, 3, 14, 20) / 1000; // 周二 09:20 ET
  const rows = globexBars(now - 70 * 86400, Math.floor(now / H) * H - H);
  const stats = hourStats(rows);
  assert.ok(stats.n > 1000);
  assert.ok(stats.hour[10].sigma > 2.3 * stats.hour[3].sigma, '美东 10 点的波动明显高于凌晨');
  assert.ok(Math.abs(stats.hour[3].sigma - 0.002) < 0.0006, `凌晨时段约等于真实波动 0.2%：${stats.hour[3].sigma}`);
  assert.ok(stats.q68 > 0.8 && stats.q68 < 1.2 && stats.q95 > 1.6 && stats.q95 < 2.4, `${stats.q68} ${stats.q95}`);

  const wti = byKey.wti;
  const o = computeOutlook(wti, rows, { nowSec: now, stats });
  assert.equal(o.status, 'open');
  assert.equal(o.window_start, Date.UTC(2026, 10, 3, 14) / 1000);
  assert.ok(o.lo68 < o.base_price && o.base_price < o.hi68 && o.lo95 < o.lo68 && o.hi95 > o.hi68);
  assert.equal(o.horizon_h, 2, '最新价格是上一个整点前的收盘 → 覆盖 2 小时');

  // 周三 10:30 ET 有 EIA：窗口 10:00–11:00 用历史同时段波动（更宽）
  const wed = Date.UTC(2026, 10, 4, 15, 5) / 1000;
  const rows2 = globexBars(wed - 70 * 86400, Math.floor(wed / H) * H, { seed: 9 });
  const ev = [{ ts: '2026-11-04T15:30:00.000Z', title: 'EIA 原油库存周报（WPSR）', instruments: ['wti', 'brent'], importance: 3, source: 'recurring' }];
  const withEv = computeOutlook(wti, rows2, { nowSec: wed, events: ev });
  const noEv = computeOutlook(wti, rows2, { nowSec: wed, events: [] });
  assert.equal(withEv.events.length, 1);
  assert.ok(withEv.event_adj === null || withEv.width68_pct >= noEv.width68_pct);
  assert.equal(computeOutlook(byKey.gold, rows2, { nowSec: wed, events: ev }).events.length, 0, 'EIA 不算黄金的数据发布');

  const sat = Date.UTC(2026, 10, 7, 15) / 1000;
  assert.equal(computeOutlook(wti, rows, { nowSec: sat }).status, 'closed');
});

test('风险展望：滚动回测，68%/95% 区间的命中率接近名义水平', () => {
  const start = Date.UTC(2026, 0, 5) / 1000;
  const all = globexBars(start, start + 200 * 86400, { seed: 21, hot: 2.5 });
  let n = 0, h68 = 0, h95 = 0;
  for (let k = 1700; k < all.length - 2; k += 3) {
    const end = all[k].ts + H; // 已知到第 k 根K线收盘
    const nowSec = end + 600; // 10 分钟后生成本小时展望
    const hist = all.slice(Math.max(0, k - 1600), k + 1);
    const o = computeOutlook(byKey.es, hist, { nowSec });
    if (o.status !== 'open') continue;
    const target = all.find((b) => priceTime(b) === o.window_end);
    if (!target) continue;
    n++;
    if (target.close >= o.lo68 && target.close <= o.hi68) h68++;
    if (target.close >= o.lo95 && target.close <= o.hi95) h95++;
  }
  assert.ok(n > 300, `样本 ${n}`);
  assert.ok(Math.abs(h68 / n - 0.683) < 0.07, `68% 区间命中率 ${(h68 / n).toFixed(3)}`);
  assert.ok(Math.abs(h95 / n - 0.954) < 0.04, `95% 区间命中率 ${(h95 / n).toFixed(3)}`);
});

test('定时任务：整点生成展望 + AI 情景，之后自动核对，接口返回命中率', async () => {
  const env = makeEnv();
  const t0 = Date.UTC(2030, 0, 8, 15, 0) / 1000; // 周二 10:00 ET（取未来日期，避免测试随真实时间失效）
  const ins = env.DB._db.prepare('INSERT INTO prices (instrument, contract, ts, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const series = {};
  for (const [i, key] of ['wti', 'gold', 'es'].entries()) {
    series[key] = globexBars(t0 - 60 * 86400, t0 + 3 * H, { seed: 30 + i, base: [70, 2600, 6000][i] });
    for (const b of series[key].filter((x) => x.ts < t0 - H)) ins.run(key, 'Z26', b.ts, b.open, b.high, b.low, b.close);
  }
  globalThis.fetch = async () => new Response('down', { status: 503 }); // 外部行情源全部不可用：只用库里的数据
  let prompt = '';
  env.AI._chat = async (model, input) => {
    prompt = input.messages.at(-1).content;
    return { response: JSON.stringify({ items: [
      { instrument: 'wti', context: 'EIA 数据前夕', upside: '若库存降幅超预期，价格可能冲向区间上沿', downside: '若库存意外增加，可能回落至区间下沿', watch: 'EIA 原油库存' },
      { instrument: 'gold', context: '美元走弱', upside: '美元继续走弱时可能上行', downside: '美债收益率上行时可能承压', watch: '美元指数' },
      { instrument: 'es', context: '财报季', upside: '大型科技股走强', downside: '建议做空规避风险', watch: '纳指' }, // 含交易指令 → 丢弃
    ] }) };
  };

  await worker.scheduled({ cron: 't', scheduledTime: t0 * 1000 + 30000 }, env, {});
  const made = env.DB._db.prepare('SELECT instrument FROM hourly_outlook WHERE window_start = ?').all(t0).map((r) => r.instrument).sort();
  assert.deepEqual(made, ['es', 'gold', 'wti'], '只有有数据的品种生成展望');
  await drainQueue(worker, env);
  assert.match(prompt, /68% 统计区间/);

  const ov = await getOutlook(env, { nowSec: t0 + 600 });
  const wti = ov.instruments.find((i) => i.instrument === 'wti');
  assert.equal(wti.status, 'current');
  assert.equal(wti.ai.watch, 'EIA 原油库存');
  assert.equal(ov.instruments.find((i) => i.instrument === 'es').ai, null, '含"做空"的条目被过滤');
  assert.equal(ov.instruments.find((i) => i.instrument === 'silver').status, 'pending');

  // 一小时后数据到达（两根新K线），下一次定时任务核对
  for (const key of Object.keys(series)) for (const b of series[key].filter((x) => x.ts >= t0 - H && x.ts < t0 + H)) ins.run(key, 'Z26', b.ts, b.open, b.high, b.low, b.close);
  await worker.scheduled({ cron: 't', scheduledTime: (t0 + H + 15 * 60) * 1000 }, env, {});
  const ev = env.DB._db.prepare('SELECT instrument, actual, hit68, hit95 FROM hourly_outlook WHERE window_start = ?').all(t0);
  assert.ok(ev.every((r) => r.actual !== null && r.hit95 !== null), JSON.stringify(ev));
  const want = series.wti.find((b) => priceTime(b) === t0 + H).close;
  assert.ok(Math.abs(ev.find((r) => r.instrument === 'wti').actual - want) < 1e-9, '用窗口结束时的收盘价核对');

  const track = await (await worker.fetch(new Request('https://x/api/outlook/track'), env, {})).json();
  assert.equal(track.overall.n, 3);
  const hr = await getHourly(env, 'wti', { nowSec: t0 + H + 900, hours: 48 });
  assert.equal((await (await worker.fetch(new Request('https://x/api/instruments/wti/hourly'), env, {})).json()).instrument, 'wti');
  assert.equal(hr.candles.length, 48);
  assert.equal(hr.history.length, 1);
  assert.equal(hr.hour_profile.length, 24);
});
