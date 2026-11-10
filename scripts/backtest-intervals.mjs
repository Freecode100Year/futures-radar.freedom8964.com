// 第 1 步回测：一小时 68% / 95% 区间的覆盖率。
//   node scripts/backtest-intervals.mjs [品种...]
// 模拟线上流程：每个开盘整点 H，用 H 之前 70 天的小时线算区间，基准价 = H 时的收盘，核对 H+1 小时的收盘。
// 比较几种做法；好的做法：覆盖率接近 68% / 95%（各种行情下都接近），区间分数（Winkler，越低越好）更低。
import { readFileSync } from 'node:fs';
import { INSTRUMENTS } from '../src/instruments.js';
import { isOpen } from '../src/sessions.js';
import { hourStats, intervalScale } from '../src/outlook.js';

const HOUR = 3600, DAY = 86400, HISTORY = 70 * DAY;
const only = process.argv.slice(2);
const load = (k) => JSON.parse(readFileSync(new URL(`../.backtest/${k}.60m.json`, import.meta.url))).filter((b) => b.ts % HOUR === 0);

const rmsOf = (xs) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
const quantile = (s, q) => { const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };

// 各做法：输入 stats（含 raw_regime）和该品种过去已核对窗口的标准化误差，返回 { sig 乘数, q68, q95 }
const VARIANTS = {
  'A 现有做法': (st) => ({ m: st.regime, q68: st.q68, q95: st.q95 }),
  'B 放宽上下限': (st) => ({ m: Math.min(2.5, Math.max(0.85, st.raw_regime)), q68: st.q68, q95: st.q95 }),
  'C 状态向1收缩': (st) => ({ m: Math.min(2.5, Math.max(0.85, Math.sqrt(0.5 * st.raw_regime ** 2 + 0.5))), q68: st.q68, q95: st.q95 }),
  'D C+自适应校准': (st, past) => {
    const m = Math.min(2.5, Math.max(0.85, Math.sqrt(0.5 * st.raw_regime ** 2 + 0.5)));
    const s = intervalScale(past);
    return { m, q68: st.q68 * s.k68, q95: st.q95 * s.k95, b68: st.q68, b95: st.q95 };
  },
  'E B+自适应校准': (st, past) => {
    const m = Math.min(2.5, Math.max(0.85, st.raw_regime));
    const s = intervalScale(past);
    return { m, q68: st.q68 * s.k68, q95: st.q95 * s.k95, b68: st.q68, b95: st.q95 };
  },
};

let res = {};
for (const inst of process.env.MERGE ? [] : INSTRUMENTS.filter((i) => !only.length || only.includes(i.key))) {
  const bars = load(inst.key);
  const past = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, []]));
  let lo = 0;
  for (let i = 1; i < bars.length - 1; i++) {
    const H = bars[i].ts + HOUR; // 第 i 根K线收盘时刻 = 窗口开始
    const next = bars[i + 1];
    if (next.ts !== H) continue; // 下一小时必须连续（不跨休市）
    if (!isOpen(inst.spec.session, new Date((H + 1800) * 1000))) continue;
    while (bars[lo].ts < H - HISTORY) lo++;
    if (i - lo < 300) continue;
    const st = hourStats(bars.slice(lo, i + 1));
    if (!st) continue;
    const base = bars[i].close, actual = next.close;
    const r = Math.log(actual / base);
    const hSig = st.hour[etHourOf(H)].sigma;
    for (const [name, fn] of Object.entries(VARIANTS)) {
      const v = fn(st, past[name]);
      const sig = hSig * v.m;
      const z = Math.abs(r) / sig;
      const hit68 = z <= v.q68, hit95 = z <= v.q95;
      // Winkler 区间分数（按收益率、以百分比计）：宽度 + 落在区间外时 2/α × 超出部分
      const w = (q, a) => 2 * q * sig + (z > q ? (2 / a) * (Math.abs(r) - q * sig) : 0);
      const o = ((res[name] ||= {})[inst.key] ||= []);
      o.push({ t: H, hit68, hit95, regime: st.raw_regime, s68: w(v.q68, 0.32) * 100, s95: w(v.q95, 0.05) * 100 });
      past[name].push({ r, b68: (v.b68 ?? v.q68) * sig, b95: (v.b95 ?? v.q95) * sig });
      if (past[name].length > 400) past[name].shift();
    }
  }
}

import { etParts } from '../src/sessions.js';
import { writeFileSync, readdirSync } from 'node:fs';
if (process.env.SAVE) { writeFileSync(new URL(`../.backtest/iv-${only.join('_')}.json`, import.meta.url), JSON.stringify(res)); process.exit(0); }
if (process.env.MERGE) {
  res = {};
  for (const f of readdirSync(new URL('../.backtest/', import.meta.url)).filter((f) => f.startsWith('iv-'))) {
    const part = JSON.parse(readFileSync(new URL(`../.backtest/${f}`, import.meta.url)));
    for (const [v, byInst] of Object.entries(part)) Object.assign((res[v] ||= {}), byInst);
  }
}
function etHourOf(sec) { return Math.floor(etParts(new Date(sec * 1000)).minute / 60); }

const pct = (xs, f) => (xs.length ? (xs.filter(f).length / xs.length * 100).toFixed(1) : '—');
const avg = (xs, f) => (xs.length ? (xs.reduce((a, x) => a + f(x), 0) / xs.length).toFixed(3) : '—');
const cutoff = Object.values(Object.values(res)[0]).flat().reduce((m, x) => Math.max(m, x.t), 0) - 60 * DAY;
console.log('做法              样本   68%覆盖  95%覆盖 | 平静时68% 剧烈时68% | 近60天68% 近60天95% | 区间分数68 区间分数95');
for (const [name, byInst] of Object.entries(res)) {
  const all = Object.values(byInst).flat();
  const calm = all.filter((x) => x.regime < 0.85), hot = all.filter((x) => x.regime > 1.4), rec = all.filter((x) => x.t >= cutoff);
  console.log(`${name.padEnd(14)} ${String(all.length).padStart(7)}   ${pct(all, (x) => x.hit68).padStart(5)}   ${pct(all, (x) => x.hit95).padStart(5)}  |   ${pct(calm, (x) => x.hit68).padStart(5)}     ${pct(hot, (x) => x.hit68).padStart(5)}   |   ${pct(rec, (x) => x.hit68).padStart(5)}    ${pct(rec, (x) => x.hit95).padStart(5)}   |   ${avg(all, (x) => x.s68)}      ${avg(all, (x) => x.s95)}`);
}
console.log('\n各品种 68% 覆盖（A 现有 → D 新做法）：');
const names = Object.keys(res);
for (const k of Object.keys(res[names[0]])) console.log(`  ${k.padEnd(9)} ${pct(res[names[0]][k], (x) => x.hit68)} → ${pct(res[names.at(-1)][k], (x) => x.hit68)}   95%: ${pct(res[names[0]][k], (x) => x.hit95)} → ${pct(res[names.at(-1)][k], (x) => x.hit95)}`);
