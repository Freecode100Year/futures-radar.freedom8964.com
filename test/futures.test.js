import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateContracts, curveMetrics, resolveCurve, updateCurves } from '../src/contracts.js';
import { pickContractSeries, robustSigma, computeReaction, fetchMarket } from '../src/market.js';
import { dailyCloses, computeStats, computeSnapshots, generateBrief } from '../src/futures.js';
import { byKey } from '../src/instruments.js';
import worker from '../src/index.js';
import { makeEnv, synthSeries } from './mock-env.js';

const NOV1 = Date.UTC(2026, 10, 1, 12) / 1000; // 2026-11-01
const DAY = 86400, H = 3600;

test('候选合约按各品种交割月周期生成', () => {
  const syms = (k) => candidateContracts(byKey[k], NOV1, 3).map((c) => c.symbol);
  assert.deepEqual(syms('gold'), ['GCZ26.CMX', 'GCG27.CMX', 'GCJ27.CMX']);
  assert.deepEqual(syms('es'), ['ESZ26.CME', 'ESH27.CME', 'ESM27.CME']);
  assert.deepEqual(syms('soybeans'), ['ZSX26.CBT', 'ZSF27.CBT', 'ZSH27.CBT']);
  assert.deepEqual(syms('wti'), ['CLX26.NYM', 'CLZ26.NYM', 'CLF27.NYM']);
  assert.equal(candidateContracts(byKey['wti'], NOV1, 3)[2].month, '2027-01');
});

test('期限结构指标：升水 / 贴水 / 展期收益', () => {
  const contango = curveMetrics([{ contract: 'NGZ26', month: '2026-12', close: 3.0 }, { contract: 'NGF27', month: '2027-01', close: 3.3 }, { contract: 'NGG27', month: '2027-02', close: 3.4 }]);
  assert.equal(contango.structure, '升水（Contango）');
  assert.equal(contango.spread_pct, 10);
  assert.equal(contango.roll_yield_ann_pct, -120);
  const back = curveMetrics([{ contract: 'CLZ26', month: '2026-12', close: 80 }, { contract: 'CLF27', month: '2027-01', close: 79 }]);
  assert.equal(back.structure, '贴水（Backwardation）');
  assert.ok(back.roll_yield_ann_pct > 0);
  assert.equal(curveMetrics([{ contract: 'x', month: '2026-12', close: 1 }]), null);
});

// 假的日线：CLX26 已到期（最后成交在 10 天前），CLZ26 成交量最大
const dailyFor = (symbol) => {
  const ages = { 'CLX26.NYM': 10 };
  const vols = { 'CLZ26.NYM': 300000, 'CLF27.NYM': 120000, 'CLG27.NYM': 50000 };
  const base = { 'CLZ26.NYM': 80, 'CLF27.NYM': 79.4, 'CLG27.NYM': 78.9, 'CLH27.NYM': 78.5, 'CLJ27.NYM': 78.2, 'CLK27.NYM': 78, 'CLX26.NYM': 81 };
  const end = NOV1 - (ages[symbol] || 0) * DAY;
  return Array.from({ length: 20 }, (_, i) => ({ ts: end - (19 - i) * DAY, close: (base[symbol] || 77) + i * 0.01, volume: vols[symbol] || 10000 }));
};

test('主力合约 = 前 3 个有效合约中成交量最大；跳过已到期合约', async () => {
  const { points, active } = await resolveCurve(byKey.wti, NOV1, { fetcher: async (s) => dailyFor(s) });
  assert.equal(points[0].contract, 'CLZ26', 'CLX26 已到期被跳过');
  assert.equal(points.length, 6);
  assert.equal(active.contract, 'CLZ26');
  assert.equal(curveMetrics(points).structure, '贴水（Backwardation）');
});

