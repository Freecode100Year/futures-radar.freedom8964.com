// 第 2 步回测：一小时涨跌方向的概率校准。
//   SAVE=1 node scripts/backtest-direction.mjs <品种...>   逐品种跑，结果存 .backtest/dir-*.json
//   MERGE=1 node scripts/backtest-direction.mjs            汇总
// 模拟线上：每个开盘整点用之前 70 天已收盘的小时线拟合，预测下一小时方向。核对规则与线上相同：
// 涨跌幅 < 0.1 倍预期波动算持平（不计）；|P−50%| < 2 个百分点算不表态（不计命中率）。
// 指标：Brier（越低越好，0.25 = 永远报 50%）、表态次数、命中率。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { INSTRUMENTS } from '../src/instruments.js';
import { isOpen } from '../src/sessions.js';
import { fitDirectionModel, applyDirectionModel, NO_CALL, PEERS } from '../src/predict.js';
import { calibrateProb } from '../src/predict.js';

const HOUR = 3600, DAY = 86400, HISTORY = 70 * DAY;
const only = process.argv.slice(2);
const DIR = new URL('../.backtest/', import.meta.url);

const VARIANTS = {
  'A 现有 λ=30': { lambda: 30 },
  'B λ=100': { lambda: 100 },
  'C λ=300': { lambda: 300 },
  'D λ=30+概率校准': { lambda: 30, calib: true },
  'E λ=100+概率校准': { lambda: 100, calib: true },
  'F λ=30+联动': { lambda: 30, peers: true },
  'G λ=100+联动': { lambda: 100, peers: true },
  'H λ=100+联动+校准': { lambda: 100, peers: true, calib: true },
};

let res = {};
if (!process.env.MERGE) {
  for (const inst of INSTRUMENTS.filter((i) => only.includes(i.key))) {
    const loadBars = (k) => JSON.parse(readFileSync(new URL(`${k}.60m.json`, DIR))).filter((b) => b.ts % HOUR === 0);
    const bars = loadBars(inst.key);
    const peerBars = (PEERS[inst.key] || []).map(loadBars);
    const peerLo = peerBars.map(() => 0), peerHi = peerBars.map(() => 0);
    const hist = Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, []]));
    const recentR = [];
    const models = {}; // 每天重新训练一次（线上每小时训练；权重在 70 天窗口里一天内变化很小）
    let lo = 0;
    for (let i = 1; i < bars.length - 1; i++) {
      const H = bars[i].ts + HOUR, next = bars[i + 1];
      if (next.ts !== H || bars[i].ts - bars[i - 1].ts !== HOUR) continue;
      const r = Math.log(next.close / bars[i].close);
      recentR.push(Math.log(bars[i].close / bars[i - 1].close));
      if (recentR.length > 500) recentR.shift();
      if (!isOpen(inst.spec.session, new Date((H + 1800) * 1000))) continue;
      while (bars[lo].ts < H - HISTORY) lo++;
      if (i - lo < 400) continue;
      const sigma = Math.sqrt(recentR.reduce((a, x) => a + x * x, 0) / recentR.length);
      const dir = Math.abs(r) < 0.1 * sigma ? 0 : r > 0 ? 1 : -1;
      const rows = bars.slice(lo, i + 1);
      const fromTs = bars[lo].ts;
      const peers = peerBars.map((pb, j) => {
        while (peerLo[j] < pb.length && pb[peerLo[j]].ts < fromTs) peerLo[j]++;
        while (peerHi[j] < pb.length && pb[peerHi[j]].ts <= bars[i].ts) peerHi[j]++;
        return pb.slice(peerLo[j], peerHi[j]);
      });
      const cache = {};
      for (const [name, v] of Object.entries(VARIANTS)) {
        const day = Math.floor(H / DAY);
        const mk = `${v.lambda}${v.peers ? 'p' : ''}`;
        const opt = { lambda: v.lambda, peers: v.peers ? peers : [] };
        if (!models[mk] || models[mk].day !== day) models[mk] = { day, m: fitDirectionModel(rows, opt) };
        const pred = (cache[mk] ||= applyDirectionModel(rows, H, models[mk].m, opt));
        if (!pred) continue;
        const p = v.calib ? calibrateProb(pred.p_up, hist[name]) : pred.p_up;
        ((res[name] ||= {})[inst.key] ||= []).push({ t: H, p, dir });
        if (dir !== 0) { hist[name].push({ p: pred.p_up, y: dir > 0 ? 1 : 0 }); if (hist[name].length > 1000) hist[name].shift(); }
      }
    }
  }
  writeFileSync(new URL(`dir-${only.join('_')}.json`, DIR), JSON.stringify(res));
  process.exit(0);
}

for (const f of readdirSync(DIR).filter((f) => f.startsWith('dir-'))) {
  for (const [v, byInst] of Object.entries(JSON.parse(readFileSync(new URL(f, DIR))))) Object.assign((res[v] ||= {}), byInst);
}
const summary = (xs) => {
  const ev = xs.filter((x) => x.dir !== 0);
  const brier = ev.reduce((a, x) => a + (x.p - (x.dir > 0 ? 1 : 0)) ** 2, 0) / ev.length;
  const calls = ev.filter((x) => Math.abs(x.p - 0.5) >= NO_CALL);
  const hits = calls.filter((x) => (x.p > 0.5 ? 1 : -1) === x.dir).length;
  return { n: ev.length, brier, calls: calls.length, rate: calls.length ? hits / calls.length : NaN };
};
const latest = Math.max(...Object.values(Object.values(res)[0]).flat().map((x) => x.t));
console.log('做法                 样本    Brier   表态次数  命中率 | 近6个月 Brier  命中率');
for (const [name, byInst] of Object.entries(res)) {
  const all = Object.values(byInst).flat();
  const s = summary(all), r6 = summary(all.filter((x) => x.t >= latest - 182 * DAY));
  console.log(`${name.padEnd(16)} ${String(s.n).padStart(7)}  ${s.brier.toFixed(4)}  ${String(s.calls).padStart(7)}   ${(s.rate * 100).toFixed(1)}% |    ${r6.brier.toFixed(4)}    ${(r6.rate * 100).toFixed(1)}%`);
}
console.log('\n各品种 Brier / 命中率（A 现有 → 最后一种做法）：');
const names = Object.keys(res);
for (const k of Object.keys(res[names[0]])) {
  const a = summary(res[names[0]][k]), b = summary(res[names.at(-1)][k]);
  console.log(`  ${k.padEnd(9)} ${a.brier.toFixed(4)} ${(a.rate * 100).toFixed(1)}%  →  ${b.brier.toFixed(4)} ${(b.rate * 100).toFixed(1)}%（表态 ${a.calls} → ${b.calls}）`);
}
