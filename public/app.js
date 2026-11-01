// 期货雷达前端：调用 /api；API 不可用或 ?demo=1 时使用 demo.json
// 路由（仅用 #名字）：#（品种）· #i-gold（品种详情）· #events（事件）· #e-12（事件详情）· #calibration（模型校准）
const DIMS = {
  military_escalation: '军事升级',
  market_shock: '市场冲击',
  supply_demand: '供需冲击',
  systemic_contagion: '系统性传导',
  geographic_scope: '地理范围',
  human_impact: '人员影响', // 旧版分析
  persistence: '持续性',
  escalation_momentum: '升级势头',
};
const SECTORS = ['能源', '金属', '农产品', '金融期货'];
const LEVEL_COLOR = { 低: '#5b6578', 关注: '#3d8bd9', 显著: '#d9a03d', 严重: '#e0663a', 危急: '#e03a4f' };
const DIR_ICON = { 上涨: '▲', 下跌: '▼', 波动加剧: '◆', 不确定: '·' };
const EFFECT_CLASS = { 利多: 'up', 利空: 'down', 中性: 'flat' };

const DISCLAIMER = '本站内容由 AI 根据公开新闻和行情数据自动生成，仅供研究参考，可能存在错误或遗漏，不构成任何投资建议。期货交易风险高、杠杆大，据此操作风险自负。';
const state = { view: 'instruments', sector: null, min: 0, watch: true, selected: null, inst: null, demo: null, instruments: null };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const refs = (ids, sources) =>
  (ids || [])
    .map((id) => {
      const s = sources?.find((x) => x.sid === id);
      return `<span class="ref" title="${esc(s ? `${s.source}: ${s.title}` : '')}">[S${id}]</span>`;
    })
    .join('');

async function loadDemo() {
  if (!state.demo) {
    state.demo = await (await fetch('demo.json')).json();
    $('#demoBadge').hidden = false;
  }
  return state.demo;
}

