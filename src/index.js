import { ingest, processArticles, scheduleAnalyses, runAnalysis, purgeOld } from './pipeline.js';
import { DEFAULT_SOURCES } from './sources.js';
import { fetchMarket, calibrateEvents, calibrationStats } from './market.js';
import { INSTRUMENTS } from './instruments.js';
import { selfTest, status as llmStatus } from './llm.js';
import { updateCurves } from './contracts.js';
import { computeSnapshots, generateBrief, listInstruments, getInstrument } from './futures.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const parseJson = (s, d = null) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

function isAdmin(req, env) {
  const h = req.headers.get('authorization') || '';
  return env.ADMIN_TOKEN && h === `Bearer ${env.ADMIN_TOKEN}`;
}

async function listEvents(env, url) {
  const min = Number(url.searchParams.get('min') || 0);
  const domain = url.searchParams.get('domain');
  const sector = url.searchParams.get('sector');
  const includeWatch = url.searchParams.get('watch') !== '0';
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  const statuses = includeWatch ? "('analyzed','watch')" : "('analyzed')";

  let sql = `SELECT e.id, COALESCE(e.title_zh, e.title) AS title, e.severity, e.level, e.confidence, e.domains, e.sectors,
      e.article_count, e.first_seen_at, e.last_updated_at, e.status,
      (SELECT json_extract(a.payload, '$.summary_zh') FROM analyses a WHERE a.event_id = e.id ORDER BY a.created_at DESC LIMIT 1) AS summary
    FROM events e WHERE e.status IN ${statuses} AND COALESCE(e.severity, 0) >= ?`;
  const binds = [min];
  if (domain) {
    sql += ' AND EXISTS (SELECT 1 FROM json_each(e.domains) WHERE value = ?)';
    binds.push(domain);
  }
  if (sector) {
    sql += ' AND EXISTS (SELECT 1 FROM json_each(e.sectors) WHERE value = ?)';
    binds.push(sector);
  }
  sql += ' ORDER BY e.last_updated_at DESC LIMIT ?';
  binds.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results.map((r) => ({ ...r, domains: parseJson(r.domains, []), sectors: parseJson(r.sectors, []) }));
}

