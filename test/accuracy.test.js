// 准确性改进（v0.10）：区间自适应校准、方向概率校准、事件战绩门槛与冲击偏差修正
import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalScale } from '../src/outlook.js';
import { calibrationFactor, calibrateProb } from '../src/predict.js';
import { directionGate, shockBias, trackRecordBefore } from '../src/market.js';

// 简单的可复现随机数
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

test('intervalScale：样本不足时不改动', () => {
  assert.deepEqual(intervalScale([]), { k68: 1, k95: 1, n: 0 });
});

test('intervalScale：区间画窄了就放宽，画宽了就收窄', () => {
  const r = rng(1);
  // 真实波动 1.2，校准前半宽按 1.0 画 → 需要放宽约 1.2 倍
  const narrow = Array.from({ length: 300 }, () => ({ r: 1.2 * gauss(r), b68: 1, b95: 2 }));
  const k = intervalScale(narrow);
  assert.ok(k.k68 > 1.1 && k.k68 < 1.3, `k68=${k.k68}`);
  assert.ok(k.k95 > 1.1 && k.k95 < 1.3, `k95=${k.k95}`);
  const wide = Array.from({ length: 300 }, () => ({ r: 0.85 * gauss(r), b68: 1, b95: 2 }));
  assert.ok(intervalScale(wide).k68 < 0.95);
});

test('intervalScale：倍数有上下限', () => {
  const huge = Array.from({ length: 300 }, () => ({ r: 10, b68: 1, b95: 2 }));
  assert.equal(intervalScale(huge).k68, 1.6);
});

test('calibrationFactor：概率报得过于自信时收缩，样本少时不改', () => {
  assert.equal(calibrationFactor([]), 1);
  const r = rng(2);
  // 模型报的偏离只有一半是真的：真实上涨概率 = 0.5 + 0.5 × (p − 0.5)
  const hist = Array.from({ length: 1000 }, () => {
    const p = 0.4 + 0.2 * r();
    return { p, y: r() < 0.5 + 0.5 * (p - 0.5) ? 1 : 0 };
  });
  const c = calibrationFactor(hist);
  assert.ok(c > 0.2 && c < 0.85, `c=${c}`);
  const q = calibrateProb(0.6, hist);
  assert.ok(q > 0.5 && q < 0.6, `q=${q}`);
});

test('calibrateProb：结果限制在 25%–75%，空值原样返回', () => {
  const hist = Array.from({ length: 1000 }, (_, i) => ({ p: i % 2 ? 0.6 : 0.4, y: i % 2 }));
  assert.ok(calibrateProb(0.99, hist) <= 0.75);
  assert.equal(calibrateProb(null, hist), null);
});

test('directionGate：同品种同方向战绩差才降级，样本少不降级', () => {
  const bad = Array.from({ length: 20 }, (_, i) => ({ key: 'wti', dir: '上涨', verdict: i < 3 ? 'hit' : 'miss' }));
  assert.equal(directionGate('wti', '上涨', bad).demote, true);
  assert.equal(directionGate('wti', '下跌', bad).demote, false); // 方向不同
  assert.equal(directionGate('gold', '上涨', bad).demote, false); // 品种不同
  assert.equal(directionGate('wti', '上涨', bad.slice(0, 5)).demote, false); // 样本太少
  assert.equal(directionGate('wti', '不确定', bad).demote, false);
  const ok = Array.from({ length: 20 }, (_, i) => ({ key: 'wti', dir: '上涨', verdict: i < 10 ? 'hit' : 'miss' }));
  assert.equal(directionGate('wti', '上涨', ok).demote, false);
});

test('shockBias：模型系统性低估时往上修正，有上限', () => {
  assert.equal(shockBias([]), 0);
  const under = Array.from({ length: 100 }, () => ({ observed_score: 3, model_score: 2, weight: 0.6 }));
  const b = shockBias(under);
  assert.ok(b > 0.7 && b <= 1, `b=${b}`);
  const way = Array.from({ length: 100 }, () => ({ observed_score: 5, model_score: 0, weight: 0.6 }));
  assert.equal(shockBias(way), 1.5);
});

test('trackRecordBefore：只用 72 小时核对窗口已结束的事件，用原始核对结果', () => {
  const H = 3600 * 1000, t = Date.parse('2026-11-10T00:00:00Z');
  const mk = (ago, verdict, raw) => ({ t: t - ago * H, m: { observed_score: 2, model_score: 1, weight: 0.6, instruments: [{ key: 'wti', expected: '上涨', verdict, raw_verdict: raw }] } });
  const history = [mk(100, 'miss'), mk(80, 'demoted', 'hit'), mk(10, 'miss')];
  const { record } = trackRecordBefore(history, t);
  assert.equal(record.length, 2); // 10 小时前的还没核对完
  assert.deepEqual(record.map((r) => r.verdict), ['miss', 'hit']);
});