async function api(path) {
  if (new URLSearchParams(location.search).has('demo') || state.demo) return null;
  try {
    const r = await fetch(path);
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchEvents() {
  const q = new URLSearchParams({ min: state.min, watch: state.watch ? '1' : '0' });
  if (state.sector) q.set('sector', state.sector);
  const live = await api('/api/events?' + q);
  if (live) return live;
  const d = await loadDemo();
  return d.events.filter(
    (e) => (e.severity ?? 0) >= state.min && (state.watch || e.status === 'analyzed') && (!state.sector || (e.sectors || []).includes(state.sector)),
  );
}

async function fetchDetail(id) {
  return (await api('/api/events/' + id)) || (await loadDemo()).details[id];
}

// ---------- 列表 ----------

function renderChips() {
  $('#domainChips').innerHTML = [null, ...SECTORS]
    .map((d) => `<button class="chip ${state.sector === d ? 'on' : ''}" data-d="${d ?? ''}">${d ?? '全部品类'}</button>`)
    .join('');
}

async function renderEventList() {
  const events = await fetchEvents();
  const el = $('#list');
  if (!events.length) {
    el.innerHTML = '<div class="empty">暂无符合条件的事件</div>';
    return;
  }
  el.innerHTML = events
    .map(
      (e) => `<article class="card ${state.selected === e.id ? 'sel' : ''}" data-id="${e.id}" tabindex="0">
        <div class="sev lv-${esc(e.level)}">${Math.round(e.severity ?? 0)}<small>${esc(e.level)}</small></div>
        <div>
          <h3>${esc(e.title)}</h3>
          <div class="meta">
            <span>${fmt(e.last_updated_at)}</span><span>${e.article_count} 篇报道</span>
            ${e.status === 'watch' ? '<span class="tag watch-tag">观察 · 未深析</span>' : ''}
            ${(e.sectors || []).map((d) => `<span class="tag sec">${esc(d)}</span>`).join('')}
          </div>
          ${e.summary ? `<p>${esc(e.summary)}</p>` : ''}
        </div>
      </article>`,
    )
    .join('');
  if (state.view === 'events' && !state.selected && events[0] && window.matchMedia('(min-width: 861px)').matches) location.replace(`#e-${events[0].id}`);
}

// ---------- 详情 ----------

function sparkline(history) {
  if (!history || history.length < 2) return '<p class="note">分析次数不足，暂无趋势。</p>';
  const W = 600, H = 60, P = 6;
  const vals = history.map((h) => h.severity ?? 0);
  const lo = Math.max(0, Math.min(...vals) - 10), hi = Math.min(100, Math.max(...vals) + 10);
  const xs = history.map((_, i) => P + (i * (W - 2 * P)) / (history.length - 1));
  const ys = vals.map((v) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P));
  const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const last = history[history.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="严重性趋势">
      <polyline points="${pts}" fill="none" stroke="#4da3ff" stroke-width="2" vector-effect="non-scaling-stroke"/>
      ${xs.map((x, i) => {
        const mk = history[i].source === 'market';
        return `<circle cx="${x}" cy="${ys[i]}" r="4" fill="${mk ? '#12161d' : '#4da3ff'}" stroke="#4da3ff" stroke-width="2"><title>${fmt(history[i].created_at)} ${mk ? '市场校准' : '深度分析'}：${history[i].severity}</title></circle>`;
      }).join('')}
    </svg>
    <p class="note">${fmt(history[0].created_at)} → ${fmt(last.created_at)} · 实心点＝深度分析，空心点＝市场校准 · 最新 ${last.severity}</p>`;
}

function renderDetail(d) {
  const { event: ev, analysis: a, history, articles } = d;
  const el = $('#detail');
  if (!a) {
    el.innerHTML = `<div class="d-head"><div><h2>${esc(ev.title_zh || ev.title)}</h2>
      <div class="meta">${ev.article_count} 篇报道 · 分诊粗分 ${esc(ev.triage?.rough_severity ?? '—')}/5</div></div></div>
      <div class="box"><h4>尚未深度分析</h4><p class="note">分诊判断为低严重性，处于观察状态。报道增加后会自动重新评估。</p></div>
      <div class="box"><h4>相关报道</h4><ul class="plain src">${articles.map((x) => `<li><a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener">${esc(x.title)}</a> <span class="note">${esc(x.source_name)} · ${fmt(x.published_at)}</span></li>`).join('')}</ul></div>`;
    return;
  }
  const S = a.sources;
  const m = ev.market;
  const sev = ev.severity ?? a.severity;
  const lvl = ev.level ?? a.level;
  const calibrated = m && m.weight > 0;
  const color = LEVEL_COLOR[lvl] || '#5b6578';

  el.innerHTML = `
  <div class="d-head">
    <div>
      <h2>${esc(a.title_zh)}</h2>
      <div class="meta">
        ${(a.domains || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}
        <span>首次出现 ${fmt(ev.first_seen_at)}</span><span>更新 ${fmt(ev.last_updated_at)}</span>
        <span>${ev.article_count} 篇报道</span>
        <span>置信度 ${Math.round((a.confidence ?? 0) * 100)}%</span>
        <span>引文核对 ${Math.round((a.quality?.verified_quote_ratio ?? 0) * 100)}%</span>
      </div>
    </div>
    <div class="big lv-${esc(lvl)}"><div class="n">${sev}</div><div class="l">${esc(lvl)}</div>
      ${calibrated ? `<div class="cal">模型 ${m.model_severity} · 市场校准后</div>` : ''}</div>
  </div>
  <p class="summary">${esc(a.summary_zh)}</p>

  <div class="grid2">
    <div class="box">
      <h4>严重性分项（0–5，代码加权得总分）</h4>
      ${Object.entries(DIMS)
        .filter(([k]) => a.scores?.[k])
        .map(([k, label]) => {
          const s = a.scores[k];
          const cal = k === 'market_shock' && calibrated ? m.blended_score : null;
          return `<div class="score"><span class="name">${label}</span>
            <span class="bar"><i style="width:${(s.score / 5) * 100}%;background:${color}"></i>${cal !== null ? `<b class="calmark" style="left:${(cal / 5) * 100}%" title="市场校准后 ${cal}"></b>` : ''}</span>
            <span class="v">${cal !== null ? `${s.score}→${cal}` : s.score}</span></div>
            <div class="why">${esc(s.rationale)}${refs(s.source_ids, S)}</div>`;
        })
        .join('')}
    </div>
    <div>
      <div class="box"><h4>严重性趋势</h4>${sparkline(history)}</div>
      <div class="box"><h4>政治 → 军事 → 经济 → 市场 传导链</h4>
        <div class="chain">${(a.transmission_chain || [])
          .map((c, i, arr) => {
            const showFrom = i === 0 || arr[i - 1].to !== c.from; // 非线性链条时补出起点
            return `${showFrom ? `<span class="node">${esc(c.from)}</span>` : ''}
              <span class="arrow">${esc(c.mechanism)}${c.lag ? ` <em>${esc(c.lag)}</em>` : ''}</span>
              <span class="node">${esc(c.to)}</span>`;
          })
          .join('')}</div>
      </div>
    </div>
  </div>

  ${marketPanel(m)}

  <div class="box">
    <h4>影响范围</h4>
    <div id="map"></div>
    <div class="regions">${(a.impact?.regions || []).map((r) => `<span class="tag role-${esc(r.role)}" title="${esc(r.note)}">${esc(r.role)} · ${esc(r.name)}</span>`).join('')}</div>
  </div>

  <div class="grid2">
    <div class="box"><h4>期货影响 <span class="nb">不构成投资建议</span></h4>
      <table><thead><tr><th>资产</th><th>方向</th><th>周期</th><th>逻辑</th></tr></thead><tbody>
      ${(a.impact?.assets || []).map((x) => `<tr><td>${x.instrument && x.instrument !== 'other' ? `<a href="#i-${esc(x.instrument)}">${esc(x.asset)}</a>` : esc(x.asset)}</td><td class="dir-${esc(x.direction)}">${DIR_ICON[x.direction] || ''} ${esc(x.direction)}</td><td>${esc(x.horizon)}</td><td class="note">${esc(x.rationale)}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="box"><h4>行业影响</h4>
      <table><thead><tr><th>行业</th><th>方向</th><th>说明</th></tr></thead><tbody>
      ${(a.impact?.sectors || []).map((x) => `<tr><td>${esc(x.name)}</td><td class="dir-${esc(x.direction)}">${DIR_ICON[x.direction] || ''} ${esc(x.direction)}</td><td class="note">${esc(x.note)}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>

  <div class="box"><h4>时间线</h4>
    <ol class="tl">${(a.timeline || [])
      .map((t) => `<li class="st-${esc(t.status)}">
        <div class="when">${esc(t.date)}${t.time ? ' ' + esc(t.time) : ''}${t.date_precision === '约略' ? ' (约)' : ''} · ${esc(t.status)}</div>
        <div class="what">${esc(t.event)}${refs(t.source_ids, S)}</div>
        <blockquote>“${esc(t.quote)}” ${t.verified ? '<span class="ok">✓ 已核对原文</span>' : '<span class="warn">⚠ 未能在原文中找到</span>'}</blockquote>
      </li>`)
      .join('')}</ol>
  </div>

  ${a.contradictions?.length ? `<div class="box"><h4>信源矛盾</h4><ul class="plain">${a.contradictions.map((c) => `<li>${esc(c.claim)} <span class="note">支持${refs(c.supporting, S)} 反对${refs(c.contradicting, S)}</span></li>`).join('')}</ul></div>` : ''}

  <div class="box"><h4>后续情景</h4>
    <div class="scen">${(a.scenarios || []).map((s) => `<div><b>${esc(s.name)} <span class="tag">可能性 ${esc(s.likelihood)}</span></b><p>触发：${esc(s.triggers)}</p><p>市场：${esc(s.market_implication)}</p></div>`).join('')}</div>
  </div>

  <div class="grid2">
    <div class="box"><h4>先行指标</h4><ul class="plain">${(a.watch_indicators || []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
    <div class="box"><h4>信源</h4><ol class="plain src">${(S || []).map((s) => `<li value="${s.sid}"><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="note">${esc(s.source)} · ${fmt(s.published_at)}</span></li>`).join('')}</ol>
      <p class="note">分析于 ${fmt(a.created_at)} · ${esc(a.model)}</p></div>
  </div>
  <p class="disclaimer">${DISCLAIMER}</p>`;

  drawMap(a.impact?.regions || []);
  drawReactionChart(m);
}

// ---------- 市场实际反应 ----------

const SERIES = ['#3987e5', '#d95926', '#199e70']; // 已用校验脚本验证（深色背景）
const VERDICT = { hit: ['✓ 命中', 'ok'], miss: ['✗ 相反', 'bad'], insignificant: ['— 不显著', 'note'], unscored: ['未评', 'note'] };
const STATUS = { insufficient_history: '历史数据不足', zero_volatility: '无波动', waiting: '等待开盘' };

function fmtChange(kind, c) {
  if (!Number.isFinite(c)) return '—';
  const v = kind === 'yield' ? c * 100 : (Math.exp(c) - 1) * 100;
  const sgn = v > 0 ? '+' : '';
  return kind === 'yield' ? `${sgn}${v.toFixed(1)}bp` : `${sgn}${v.toFixed(2)}%`;
}

function winCell(r, h) {
  const w = r.windows?.[h];
  if (!w || !w.n) return `<td class="note">${w && !w.complete ? '进行中' : '—'}</td>`;
  return `<td class="num">${fmtChange(r.kind, w.change)}<small>${w.z > 0 ? '+' : ''}${w.z}σ${w.complete ? '' : ' …'}</small></td>`;
}

function chartSeries(m) {
  return (m?.instruments || [])
    .filter((r) => r.status === 'ok' && r.kind === 'price' && r.chart?.length > 2)
    .sort((x, y) => Math.abs(y.z) - Math.abs(x.z))
    .slice(0, 3);
}

function marketPanel(m) {
  if (!m) return `<div class="box"><h4>市场实际反应</h4><p class="note">尚无行情数据。部署后运行一次行情回填，之后每小时自动更新。</p></div>`;
  const anchorMs = Date.parse(m.anchor);
  const hrs = Math.min(72, Math.max(0, (Date.now() - anchorMs) / 3600e3));
  const state = m.final ? '72 小时窗口已结束，结果定稿' : `观察中 · 已过 ${Math.floor(hrs)}/72 小时`;
  const tile = (label, v, sub) => `<div class="tile"><span>${label}</span><b>${v ?? '—'}<small>/5</small></b><em>${sub}</em></div>`;
  const series = chartSeries(m);
  return `<div class="box market">
    <h4>市场实际反应 · 校准“市场冲击” <span class="nb">不构成投资建议</span></h4>
    <p class="note">按主力合约计算 · 锚点 ${fmt(m.anchor)}（首篇报道前 2 小时）· ${state} · ${m.linked ? '按模型列出的资产核对' : '模型未列出可核对资产，使用核心资产兜底'}</p>
    <div class="tiles">
      ${tile('模型预估', m.model_score, '来自新闻文本')}
      ${tile('市场实测', m.observed_score, '按波动率标准化')}
      ${tile('校准后', m.blended_score, `实测权重 ${Math.round(m.weight * 100)}%`)}
    </div>
    ${series.length ? `<div class="legend"${series.length < 2 ? ' hidden' : ''}>${series.map((r, i) => `<span><i style="background:${SERIES[i]}"></i>${esc(r.name)}</span>`).join('')}</div>
      <div id="rxChart" class="rx" role="img" aria-label="事件前后价格变化（相对锚点，%）"></div>` : ''}
    <div class="tablewrap"><table class="rxt"><thead><tr><th>资产</th><th>模型预期</th><th>4 小时</th><th>24 小时</th><th>72 小时</th><th>判定</th></tr></thead><tbody>
    ${m.instruments.map((r) => `<tr>
        <td><a href="#i-${esc(r.key)}">${esc(r.name)}</a>${r.contract && r.contract !== 'cont' ? ` <span class="note">${esc(r.contract)}</span>` : ''}</td>
        <td class="dir-${esc(r.expected || '不确定')}">${r.expected ? `${DIR_ICON[r.expected] || ''} ${esc(r.expected)}` : '<span class="note">参考</span>'}</td>
        ${r.status === 'ok' ? winCell(r, 'h4') + winCell(r, 'h24') + winCell(r, 'h72') : `<td colspan="3" class="note">${STATUS[r.status] || esc(r.status)}</td>`}
        <td class="${VERDICT[r.verdict][1]}">${r.verdict === 'miss' && r.expected === '波动加剧' ? '✗ 波动不足' : VERDICT[r.verdict][0]}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">σ＝相对事件前 30 天正常波动的倍数，|σ|≥2 才算明显异动。相关不等于因果：同一时间的其他新闻也可能推动价格，所以实测分最多只占 60% 权重。</p>
  </div>`;
}

function drawReactionChart(m) {
  const box = $('#rxChart');
  const series = chartSeries(m);
  if (!box || !series.length) return;
  const anchor = Date.parse(m.anchor) / 1000;
  const W = Math.max(300, box.clientWidth), H = 220, L = 44, T = 10, B = 26;
  const directLabels = W >= 520; // 窄屏只用图例，避免标签挤出画布
  const R = directLabels ? 24 + 8 * Math.max(...series.map((r) => r.name.length * 1.6 + 7)) : 12;
  const x0 = anchor - 24 * 3600, x1 = anchor + 72 * 3600;
  const all = series.flatMap((r) => r.chart.map((p) => p[1]));
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const pad = (hi - lo || 1) * 0.1;
  lo -= pad; hi += pad;
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = niceTicks(lo, hi, 4);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  for (const t of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="grid${t === 0 ? ' zero' : ''}"/><text x="${L - 6}" y="${Y(t) + 4}" class="ax" text-anchor="end">${t > 0 ? '+' : ''}${+t.toFixed(2)}%</text>`;
  for (const h of [-24, 0, 24, 48, 72]) svg += `<text x="${X(anchor + h * 3600)}" y="${H - 6}" class="ax" text-anchor="middle">${h === 0 ? '锚点' : (h > 0 ? '+' : '') + h + 'h'}</text>`;
  svg += `<line x1="${X(anchor)}" x2="${X(anchor)}" y1="${T}" y2="${H - B}" class="anchor"/>`;
  // 直接标签：按终点位置排开，避免重叠
  const ends = series.map((r, i) => ({ i, y: Y(r.chart.at(-1)[1]), r })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
  series.forEach((r, i) => {
    const d = r.chart.map((p, j) => `${j ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    svg += `<path d="${d}" fill="none" stroke="${SERIES[i]}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  for (const e of directLabels ? ends : []) {
    const last = e.r.chart.at(-1);
    svg += `<circle cx="${X(last[0])}" cy="${Y(last[1])}" r="3" fill="${SERIES[e.i]}"/>`;
    svg += `<text x="${X(last[0]) + 8}" y="${e.y + 4}" class="lbl">${esc(e.r.name)} ${last[1] > 0 ? '+' : ''}${last[1].toFixed(2)}%</text>`;
  }
  svg += `<line id="rxCross" y1="${T}" y2="${H - B}" class="cross" style="display:none"/><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="rxHit"/></svg><div id="rxTip" class="tip" hidden></div>`;
  box.innerHTML = svg;

  const tip = $('#rxTip'), cross = $('#rxCross');
  const nearest = (arr, t) => arr.reduce((b, p) => (Math.abs(p[0] - t) < Math.abs(b[0] - t) ? p : b), arr[0]);
  const move = (ev) => {
    const rect = box.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const t = x0 + ((px - L) / (W - L - R)) * (x1 - x0);
    const ref = nearest(series[0].chart, t);
    cross.setAttribute('x1', X(ref[0])); cross.setAttribute('x2', X(ref[0])); cross.style.display = '';
    const rel = (ref[0] - anchor) / 3600;
    tip.innerHTML = `<div class="note">${fmt(new Date(ref[0] * 1000).toISOString())}（${rel >= 0 ? '+' : ''}${rel.toFixed(0)}h）</div>` +
      series.map((r, i) => { const p = nearest(r.chart, ref[0]); return `<div><i style="background:${SERIES[i]}"></i>${esc(r.name)} <b>${p[1] > 0 ? '+' : ''}${p[1].toFixed(2)}%</b></div>`; }).join('');
    tip.hidden = false;
    const left = Math.min(px + 12, W - 190);
    tip.style.left = left + 'px'; tip.style.top = '8px';
  };
  const hit = $('#rxHit');
  hit.addEventListener('mousemove', move);
  hit.addEventListener('mouseleave', () => { tip.hidden = true; cross.style.display = 'none'; });
}

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
}

// ---------- 模型校准统计 ----------

async function showCalibration() {
  state.selected = null;
  document.querySelectorAll('.card').forEach((c) => c.classList.remove('sel'));
  const c = (await api('/api/calibration')) || (await loadDemo()).calibration;
  const pct = (v) => (v === null || v === undefined ? '—' : Math.round(v * 100) + '%');
  $('#detail').innerHTML = `<div class="d-head"><div><h2>模型校准统计</h2><div class="meta">基于 ${c.events} 个有行情数据的事件</div></div></div>
    <div class="tiles">
      <div class="tile"><span>方向命中率</span><b>${pct(c.direction.hit_rate)}</b><em>命中 ${c.direction.hits} · 相反 ${c.direction.misses} · 不显著 ${c.direction.insignificant}</em></div>
      <div class="tile"><span>市场冲击偏差</span><b>${c.market_shock.bias ?? '—'}</b><em>模型分 − 实测分；负数＝模型低估</em></div>
      <div class="tile"><span>平均绝对误差</span><b>${c.market_shock.mae ?? '—'}</b><em>${c.market_shock.n} 个事件，0–5 分制</em></div>
    </div>
    <div class="box"><h4>按资产</h4><table><thead><tr><th>资产</th><th>命中</th><th>相反</th><th>命中率</th></tr></thead><tbody>
      ${c.by_instrument.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.hit}</td><td class="num">${i.miss}</td><td class="num">${pct(i.hit_rate)}</td></tr>`).join('') || '<tr><td colspan="4" class="note">暂无数据</td></tr>'}
    </tbody></table></div>
    <div class="box"><h4>怎么用这些数字</h4><ul class="plain">
      <li>偏差长期为负，说明模型习惯低估市场冲击，可以在提示词里提醒它，或调整 <code>observedShockScore</code> 的刻度。</li>
      <li>某个资产命中率接近 50%，说明模型在这个资产上和抛硬币差不多，可以考虑不让它预测这个资产的方向。</li>
      <li>样本少于 30 个事件时，这些比例波动很大，先别据此调参。</li>
    </ul></div>`;
}

let map;
function drawMap(regions) {
  const box = $('#map');
  if (!window.L || !regions.length) {
    box.style.display = 'none';
    return;
  }
  if (map) map.remove();
  map = L.map(box, { scrollWheelZoom: false, attributionControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 8,
  }).addTo(map);
  const col = { 发源地: '#e03a4f', 直接影响: '#e0663a', 间接影响: '#3d8bd9' };
  const pts = regions
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .map((r) => {
      L.circleMarker([r.lat, r.lon], { radius: r.role === '发源地' ? 10 : 7, color: col[r.role] || '#888', fillOpacity: 0.5, weight: 2 })
        .bindTooltip(`${esc(r.role)} · ${esc(r.name)}${r.note ? '<br>' + esc(r.note) : ''}`)
        .addTo(map);
      return [r.lat, r.lon];
    });
  if (pts.length === 1) map.setView(pts[0], 4);
  else map.fitBounds(pts, { padding: [30, 30], maxZoom: 5 });
}

async function select(id) {
  state.selected = id;
  document.querySelectorAll('.card[data-id]').forEach((c) => c.classList.toggle('sel', Number(c.dataset.id) === id));
  const d = await fetchDetail(id);
  if (d) renderDetail(d);
  else $('#detail').innerHTML = '<div class="empty">事件不存在</div>';
  if (window.matchMedia('(max-width: 860px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
}

// =====================================================================
// 品种视图
// =====================================================================

async function fetchInstruments() {
  return (await api('/api/instruments')) || (await loadDemo()).instruments;
}
async function fetchInstrument(key) {
  return (await api('/api/instruments/' + key)) || (await loadDemo()).instrumentDetails[key];
}

const sign = (v, d = 2) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const fmtPrice = (v) => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v), a = Math.abs(n);
  return a >= 1000 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toFixed(a >= 10 ? 2 : 3);
};

function miniSpark(vals) {
  if (!vals || vals.length < 2) return '<svg class="mini"></svg>';
  const W = 72, H = 22, lo = Math.min(...vals), hi = Math.max(...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)).toFixed(1)}`).join(' ');
  const color = vals.at(-1) >= vals[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

async function renderInstrumentList() {
  const list = (state.instruments = await fetchInstruments());
  const el = $('#list');
  const shown = list.filter((i) => !state.sector || i.sector === state.sector);
  el.innerHTML = SECTORS.filter((sec) => shown.some((i) => i.sector === sec))
    .map((sec) => `<div class="group">${sec}</div>` + shown.filter((i) => i.sector === sec).map((i) => `
      <article class="irow ${state.inst === i.key ? 'sel' : ''}" data-key="${esc(i.key)}" tabindex="0">
        <div class="iname"><b>${esc(i.name)}</b><span class="note">${esc(i.contract && i.contract !== 'cont' ? i.contract : i.root)}</span></div>
        ${miniSpark(i.spark)}
        <div class="iprice"><b>${fmtPrice(i.stats?.last)}</b><span class="${cls(i.stats?.chg_1d_pct)}">${sign(i.stats?.chg_1d_pct)}</span></div>
        ${i.brief ? `<p class="ihead">${esc(i.brief.headline)}</p>` : ''}
      </article>`).join(''))
    .join('') || '<div class="empty">暂无行情数据</div>';
  const first = shown.find((i) => i.brief) || shown[0]; // 优先打开已有 AI 解读的品种
  if (!state.inst && first && window.matchMedia('(min-width: 861px)').matches) location.replace(`#i-${first.key}`);
}

async function selectInstrument(key) {
  state.inst = key;
  document.querySelectorAll('.irow').forEach((c) => c.classList.toggle('sel', c.dataset.key === key));
  const d = await fetchInstrument(key);
  if (!d) {
    $('#detail').innerHTML = '<div class="empty">品种不存在</div>';
    return;
  }
  renderInstrument(d);
  if (window.matchMedia('(max-width: 860px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
}

function renderInstrument(d) {
  const { instrument: inst, snapshot: snap, brief: b, events, hit_rate: hr } = d;
  const st = snap?.stats;
  const cm = snap?.curve?.metrics;
  const tile = (label, v, sub = '', c = '') => `<div class="tile"><span>${label}</span><b class="${c}">${v}</b><em>${sub}</em></div>`;
  $('#detail').innerHTML = `
  <div class="d-head">
    <div>
      <h2>${esc(inst.name)} <span class="sub2">${esc(inst.root)} · ${esc(inst.exchange)}</span></h2>
      <div class="meta"><span class="tag sec">${esc(inst.sector)}</span>
        <span>跟踪合约 ${esc(snap?.contract && snap.contract !== 'cont' ? snap.contract : '连续合约')}</span>
        <span>单位 ${esc(inst.unit)}</span><span>行情更新 ${fmt(snap?.updated_at)}</span></div>
    </div>
    <div class="big px"><div class="n">${fmtPrice(st?.last)}</div><div class="l ${cls(st?.chg_1d_pct)}">${sign(st?.chg_1d_pct)} 日</div></div>
  </div>
  ${st ? `<div class="tiles t4">
    ${tile('5 日', sign(st.chg_5d_pct), '', cls(st.chg_5d_pct))}
    ${tile('20 日', sign(st.chg_20d_pct), '', cls(st.chg_20d_pct))}
    ${tile('20 日年化波动率', st.vol_20d_ann_pct === null ? '—' : st.vol_20d_ann_pct + '%', '')}
    ${tile('3 个月区间位置', st.range_3m.position_pct + '%', `${fmtPrice(st.range_3m.low)} – ${fmtPrice(st.range_3m.high)}`)}
  </div>` : '<div class="box"><p class="note">行情数据不足。部署后运行一次期限结构更新和行情回填。</p></div>'}

  <div class="grid2">
    <div class="box"><h4>价格走势（日收盘，近 90 天）</h4><div id="pxChart" class="rx" role="img" aria-label="${esc(inst.name)} 日收盘价"></div>
      <p class="note">${esc(st?.trend || '')}${st?.ma20 ? ` · 20日均线 ${fmtPrice(st.ma20)}` : ''}${st?.ma60 ? ` · 60日均线 ${fmtPrice(st.ma60)}` : ''}</p></div>
    <div class="box"><h4>期限结构</h4>
      ${cm ? `<div id="curveChart" class="rx" role="img" aria-label="各合约月份价格"></div>
        <p class="note"><b class="${cm.structure.startsWith('贴水') ? 'up' : cm.structure.startsWith('升水') ? 'down' : ''}">${esc(cm.structure)}</b> · ${esc(cm.front)}→${esc(cm.next)} 价差 ${sign(cm.spread_pct)} · 多头展期年化 ${sign(cm.roll_yield_ann_pct, 1)}</p>`
        : '<p class="note">暂无期限结构数据（每天美盘收盘后更新）。</p>'}
    </div>
  </div>

  ${b ? `<div class="box brief">
    <h4>AI 行情解读 · ${esc(b.day)} <span class="nb">不构成投资建议</span></h4>
    <h3>${esc(b.headline)} <span class="tag">${esc(b.price_action)}</span></h3>
    <p class="summary">${esc(b.summary)}</p>
    <div class="drivers">${(b.drivers || []).map((x) => `<div class="drv">
        <span class="eff ${EFFECT_CLASS[x.effect] || 'flat'}">${esc(x.effect)}</span>
        <div><b>${esc(x.factor)}</b> <span class="note">${esc(x.strength)} · ${esc(x.basis)}</span>
          ${(x.event_ids || []).map((id) => `<a class="ref" href="#e-${id}">事件#${id}</a>`).join(' ')}
          ${x.note ? `<p>${esc(x.note)}</p>` : ''}</div></div>`).join('')}</div>
    <div class="grid2 tight">
      <div><h5>期限结构解读</h5><p>${esc(b.term_structure)}</p></div>
      <div><h5>风险</h5><ul class="plain">${(b.risks || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>
    </div>
    <h5>接下来关注</h5><ul class="plain">${(b.watch || []).map((w) => `<li><b>${esc(w.item)}</b> <span class="note">${esc(w.why)}</span></li>`).join('')}</ul>
    <p class="note">由 ${esc(b.model)} 生成于 ${fmt(b.created_at)}。行情数字由系统计算，模型只负责归因。</p>
  </div>` : '<div class="box"><h4>AI 行情解读</h4><p class="note">今天的解读还没生成（每天美盘收盘后生成）。</p></div>'}

  <div class="box"><h4>相关事件（近 14 天）</h4>
    ${events?.length ? `<table><thead><tr><th>事件</th><th>严重性</th><th>对本品种</th><th>逻辑</th></tr></thead><tbody>
      ${events.map((e) => `<tr><td><a href="#e-${e.id}">${esc(e.title)}</a></td><td><span class="lvchip lv-${esc(e.level)}">${Math.round(e.severity)} ${esc(e.level)}</span></td>
        <td class="dir-${esc(e.direction)}">${DIR_ICON[e.direction] || ''} ${esc(e.direction)}${e.horizon ? ` · ${esc(e.horizon)}` : ''}</td><td class="note">${esc(e.rationale || '')}</td></tr>`).join('')}
    </tbody></table>` : '<p class="note">近 14 天没有涉及本品种的已分析事件。</p>'}
    <p class="note">模型过往对本品种的方向判断：命中 ${hr?.hit ?? 0} · 相反 ${hr?.miss ?? 0} · 不显著 ${hr?.insignificant ?? 0}${hr?.hit_rate !== null && hr?.hit_rate !== undefined ? ` · 命中率 ${Math.round(hr.hit_rate * 100)}%` : ''}</p>
  </div>
  <p class="disclaimer">${DISCLAIMER}</p>`;

  drawPriceChart(snap?.daily || [], inst);
  if (cm) drawCurveChart(snap.curve.points);
}

function drawPriceChart(daily, inst) {
  const box = $('#pxChart');
  if (!box || daily.length < 2) return;
  const W = Math.max(300, box.clientWidth), H = 200, L = 60, R = 12, T = 10, B = 24;
  const xs = daily.map((d) => d[0]), ys = daily.map((d) => d[1]);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad; hi += pad;
  const X = (t) => L + ((t - xs[0]) / (xs.at(-1) - xs[0] || 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let svg = `<svg width="${W}" height="${H}">`;
  for (const t of niceTicks(lo, hi, 4)) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${L - 6}" y="${Y(t) + 4}" class="ax" text-anchor="end">${fmtPrice(t)}</text>`;
  const ticks = [0, Math.floor(daily.length / 2), daily.length - 1];
  for (const i of ticks) svg += `<text x="${X(xs[i])}" y="${H - 6}" class="ax" text-anchor="${i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}">${new Date(xs[i] * 1000).toISOString().slice(5, 10)}</text>`;
  svg += `<path d="${daily.map((d, i) => `${i ? 'L' : 'M'}${X(d[0]).toFixed(1)},${Y(d[1]).toFixed(1)}`).join('')}" fill="none" stroke="${SERIES[0]}" stroke-width="2" stroke-linejoin="round"/>`;
  svg += `<line id="pxCross" y1="${T}" y2="${H - B}" class="cross" style="display:none"/><circle id="pxDot" r="4" fill="${SERIES[0]}" style="display:none"/>`;
  svg += `<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="pxHit"/></svg><div id="pxTip" class="tip" hidden></div>`;
  box.innerHTML = svg;
  const tip = $('#pxTip'), cross = $('#pxCross'), dot = $('#pxDot');
  $('#pxHit').addEventListener('mousemove', (ev) => {
    const px = ev.clientX - box.getBoundingClientRect().left;
    const t = xs[0] + ((px - L) / (W - L - R)) * (xs.at(-1) - xs[0]);
    const i = xs.reduce((b, x, k) => (Math.abs(x - t) < Math.abs(xs[b] - t) ? k : b), 0);
    const prev = i > 0 ? ys[i - 1] : null;
    cross.setAttribute('x1', X(xs[i])); cross.setAttribute('x2', X(xs[i])); cross.style.display = '';
    dot.setAttribute('cx', X(xs[i])); dot.setAttribute('cy', Y(ys[i])); dot.style.display = '';
    tip.innerHTML = `<div class="note">${new Date(xs[i] * 1000).toISOString().slice(0, 10)}</div><div><b>${fmtPrice(ys[i])}</b> ${esc(inst.unit)}${prev ? ` <span class="${cls(ys[i] - prev)}">${sign((ys[i] / prev - 1) * 100)}</span>` : ''}</div>`;
    tip.hidden = false;
    tip.style.left = Math.min(px + 12, W - 170) + 'px'; tip.style.top = '8px';
  });
  $('#pxHit').addEventListener('mouseleave', () => { tip.hidden = true; cross.style.display = 'none'; dot.style.display = 'none'; });
}

function drawCurveChart(points) {
  const box = $('#curveChart');
  if (!box || points.length < 2) return;
  const W = Math.max(300, box.clientWidth), H = 200, L = 56, R = 30, T = 18, B = 34;
  const ys = points.map((p) => p.close);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.25;
  lo -= pad; hi += pad;
  const X = (i) => L + (i / (points.length - 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let svg = `<svg width="${W}" height="${H}">`;
  for (const t of niceTicks(lo, hi, 4)) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${L - 6}" y="${Y(t) + 4}" class="ax" text-anchor="end">${fmtPrice(t)}</text>`;
  svg += `<path d="${points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.close).toFixed(1)}`).join('')}" fill="none" stroke="${SERIES[0]}" stroke-width="2"/>`;
  points.forEach((p, i) => {
    svg += `<circle cx="${X(i)}" cy="${Y(p.close)}" r="5" fill="${SERIES[0]}" stroke="var(--panel)" stroke-width="2"><title>${esc(p.contract)}（${esc(p.month)}）${fmtPrice(p.close)}</title></circle>`;
    svg += `<text x="${X(i)}" y="${H - 18}" class="ax" text-anchor="middle">${esc(p.contract)}</text><text x="${X(i)}" y="${H - 5}" class="ax" text-anchor="middle">${esc(p.month.slice(2))}</text>`;
    if (i === 0 || i === points.length - 1) svg += `<text x="${X(i)}" y="${Y(p.close) - 10}" class="lbl" text-anchor="${i === 0 ? 'start' : 'end'}">${fmtPrice(p.close)}</text>`;
  });
  box.innerHTML = svg + '</svg>';
}

// =====================================================================
// 路由与事件绑定
// =====================================================================

function setView(view) {
  state.view = view;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  $('#evFilters').hidden = view !== 'events';
}

async function renderSide() {
  if (state.view === 'events') await renderEventList();
  else await renderInstrumentList();
}

async function route() {
  const h = location.hash.slice(1);
  if (h === 'calibration') {
    setView('calibration');
    state.selected = null;
    state.inst = null;
    await renderEventList();
    return showCalibration();
  }
  if (h === 'events' || h.startsWith('e-')) {
    const prev = state.view;
    setView('events');
    state.selected = h.startsWith('e-') ? Number(h.slice(2)) : null;
    if (prev !== 'events' || !document.querySelector('.card[data-id]')) await renderEventList();
    if (state.selected) select(state.selected);
    return;
  }
  const prev = state.view;
  setView('instruments');
  state.inst = h.startsWith('i-') ? h.slice(2) : null;
  if (prev !== 'instruments' || !document.querySelector('.irow')) await renderInstrumentList();
  if (state.inst) selectInstrument(state.inst);
  else if (!window.matchMedia('(min-width: 861px)').matches) $('#detail').innerHTML = '<div class="empty">选择一个品种查看行情与 AI 解读</div>';
}

$('#domainChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.sector = b.dataset.d || null;
  renderChips();
  if (state.view === 'instruments') state.inst = null;
  if (state.view === 'events') state.selected = null;
  renderSide();
});
$('#minSev').addEventListener('input', (e) => {
  state.min = Number(e.target.value);
  $('#minVal').textContent = state.min;
});
$('#minSev').addEventListener('change', renderEventList);
$('#watch').addEventListener('change', (e) => {
  state.watch = e.target.checked;
  renderEventList();
});
const openFromList = (el) => {
  const c = el.closest('.card[data-id], .irow');
  if (!c) return false;
  location.hash = c.dataset.id ? `e-${c.dataset.id}` : `i-${c.dataset.key}`;
  return true;
};
$('#list').addEventListener('click', (e) => openFromList(e.target));
$('#list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && openFromList(e.target)) e.preventDefault();
});
window.addEventListener('hashchange', route);

renderChips();
route();
setInterval(renderSide, 5 * 60e3);
