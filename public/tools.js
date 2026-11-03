// 总览页与品种详情的行情工具（依赖 app.js 里的 $、esc、fmt、fmtPrice、sign、cls、miniSpark、niceTicks、SERIES 等）
// 本文件先于 app.js 加载，函数在两者都加载完成后才被调用。

const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const MONTH_CODES = 'FGHJKMNQUVXZ';
const PERF_COLS = [['d1', '1日'], ['w1', '1周'], ['m1', '1月'], ['m3', '3月'], ['ytd', '年初至今'], ['y1', '1年']];
const SHORT = { wti: 'WTI', brent: '布油', natgas: '天然气', gold: '黄金', silver: '白银', copper: '铜', soybeans: '大豆', corn: '玉米', wheat: '小麦', es: '标普', nq: '纳指', zn: '10Y美债' };

// ---------------- 自选（只存在本浏览器） ----------------
function getWatch() {
  try {
    return new Set(JSON.parse(localStorage.getItem('fr-watch') || '[]'));
  } catch {
    return new Set();
  }
}
function toggleWatch(key) {
  const w = getWatch();
  w.has(key) ? w.delete(key) : w.add(key);
  try {
    localStorage.setItem('fr-watch', JSON.stringify([...w]));
  } catch {}
  return w.has(key);
}
const star = (key) => `<button class="star ${getWatch().has(key) ? 'on' : ''}" data-star="${esc(key)}" title="加入/移出自选" aria-label="自选">★</button>`;

