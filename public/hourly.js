// 小时行情与"未来一小时风险展望"（依赖 app.js / tools.js 中的 esc、fmt、fmtPrice、sign、cls、api、loadDemo、state、SHORT）
// 展望是统计波动区间，不是涨跌预测。

const OUTLOOK_NOTE = '区间由近 70 天同一时段的历史波动率估算（含数据发布时段的放大），表示"价格大概率在这个范围内波动"，不代表方向判断。';

async function fetchOutlook() {
  return (await api('/api/outlook')) || (await loadDemo()).outlook || null;
}
async function fetchIntraday(key) {
  return (await api(`/api/instruments/${encodeURIComponent(key)}/intraday?hours=24`)) || (await loadDemo()).intraday?.[key] || null;
}
async function fetchHourly(key) {
  return (await api(`/api/instruments/${encodeURIComponent(key)}/hourly?hours=72`)) || (await loadDemo()).hourly?.[key] || null;
}

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—');
const pctTxt = (v) => (v === null || v === undefined ? '—' : `±${Number(v).toFixed(2)}%`);
const rateTxt = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
/** 命中率与名义水平的差距：±5 个百分点以内算校准良好 */
const rateCls = (v, target) => (v === null || v === undefined ? 'note' : Math.abs(v - target) <= 0.05 ? 'rgood' : 'rwarn');

function windowLabel(o) {
  return `${hhmm(o.window_start)}–${hhmm(o.window_end)}`;
}

// ---------------------------------------------------------------------
// 总览：未来一小时风险展望表
// ---------------------------------------------------------------------
function outlookOverviewHtml(ol, visibleKeys) {
  if (!ol) return '';
  const rows = ol.instruments.filter((i) => visibleKeys.has(i.instrument));
  const t = ol.track?.overall;
  const cur = ol.instruments.find((i) => i.window_start);
  const body = rows.map((o) => {
    if (!o.window_start) {
      return `<tr><td><a href="#i-${esc(o.instrument)}">${esc(SHORT[o.instrument] || o.name)}</a></td><td colspan="5" class="note">${o.status === 'closed' ? '本小时休市' : '等待整点生成'}</td></tr>`;
    }
    const ev = (o.events || []).map((e) => `<span class="evchip" title="${esc(e.title)} ${hhmm(e.ts)}">${esc(e.title.replace(/（.*?）/g, ''))} ${hhmm(e.ts)}</span>`).join('');
    return `<tr${o.status === 'previous' ? ' class="stale"' : ''}>
      <td><a href="#i-${esc(o.instrument)}">${esc(SHORT[o.instrument] || o.name)}</a></td>
      <td class="r mono">${fmtPrice(o.base_price)}<div class="note small">${hhmm(o.base_time)}</div></td>
      <td>${rangeBar(o)}</td>
      <td class="r mono">${pctTxt(o.width68_pct)}<div class="note small">95% ${pctTxt(o.width95_pct)}</div></td>
      <td>${ev || '<span class="note">—</span>'}${o.regime >= 1.25 ? ' <span class="evchip hot" title="近 24 小时实际波动高于长期水平">波动偏高</span>' : ''}</td>
      <td class="aiw">${o.ai ? esc(o.ai.watch) : '<span class="note">—</span>'}</td>
    </tr>`;
  }).join('');
  return `<div class="box"><h4>未来一小时风险展望 <span class="note">${cur ? `窗口 ${windowLabel(cur)} · ` : ''}统计波动区间，不预测涨跌</span></h4>
    <div class="tablewrap"><table class="olt">
      <thead><tr><th>品种</th><th class="r">基准价</th><th>68% / 95% 区间</th><th class="r">68% 幅度</th><th>本小时数据发布</th><th>AI：本小时关注</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="note">${OUTLOOK_NOTE} 基准价有 10–30 分钟延迟。区间命中记录（近 30 天）：68% 区间 <b class="${rateCls(t?.hit68, 0.683)}">${rateTxt(t?.hit68)}</b>，95% 区间 <b class="${rateCls(t?.hit95, 0.954)}">${rateTxt(t?.hit95)}</b>，共 ${t?.n ?? 0} 次 · <a href="#calibration">详情</a></p>
  </div>`;
}

