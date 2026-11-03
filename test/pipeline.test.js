// 端到端：采集 → 聚类 → 分诊 → 深度分析 → API，全部使用模拟绑定和模拟 Claude
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv, drainQueue, synthSeries } from './mock-env.js';

const h = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600e3).toUTCString();
const rss = (items) =>
  `<rss><channel>${items.map((i) => `<item><title>${i.t}</title><link>${i.u}</link><description>${i.d}</description><pubDate>${i.p}</pubDate></item>`).join('')}</channel></rss>`;

const FEEDS = {
  'https://feed-a.test/rss': rss([
    { t: 'Iran navy seizes tanker near Strait of Hormuz', u: 'https://a.test/1', d: 'Iranian navy seized an oil tanker in the Strait of Hormuz on Tuesday.', p: h(30) },
    { t: 'Football club wins league title', u: 'https://a.test/2', d: 'Fans celebrate championship victory parade.', p: h(5) },
  ]),
  'https://feed-b.test/rss': rss([
    { t: 'Hormuz tanker seizure: Iran navy seizes oil tanker in strait', u: 'https://b.test/1', d: 'Brent crude prices jumped after the Iran navy seized tanker in Hormuz strait.', p: h(20) },
  ]),
};

let claudeCalls = [];
const claudeModels = [];
function claudeMock(body) {
  claudeCalls.push(body.tools[0].name);
  const text = body.messages[0].content;
  if (body.tools[0].name === 'triage') {
    const hormuz = /hormuz/i.test(text);
    return { relevant: hormuz, rough_severity: hormuz ? 4 : 0, sectors: hormuz ? ['能源'] : [], domains: hormuz ? ['军事', '能源'] : [], title_zh: hormuz ? '伊朗在霍尔木兹海峡扣押油轮' : '足球' };
  }
  const scores = {
    military_escalation: { score: 3, rationale: '扣押船只', source_ids: [1] },
    market_shock: { score: 3, rationale: '油价上涨', source_ids: [2] },
    systemic_contagion: { score: 4, rationale: '关键海峡', source_ids: [1, 2] },
    geographic_scope: { score: 3, rationale: '区域', source_ids: [1] },
    supply_demand: { score: 3, rationale: '海峡通行受阻', source_ids: [1] },
    persistence: { score: 2, rationale: '数周', source_ids: [] },
    escalation_momentum: { score: 3, rationale: '缓慢升级', source_ids: [2] },
  };
  return {
    title_zh: '伊朗在霍尔木兹海峡扣押油轮',
    summary_zh: '伊朗海军扣押油轮，油价上涨。',
    domains: ['军事', '能源', '地缘政治'],
    scores,
    confidence: 0.7,
    impact: { regions: [{ name: '霍尔木兹海峡', lat: 26.5, lon: 56.3, role: '发源地' }], sectors: [{ name: '航运', direction: '下跌' }], assets: [{ asset: '布伦特原油', instrument: 'brent', direction: '上涨', horizon: '数日', rationale: '供应担忧' }, { asset: '黄金', instrument: 'gold', direction: '上涨', horizon: '数周', rationale: '避险' }] },
    transmission_chain: [{ from: '扣押油轮', to: '油价', mechanism: '供应风险溢价', lag: '即时' }],
    timeline: [
      { date: '2026-10-27', date_precision: '约略', event: '伊朗海军扣押油轮', source_ids: [1], quote: 'seized an oil tanker in the Strait of Hormuz', status: '已证实' },
      { date: '2026-10-28', date_precision: '约略', event: '编造的条目', source_ids: [42], quote: 'nonexistent', status: '单一信源' },
    ],
    scenarios: [{ name: '降温', likelihood: '中', triggers: '释放油轮', market_implication: '油价回落' }],
    watch_indicators: ['布伦特-WTI 价差'],
  };
}

// 合成行情：布伦特在事件锚点（首篇报道前 2 小时）之后跳涨 4%，其余品种只有噪声
const NOW = Math.floor(Date.now() / 1000);
const ANCHOR = NOW - 32 * 3600;
function yahooMock(symbol) {
  const seed = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0);
  const pts = synthSeries({ start: NOW - 60 * 86400, end: NOW, sigma: 0.002, seed, jumpAt: symbol === 'BZ=F' ? ANCHOR + 3600 : null, jump: 0.04 });
  return { chart: { result: [{ timestamp: pts.map((p) => p.ts), indicators: { quote: [{ close: pts.map((p) => p.close) }] } }] } };
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://open.bigmodel.cn/api/paas/v4/chat/completions') {
    const body = JSON.parse(init.body);
    const name = /分诊员/.test(body.messages[0].content) ? 'triage' : 'event_analysis';
    claudeModels.push(`${name}:${body.model}`);
    const out = claudeMock({ tools: [{ name }], messages: [{ content: body.messages[1].content }] });
    return Response.json({ model: body.model, choices: [{ message: { content: '```json\n' + JSON.stringify(out) + '\n```' } }], usage: { prompt_tokens: 12000, completion_tokens: 3000 } });
  }
  const ym = url.match(/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/([^?]+)/);
  if (ym) return ym[1].includes('ZW') ? new Response('rate limited', { status: 429 }) : Response.json(yahooMock(decodeURIComponent(ym[1])));
  if (url === 'https://api.anthropic.com/v1/messages') {
    const body = JSON.parse(init.body);
    const usage = body.tools[0].name === 'triage' ? { input_tokens: 2000, output_tokens: 150 } : { input_tokens: 15000, output_tokens: 4000, cache_read_input_tokens: 3000 };
    claudeModels.push(`${body.tools[0].name}:${body.model}`);
    return Response.json({ content: [{ type: 'tool_use', name: body.tools[0].name, input: claudeMock(body) }], usage });
  }
  if (FEEDS[url]) return new Response(FEEDS[url], { headers: { 'content-type': 'application/rss+xml' } });
  if (url.includes('broken')) return new Response('nope', { status: 503 });
  return new Response('<html><p>short</p></html>', { headers: { 'content-type': 'text/html' } });
};