// ---------------- 交易时段（前端也算一份，演示模式和长时间停留时保持准确） ----------------
const _etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const _DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function sessionOpen(type, date) {
  const p = Object.fromEntries(_etFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const day = _DAYS[p.weekday], m = Number(p.hour) * 60 + Number(p.minute);
  if (type === 'grains') return (day <= 4 && m >= 1200) || (day >= 1 && day <= 5 && m < 525) || (day >= 1 && day <= 5 && m >= 570 && m < 860);
  return (day === 0 && m >= 1080) || (day >= 1 && day <= 4 && (m < 1020 || m >= 1080)) || (day === 5 && m < 1020);
}
function sessionNow(type) {
  const now = new Date(), open = sessionOpen(type, now);
  for (let t = Math.ceil(now / 300000) * 300000; t < +now + 4 * 86400000; t += 300000) if (sessionOpen(type, new Date(t)) !== open) return { open, next: new Date(t) };
  return { open, next: null };
}
const untilText = (d) => {
  if (!d) return '';
  const mins = Math.round((d - Date.now()) / 60000);
  return mins < 60 ? `${mins} 分钟后` : mins < 1440 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分后` : `${Math.floor(mins / 1440)} 天后`;
};
function sessionChip(type, label) {
  const s = sessionNow(type);
  return `<span class="sess ${s.open ? 'open' : ''}"><i></i>${esc(label)}：${s.open ? '交易中' : '休市'}<small>${s.next ? `${s.open ? '收盘' : '开盘'} ${untilText(s.next)}` : ''}</small></span>`;
}

// =====================================================================
// 总览页
// =====================================================================

async function fetchOverview() {
  return (await api('/api/overview')) || (await loadDemo()).overview;
}

const heat = (v, scale) => {
  if (v === null || v === undefined) return '';
  const a = Math.min(1, Math.abs(v) / scale) * 0.55;
  return `background: color-mix(in srgb, ${v >= 0 ? 'var(--up)' : 'var(--down)'} ${Math.round(a * 100)}%, transparent)`;
};
const SCALE = { d1: 3, w1: 6, m1: 10, m3: 18, ytd: 30, y1: 40 };

async function renderOverview() {
  const el = $('#detail');
  el.innerHTML = '<div class="empty">加载中…</div>';
  const [ov, ol] = await Promise.all([fetchOverview(), fetchOutlook().catch(() => null)]);
  if (!ov) {
    el.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }
  const rows = ov.instruments.filter((i) => !state.sector || i.sector === state.sector || (state.sector === '自选' && getWatch().has(i.key)));
  const secs = ['能源', '金属', '农产品', '金融期货'];
  el.innerHTML = `
  <div class="ov-head">
    <h2>市场总览</h2>
    <div class="sessbar">${sessionChip('globex', '能源·金属·股指·国债')}${sessionChip('grains', '谷物')}</div>
    <p class="note">行情为交易所延迟数据（10–30 分钟），不含交易所节假日；仅供研究参考，不构成投资建议。</p>
    ${historyNotice(ov)}
  </div>

  <div class="box"><h4>多周期涨跌 <span class="note">单元格颜色深浅表示涨跌幅度</span></h4>
    <div class="tablewrap"><table class="perf">
      <thead><tr><th></th><th>品种</th><th>主力</th><th class="r">最新</th>${PERF_COLS.map(([, l]) => `<th class="r">${l}</th>`).join('')}<th>52周位置</th><th class="r">RSI</th><th>资金持仓</th></tr></thead>
      <tbody>${secs.map((sec) => {
        const rs = rows.filter((i) => i.sector === sec);
        if (!rs.length) return '';
        return `<tr class="grp"><td colspan="14">${sec}</td></tr>` + rs.map((i) => `<tr>
          <td>${star(i.key)}</td>
          <td><a href="#i-${esc(i.key)}">${esc(i.name)}</a></td>
          <td class="note mono">${esc(i.contract && i.contract !== 'cont' ? i.contract : i.root)}</td>
          <td class="r mono">${fmtPrice(i.stats?.last ?? i.perf?.last)}</td>
          ${PERF_COLS.map(([k]) => `<td class="r mono hc" style="${heat(i.perf?.[k], SCALE[k])}">${sign(i.perf?.[k], k === 'd1' ? 2 : 1)}</td>`).join('')}
          <td>${i.perf?.pos52 !== null && i.perf?.pos52 !== undefined ? `<span class="rng" title="52周区间位置 ${i.perf.pos52}%"><b style="left:${i.perf.pos52}%"></b></span>` : '—'}</td>
          <td class="r mono ${i.rsi14 !== null && i.rsi14 !== undefined && (i.rsi14 >= 70 || i.rsi14 <= 30) ? 'warnc' : ''}">${i.rsi14 ?? '—'}</td>
          <td>${i.cot ? `<span class="cotchip" title="${esc(i.cot.group)} · COT 指数 ${i.cot.cot_index} · ${esc(i.cot.state)}">${cotBar(i.cot.cot_index)}</span>` : '<span class="note">—</span>'}</td>
        </tr>`).join('');
      }).join('')}</tbody>
    </table></div>
  </div>

  ${outlookOverviewHtml(ol, new Set(rows.map((i) => i.key)))}

  <div class="grid2">
    <div class="box"><h4>价差与比价 <span class="note">近 1 年</span></h4>
      <div class="spreads">${(ov.spreads || []).map((s) => `<div class="spr">
        <div class="spr-h"><b>${esc(s.name)}</b><span class="mono">${s.value}${s.unit ? ' ' + esc(s.unit) : ''}</span></div>
        ${spreadSpark(s.series)}
        <div class="note">1年分位 ${s.percentile_1y}% · 偏离均值 ${s.z_1y ?? '—'}σ · 近1月 ${s.chg_1m > 0 ? '+' : ''}${s.chg_1m ?? '—'}</div>
        <div class="note small">${esc(s.note)}</div></div>`).join('') || '<p class="note">日线数据不足</p>'}</div>
    </div>
    <div class="box"><h4>资金持仓拥挤度 <span class="note">CFTC COT 指数（近 3 年区间位置）</span></h4>
      ${cotRanking(ov.instruments)}
      <p class="note">商品为管理基金、金融期货为杠杆基金的净持仓。≥90 多头拥挤，≤10 空头拥挤。数据来源：美国商品期货交易委员会（CFTC），每周五发布、统计至当周周二。</p>
    </div>
  </div>

  <div class="grid2">
    <div class="box"><h4>相关性矩阵 <span class="note">${ov.correlation ? `近 ${ov.correlation.window} 个交易日日收益率` : ''}</span></h4>${corrMatrix(ov.correlation)}</div>
    <div>
      <div class="box"><h4>财经日历 <span class="note">未来 7 天 · 美东时间换算为本地显示</span></h4>${calendarList(ov.calendar)}</div>
      <div class="box"><h4>近 3 天重点事件</h4>${(ov.top_events || []).length ? `<ul class="plain evl">${ov.top_events.map((e) => `<li><a href="#e-${e.id}">${esc(e.title)}</a> <span class="lvchip lv-${esc(e.level)}">${Math.round(e.severity)} ${esc(e.level)}</span></li>`).join('')}</ul>` : '<p class="note">暂无</p>'}</div>
    </div>
  </div>
  <p class="disclaimer">${DISCLAIMER}</p>`;
}

function historyNotice(ov) {
  const total = ov.instruments.length;
  // 总览快照还没算过时 history_ready 为空：按每个品种的数据来源估算，避免横幅漏报
  const n = ov.history_ready ?? ov.instruments.filter((i) => i.bars_source === 'daily').length;
  const noCot = !ov.instruments.some((i) => i.cot);
  if (n >= total && !noCot) return '';
  const parts = [];
  if (n < total) parts.push(`历史日线已就绪 ${n}/${total} 个品种（每 15 分钟自动补 3 个；补齐前，涨跌和技术指标先用近几个月的小时线估算，季节性、价差、相关性暂缺）`);
  if (noCot) parts.push('CFTC 持仓报告尚未拉取（每小时自动重试）');
  return `<div class="notice">⏳ ${parts.join('；')}。详情见 <a href="/api/data-status" target="_blank" rel="noopener">数据状态</a>。</div>`;
}

const cotBar = (v) => `<span class="cbar"><b style="width:${v}%;background:${v >= 90 ? 'var(--up)' : v <= 10 ? 'var(--down)' : 'var(--accent)'}"></b></span><span class="mono">${v}</span>`;

function cotRanking(list) {
  const rs = list.filter((i) => i.cot).sort((a, b) => b.cot.cot_index - a.cot.cot_index);
  if (!rs.length) return '<p class="note">暂无持仓数据（部署后运行一次持仓报告回填）。</p>';
  return `<table class="cott"><thead><tr><th>品种</th><th>COT 指数</th><th class="r">净持仓</th><th class="r">周变化</th><th class="r">占持仓</th></tr></thead><tbody>
    ${rs.map((i) => `<tr><td><a href="#i-${esc(i.key)}">${esc(i.name)}</a></td><td>${cotBar(i.cot.cot_index)}</td>
      <td class="r mono">${fmtInt(i.cot.net)}</td><td class="r mono ${cls(i.cot.net_change)}">${i.cot.net_change > 0 ? '+' : ''}${fmtInt(i.cot.net_change)}</td>
      <td class="r mono">${i.cot.net_pct_oi ?? '—'}%</td></tr>`).join('')}
  </tbody></table><p class="note">报告日期 ${esc(rs[0].cot.report_date)}</p>`;
}
const fmtInt = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US'));

function spreadSpark(series) {
  if (!series || series.length < 2) return '';
  const vals = series.map((p) => p[1]);
  const W = 260, H = 44, lo = Math.min(...vals), hi = Math.max(...vals);
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)).toFixed(1)}`).join(' ');
  return `<svg class="sspark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${SERIES[0]}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

function corrMatrix(c) {
  if (!c) return '<p class="note">日线数据不足</p>';
  const color = (v) => {
    const a = Math.round(Math.min(1, Math.abs(v)) * 85);
    return v >= 0 ? `color-mix(in srgb, ${SERIES[0]} ${a}%, var(--panel-2))` : `color-mix(in srgb, ${SERIES[1]} ${a}%, var(--panel-2))`;
  };
  return `<div class="corr" style="grid-template-columns: 56px repeat(${c.keys.length}, 1fr)">
    <span></span>${c.keys.map((k) => `<span class="ch">${esc(SHORT[k] || k)}</span>`).join('')}
    ${c.keys.map((k, i) => `<span class="rh">${esc(SHORT[k] || k)}</span>${c.matrix[i].map((v, j) => `<span class="cc" style="background:${color(v)}" title="${esc(SHORT[k])} × ${esc(SHORT[c.keys[j]])}：${v}">${i === j ? '' : v.toFixed(1)}</span>`).join('')}`).join('')}
  </div>
  <div class="legend"><span><i style="background:${SERIES[0]}"></i>正相关</span><span><i style="background:${SERIES[1]}"></i>负相关</span><span class="note">截至 ${esc(c.end)}</span></div>`;
}

function calendarList(items) {
  if (!items?.length) return '<p class="note">未来 7 天没有安排。</p>';
  const byDay = {};
  for (const e of items) (byDay[new Date(e.ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })] ||= []).push(e);
  return Object.entries(byDay).map(([d, es]) => `<div class="calday"><div class="cald">${esc(d)}</div>${es.map((e) => `<div class="cale">
      <span class="mono">${new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="imp" title="重要性">${'●'.repeat(e.importance)}${'○'.repeat(3 - e.importance)}</span>
      <span>${esc(e.title)}${e.instruments?.length ? ` ${e.instruments.map((k) => `<a class="tag" href="#i-${esc(k)}">${esc(SHORT[k] || k)}</a>`).join('')}` : ''}</span></div>`).join('')}</div>`).join('');
}

// =====================================================================
// 品种详情扩展
// =====================================================================

function specBox(inst, snap, session) {
  const sp = inst.spec;
  if (!sp) return '';
  const last = snap?.stats?.last ?? snap?.perf?.last;
  const months = [...(inst.months || '')].map((c) => MONTH_NAMES[MONTH_CODES.indexOf(c)]).join('、');
  const s = sessionNow(sp.session);
  return `<div class="box"><h4>合约规格</h4><table class="kv">
    <tr><th>交易所</th><td>${esc(inst.exchange)}（代码 ${esc(inst.root)}）</td></tr>
    <tr><th>合约规模</th><td>${esc(sp.size)}</td></tr>
    <tr><th>最小变动价位</th><td class="mono">${sp.tick} ${esc(inst.unit.split('/')[0] === '美分' ? '美分' : '')} = $${sp.tickValue}</td></tr>
    <tr><th>名义价值（按最新价）</th><td class="mono">${Number.isFinite(last) ? '$' + Math.round(last * sp.pointValue).toLocaleString('en-US') : '—'}</td></tr>
    <tr><th>交割月份</th><td>${esc(months)}</td></tr>
    <tr><th>结算方式</th><td>${esc(sp.settle)}</td></tr>
    <tr><th>交易时段</th><td>${esc(inst.session_hours || '')}</td></tr>
    <tr><th>当前状态</th><td><span class="sess ${s.open ? 'open' : ''}"><i></i>${s.open ? '交易中' : '休市'}<small>${s.next ? `${s.open ? '收盘' : '开盘'} ${untilText(s.next)}` : ''}</small></span></td></tr>
  </table><p class="note">规格以交易所官网为准；保证金由经纪商决定，未列出。</p></div>`;
}

function perfBox(snap) {
  const p = snap?.perf;
  if (!p) return '';
  return `<div class="box"><h4>多周期表现 <span class="note">${snap.bars_source === 'hourly' ? '日线回填中，暂用小时线估算' : '连续合约日线'}</span></h4>
    <div class="pgrid">${[['w1', '1周'], ['m1', '1月'], ['m3', '3月'], ['m6', '6月'], ['ytd', '年初至今'], ['y1', '1年']].map(([k, l]) => `<div class="pc" style="${heat(p[k], SCALE[k] || 20)}"><span>${l}</span><b class="mono">${sign(p[k], 1)}</b></div>`).join('')}</div>
    <div class="r52"><span class="mono">${fmtPrice(p.lo52)}</span><span class="rng wide"><b style="left:${p.pos52 ?? 50}%"></b></span><span class="mono">${fmtPrice(p.hi52)}</span></div>
    <p class="note">52 周区间位置 ${p.pos52 ?? '—'}% · 距 52 周高点 ${sign(p.from_hi52, 1)}</p></div>`;
}

function techBox(snap) {
  const t = snap?.tech;
  if (!t) return '';
  const pv = snap.pivots;
  const row = (k, v, note = '') => `<tr><th>${k}</th><td class="mono">${v ?? '—'}</td><td class="note">${note}</td></tr>`;
  return `<div class="box"><h4>技术指标 <span class="note">${snap.bars_source === 'hourly' ? '日线回填中，暂用小时线估算（高低价以收盘价近似）' : '日线'} · 只描述状态，不构成买卖信号</span></h4>
    <table class="kv">
      ${row('RSI(14)', t.rsi14, t.rsi14 >= 70 ? '超买区域' : t.rsi14 <= 30 ? '超卖区域' : '中性区域')}
      ${row('MACD(12,26,9)', `${t.macd} / ${t.macd_signal}`, `柱 ${t.macd_hist > 0 ? '+' : ''}${t.macd_hist}`)}
      ${row('ATR(14)', fmtPrice(t.atr14), `约占价格 ${t.atr_pct}%`)}
      ${row('布林带(20,2)', `${fmtPrice(t.boll_lower)} – ${fmtPrice(t.boll_upper)}`, `%B ${t.boll_pctb} · 带宽 ${t.boll_width_pct}%`)}
      ${row('20 / 50 / 200 日均线', `${fmtPrice(t.sma20)} / ${fmtPrice(t.sma50)} / ${fmtPrice(t.sma200)}`, `距 50 日 ${sign(t.dist_sma50_pct, 1)} · 距 200 日 ${sign(t.dist_sma200_pct, 1)}`)}
      ${row('20 日历史波动率', t.hv20_ann_pct + '%', '年化')}
    </table>
    <ul class="plain states">${t.states.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    ${pv ? `<h5>经典枢轴点 <span class="note">基于 ${esc(pv.day)} 高低收，仅作参考价位</span></h5>
      <div class="tablewrap"><table class="piv"><tr>${['s3', 's2', 's1', 'p', 'r1', 'r2', 'r3'].map((k) => `<th>${k.toUpperCase()}</th>`).join('')}</tr>
      <tr>${['s3', 's2', 's1', 'p', 'r1', 'r2', 'r3'].map((k) => `<td class="mono ${k === 'p' ? 'pp' : ''}">${fmtPrice(pv[k])}</td>`).join('')}</tr></table></div>` : ''}
  </div>`;
}

function seasonBox(snap) {
  const s = snap?.seasonality;
  if (!s) return `<div class="box"><h4>季节性</h4><p class="note">${snap?.bars_source === 'hourly' ? '历史日线回填中，补齐后自动显示。' : '需要至少一年的日线数据。'}</p></div>`;
  const max = Math.max(...s.monthly.map((m) => Math.abs(m.mean ?? 0)), 0.5);
  return `<div class="box"><h4>季节性 <span class="note">近 ${s.years} 个完整年度 · 连续合约，换月价差可能影响结果</span></h4>
    <div class="grid2 tight">
      <div><h5>各月平均涨跌与上涨概率</h5>
        <div class="mbars">${s.monthly.map((m) => `<div class="mb ${m.month === s.current_month ? 'cur' : ''}" title="${m.month}月：平均 ${m.mean}% · 中位数 ${m.median}% · 上涨 ${m.win_rate}%（${m.n} 年）">
          <div class="mbz"><i class="${m.mean >= 0 ? 'pos' : 'neg'}" style="height:${(Math.abs(m.mean ?? 0) / max) * 50}%"></i></div>
          <span class="mono">${m.mean === null ? '—' : (m.mean > 0 ? '+' : '') + m.mean.toFixed(1)}</span><span>${m.month}月</span><span class="note mono">${m.win_rate ?? '—'}%</span></div>`).join('')}</div>
        <p class="note">柱上数字为平均涨跌 %，最下一行为上涨年份占比；高亮为当前月份。</p></div>
      <div><h5>今年走势 vs 历史平均（自年初累计 %）</h5>
        <div class="legend"><span><i style="background:${SERIES[0]}"></i>今年</span><span><i style="background:${SERIES[1]}"></i>近 5 年平均</span><span><i style="background:${SERIES[2]}"></i>近 10 年平均</span></div>
        <div id="seasonChart" class="rx" role="img" aria-label="今年与历史平均的年内累计涨跌"></div></div>
    </div></div>`;
}

function drawSeasonChart(s) {
  const box = $('#seasonChart');
  if (!box || !s?.path) return;
  const lines = [[s.path.current, SERIES[0]], [s.path.avg5, SERIES[1]], [s.path.avg10, SERIES[2]]].filter(([v]) => v && v.some((x) => x !== null));
  if (!lines.length) return;
  const W = Math.max(280, box.clientWidth), H = 190, L = 44, R = 10, T = 8, B = 22;
  const all = lines.flatMap(([v]) => v.filter((x) => x !== null));
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const pad = (hi - lo || 1) * 0.1;
  lo -= pad; hi += pad;
  const X = (w) => L + (w / 52) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let svg = `<svg width="${W}" height="${H}">`;
  for (const t of niceTicks(lo, hi, 4)) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="grid${t === 0 ? ' zero' : ''}"/><text x="${L - 6}" y="${Y(t) + 4}" class="ax" text-anchor="end">${t > 0 ? '+' : ''}${+t.toFixed(1)}%</text>`;
  [0, 13, 26, 39, 52].forEach((w, i) => (svg += `<text x="${X(w)}" y="${H - 6}" class="ax" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${['1月', '4月', '7月', '10月', '12月'][i]}</text>`));
  for (const [v, c] of lines) {
    let d = '', pen = false;
    v.forEach((y, w) => {
      if (y === null) return (pen = false);
      d += `${pen ? 'L' : 'M'}${X(w).toFixed(1)},${Y(y).toFixed(1)}`;
      pen = true;
    });
    svg += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2"/>`;
  }
  box.innerHTML = svg + '</svg>';
}

function cotBox(snap) {
  const c = snap?.cot;
  if (!c) return '<div class="box"><h4>资金持仓（CFTC）</h4><p class="note">暂无持仓数据。</p></div>';
  return `<div class="box"><h4>资金持仓（CFTC · ${esc(c.group)}净持仓）</h4>
    <div class="tiles t4">
      <div class="tile"><span>净持仓（手）</span><b class="mono ${cls(c.net)}">${fmtInt(c.net)}</b><em>多 ${fmtInt(c.long)} / 空 ${fmtInt(c.short)}</em></div>
      <div class="tile"><span>周变化</span><b class="mono ${cls(c.net_change)}">${c.net_change > 0 ? '+' : ''}${fmtInt(c.net_change)}</b><em>报告日 ${esc(c.report_date)}</em></div>
      <div class="tile"><span>占总持仓</span><b class="mono">${c.net_pct_oi ?? '—'}%</b><em>净持仓 / 总持仓</em></div>
      <div class="tile"><span>COT 指数</span><b class="mono">${c.cot_index}</b><em>${esc(c.state)}</em></div>
    </div>
    <div id="cotChart" class="rx" role="img" aria-label="净持仓历史"></div>
    <p class="note">COT 指数 = 当前净持仓在近 ${c.weeks} 周区间中的位置。持仓拥挤本身不代表价格方向，只说明同向仓位集中、反向变动时波动可能放大。数据来源：CFTC。</p></div>`;
}

function drawCotChart(c) {
  const box = $('#cotChart');
  if (!box || !c?.series?.length) return;
  const pts = c.series;
  const W = Math.max(280, box.clientWidth), H = 170, L = 64, R = 10, T = 8, B = 22;
  const vals = pts.map((p) => p[1]);
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad; hi += pad;
  const X = (i) => L + (i / (pts.length - 1 || 1)) * (W - L - R), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let svg = `<svg width="${W}" height="${H}">`;
  for (const t of niceTicks(lo, hi, 4)) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="grid${t === 0 ? ' zero' : ''}"/><text x="${L - 6}" y="${Y(t) + 4}" class="ax" text-anchor="end">${fmtInt(t)}</text>`;
  [0, Math.floor(pts.length / 2), pts.length - 1].forEach((i, k) => (svg += `<text x="${X(i)}" y="${H - 6}" class="ax" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${esc(String(pts[i][0]).slice(0, 7))}</text>`));
  const zero = Y(0);
  svg += `<path d="M${X(0)},${zero}${pts.map((p, i) => `L${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}L${X(pts.length - 1)},${zero}Z" fill="color-mix(in srgb, ${SERIES[0]} 18%, transparent)"/>`;
  svg += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}" fill="none" stroke="${SERIES[0]}" stroke-width="2"/>`;
  box.innerHTML = svg + '</svg>';
}

/** 品种详情新增区块（插在价格/期限结构之后） */
function instrumentToolsHtml(d) {
  const snap = d.snapshot;
  return `<div class="grid2">${perfBox(snap)}${specBox(d.instrument, snap, d.session)}</div>`;
}
function instrumentToolsHtml2(d) {
  const snap = d.snapshot;
  return `${techBox(snap)}${seasonBox(snap)}${cotBox(snap)}`;
}
function drawInstrumentTools(d) {
  drawSeasonChart(d.snapshot?.seasonality);
  drawCotChart(d.snapshot?.cot);
}