test('换月：主力切换时写入状态并回填新主力小时线；之后行情抓取改用主力合约', async () => {
  const env = makeEnv();
  const hourly = synthSeries({ start: NOV1 - 80 * DAY, end: NOV1, base: 80, seed: 5 }).map((p) => ({ ...p, volume: 1 }));
  const fetched = [];
  const fetcher = async (symbol, { interval }) => {
    fetched.push(`${symbol}@${interval}`);
    return interval === '1d' ? dailyFor(symbol) : hourly;
  };
  const r1 = await updateCurves(env, { group: 0, nowSec: NOV1, fetcher }); // group 0 = 第 0/4/8 个品种：wti、silver、wheat
  const wti = r1.find((x) => x.instrument === 'wti');
  assert.equal(wti.active, 'CLZ26');
  assert.equal(wti.rolled, true);
  assert.ok(fetched.includes('CLZ26.NYM@60m'), '回填新主力的小时线');
  assert.ok(env.DB._db.prepare("SELECT COUNT(*) n FROM prices WHERE instrument='wti' AND contract='CLZ26'").get().n > 1000);

  fetched.length = 0;
  const r2 = await updateCurves(env, { group: 0, nowSec: NOV1, fetcher });
  assert.equal(r2.find((x) => x.instrument === 'wti').rolled, false);
  assert.ok(!fetched.some((f) => f.endsWith('@60m')), '主力没变就不回填');

  // fetchMarket 用主力合约代码请求 Yahoo
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(decodeURIComponent(url));
    return Response.json({ chart: { result: [{ timestamp: [NOV1 + H], indicators: { quote: [{ close: [80.5], volume: [5] }] } }] } });
  };
  const rep = await fetchMarket(env, { group: 0 });
  assert.ok(urls.some((u) => u.includes('/CLZ26.NYM?')));
  assert.equal(rep.find((x) => x.instrument === 'wti').contract, 'CLZ26');
  assert.equal(urls.length, 3, 'group 0 只抓本组 3 个品种');
  assert.ok(!urls.some((u) => u.includes('/HG')), '铜不在 group 0');
});

test('按合约计算市场反应：换月价差不会被误判为异动', () => {
  const t0 = NOV1 - 4 * DAY;
  // 旧合约 X 到 t0+1h 为止；新合约 Z 全程报价，比旧合约高 3%（升水），自身没有异动
  const oldC = synthSeries({ start: t0 - 40 * DAY, end: t0 + H, base: 80, sigma: 0.001, seed: 2 }).map((p) => ({ ...p, contract: 'CLX26' }));
  const newC = synthSeries({ start: t0 - 40 * DAY, end: NOV1, base: 82.4, sigma: 0.001, seed: 3 }).map((p) => ({ ...p, contract: 'CLZ26' }));
  const { contract, series } = pickContractSeries([...oldC, ...newC], t0);
  assert.equal(contract, 'CLZ26');
  assert.ok(Math.abs(computeReaction(series, t0, NOV1).z) < 3);

  // 反例：天真地把旧合约和新合约拼成一条连续线 → 出现假的 3% 跳空
  const naive = [...oldC, ...newC.filter((p) => p.ts > t0 + H)];
  assert.ok(computeReaction(naive, t0, NOV1).z > 3, '拼接连续合约会制造假异动');
});

test('稳健波动率不被少数跳空抬高', () => {
  const xs = Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.001 : -0.001));
  xs[50] = 0.05;
  xs[120] = -0.04;
  assert.ok(robustSigma(xs) < 0.0016);
});

test('日线汇总与行情统计', () => {
  const s = synthSeries({ start: NOV1 - 100 * DAY, end: NOV1, base: 2000, sigma: 0.002, seed: 9 });
  const d = dailyCloses(s);
  assert.ok(d.length >= 100 && d.length <= 102);
  const st = computeStats(d);
  assert.ok(st.vol_20d_ann_pct > 0);
  assert.ok(st.range_3m.position_pct >= 0 && st.range_3m.position_pct <= 100);
  assert.match(st.trend, /均线/);
  assert.equal(computeStats(d.slice(0, 3)), null);
});

