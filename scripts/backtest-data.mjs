// 下载回测用的历史行情（Yahoo 连续合约），缓存到 .backtest/ 目录（不提交）。
//   node scripts/backtest-data.mjs            小时线 730 天 + 5 分钟线 60 天
// 输出每个品种：.backtest/<key>.60m.json、.backtest/<key>.5m.json，格式 [{ts, open, high, low, close, volume}]
import { mkdirSync, writeFileSync } from 'node:fs';
import { INSTRUMENTS } from '../src/instruments.js';

const DIR = new URL('../.backtest/', import.meta.url);
mkdirSync(DIR, { recursive: true });

async function chart(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (backtest)' } });
    if (res.ok) {
      const r = (await res.json()).chart.result[0];
      const q = r.indicators.quote[0];
      return r.timestamp
        .map((ts, i) => ({ ts, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
        .filter((b) => b.close > 0);
    }
    await new Promise((s) => setTimeout(s, 2000 * attempt));
  }
  throw new Error(`${symbol} ${interval}: download failed`);
}

for (const inst of INSTRUMENTS) {
  const h = await chart(inst.yahoo, '60m', '730d');
  writeFileSync(new URL(`${inst.key}.60m.json`, DIR), JSON.stringify(h));
  const m = await chart(inst.yahoo, '5m', '60d');
  writeFileSync(new URL(`${inst.key}.5m.json`, DIR), JSON.stringify(m));
  console.log(`${inst.key.padEnd(9)} 60m ${h.length} bars (${new Date(h[0].ts * 1000).toISOString().slice(0, 10)} →)  5m ${m.length} bars`);
  await new Promise((s) => setTimeout(s, 500));
}
