import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, parseGdelt } from '../src/rss.js';
import { computeSeverity, levelOf, DIMENSIONS } from '../src/rubric.js';
import { postProcess } from '../src/analyze.js';

test('RSS 2.0：CDATA、实体、日期', () => {
  const xml = `<rss><channel><item><title><![CDATA[Oil &amp; gas: Brent jumps]]></title>
    <link>https://x.com/a?b=1&amp;c=2</link><description>&lt;p&gt;Prices rose 5%&lt;/p&gt;</description>
    <pubDate>Sat, 31 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  const [it] = parseFeed(xml);
  assert.equal(it.title, 'Oil & gas: Brent jumps');
  assert.equal(it.url, 'https://x.com/a?b=1&c=2');
  assert.equal(it.summary, 'Prices rose 5%');
  assert.equal(it.published_at, '2026-10-31T10:00:00.000Z');
});

test('Atom：alternate 链接', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fed holds rates</title>
    <link rel="alternate" href="https://fed.gov/x"/><updated>2026-10-30T18:00:00Z</updated><summary>Statement</summary></entry></feed>`;
  const [it] = parseFeed(xml);
  assert.equal(it.url, 'https://fed.gov/x');
  assert.equal(it.published_at, '2026-10-30T18:00:00.000Z');
});

test('GDELT 日期格式', () => {
  const [it] = parseGdelt({ articles: [{ url: 'u', title: 't', seendate: '20261031T120500Z', domain: 'ex.com' }] });
  assert.equal(it.published_at, '2026-10-31T12:05:00.000Z');
  assert.equal(it.source_name, 'ex.com');
});

test('严重性：全 0 / 全 5 / 权重和为 1', () => {
  const all = (n) => Object.fromEntries(Object.keys(DIMENSIONS).map((k) => [k, { score: n }]));
  assert.equal(computeSeverity(all(0)), 0);
  assert.equal(computeSeverity(all(5)), 100);
  assert.equal(computeSeverity(all(3)), 60);
  const w = Object.values(DIMENSIONS).reduce((s, d) => s + d.weight, 0);
  assert.ok(Math.abs(w - 1) < 1e-9);
  assert.equal(levelOf(60), '严重');
  assert.equal(levelOf(19.9), '低');
});

test('校验：丢弃无信源条目，核对引文', () => {
  const sources = [{ sid: 1, article: { id: 7, title: 'T', content: 'The navy said it "seized the vessel" on Tuesday.', url: 'u' } }];
  const out = postProcess(
    {
      scores: { military_escalation: { score: 3, rationale: 'r', source_ids: [1, 5] } },
      timeline: [
        { date: '2026-10-27', event: 'a', source_ids: [1], quote: 'seized the vessel on Tuesday', status: '单一信源' },
        { date: '2026-10-28', event: 'b', source_ids: [1], quote: 'missiles were launched at dawn', status: '单一信源' },
        { date: '2026-10-29', event: 'c', source_ids: [9], quote: 'x', status: '单一信源' },
        { date: '十月', event: 'd', source_ids: [1], quote: 'x', status: '单一信源' },
      ],
    },
    sources,
  );
  assert.equal(out.timeline.length, 2);
  assert.equal(out.timeline[0].verified, true);
  assert.equal(out.timeline[1].verified, false);
  assert.equal(out.quality.dropped_timeline_items, 2);
  assert.deepEqual(out.scores.military_escalation.source_ids, [1]);
  assert.equal(out.scores.market_shock.score, 0); // 缺失维度补 0
});