test('快照 → 每日 AI 解读 → 品种 API；解读只能引用真实事件', async () => {
  const env = makeEnv({ ZHIPU_API_KEY: 'z', CHAIN_BRIEF: 'glm' });
  const now = Math.floor(Date.now() / 1000);
  const pts = synthSeries({ start: now - 100 * DAY, end: now, base: 2650, sigma: 0.0015, seed: 4 });
  const stmt = env.DB._db.prepare("INSERT INTO prices (instrument, contract, ts, close) VALUES ('gold', 'GCZ26', ?, ?)");
  for (const p of pts) stmt.run(p.ts, p.close);
  env.DB._db.prepare("INSERT INTO curves (instrument, day, payload) VALUES ('gold', '2026-11-01', ?)").run(JSON.stringify({
    points: [{ contract: 'GCZ26', month: '2026-12', close: 2650 }, { contract: 'GCG27', month: '2027-02', close: 2670 }],
    metrics: curveMetrics([{ contract: 'GCZ26', month: '2026-12', close: 2650 }, { contract: 'GCG27', month: '2027-02', close: 2670 }]),
  }));
  // 一个已分析事件，资产里有黄金
  const iso = new Date().toISOString();
  env.DB._db.prepare("INSERT INTO events (id, title, title_zh, first_seen_at, last_updated_at, status, severity, level) VALUES (7, 't', '中东局势升级', ?, ?, 'analyzed', 62, '严重')").run(iso, iso);
  env.DB._db.prepare("INSERT INTO analyses (event_id, created_at, payload) VALUES (7, ?, ?)").run(iso, JSON.stringify({ impact: { assets: [{ asset: '黄金', instrument: 'gold', direction: '上涨', horizon: '数周', rationale: '避险' }] } }));

  await computeSnapshots(env, now);
  let prompt = '';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    prompt = body.messages[1].content;
    return Response.json({ model: 'glm-4.7-flash', choices: [{ message: { content: JSON.stringify({
      headline: '避险需求推升金价', summary: '……', price_action: '上行',
      drivers: [
        { factor: '中东局势', effect: '利多', strength: '强', basis: '事件', event_ids: [7, 999] },
        { factor: '升水结构', effect: '中性', strength: '弱', basis: '期限结构' },
      ],
      term_structure: '温和升水，反映持有成本', risks: ['美元走强'], watch: [{ item: '美联储议息', why: '利率预期' }],
    }) } }] });
  };
  const r = await generateBrief(env, 'gold', now);
  assert.equal(r.model, 'glm:glm-4.7-flash');
  assert.match(prompt, /\[E7\] 中东局势升级/);
  assert.match(prompt, /升水（Contango）/);
  assert.match(prompt, /20日年化波动率/);

  const list = await (await worker.fetch(new Request('https://x/api/instruments'), env, {})).json();
  assert.equal(list.length, 12);
  const gold = list.find((i) => i.key === 'gold');
  assert.equal(gold.contract, 'GCZ26');
  assert.equal(gold.spark.length, 30);
  assert.equal(gold.brief.headline, '避险需求推升金价');
  assert.equal(gold.structure, '升水（Contango）');
  assert.equal(list.find((i) => i.key === 'wheat').stats, null);

  const detail = await (await worker.fetch(new Request('https://x/api/instruments/gold'), env, {})).json();
  assert.deepEqual(detail.brief.drivers[0].event_ids, [7], '编造的事件编号 999 被删掉');
  assert.equal(detail.events[0].id, 7);
  assert.ok(detail.snapshot.daily.length >= 89);
  assert.equal((await worker.fetch(new Request('https://x/api/instruments/nope'), env, {})).status, 404);

  // 没有行情的品种不调用模型
  assert.equal((await generateBrief(env, 'wheat', now)).skipped, '行情数据不足');
});
