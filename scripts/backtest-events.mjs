// 第 5 步回测：新闻事件的方向判断与冲击力度。
//   node scripts/backtest-events.mjs      （先用 curl 把 /api/events/<id> 存到 .backtest/ev/）
// 按事件出现的时间顺序逐个模拟，每个事件只用"它之前已核对完"的事件来决定规则，避免偷看未来。
import { readFileSync, readdirSync } from 'node:fs';
import { directionGate, shockBias } from '../src/market.js';

const DIR = new URL('../.backtest/ev/', import.meta.url);
const events = readdirSync(DIR)
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR))).event)
  .map((e) => ({ ...e, market: typeof e.market === 'string' ? JSON.parse(e.market) : e.market }))
  .filter((e) => e.market)
  .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));

const H72 = 72 * 3600 * 1000;
let base = { hit: 0, miss: 0 }, gated = { hit: 0, miss: 0, demoted: 0, demotedWouldHit: 0 };
let maeBefore = 0, maeAfter = 0, nShock = 0, biasBefore = 0, biasAfter = 0;
for (const e of events) {
  const t = Date.parse(e.first_seen_at);
  // 只有 72 小时核对窗口已结束的旧事件才算"已知历史"
  const known = events.filter((x) => Date.parse(x.first_seen_at) + H72 <= t);
  const record = known.flatMap((x) => x.market.instruments.filter((i) => ['hit', 'miss'].includes(i.verdict)).map((i) => ({ key: i.key, dir: i.expected, verdict: i.verdict })));
  for (const i of e.market.instruments) {
    if (!['hit', 'miss'].includes(i.verdict)) continue;
    base[i.verdict]++;
    if (directionGate(i.key, i.expected, record).demote) {
      gated.demoted++;
      if (i.verdict === 'hit') gated.demotedWouldHit++;
    } else gated[i.verdict]++;
  }
  const m = e.market;
  if (m.observed_score !== null && m.weight > 0) {
    const past = known.map((x) => x.market).filter((x) => x.observed_score !== null && x.weight > 0);
    const adj = Math.min(5, Math.max(0, m.model_score + shockBias(past)));
    maeBefore += Math.abs(m.model_score - m.observed_score); maeAfter += Math.abs(adj - m.observed_score);
    biasBefore += m.model_score - m.observed_score; biasAfter += adj - m.observed_score; nShock++;
  }
}
const rate = (s) => ((s.hit / (s.hit + s.miss)) * 100).toFixed(1) + '%';
console.log(`事件 ${events.length} 个`);
console.log(`方向判断  现有：${base.hit + base.miss} 次，命中率 ${rate(base)}`);
console.log(`          新规则：${gated.hit + gated.miss} 次，命中率 ${rate(gated)}（改为"不确定" ${gated.demoted} 次，其中本来能对的 ${gated.demotedWouldHit} 次）`);
console.log(`冲击力度  ${nShock} 个：偏差 ${(biasBefore / nShock).toFixed(2)} → ${(biasAfter / nShock).toFixed(2)}，平均误差 ${(maeBefore / nShock).toFixed(2)} → ${(maeAfter / nShock).toFixed(2)}`);
