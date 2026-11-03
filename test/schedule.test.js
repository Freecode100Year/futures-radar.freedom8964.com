import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { parseYahooIntraday, latestQuotes, intradayCandles } from '../src/quotes.js';
import { makeEnv } from './mock-env.js';

// 记录外部请求；Yahoo 5 分钟接口返回一根K线，其余全部 503
function mockFetch(urls) {
  return async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes('interval=5m')) {
      const ts = Math.floor(Date.UTC(2026, 10, 3, 15, 0) / 1000);
      return Response.json({ chart: { result: [{ meta: { regularMarketPrice: 71.5, regularMarketTime: ts + 120, previousClose: 70 },
        timestamp: [ts - 300, ts], indicators: { quote: [{ open: [70.8, 71], high: [71.1, 71.6], low: [70.7, 70.9], close: [71, 71.5], volume: [10, 20] }] } }] } });
    }
    return new Response('down', { status: 503 });
  };
}
const run = (env, iso) => worker.scheduled({ cron: '*/5', scheduledTime: Date.parse(iso) }, env, {});

test('5 分钟行情：解析 Yahoo 元数据，写入报价与 5 分钟K线', async () => {
  const p = parseYahooIntraday({ chart: { result: [{ meta: { chartPreviousClose: 99 }, timestamp: [1, 2], indicators: { quote: [{ close: [100, null] }] } }] } });
  assert.deepEqual([p.price, p.prev_close, p.bars.length], [100, 99, 1]);

  const env = makeEnv();
  const urls = [];
  globalThis.fetch = mockFetch(urls);
  await run(env, '2026-11-03T15:05:00Z'); // 非 15 分钟整点：只更新报价
  assert.equal(urls.filter((u) => u.includes('interval=5m')).length, 12, '12 个品种各一次');
  assert.ok(!urls.some((u) => u.includes('interval=60m')), '不抓小时线');
  assert.ok(!urls.some((u) => /rss|gdelt/i.test(u)), '不采集新闻');
  const q = (await latestQuotes(env)).wti;
  assert.equal(q.price, 71.5);
  assert.equal(q.chg_pct, 2.14);
  const c = await intradayCandles(env, 'wti', { nowSec: Date.parse('2026-11-03T15:20:00Z') / 1000 });
  assert.equal(c.candles.length, 2);
  assert.equal(c.candles[1].partial, true);
  const ov = await (await worker.fetch(new Request('https://x/api/instruments'), env, {})).json();
  assert.equal(ov.find((i) => i.key === 'wti').quote.price, 71.5);
});

test('AI 调用时间：工作日美东 17:30 错开排队 12 个解读，周末不生成；按美东时间自动处理夏令时', async () => {
  const env = makeEnv();
  globalThis.fetch = mockFetch([]);
  // 冬令时：美东 17:30 = UTC 22:30（2026-11-03 周二）
  await run(env, '2026-11-03T22:30:00Z');
  const briefs = env.QUEUE._q.filter((b) => b.type === 'brief');
  assert.equal(briefs.length, 12);
  env.QUEUE._q.length = 0;
  // 夏令时：美东 17:30 = UTC 21:30（2026-07-07 周二）
  await run(env, '2026-07-07T21:30:00Z');
  assert.equal(env.QUEUE._q.filter((b) => b.type === 'brief').length, 12);
  env.QUEUE._q.length = 0;
  await run(env, '2026-07-07T22:30:00Z'); // 夏令时的 UTC 22:30 是美东 18:30，不再生成
  assert.equal(env.QUEUE._q.filter((b) => b.type === 'brief').length, 0);
  await run(env, '2026-11-07T22:30:00Z'); // 周六
  assert.equal(env.QUEUE._q.filter((b) => b.type === 'brief').length, 0);
});

test('解读排队时每个品种间隔 30 秒', async () => {
  const env = makeEnv();
  globalThis.fetch = mockFetch([]);
  const sent = [];
  env.QUEUE.sendBatch = async (msgs) => sent.push(...msgs);
  await run(env, '2026-11-03T22:30:00Z');
  assert.deepEqual(sent.map((m) => m.delaySeconds), Array.from({ length: 12 }, (_, k) => k * 30));
});
