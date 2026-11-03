// 采集 → 正文提取 → 向量聚类成事件 → 分诊 → 深度分析
import { parseFeed, parseGdelt } from './rss.js';
import { extractArticleText } from './extract.js';
import { triageEvent, analyzeEvent } from './analyze.js';
import { levelOf } from './rubric.js';
import { calibrateEvents } from './market.js';

const now = () => new Date().toISOString();
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------------- 1. 采集 ----------------

export async function ingest(env) {
  const { results: sources } = await env.DB.prepare('SELECT * FROM sources WHERE enabled = 1').all();
  const perFeed = num(env.MAX_ITEMS_PER_FEED, 30);
  const maxAgeMs = num(env.MAX_ARTICLE_AGE_HOURS, 72) * 3600e3;
  const newIds = [];
  const report = [];

  await Promise.all(
    sources.map(async (src) => {
      try {
        const res = await fetch(src.url, {
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; NewsRadar/1.0)' },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items = src.type === 'gdelt' ? parseGdelt(await res.json()) : parseFeed(await res.text());
        const fresh = items
          .filter((it) => !it.published_at || Date.now() - Date.parse(it.published_at) < maxAgeMs)
          .slice(0, perFeed);

        const stmt = env.DB.prepare(
          `INSERT OR IGNORE INTO articles (url, source_id, source_name, title, summary, lang, published_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        );
        const ts = now();
        const out = fresh.length
          ? await env.DB.batch(
              fresh.map((it) =>
                stmt.bind(it.url, src.id, it.source_name || src.name, it.title, it.summary || '', src.lang, it.published_at || ts, ts),
              ),
            )
          : [];
        const ids = out.flatMap((r) => r.results.map((row) => row.id));
        newIds.push(...ids);
        await env.DB.prepare('UPDATE sources SET last_fetched_at = ?, last_error = NULL WHERE id = ?').bind(ts, src.id).run();
        report.push({ source: src.name, parsed: items.length, new: ids.length });
      } catch (err) {
        await env.DB.prepare('UPDATE sources SET last_error = ? WHERE id = ?').bind(String(err.message || err), src.id).run();
        report.push({ source: src.name, error: String(err.message || err) });
      }
    }),
  );

  for (let i = 0; i < newIds.length; i += 100) {
    await env.QUEUE.sendBatch(newIds.slice(i, i + 100).map((id) => ({ body: { type: 'article', id } })));
  }
  return { new_articles: newIds.length, sources: report };
}

// ---------------- 2. 正文 + 聚类 ----------------

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function embed(env, texts) {
  const res = await env.AI.run(env.EMBED_MODEL, { text: texts });
  return res.data ?? res.response;
}

export async function processArticles(env, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const { results: articles } = await env.DB.prepare(
    `SELECT * FROM articles WHERE id IN (${placeholders}) AND processed = 0`,
  ).bind(...ids).all();
  if (!articles.length) return;

  // 正文提取（并发）
  await Promise.all(
    articles.map(async (a) => {
      if (a.content) return;
      const text = await extractArticleText(a.url);
      if (text) {
        a.content = text;
        await env.DB.prepare('UPDATE articles SET content = ? WHERE id = ?').bind(text, a.id).run();
      }
    }),
  );

  const vectors = await embed(env, articles.map((a) => `${a.title}\n${(a.summary || a.content || '').slice(0, 500)}`));
  const threshold = num(env.CLUSTER_THRESHOLD, 0.78);
  const windowMs = num(env.CLUSTER_WINDOW_HOURS, 72) * 3600e3;
  const batchSeen = []; // Vectorize 写入有延迟，同批次内的文章在内存里互相比较
  const upserts = [];

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const vec = vectors[i];
    const candidates = [];

    const q = await env.VECTORIZE.query(vec, { topK: 5, returnMetadata: 'all' });
    for (const m of q.matches || []) {
      if (m.metadata?.event_id && m.score >= threshold) candidates.push({ eventId: Number(m.metadata.event_id), score: m.score });
    }
    for (const s of batchSeen) {
      const sc = cosine(vec, s.vec);
      if (sc >= threshold) candidates.push({ eventId: s.eventId, score: sc });
    }
    candidates.sort((x, y) => y.score - x.score);

    let eventId = null;
    for (const c of candidates) {
      const ev = await env.DB.prepare('SELECT id, last_updated_at FROM events WHERE id = ?').bind(c.eventId).first();
      if (ev && Date.parse(a.published_at) - Date.parse(ev.last_updated_at) < windowMs) {
        eventId = ev.id;
        break;
      }
    }

    const ts = a.published_at || now();
    if (eventId) {
      await env.DB.prepare(
        `UPDATE events SET article_count = article_count + 1, needs_analysis = 1,
           last_updated_at = MAX(last_updated_at, ?) WHERE id = ?`,
      ).bind(ts, eventId).run();
    } else {
      const row = await env.DB.prepare(
        `INSERT INTO events (title, first_seen_at, last_updated_at, article_count, needs_analysis)
         VALUES (?, ?, ?, 1, 1) RETURNING id`,
      ).bind(a.title, ts, ts).first();
      eventId = row.id;
    }

    await env.DB.prepare('UPDATE articles SET event_id = ?, processed = 1 WHERE id = ?').bind(eventId, a.id).run();
    batchSeen.push({ vec, eventId });
    upserts.push({ id: String(a.id), values: vec, metadata: { event_id: eventId } });
  }

  await env.VECTORIZE.upsert(upserts);
}

// ---------------- 3. 调度分析（防抖） ----------------

export async function scheduleAnalyses(env) {
  const nowMs = Date.now();
  const cooldown = new Date(nowMs - num(env.ANALYSIS_COOLDOWN_MIN, 30) * 60e3).toISOString();
  const stale = new Date(nowMs - num(env.REANALYZE_MAX_HOURS, 6) * 3600e3).toISOString();
  // 重新分析门槛（深度分析是主要成本）：
  //   已分析事件 —— 新增报道 ≥ max(REANALYZE_MIN_NEW, 30%)，或距上次分析超过 REANALYZE_MAX_HOURS 小时
  //   观察级/不相关事件 —— 报道数翻倍才重新分诊
  const { results } = await env.DB.prepare(
    `SELECT id FROM events
     WHERE needs_analysis = 1 AND (last_analyzed_at IS NULL OR last_analyzed_at < ?)
       AND (
         status = 'new'
         OR (status = 'analyzed' AND (article_count >= analyzed_count + MAX(?, CAST(analyzed_count * 0.3 AS INTEGER)) OR last_analyzed_at < ?))
         OR (status IN ('watch', 'irrelevant') AND article_count >= triaged_count * 2)
       )
     ORDER BY article_count DESC, last_updated_at DESC LIMIT ?`,
  ).bind(cooldown, num(env.REANALYZE_MIN_NEW, 3), stale, num(env.MAX_ANALYSES_PER_RUN, 5)).all();
  if (!results.length) return 0;
  await env.DB.batch(results.map((r) => env.DB.prepare('UPDATE events SET needs_analysis = 0 WHERE id = ?').bind(r.id)));
  await env.QUEUE.sendBatch(results.map((r) => ({ body: { type: 'analyze', id: r.id } })));
  return results.length;
}

// ---------------- 4. 分诊 + 深度分析 ----------------

export async function runAnalysis(env, eventId, { force = false } = {}) {
  const ev = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!ev) return { skipped: 'not found' };
  const { results: articles } = await env.DB.prepare(
    'SELECT * FROM articles WHERE event_id = ? ORDER BY published_at',
  ).bind(eventId).all();
  if (!articles.length) return { skipped: 'no articles' };

  const ts = now();
  const needTriage = force || ev.triaged_count === 0 || ev.article_count >= ev.triaged_count * 2;
  let triage = ev.triage ? JSON.parse(ev.triage) : null;

  if (needTriage) {
    triage = await triageEvent(env, articles);
    await env.DB.prepare('UPDATE events SET triage = ?, triaged_count = ?, title_zh = COALESCE(title_zh, ?), domains = ?, sectors = COALESCE(sectors, ?) WHERE id = ?')
      .bind(JSON.stringify(triage), ev.article_count, triage.title_zh, JSON.stringify(triage.domains), JSON.stringify(triage.sectors || []), eventId).run();
  } else if (ev.status === 'irrelevant') {
    return { skipped: 'irrelevant' };
  }

  if (!triage.relevant) {
    await env.DB.prepare("UPDATE events SET status = 'irrelevant', last_analyzed_at = ? WHERE id = ?").bind(ts, eventId).run();
    return { status: 'irrelevant' };
  }
  if (!force && triage.rough_severity < num(env.MIN_TRIAGE_SEVERITY, 2)) {
    const sev = triage.rough_severity * 20;
    await env.DB.prepare("UPDATE events SET status = 'watch', severity = ?, level = ?, last_analyzed_at = ? WHERE id = ?")
      .bind(sev, levelOf(sev), ts, eventId).run();
    return { status: 'watch' };
  }

  // 重要事件（粗分高或此前已判为严重）走 analysis_important 调用链（有 Anthropic key 时先用 Sonnet），
  // 其余走 analysis 调用链（免费模型优先）。付费模型受 DAILY_BUDGET_USD 约束，由路由层自动跳过。
  const important = triage.rough_severity >= num(env.DEEP_MODEL_MIN_SEVERITY, 4) || (ev.severity ?? 0) >= 60;
  const result = await analyzeEvent(env, articles, ts, important ? 'analysis_important' : 'analysis');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO analyses (event_id, created_at, model, severity, scores, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(eventId, ts, result.model, result.severity, JSON.stringify(result.scores), JSON.stringify(result)),
    env.DB.prepare(
      `UPDATE events SET status = 'analyzed', severity = ?, level = ?, confidence = ?, title_zh = ?, domains = ?, sectors = ?,
         last_analyzed_at = ? WHERE id = ?`,
    ).bind(result.severity, result.level, result.confidence, result.title_zh, JSON.stringify(result.domains),
      JSON.stringify(result.sectors.length ? result.sectors : triage.sectors || []), ts, eventId),
    env.DB.prepare("INSERT INTO severity_log (event_id, ts, severity, source) VALUES (?, ?, ?, 'analysis')").bind(eventId, ts, result.severity),
    // 新分析可能改变了相关资产列表，重新开始市场校准
    env.DB.prepare('UPDATE events SET model_severity = ?, market_final = 0, analyzed_count = ? WHERE id = ?').bind(result.severity, ev.article_count, eventId),
  ]);
  const [cal] = await calibrateEvents(env, [eventId]);
  return { status: 'analyzed', model: result.model, attempts: result.attempts, model_severity: result.severity, severity: cal?.severity ?? result.severity, level: result.level };
}

// ---------------- 5. 存储清理 ----------------

/** 清除旧文章正文（分析已完成，只保留标题、摘要和链接）和过期行情，控制 D1 体积 */
export async function purgeOld(env) {
  const contentCutoff = new Date(Date.now() - num(env.CONTENT_RETENTION_DAYS, 30) * 86400e3).toISOString();
  const priceCutoff = Math.floor(Date.now() / 1000) - num(env.PRICE_RETENTION_DAYS, 400) * 86400;
  await env.DB.batch([
    env.DB.prepare('UPDATE articles SET content = NULL WHERE content IS NOT NULL AND fetched_at < ?').bind(contentCutoff),
    env.DB.prepare('DELETE FROM prices WHERE ts < ?').bind(priceCutoff),
    // 小时展望及其核对结果保留一年（命中率统计只用近 30–180 天）
    env.DB.prepare('DELETE FROM hourly_outlook WHERE window_start < ?').bind(Math.floor(Date.now() / 1000) - 366 * 86400),
    env.DB.prepare('DELETE FROM hourly_commentary WHERE window_start < ?').bind(Math.floor(Date.now() / 1000) - 30 * 86400),
  ]);
}