async function getEvent(env, id) {
  const ev = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!ev) return null;
  const [latest, history, articles] = await Promise.all([
    env.DB.prepare('SELECT * FROM analyses WHERE event_id = ? ORDER BY created_at DESC LIMIT 1').bind(id).first(),
    env.DB.prepare('SELECT ts AS created_at, severity, source FROM severity_log WHERE event_id = ? ORDER BY ts, id').bind(id).all(),
    env.DB.prepare('SELECT id, title, url, source_name, published_at FROM articles WHERE event_id = ? ORDER BY published_at DESC').bind(id).all(),
  ]);
  return {
    event: { ...ev, domains: parseJson(ev.domains, []), sectors: parseJson(ev.sectors, []), triage: parseJson(ev.triage), market: parseJson(ev.market) },
    analysis: latest ? { created_at: latest.created_at, model: latest.model, ...parseJson(latest.payload, {}) } : null,
    history: history.results,
    articles: articles.results,
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/api/events') return json(await listEvents(env, url));

      const m = path.match(/^\/api\/events\/(\d+)$/);
      if (req.method === 'GET' && m) {
        const data = await getEvent(env, Number(m[1]));
        return data ? json(data) : json({ error: 'not found' }, 404);
      }

      if (req.method === 'GET' && path === '/api/sources') {
        const { results } = await env.DB.prepare(
          'SELECT id, name, category, lang, type, enabled, last_fetched_at, last_error FROM sources ORDER BY category, name',
        ).all();
        return json(results);
      }

      if (req.method === 'GET' && path === '/api/instruments') return json(await listInstruments(env));
      const im = path.match(/^\/api\/instruments\/([a-z0-9]+)$/);
      if (req.method === 'GET' && im) {
        const data = await getInstrument(env, im[1]);
        return data ? json(data) : json({ error: 'not found' }, 404);
      }

      if (req.method === 'GET' && path === '/api/usage') {
        const { results } = await env.DB.prepare(
          'SELECT day, model, purpose, calls, input_tokens, output_tokens, cache_read_tokens, ROUND(cost_usd, 4) AS cost_usd FROM api_usage ORDER BY day DESC, model LIMIT 120',
        ).all();
        const byDay = {};
        for (const r of results) byDay[r.day] = Math.round(((byDay[r.day] || 0) + r.cost_usd) * 10000) / 10000;
        return json({ daily_budget_usd: Number(env.DAILY_BUDGET_USD || 2), by_day: byDay, rows: results });
      }

      if (req.method === 'GET' && path === '/api/calibration') return json(await calibrationStats(env));

      if (req.method === 'GET' && path === '/api/market') {
        const { results } = await env.DB.prepare(
          'SELECT instrument, COUNT(*) AS bars, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM prices GROUP BY instrument',
        ).all();
        const stat = Object.fromEntries(results.map((r) => [r.instrument, r]));
        return json(INSTRUMENTS.map((i) => ({ key: i.key, name: i.name, ...(stat[i.key] || { bars: 0 }) })));
      }

      if (path.startsWith('/api/admin/')) {
        if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
        if (req.method === 'GET' && path === '/api/admin/llm') return json(await llmStatus(env));
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        if (path === '/api/admin/llm/test') return json(await selfTest(env));

        if (path === '/api/admin/init') {
          await env.DB.batch(
            DEFAULT_SOURCES.map((s) =>
              env.DB.prepare('INSERT OR IGNORE INTO sources (name, url, type, lang, category) VALUES (?, ?, ?, ?, ?)')
                .bind(s.name, s.url, s.type || 'rss', s.lang, s.category),
            ),
          );
          return json({ ok: true, sources: DEFAULT_SOURCES.length });
        }
        if (path === '/api/admin/ingest') return json(await ingest(env));
        if (path === '/api/admin/market/backfill') return json(await fetchMarket(env, { backfill: true }));
        if (path === '/api/admin/market/fetch') return json(await fetchMarket(env));
        if (path === '/api/admin/calibrate') return json(await calibrateEvents(env));
        if (path === '/api/admin/curves') return json({ curves: await updateCurves(env), snapshots: await computeSnapshots(env) });
        if (path === '/api/admin/snapshots') return json(await computeSnapshots(env));
        const bm = path.match(/^\/api\/admin\/brief\/([a-z0-9]+)$/);
        if (bm) return json(await generateBrief(env, bm[1]));
        if (path === '/api/admin/schedule') return json({ queued: await scheduleAnalyses(env) });

        const am = path.match(/^\/api\/admin\/analyze\/(\d+)$/);
        if (am) return json(await runAnalysis(env, Number(am[1]), { force: true }));
      }

      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: String(err.message || err) }, 500);
    }
  },

  // Cron（每 15 分钟）：采集新闻、调度分析、错峰采集行情；每小时一次重新校准市场反应
  async scheduled(controller, env, ctx) {
    const t = new Date(controller.scheduledTime || Date.now());
    const group = Math.floor(t.getUTCMinutes() / 15) % 4;
    const r = await ingest(env);
    const queued = await scheduleAnalyses(env);
    const market = await fetchMarket(env, { group });
    const calibrated = group === 3 ? await calibrateEvents(env) : [];
    if (group === 3) await computeSnapshots(env); // 每小时刷新品种快照
    const h = t.getUTCHours();
    if (group === 0 && h === 4) await purgeOld(env); // 每天一次
    // 美国期货日盘收盘后：22 点分 4 组更新期限结构（识别主力合约），23 点把 12 个品种的解读放进队列
    if (h === 22) await updateCurves(env, { group });
    if (h === 23 && group === 0) {
      await computeSnapshots(env);
      await env.QUEUE.sendBatch(INSTRUMENTS.map((i) => ({ body: { type: 'brief', key: i.key } })));
    }
    console.log(JSON.stringify({
      cron: controller.cron, new_articles: r.new_articles, analyses_queued: queued,
      market_errors: market.filter((m) => m.error), calibrated: calibrated.length,
    }));
  },

  // Queue 消费者：文章聚类 / 事件分析
  async queue(batch, env) {
    const articleMsgs = batch.messages.filter((m) => m.body.type === 'article');
    if (articleMsgs.length) {
      try {
        await processArticles(env, articleMsgs.map((m) => m.body.id));
        articleMsgs.forEach((m) => m.ack());
      } catch (err) {
        console.error('processArticles', err);
        articleMsgs.forEach((m) => m.retry());
      }
    }
    for (const m of batch.messages.filter((x) => x.body.type === 'brief')) {
      try {
        console.log(JSON.stringify({ brief: m.body.key, ...(await generateBrief(env, m.body.key)) }));
        m.ack();
      } catch (err) {
        console.error('generateBrief', m.body.key, err);
        m.retry({ delaySeconds: 300 });
      }
    }
    for (const m of batch.messages.filter((x) => x.body.type === 'analyze')) {
      try {
        console.log(JSON.stringify({ analyze: m.body.id, ...(await runAnalysis(env, m.body.id)) }));
        m.ack();
      } catch (err) {
        console.error('runAnalysis', m.body.id, err);
        m.retry({ delaySeconds: 120 });
      }
    }
  },
};