/** 横向区间条：95%（浅）、68%（深）、基准价（竖线）；已核对的窗口再标出实际价格 */
function rangeBar(o) {
  const lo = o.lo95, hi = o.hi95, span = hi - lo || 1;
  const X = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const act = o.actual !== null && o.actual !== undefined ? `<i class="act ${o.hit68 ? '' : 'miss'}" style="left:${X(o.actual)}%" title="实际 ${fmtPrice(o.actual)}"></i>` : '';
  return `<div class="rbar" title="68%: ${fmtPrice(o.lo68)} – ${fmtPrice(o.hi68)}；95%: ${fmtPrice(o.lo95)} – ${fmtPrice(o.hi95)}">
    <span class="b95"></span><span class="b68" style="left:${X(o.lo68)}%;width:${X(o.hi68) - X(o.lo68)}%"></span><i class="base" style="left:${X(o.base_price)}%"></i>${act}
    <em class="l">${fmtPrice(o.lo68)}</em><em class="h">${fmtPrice(o.hi68)}</em></div>`;
}

// ---------------------------------------------------------------------
// 品种详情：小时K线 + 本小时展望 + 逐时涨跌 + 命中记录
// ---------------------------------------------------------------------
function hourlyPlaceholder() {
  return '<div id="hourlyBox"><div class="box"><h4>小时行情</h4><p class="note">加载中…</p></div></div>';
}

