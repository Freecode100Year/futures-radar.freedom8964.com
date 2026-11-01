import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReaction, observedShockScore, judgeDirection, blendWeight, calibrate, parseYahoo, parseTwelve } from '../src/market.js';
import { synthSeries } from './mock-env.js';

const H = 3600, D = 86400;
const now = 1_790_000_000;
const t0 = now - 4 * D;

test('跳变 +2% 被识别为显著（z>3），纯噪声不显著', () => {
  const jumpy = synthSeries({ start: now - 40 * D, end: now, sigma: 0.001, seed: 7, jumpAt: t0 + 1 * H, jump: 0.02 });
  const r = computeReaction(jumpy, t0, now);
  assert.equal(r.status, 'ok');
  assert.ok(r.z > 3, `z=${r.z}`);
  assert.ok(r.windows.h4.z > r.windows.h72.z, '同样的跳变，窗口越长 z 越小');
  assert.ok(r.chart.length <= 121);

  const calm = synthSeries({ start: now - 40 * D, end: now, sigma: 0.001, seed: 7 });
  assert.ok(Math.abs(computeReaction(calm, t0, now).z) < 3);
});

test('历史不足 / 尚无事件后数据 / 收益率用水平变化', () => {
  const short = synthSeries({ start: t0 - 10 * H, end: now });
  assert.equal(computeReaction(short, t0, now).status, 'insufficient_history');

  const before = synthSeries({ start: now - 40 * D, end: t0 });
  assert.equal(computeReaction(before, t0, now).status, 'waiting');

  const y = synthSeries({ start: now - 40 * D, end: now, base: 4.2, sigma: 0.0005, seed: 3 }).map((p) => ({ ...p }));
  for (const p of y) if (p.ts > t0) p.close += 0.15; // +15bp
  const r = computeReaction(y, t0, now, 'yield');
  assert.ok(Math.abs(r.latest_change - 0.15) < 0.05);
  assert.ok(r.z > 3);
});

test('实测分刻度与多资产联动', () => {
  assert.equal(observedShockScore([]), null);
  assert.equal(observedShockScore([0.5, -0.3]), 0);
  assert.equal(observedShockScore([-2.5]), 2);
  assert.equal(observedShockScore([2.1, -2.2, 2.0]), 3); // 三个资产 ≥2σ
  assert.equal(observedShockScore([8]), 5);
});

test('方向判定', () => {
  const r = (z) => ({ status: 'ok', z });
  assert.equal(judgeDirection('上涨', r(2.5)), 'hit');
  assert.equal(judgeDirection('下跌', r(2.5)), 'miss');
  assert.equal(judgeDirection('上涨', r(0.4)), 'insignificant');
  assert.equal(judgeDirection('波动加剧', r(-2.4)), 'hit');
  assert.equal(judgeDirection('不确定', r(5)), 'unscored');
  assert.equal(judgeDirection('上涨', { status: 'waiting' }), 'unscored');
});

test('融合权重随窗口完成度增加', () => {
  const mk = (h4, h24) => ({ status: 'ok', windows: { h4: { complete: h4, n: h4 ? 4 : 0 }, h24: { complete: h24, n: h24 ? 20 : 0 } } });
  assert.equal(blendWeight([mk(true, true)], true), 0.6);
  assert.equal(blendWeight([mk(true, true)], false), 0.3);
  assert.ok(Math.abs(blendWeight([mk(true, false)], true) - 0.24) < 1e-9);
  assert.equal(blendWeight([mk(false, false)], true), 0);
  assert.equal(blendWeight([{ status: 'waiting' }], true), 0);
});

test('calibrate：模型低估市场冲击时分数上调', () => {
  const firstSeen = new Date((t0 + 2 * H) * 1000).toISOString(); // 锚点 = 首见 - 2h = t0
  const prices = {
    brent: synthSeries({ start: now - 40 * D, end: now, sigma: 0.002, seed: 11, jumpAt: t0 + H, jump: 0.05 }),
    gold: synthSeries({ start: now - 40 * D, end: now, sigma: 0.001, seed: 12 }),
  };
  const analysis = {
    scores: { market_shock: { score: 1 }, military_escalation: { score: 3 }, systemic_contagion: { score: 3 }, geographic_scope: { score: 3 }, human_impact: { score: 1 }, persistence: { score: 2 }, escalation_momentum: { score: 3 } },
    impact: { assets: [{ asset: '布伦特', instrument: 'brent', direction: '上涨' }, { asset: '黄金', instrument: 'gold', direction: '上涨' }, { asset: '某股', instrument: 'other', direction: '下跌' }] },
  };
  const m = calibrate(analysis, firstSeen, prices, now);
  if (process.env.DEBUG) console.log(JSON.stringify({ obs: m.observed_score, w: m.weight, b: m.blended_score, sev: m.severity, ms: m.model_severity, inst: m.instruments.map((i) => [i.key, i.z, i.verdict, i.status]) }));
  assert.equal(m.linked, true);
  assert.equal(m.instruments.length, 2, 'other 不参与');
  assert.ok(m.observed_score >= 4, `observed=${m.observed_score}`);
  assert.equal(m.weight, 0.6);
  assert.ok(m.blended_score > 2.5 && m.blended_score < m.observed_score);
  assert.ok(m.severity > m.model_severity);
  assert.equal(m.final, true);
  assert.equal(m.instruments.find((i) => i.key === 'brent').verdict, 'hit');

  // 没有对应资产 → 用核心资产兜底，权重上限 0.3
  const m2 = calibrate({ scores: analysis.scores, impact: { assets: [] } }, firstSeen, prices, now);
  assert.equal(m2.linked, false);
  assert.deepEqual(m2.instruments.map((i) => i.key).sort(), ['brent', 'copper', 'es', 'gold', 'zn']);
  assert.ok(m2.weight <= 0.3);
});

test('解析 Yahoo（跳过空值）和 Twelve Data（UTC、升序）', () => {
  const y = parseYahoo({ chart: { result: [{ timestamp: [1, 2, 3], indicators: { quote: [{ close: [10, null, 12] }] } }] } });
  assert.deepEqual(y, [{ ts: 1, close: 10 }, { ts: 3, close: 12 }]);
  assert.throws(() => parseYahoo({ chart: { result: null, error: { description: 'No data found' } } }), /No data/);
  const t = parseTwelve({ status: 'ok', values: [{ datetime: '2026-10-30 11:00:00', close: '2' }, { datetime: '2026-10-30 10:00:00', close: '1' }] });
  assert.deepEqual(t.map((p) => p.close), [1, 2]);
  assert.equal(t[0].ts, Date.UTC(2026, 9, 30, 10) / 1000);
  assert.throws(() => parseTwelve({ status: 'error', message: 'quota' }), /quota/);
});
