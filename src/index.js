import { ingest, processArticles, scheduleAnalyses, runAnalysis, purgeOld } from './pipeline.js';
import { DEFAULT_SOURCES } from './sources.js';
import { fetchMarket, calibrateEvents, calibrationStats } from './market.js';
import { INSTRUMENTS } from './instruments.js';
import { selfTest, status as llmStatus, checkOpencodeModel } from './llm.js';
import { updateCurves, updateDailyBars } from './contracts.js';
import { computeSnapshots, generateBrief, listInstruments, getInstrument, getOverview, ensureHistory, dataStatus } from './futures.js';
import { updateCot } from './cot.js';
import { upcomingEvents, addEvent } from './calendar.js';
import { etParts } from './sessions.js';
import { updateQuotes, purgeQuotes, intradayCandles, latestQuotes } from './quotes.js';
import { ensureSchema } from './schema-guard.js';
import { makeOutlooks, evaluateOutlooks, getOutlook, getHourly, outlookTrack, generateOutlookCommentary } from './outlook.js';

/** 从步骤返回值里找出逐项错误：数组里带 error 的项，或对象里各个数组字段中带 error 的项 */
export function itemErrors(res) {
  const lists = Array.isArray(res) ? [res] : res && typeof res === 'object' ? Object.values(res).filter(Array.isArray) : [];
  return lists.flat().filter((x) => x && typeof x === 'object' && x.error).map((x) => `${x.instrument || x.report || x.key || '?'}: ${x.error}`);
}