async function loadHourlyBox(inst) {
  const el = $('#hourlyBox');
  if (!el) return;
  const d = await fetchHourly(inst.key);
  if (state.inst !== inst.key || !$('#hourlyBox')) return; // 用户已切换品种
  if (!d || !d.candles?.length) {
    el.innerHTML = '<div class="box"><h4>小时行情</h4><p class="note">暂无小时数据。</p></div>';
    return;
  }
  const o = d.current;
  const last = d.candles.at(-1);
  const tr = d.track?.by_instrument?.[0];
  el.innerHTML = `<div class="box"><h4><span id="tfTitle">小时K线</span> <span class="note" id="tfNote"></span>
        <span class="tfsw" role="tablist"><button data-tf="5m">5 分钟</button><button data-tf="1h" class="on">1 小时</button></span></h4>
      <div id="hrChart" class="rx" role="img" aria-label="${esc(inst.name)} K线"></div>
      ${hourGrid(d.candles.slice(-24))}
    </div>
    <div class="grid2">
      <div class="box"><h4>未来一小时风险展望 <span class="nb">不构成投资建议</span></h4>${outlookCard(o, d.session_open)}</div>
      <div class="box"><h4>区间命中记录 <span class="note">近 30 天 · 本品种</span></h4>${trackCard(tr, d.history)}${profileChart(d.hour_profile)}</div>
    </div>`;
  const show = async (tf) => {
    document.querySelectorAll('.tfsw button').forEach((b) => b.classList.toggle('on', b.dataset.tf === tf));
    if (tf === '1h') {
      $('#tfTitle').textContent = '小时K线';
      $('#tfNote').textContent = `近 72 小时 · 合约 ${d.contract || '—'} · 右侧阴影为本小时 68%/95% 统计区间`;
      return drawCandles($('#hrChart'), d.candles, o, inst, '1h');
    }
    $('#tfTitle').textContent = '5 分钟K线';
    $('#tfNote').textContent = '加载中…';
    const m = await fetchIntraday(inst.key);
    if (state.inst !== inst.key) return;
    if (!m?.candles?.length) {
      $('#tfNote').textContent = '';
      $('#hrChart').innerHTML = '<p class="note">暂无 5 分钟数据（部署后每 5 分钟开始累积，保留 7 天）。</p>';
      return;
    }
    $('#tfNote').textContent = `近 24 小时 · 合约 ${m.contract || '—'} · 每 5 分钟更新，交易所延迟 10–30 分钟`;
    drawCandles($('#hrChart'), m.candles, o, inst, '5m');
  };
  document.querySelectorAll('.tfsw button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tf)));
  show('1h');
}

function hourGrid(cs) {
  return `<div class="hgrid">${cs.map((c) => `<div class="hc2" style="${heat(c.chg_pct, 1)}" title="${new Date(c.t * 1000).toLocaleString('zh-CN')}  收 ${fmtPrice(c.c)}">
      <span>${new Date(c.t * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit' }).replace(/时$/, '')}${c.partial ? '*' : ''}</span><b class="mono">${c.chg_pct === null ? '—' : sign(c.chg_pct)}</b></div>`).join('')}</div>
    <p class="note small">逐时涨跌（本地时间，按开盘时刻标注；* 为尚未收盘的一小时）。</p>`;
}

function outlookCard(o, open) {
  if (!o) return `<p class="note">${open ? '本小时的区间将在整点后几分钟内生成。' : '本小时休市，开盘后的第一个整点开始生成。'}</p>`;
  const ai = o.ai;
  return `<div class="olc">
    <div class="olc-h"><span>窗口 <b>${windowLabel(o)}</b></span><span>基准价 <b class="mono">${fmtPrice(o.base_price)}</b> <span class="note">（${hhmm(o.base_time)}，延迟约 ${o.stale_min ?? '—'} 分钟）</span></span></div>
    ${rangeBar(o)}
    <table class="kv"><tbody>
      <tr><td>68% 区间</td><td class="mono">${fmtPrice(o.lo68)} – ${fmtPrice(o.hi68)}</td><td class="note">${pctTxt(o.width68_pct)}</td></tr>
      <tr><td>95% 区间</td><td class="mono">${fmtPrice(o.lo95)} – ${fmtPrice(o.hi95)}</td><td class="note">${pctTxt(o.width95_pct)}</td></tr>
      <tr><td>波动状态</td><td class="mono">${o.regime}×</td><td class="note">近 24 小时实际波动 ÷ 长期水平</td></tr>
      ${(o.events || []).map((e) => `<tr><td>数据发布</td><td>${esc(e.title)}</td><td class="note">${hhmm(e.ts)}${o.event_adj ? ` · 区间放大 ${o.event_adj.factor}×（${esc(o.event_adj.basis)}）` : ''}</td></tr>`).join('')}
    </tbody></table>
    ${ai ? `<div class="scen">
      <p class="note">${esc(ai.context)}</p>
      <div class="sc up"><b>上行情景</b>${esc(ai.upside)}</div>
      <div class="sc down"><b>下行情景</b>${esc(ai.downside)}</div>
      <p><span class="note">本小时关注：</span>${esc(ai.watch)}</p>
    </div>` : '<p class="note">本小时没有 AI 情景。为了让解读有内容，AI 只在以下情况撰写：本小时有数据发布、近 24 小时波动偏高、有相关新闻，以及每天两个固定时段（美东 18:00 夜盘开盘、9:00 美股开盘前）。统计区间每小时都会更新。</p>'}
    <p class="note small">${OUTLOOK_NOTE} 情景由 AI 根据行情和新闻撰写，两个方向都会列出，不判断哪个更可能发生。</p>
  </div>`;
}

function trackCard(tr, history) {
  const dots = (history || []).slice().reverse().map((h) => `<i class="dot ${h.hit68 === null ? 'na' : h.hit68 ? 'in' : h.hit95 ? 'mid' : 'out'}" title="${windowLabel(h)} 实际 ${fmtPrice(h.actual)}（68%: ${fmtPrice(h.lo68)}–${fmtPrice(h.hi68)}）"></i>`).join('');
  return `<div class="tiles t2">
      <div class="tile"><span>68% 区间命中</span><b class="${rateCls(tr?.hit68, 0.683)}">${rateTxt(tr?.hit68)}</b><em>目标约 68% · ${tr?.n ?? 0} 次</em></div>
      <div class="tile"><span>95% 区间命中</span><b class="${rateCls(tr?.hit95, 0.954)}">${rateTxt(tr?.hit95)}</b><em>目标约 95%${tr?.n ? ` · 向上越界 ${tr.above68} · 向下 ${tr.below68}` : ''}</em></div>
    </div>
    ${dots ? `<div class="dots">${dots}</div><p class="note small">最近 24 个窗口：<i class="dot in"></i>落在 68% 区间 <i class="dot mid"></i>落在 95% 区间 <i class="dot out"></i>超出 95% <i class="dot na"></i>无法核对</p>` : '<p class="note">还没有已核对的窗口（每个窗口结束约 30 分钟后核对）。</p>'}`;
}

/** 各时段（美东）的典型小时波动 */
function profileChart(prof) {
  if (!prof?.length) return '';
  const max = Math.max(...prof.map((p) => p.sigma_pct)) || 1;
  return `<h5>各时段典型波动 <span class="note">美东时间 · 1 小时标准差</span></h5><div class="prof">${prof.map((p) => `<div title="${p.hour}:00 ET · ${p.sigma_pct.toFixed(3)}% · ${p.n} 个样本"><b style="height:${Math.max(2, (p.sigma_pct / max) * 100)}%;opacity:${p.n ? 1 : 0.35}"></b><span>${p.hour % 6 === 0 ? p.hour : ''}</span></div>`).join('')}</div>`;
}

function drawCandles(box, cs, o, inst, tf = '1h') {
  if (!box || cs.length < 2) return;
  const W = Math.max(320, box.clientWidth), H = 230, L = 60, R = 12, T = 10, B = 24;
  const extra = o ? 3 : 0; // 右侧留出展望区间的位置
  const n = cs.length + extra;
  let lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
  if (o) { lo = Math.min(lo, o.lo95); hi = Math.max(hi, o.hi95); }
  const pad = (hi - lo || 1) * 0.06;
  lo -= pad; hi += pad;
  const step = (W - L - R) / n;
  const X = (i) => L + (i + 0.5) * step;
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const bw = Math.max(1.5, Math.min(9, step * 0.65));
  let svg = `<svg width="${W}" height="${H}">`;
  for (const t of niceTicks(lo, hi, 4)) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/><text x="${L - 6}" y="${Y(t) + 4}" class="ax" text-anchor="end">${fmtPrice(t)}</text>`;
  // 时间轴：小时K线在每天 0 点（本地时间）画分隔线并标日期；5 分钟K线每 2 小时标一次时刻
  cs.forEach((c, i) => {
    const d = new Date(c.t * 1000);
    const newDay = i > 0 && d.getDate() !== new Date(cs[i - 1].t * 1000).getDate();
    if (newDay) svg += `<line x1="${X(i) - step / 2}" x2="${X(i) - step / 2}" y1="${T}" y2="${H - B}" class="grid"/>`;
    if (tf === '1h' && newDay) svg += `<text x="${X(i) - step / 2 + 3}" y="${H - 6}" class="ax">${d.getMonth() + 1}/${d.getDate()}</text>`;
    if (tf === '5m' && d.getMinutes() === 0 && d.getHours() % 2 === 0 && X(i) > L + 20 && X(i) < W - R - 20) {
      svg += `<text x="${X(i)}" y="${H - 6}" class="ax" text-anchor="middle">${newDay || d.getHours() === 0 ? `${d.getMonth() + 1}/${d.getDate()} ` : ''}${String(d.getHours()).padStart(2, '0')}:00</text>`;
    }
  });
  if (o) {
    const x0 = X(cs.length) - step / 2, x1 = W - R;
    svg += `<rect x="${x0}" width="${x1 - x0}" y="${Y(o.hi95)}" height="${Y(o.lo95) - Y(o.hi95)}" fill="color-mix(in srgb, var(--accent) 12%, transparent)"/>`;
    svg += `<rect x="${x0}" width="${x1 - x0}" y="${Y(o.hi68)}" height="${Y(o.lo68) - Y(o.hi68)}" fill="color-mix(in srgb, var(--accent) 26%, transparent)"/>`;
    svg += `<line x1="${x0}" x2="${x1}" y1="${Y(o.base_price)}" y2="${Y(o.base_price)}" stroke="var(--accent)" stroke-dasharray="3 3"/>`;
    svg += `<text x="${(x0 + x1) / 2}" y="${T + 10}" class="ax" text-anchor="middle">本小时</text>`;
  }
  cs.forEach((c, i) => {
    const up = c.c >= c.o, col = up ? 'var(--up)' : 'var(--down)';
    const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
    svg += `<line x1="${X(i)}" x2="${X(i)}" y1="${Y(c.h)}" y2="${Y(c.l)}" stroke="${col}"/>`;
    svg += `<rect x="${X(i) - bw / 2}" width="${bw}" y="${y1}" height="${Math.max(1, y2 - y1)}" fill="${up ? 'transparent' : col}" stroke="${col}" ${c.partial ? 'stroke-dasharray="2 2"' : ''}/>`;
  });
  svg += `<line id="hrCross" y1="${T}" y2="${H - B}" class="cross" style="display:none"/><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="hrHit"/></svg><div id="hrTip" class="tip" hidden></div>`;
  box.innerHTML = svg;
  const tip = $('#hrTip'), cross = $('#hrCross');
  $('#hrHit').addEventListener('mousemove', (ev) => {
    const px = ev.clientX - box.getBoundingClientRect().left;
    const i = Math.max(0, Math.min(cs.length - 1, Math.floor((px - L) / step)));
    const c = cs[i];
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.style.display = '';
    tip.innerHTML = `<div class="note">${new Date(c.t * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${c.partial ? '（未收盘）' : ''}</div>
      <div class="mono">开 ${fmtPrice(c.o)} 高 ${fmtPrice(c.h)}<br>低 ${fmtPrice(c.l)} 收 ${fmtPrice(c.c)} ${c.chg_pct !== null ? `<span class="${cls(c.chg_pct)}">${sign(c.chg_pct)}</span>` : ''}</div>`;
    tip.hidden = false;
    tip.style.left = Math.min(px + 12, W - 190) + 'px'; tip.style.top = '8px';
  });
  $('#hrHit').addEventListener('mouseleave', () => { tip.hidden = true; cross.style.display = 'none'; });
}

// ---------------------------------------------------------------------
// 模型校准页：区间命中率
// ---------------------------------------------------------------------
async function outlookTrackHtml() {
  const tr = (await api('/api/outlook/track?days=30')) || (await loadDemo()).outlook?.track;
  if (!tr) return '';
  const o = tr.overall;
  return `<div class="box"><h4>一小时风险区间命中率 <span class="note">近 ${tr.days} 天</span></h4>
    <div class="tiles">
      <div class="tile"><span>68% 区间</span><b class="${rateCls(o.hit68, tr.target68)}">${rateTxt(o.hit68)}</b><em>目标 68% · ${o.n} 次</em></div>
      <div class="tile"><span>95% 区间</span><b class="${rateCls(o.hit95, tr.target95)}">${rateTxt(o.hit95)}</b><em>目标 95%</em></div>
      <div class="tile"><span>怎么看</span><p class="tilep">接近目标＝区间可信；明显偏低＝低估了波动；明显偏高＝区间太宽</p></div>
    </div>
    <table><thead><tr><th>品种</th><th class="r">次数</th><th class="r">68% 命中</th><th class="r">95% 命中</th><th class="r">向上越界</th><th class="r">向下越界</th></tr></thead><tbody>
      ${tr.by_instrument.map((i) => `<tr><td><a href="#i-${esc(i.key)}">${esc(i.name)}</a></td><td class="r mono">${i.n}</td>
        <td class="r mono ${rateCls(i.hit68, tr.target68)}">${rateTxt(i.hit68)}</td><td class="r mono ${rateCls(i.hit95, tr.target95)}">${rateTxt(i.hit95)}</td>
        <td class="r mono">${i.n ? i.above68 : '—'}</td><td class="r mono">${i.n ? i.below68 : '—'}</td></tr>`).join('')}
    </tbody></table>
    <p class="note">每个整点为开盘品种生成本小时的统计区间，窗口结束、延迟行情到达后自动用实际价格核对。越界次数明显偏向一侧，说明这段时间有单边行情，而不是区间算错。样本少于 100 次时比例波动较大。</p>
  </div>`;
}

// ---------------------------------------------------------------------
// 最新价：后台每 5 分钟抓一次，页面每分钟检查一次，有新报价就原地更新数字（不重绘页面）
// ---------------------------------------------------------------------
function quoteTimeText(list) {
  const ts = (list || []).map((i) => i.quote?.updated_at).filter(Boolean).sort();
  return ts.length ? `本站更新于 ${hhmm(ts.at(-1))}` : '等待首次更新';
}

async function refreshQuotes() {
  if (document.hidden || state.demo) return;
  const qs = await api('/api/quotes');
  if (!qs || !Object.keys(qs).length) return;
  for (const [key, q] of Object.entries(qs)) {
    document.querySelectorAll(`[data-qp="${key}"]`).forEach((el) => {
      const txt = fmtPrice(q.price);
      if (el.textContent !== txt) {
        el.textContent = txt;
        el.classList.remove('flash');
        void el.offsetWidth; // 重新触发闪烁动画
        el.classList.add('flash');
      }
    });
    if (q.chg_pct === null || q.chg_pct === undefined) continue; // 没有前结算价就不覆盖
    document.querySelectorAll(`[data-qc="${key}"]`).forEach((el) => {
      el.textContent = sign(q.chg_pct) + (el.dataset.qsuffix || '');
      el.classList.remove('up', 'down', 'flat');
      if (el.classList.contains('hc')) el.setAttribute('style', heat(q.chg_pct, SCALE.d1));
      else el.classList.add(cls(q.chg_pct));
    });
  }
  const latest = Object.values(qs).map((q) => q.updated_at).sort().at(-1);
  document.querySelectorAll('[data-qt]').forEach((el) => {
    el.textContent = state.view === 'overview' ? `本站更新于 ${hhmm(latest)}` : el.textContent;
  });
  if (state.inst && qs[state.inst]) {
    const el = document.querySelector('.meta [data-qt]');
    if (el) el.textContent = `行情时间 ${fmt(qs[state.inst].market_time)}`;
  }
}

function startQuotePolling() {
  setInterval(refreshQuotes, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotes(); });
}

/** 报价异常提示条：报价表不可用、为空或超过 15 分钟没更新时显示；可关闭（本次会话内不再显示） */
function quoteBanner(st) {
  if (!st || st.ok || DEMO_MODE || sessionStorage.getItem('fr-quote-banner-off')) return '';
  const why = { quotes_unavailable: '报价服务异常', quotes_empty: '报价还没有数据', quotes_stale: '报价超过 15 分钟没有更新' }[st.error] || '报价异常';
  return `<div class="notice warnbox" id="quoteBanner">⚠ ${why}，"最新价"和"1日"列暂时不准或显示为"—"，其余周期为日线数据。
    ${st.last_update ? `最后成功更新 ${hhmm(st.last_update)}。` : ''}
    <a href="/api/data-status" target="_blank" rel="noopener">数据状态</a> ·
    <button type="button" onclick="location.reload()">重试</button> ·
    <button type="button" onclick="sessionStorage.setItem('fr-quote-banner-off','1');this.closest('#quoteBanner').remove()">关闭</button></div>`;
}