const call = (env, path, opts = {}) => worker.fetch(new Request('https://radar.test' + path, opts), env, {});
const admin = { method: 'POST', headers: { authorization: 'Bearer secret' } };

test('完整流程', async () => {
  // 调用链：分诊 Claude Haiku → GLM；重要事件 Claude Sonnet → GLM（便于断言付费/免费两条路径）
  const env = makeEnv({ ZHIPU_API_KEY: 'z', CHAIN_TRIAGE: 'claude-haiku,glm', CHAIN_ANALYSIS: 'glm', CHAIN_ANALYSIS_IMPORTANT: 'claude-sonnet,glm' });
  assert.equal((await call(env, '/api/admin/init', { method: 'POST' })).status, 401);

  // 用测试信源替换默认信源
  for (const [i, url] of [...Object.keys(FEEDS), 'https://broken.test/rss'].entries()) {
    await env.DB.prepare('INSERT INTO sources (name, url) VALUES (?, ?)').bind('S' + i, url).run();
  }

  const ing = await (await call(env, '/api/admin/ingest', admin)).json();
  assert.equal(ing.new_articles, 3);
  assert.ok(ing.sources.some((s) => s.error === 'HTTP 503'));

  // 再采集一次：去重
  assert.equal((await (await call(env, '/api/admin/ingest', admin)).json()).new_articles, 0);
  env.QUEUE._q.length = 3; // 只保留第一次的 3 条

  await drainQueue(worker, env);
  const events = env.DB._db.prepare('SELECT id, title, article_count FROM events ORDER BY id').all();
  assert.equal(events.length, 2, '霍尔木兹两篇应合并，足球单独成事件');
  const hormuz = events.find((e) => /Hormuz/.test(e.title));
  assert.equal(hormuz.article_count, 2);

  // 行情回填：小麦模拟限流且没有 Twelve Data 备用代码 → 报错但不影响其他品种
  const bf = await (await call(env, '/api/admin/market/backfill', admin)).json();
  assert.equal(bf.length, 12);
  assert.match(bf.find((b) => b.instrument === 'wheat').error, /429/);
  assert.equal(bf.find((b) => b.instrument === 'brent').provider, 'yahoo');
  assert.equal(bf.find((b) => b.instrument === 'brent').contract, 'cont', '尚未识别主力合约时用连续合约');
  const mk = await (await call(env, '/api/market')).json();
  assert.ok(mk.find((m) => m.key === 'brent').bars > 1000);

  await worker.scheduled({ cron: 'test' }, env, {}); // 采集(无新增) + 调度 + 一组行情
  await drainQueue(worker, env);
  assert.deepEqual(claudeCalls.sort(), ['event_analysis', 'triage', 'triage']);

  const list = await (await call(env, '/api/events')).json();
  assert.equal(list.length, 1, '不相关事件不应出现在列表');
  assert.equal(list[0].title, '伊朗在霍尔木兹海峡扣押油轮');
  assert.equal(list[0].level, '严重');
  assert.deepEqual(list[0].sectors.sort(), ['能源', '金属']);
  assert.equal(list[0].summary, '伊朗海军扣押油轮，油价上涨。');

  const detail = await (await call(env, `/api/events/${hormuz.id}`)).json();
  assert.equal(detail.analysis.timeline.length, 1, '无效信源编号的条目被丢弃');
  assert.equal(detail.analysis.timeline[0].verified, true);
  assert.equal(detail.analysis.sources.length, 2);
  assert.deepEqual(detail.history.map((h) => h.source), ['analysis', 'market']);
  const m = detail.event.market;
  assert.equal(detail.event.model_severity, 61);
  assert.ok(detail.event.severity > 65, String(detail.event.severity));
  assert.equal(m.observed_score, 5);
  assert.equal(m.weight, 0.6);
  assert.equal(m.blended_score, 4.2);
  assert.equal(m.instruments.find((i) => i.key === 'brent').verdict, 'hit');
  assert.equal(m.instruments.find((i) => i.key === 'gold').verdict, 'insignificant');

  // 重复校准：分数不变时不再写日志
  await call(env, '/api/admin/calibrate', admin);
  assert.equal((await (await call(env, `/api/events/${hormuz.id}`)).json()).history.length, 2);

  const cal = await (await call(env, '/api/calibration')).json();
  assert.equal(cal.direction.hits, 1);
  assert.equal(cal.direction.hit_rate, 1);
  assert.equal(cal.market_shock.bias, -2, '模型 3 分 vs 实测 5 分 → 偏差 -2（模型低估）');
  assert.equal(detail.articles.length, 2);

  // 模型分级：分诊粗分 4 → 深度分析用 Sonnet
  assert.ok(claudeModels.includes('event_analysis:claude-sonnet-5-5'));
  assert.equal(detail.analysis.model, 'claude-sonnet:claude-sonnet-5-5');

  // 记账：2 次分诊 (Haiku) + 1 次分析 (Sonnet)
  const usage = await (await call(env, '/api/usage')).json();
  const expected = 2 * (2000 * 0.1 + 150 * 0.5) / 1e6 + (15000 * 2 + 4000 * 10 + 3000 * 0.1) / 1e6;
  assert.ok(Math.abs(Object.values(usage.by_day)[0] - expected) < 1e-4, JSON.stringify(usage.by_day));

  // 行情增量写入：再抓一次，每个品种只重写最近 3 小时（小时线最多 4 根），而不是整个 5 天
  const again = await (await call(env, '/api/admin/market/fetch', admin)).json();
  assert.ok(again.filter((r) => !r.error).every((r) => r.written <= 4), JSON.stringify(again.map((r) => r.written)));

  // 重新分析门槛：新增 1 篇不触发，累计新增 3 篇才触发
  const addArticle = (n) => env.DB.prepare(
    "INSERT INTO articles (url, source_name, title, published_at, fetched_at, event_id, processed) VALUES (?, 'X', 'more', datetime('now'), datetime('now'), ?, 1)",
  ).bind(`https://more.test/${n}`, hormuz.id).run();
  const bump = () => env.DB.prepare('UPDATE events SET article_count = article_count + 1, needs_analysis = 1 WHERE id = ?').bind(hormuz.id).run();
  await addArticle(1); await bump();
  const { scheduleAnalyses } = await import('../src/pipeline.js');
  assert.equal(await scheduleAnalyses(env), 0, '只多 1 篇，不重新分析');
  await env.DB.prepare('UPDATE events SET needs_analysis = 1 WHERE id = ?').bind(hormuz.id).run();
  await addArticle(2); await bump(); await addArticle(3); await bump();
  assert.equal(await scheduleAnalyses(env), 1, '累计多 3 篇，重新分析');

  // 超出每日预算 → 路由跳过付费模型，分诊和分析都改走免费的 GLM
  env.QUEUE._q.length = 0;
  env.DAILY_BUDGET_USD = '0.01';
  claudeModels.length = 0;
  const forced = await (await call(env, `/api/admin/analyze/${hormuz.id}`, admin)).json();
  assert.deepEqual(claudeModels, ['triage:glm-4.7-flash', 'event_analysis:glm-4.7-flash']);
  assert.equal(forced.model, 'glm:glm-4.7-flash');
  assert.ok(forced.attempts.some((a) => a.provider === 'claude-sonnet' && /预算/.test(a.skipped)));
  const glmDetail = await (await call(env, `/api/events/${hormuz.id}`)).json();
  assert.equal(glmDetail.analysis.timeline.length, 1, '代码围栏里的 JSON 也能正确解析并校验');

  // GLM 也在冷却 → 所有模型失败，抛错交给队列重试
  env.DB._db.prepare("INSERT OR REPLACE INTO provider_state (provider, cooldown_until) VALUES ('glm', '2999-01-01')").run();
  const { runAnalysis } = await import('../src/pipeline.js');
  await assert.rejects(runAnalysis(env, hormuz.id, { force: true }), /所有模型都失败/);
  env.DB._db.prepare("DELETE FROM provider_state").run();
  env.DAILY_BUDGET_USD = '2';

  const st = await (await call(env, '/api/admin/llm', { headers: { authorization: 'Bearer secret' } })).json();
  assert.ok(st.providers.find((p) => p.id === 'glm').today.calls >= 2);
  assert.equal((await call(env, '/api/admin/llm')).status, 401);

  // 清理：保留期设为 -1 天 → 所有正文被清除，标题保留
  await env.DB.prepare("UPDATE articles SET content = 'body'").run();
  const { purgeOld } = await import('../src/pipeline.js');
  await purgeOld({ ...env, CONTENT_RETENTION_DAYS: '-1' });
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM articles WHERE content IS NOT NULL').get().n, 0);
  assert.ok(env.DB._db.prepare('SELECT COUNT(*) AS n FROM articles').get().n >= 5);

  const filtered = await (await call(env, '/api/events?sector=能源&min=50')).json();
  assert.equal(filtered.length, 1);
  assert.equal((await (await call(env, '/api/events?sector=农产品')).json()).length, 0);
});