// 按美东时间安排的任务（"HH:MM" → 当天第几分钟）
const SCHEDULE = Object.fromEntries(['05:00', '16:00', '16:50', '17:05', '17:10', '17:15', '17:20', '17:25', '17:30'].map((k) => [k, Number(k.slice(0, 2)) * 60 + Number(k.slice(3))]));

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
    if (path.startsWith('/api/')) await ensureSchema(env); // 漏跑迁移时自动补建新表（每个实例只检查一次）
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

      if (req.method === 'GET' && path === '/api/overview') return json(await getOverview(env));
      if (req.method === 'GET' && path === '/api/data-status') return json(await dataStatus(env));
      if (req.method === 'GET' && path === '/api/calendar') {
        const days = Math.min(Math.max(Number(url.searchParams.get('days') || 14), 1), 60);
        return json(await upcomingEvents(env, { days }));
      }
      if (req.method === 'GET' && path === '/api/outlook') return json(await getOutlook(env));
      if (req.method === 'GET' && path === '/api/outlook/track') {
        const days = Math.min(Math.max(Number(url.searchParams.get('days') || 30), 1), 180);
        return json(await outlookTrack(env, { days }));
      }
      const qm = path.match(/^\/api\/instruments\/([a-z0-9]+)\/intraday$/);
      if (req.method === 'GET' && qm) {
        if (!INSTRUMENTS.some((i) => i.key === qm[1])) return json({ error: 'not found' }, 404);
        const hours = Math.min(Math.max(Number(url.searchParams.get('hours') || 24), 1), 120);
        try {
          return json({ instrument: qm[1], ...(await intradayCandles(env, qm[1], { hours })), quote: (await latestQuotes(env))[qm[1]] || null });
        } catch (err) {
          return json({ error: 'intraday_unavailable', detail: String(err.message || err) }, 503);
        }
      }
      if (req.method === 'GET' && path === '/api/quotes') {
        // 出错或为空时返回 503 而不是 200 + {}，让监控和前端都能看出来
        try {
          const q = await latestQuotes(env);
          if (!Object.keys(q).length) return json({ error: 'quotes_empty', hint: '报价表为空，检查 /api/data-status 的 cron_steps.quotes' }, 503);
          return json(q);
        } catch (err) {
          return json({ error: 'quotes_unavailable', detail: String(err.message || err) }, 503);
        }
      }
      const hm = path.match(/^\/api\/instruments\/([a-z0-9]+)\/hourly$/);
      if (req.method === 'GET' && hm) {
        const data = await getHourly(env, hm[1], { hours: Number(url.searchParams.get('hours') || 72) });
        return data ? json(data) : json({ error: 'not found' }, 404);
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
        const cm = path.match(/^\/api\/admin\/calendar\/(\d+)$/);
        if (req.method === 'DELETE' && cm) {
          await env.DB.prepare('DELETE FROM calendar_events WHERE id = ?').bind(Number(cm[1])).run();
          return json({ ok: true });
        }
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        if (path === '/api/admin/calendar') {
          try {
            return json(await addEvent(env, await req.json()));
          } catch (e) {
            return json({ error: e.message }, 400);
          }
        }
        if (path === '/api/admin/daily') return json({ daily: await updateDailyBars(env), snapshots: await computeSnapshots(env) });
        if (path === '/api/admin/cot') {
          const weeks = Number(url.searchParams.get('weeks')) || null;
          return json({ cot: await updateCot(env, { weeks }), snapshots: await computeSnapshots(env) });
        }
        if (path === '/api/admin/llm/test') return json(await selfTest(env));
        if (path === '/api/admin/outlook') {
          const evaluated = await evaluateOutlooks(env);
          const made = await makeOutlooks(env);
          const ai = url.searchParams.get('ai') === '0' ? null : await generateOutlookCommentary(env).catch((e) => ({ error: e.message }));
          return json({ evaluated, made, ai });
        }

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
        if (path === '/api/admin/quotes') return json(await updateQuotes(env));
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

  // Cron 每 5 分钟。每一步单独 try/catch：某一步失败（例如行情源限流）不会让后面的步骤被跳过。
  // 与收盘相关的任务按美东时间安排（自动处理夏令时），见 SCHEDULE。
  async scheduled(controller, env, ctx) {
    const schema = await ensureSchema(env);
    const t = new Date(controller.scheduledTime || Date.now());
    const nowSec = Math.floor(t.getTime() / 1000);
    const minute = t.getUTCMinutes();
    const group = Math.floor(minute / 15) % 4;
    const et = etParts(t); // { day: 0=周日, minute: 当天第几分钟 }
    const etAt = (hhmm) => et.minute === SCHEDULE[hhmm];
    const weekday = et.day >= 1 && et.day <= 5;
    const log = { cron: controller.cron, group, schema: schema.created.length || schema.added.length || schema.errors.length ? schema : undefined, et: `${et.day}/${Math.floor(et.minute / 60)}:${String(et.minute % 60).padStart(2, '0')}`, errors: {} };
    const LOGGED = new Set(['quotes', 'market', 'curves', 'daily', 'cot', 'ensure_history', 'snapshots', 'outlook', 'outlook_eval', 'brief_queue']);
    const record = async (name, ok, detail) => {
      if (!LOGGED.has(name)) return;
      try {
        await env.DB.prepare('INSERT OR REPLACE INTO cron_log (step, ran_at, ok, detail) VALUES (?, ?, ?, ?)')
          .bind(name, Math.floor(Date.now() / 1000), ok ? 1 : 0, JSON.stringify(detail ?? null).slice(0, 4000)).run();
      } catch {} // 迁移 0008 未执行时不影响主流程
    };
    const step = async (name, fn) => {
      try {
        const res = await fn();
        // 很多步骤逐个品种 try/catch、把错误放进返回值；只要有一项失败，这一步就记为失败
        const failed = itemErrors(res);
        if (failed.length) {
          log.errors[name] = failed.slice(0, 12);
          await record(name, false, res);
        } else {
          await record(name, true, res);
        }
        return res;
      } catch (err) {
        log.errors[name] = String(err?.message || err);
        console.error(`cron step ${name}`, err);
        await record(name, false, log.errors[name]);
        return null;
      }
    };

    // ---- 每 5 分钟：全部品种的最新报价和 5 分钟K线（12 次请求）----
    const q = await step('quotes', () => updateQuotes(env, { nowSec }));
    log.quote_errors = (q || []).filter((x) => x.error);

    // ---- 收盘后的日线流程（美东 17:00–18:00 是 CME 每日休市时段，没有新行情）----
    // 17:05 / 17:10 / 17:15 / 17:20 分 4 组更新期限结构（主力合约）和日线，17:25 刷新快照，
    // 17:30 起每 30 秒排一个品种的每日解读（错开发出，避免免费模型每分钟限流），18:00 夜盘开盘前完成。
    // 周六、周日没有新的交易日，不重复生成。
    if (weekday) {
      for (const [k, g] of [['17:05', 0], ['17:10', 1], ['17:15', 2], ['17:20', 3]]) {
        if (etAt(k)) {
          await step('curves', () => updateCurves(env, { group: g }));
          await step('daily', () => updateDailyBars(env, { group: g }));
        }
      }
      if (etAt('17:25')) await step('snapshots', () => computeSnapshots(env));
      if (etAt('17:30')) {
        await step('brief_queue', () => env.QUEUE.sendBatch(INSTRUMENTS.map((i, k) => ({ body: { type: 'brief', key: i.key }, delaySeconds: k * 30 }))));
      }
    }
    // 下午选出今晚解读要用的 OpenCode 免费模型
    if (weekday && etAt('16:50')) log.model_health = await step('opencode_health', () => checkOpencodeModel(env));
    // CFTC 持仓报告周五美东 15:30 发布：周五 16:00 拉一次，周一 16:00 再拉一次（补节假日延迟发布）
    if ((et.day === 5 || et.day === 1) && etAt('16:00')) await step('cot', () => updateCot(env));
    if (etAt('05:00')) {
      await step('purge', () => purgeOld(env));
      await step('purge_quotes', () => purgeQuotes(env));
    }

    // 生产环境的 scheduledTime 总是整 5 分钟；手动调用（测试）没有时间时按 15 分钟流程执行
    if (controller.scheduledTime && minute % 15 !== 0) {
      console.log(JSON.stringify(log));
      return;
    }

    // ---- 每 15 分钟：新闻、事件分析、小时线、补数据 ----
    const r = await step('ingest', () => ingest(env));
    log.new_articles = r?.new_articles;
    log.analyses_queued = await step('schedule', () => scheduleAnalyses(env));
    // 整点那次采集全部 12 个品种，让本小时的风险展望用上最新价格；其余三次各采集 3 个
    const market = await step('market', () => fetchMarket(env, { group: group === 0 ? null : group }));
    log.market_errors = (market || []).filter((m) => m.error);

    // 补齐缺失的日线（每次 3 个品种，数据齐全后只是两次计数查询）；持仓报告每小时检查一次
    log.history = await step('ensure_history', () => ensureHistory(env, { checkCot: group === 3 }));
    if (group === 3) {
      log.calibrated = (await step('calibrate', () => calibrateEvents(env)))?.length;
      await step('snapshots', () => computeSnapshots(env));
    } else if (log.history?.changed) {
      await step('snapshots', () => computeSnapshots(env)); // 补到新数据就立即刷新，不等整点
    }

    // ---- 风险展望：每次核对已结束的窗口；整点生成本小时区间，并排队 AI 情景（是否调用模型由 generateOutlookCommentary 判断）----
    log.outlook_evaluated = (await step('outlook_eval', () => evaluateOutlooks(env, { nowSec })))?.length;
    if (group === 0) {
      const made = await step('outlook', () => makeOutlooks(env, { nowSec }));
      if ((made || []).some((m) => m.status === 'open')) await step('outlook_queue', () => env.QUEUE.send({ type: 'outlook_ai', window_start: Math.floor(nowSec / 3600) * 3600, now_sec: nowSec }));
    }
    console.log(JSON.stringify(log));
  },

  // Queue 消费者：文章聚类 / 事件分析
  async queue(batch, env) {
    await ensureSchema(env);
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
    for (const m of batch.messages.filter((x) => x.body.type === 'outlook_ai')) {
      try {
        console.log(JSON.stringify({ outlook_ai: m.body.window_start, ...(await generateOutlookCommentary(env, { windowStart: m.body.window_start, nowSec: Math.max(m.body.now_sec || 0, Math.floor(Date.now() / 1000)) })) }));
        m.ack();
      } catch (err) {
        console.error('outlook_ai', err);
        // 窗口只有 1 小时，重试两次就放弃
        if (m.attempts >= 3) m.ack();
        else m.retry({ delaySeconds: 90 });
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
