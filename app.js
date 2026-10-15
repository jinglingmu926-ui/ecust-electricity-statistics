const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const statusNames = { complete: '整日实测', estimated: '整日估算', partial: '今日暂计', missing: '缺测', recharge: '充值待核算' };
const slotNames = { success: '正常', late: '延迟查询', pending: '待查询', retrying: '正在重试', missing: '缺测', historical: '历史时段不详', no_time: '历史时刻不详' };
const CACHE_KEY = 'ecust215-snapshot-v2';
let snapshot = null;
let analytics = null;
let selectedRange = null;
let lastDashboard = null;
let loading = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function number(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : '—';
}
function dateTime(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return parts.replace('T', ' ');
}
function metric(id, value, unit = '', prefix = '') {
  const node = $(id);
  node.replaceChildren(document.createTextNode(Number.isFinite(value) ? `${prefix}${number(value)}` : '—'));
  if (Number.isFinite(value) && unit) node.append(element('span', 'unit', unit));
}
function notice(state, message) {
  $('notice').dataset.state = state;
  $('notice').textContent = message;
}
function showFieldMessage(message, isError = false) {
  $('range-message').textContent = message;
  $('range-message').classList.toggle('error', isError);
}
function today() { return analytics.chinaDay(Date.now()); }
function defaultRange() { return { startDate: analytics.addChinaDays(today(), -13), endDate: today() }; }
function setInputs(range) {
  $('start-date').value = range.startDate;
  $('end-date').value = range.endDate;
  constrainEnd();
}
function constrainEnd() {
  const start = $('start-date').value;
  const currentDay = today();
  $('start-date').max = currentDay;
  $('end-date').min = start;
  $('end-date').max = start ? [analytics.addChinaDays(start, 13), currentDay].sort()[0] : currentDay;
}

function renderCards(dashboard) {
  const latest = dashboard.latest;
  const balance = latest?.remainingKwh;
  metric('remaining', balance, '度');
  const mood = Number.isFinite(balance) ? balance <= 10 ? 'danger' : balance <= 30 ? 'warn' : 'good' : 'neutral';
  $('remaining').className = `metric-value ${mood}`;
  $('balance-status').className = `pill ${mood}`;
  $('balance-status').textContent = !Number.isFinite(balance) ? '暂无数据' : balance <= 10 ? '电量告急' : balance <= 30 ? '留意充值' : '电量充足';
  $('remaining-note').textContent = dashboard.freshness.state === 'stale' ? '这是上次余额，当前数据尚未更新' : '最后一次成功查询的余额';

  metric('change', Number.isFinite(dashboard.lastChange) ? Math.abs(dashboard.lastChange) : null, '度');
  $('change-note').textContent = dashboard.lastChange === null ? '暂无可比较的上一条记录' : dashboard.lastChange < 0 ? '余额净增加，可能发生充值' : dashboard.lastChange === 0 ? '两次查询之间余额未变化' : '相邻两次查询之间余额下降';
  metric('today-usage', dashboard.today.usageKwh, '度');
  $('today-note').textContent = `${statusNames[dashboard.today.status] || '待计算'} · ${dashboard.today.reason || ''}`;
  $('latest-time').textContent = latest ? dateTime(latest.observedAt) : '暂无记录';
  $('latest-note').textContent = latest?.precision === 'date' ? '历史记录仅保留日期，时刻不详' : latest?.scheduledFor ? `计划 ${dateTime(latest.scheduledFor)}，上方为实际时刻` : latest?.source === 'legacy' ? '历史迁入记录，保留实际查询时刻' : '上方为实际查询时间';
  if (latest?.precision === 'date') $('latest-time').textContent = dateTime(latest.observedAt).slice(0, 10);
  metric('average', dashboard.average.usageKwh, '度');
  $('average-note').textContent = `过去 7 个完整日中，${dashboard.average.dayCount} 个有效日参与平均（含零用电）`;
  metric('estimated-days', dashboard.estimatedDays, '天', '约 ');
  $('estimate-note').textContent = dashboard.freshness.state === 'stale' ? '基于上次余额估计，数据过期时不宜依赖' : '按近期平均值估计，至少需 3 个有效日';
  notice(dashboard.freshness.state, dashboard.freshness.message);
}

function renderSummary(dashboard) {
  const host = $('range-summary');
  host.replaceChildren();
  host.append(element('span', 'summary-main', `${dashboard.range.startDate} — ${dashboard.range.endDate}`));
  const usage = element('span', '', '有效日合计 ');
  usage.append(element('b', '', number(dashboard.summary.usageKwh)), document.createTextNode(' 度'));
  const count = element('span', '', '有效统计 ');
  count.append(element('b', '', String(dashboard.summary.validDays)), document.createTextNode(' 天'));
  host.append(usage, count);
  if (dashboard.summary.excludedDays) host.append(element('span', 'summary-excluded', `${dashboard.summary.excludedDays} 天暂计、缺测或待核算，未计入合计`));
}

function niceStep(max) {
  if (max <= 0) return 1;
  const rough = max / 4;
  const order = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / order;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * order;
}
function renderChart(dashboard) {
  const host = $('chart');
  host.replaceChildren();
  const days = dashboard.days;
  if (!days.length) { host.append(element('div', 'chart-empty', '所选日期范围没有记录')); return; }
  const width = 1060, height = 330, left = 49, right = 14, top = 36, bottom = 61;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const values = days.map(d => d.usageKwh).filter(Number.isFinite);
  const maximum = values.length ? Math.max(...values, 0) : 0;
  const step = niceStep(maximum * 1.12);
  const maxY = Math.max(step * 4, Math.ceil(maximum / step) * step);
  const tickCount = Math.round(maxY / step);
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': 'chart-title chart-desc' });
  const selection = element('p', 'chart-selection', '点选任意柱子，可在这里查看该日数值与统计依据。');
  selection.setAttribute('aria-live', 'polite');
  svg.append(svgElement('title', { id: 'chart-title' }, `${dashboard.range.startDate}至${dashboard.range.endDate}每日用电量`));
  svg.append(svgElement('desc', { id: 'chart-desc' }, days.map(d => `${d.date}：${Number.isFinite(d.usageKwh) ? `${number(d.usageKwh)}度` : '无可计算值'}，${statusNames[d.status] || d.status}。`).join(' ')));
  const defs = svgElement('defs');
  const pattern = svgElement('pattern', { id: 'estimate-pattern', patternUnits: 'userSpaceOnUse', width: 7, height: 7 });
  pattern.append(svgElement('rect', { width: 7, height: 7, fill: '#9eb7f7' }), svgElement('path', { d: 'M-2 2L2 -2M0 7L7 0M5 9L9 5', stroke: '#c3d1fb', 'stroke-width': 1.4 }));
  defs.append(pattern); svg.append(defs);
  for (let i = 0; i <= tickCount; i++) {
    const value = i * step, y = top + plotHeight - value / maxY * plotHeight;
    svg.append(svgElement('line', { x1: left, x2: width - right, y1: y, y2: y, stroke: i === 0 ? '#d7e0ee' : '#edf1f7', 'stroke-width': 1 }));
    svg.append(svgElement('text', { x: left - 11, y: y + 4, 'text-anchor': 'end', fill: '#9aa6b8', 'font-size': 11 }, number(value)));
  }
  svg.append(svgElement('text', { x: left, y: 17, fill: '#8190a5', 'font-size': 11 }, '用电量 / 度'));
  const pitch = plotWidth / days.length;
  const barWidth = Math.min(54, pitch * 0.64);
  days.forEach((day, i) => {
    const center = left + pitch * (i + 0.5), value = day.usageKwh;
    const usable = Number.isFinite(value);
    const barHeight = usable ? Math.max(value > 0 ? 1 : 0, value / maxY * plotHeight) : 0;
    const y = top + plotHeight - barHeight;
    const group = svgElement('g', { class: 'bar-group', tabindex: 0, role: 'img', 'aria-label': `${day.date}，${usable ? `${number(value)}度` : '无可计算值'}，${statusNames[day.status] || day.status}。${day.reason || ''}` });
    const selectDay = () => { selection.textContent = `${day.date} · ${usable ? `${number(value)} 度` : '暂无可靠用电量'} · ${statusNames[day.status] || day.status}：${day.reason || ''}`; };
    group.addEventListener('click', selectDay);
    group.addEventListener('focus', selectDay);
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectDay(); } });
    group.append(svgElement('title', {}, `${day.date} · ${statusNames[day.status] || day.status}\n${usable ? `${number(value)} 度` : '暂无可靠用电量'}\n${day.reason || ''}`));
    if (usable && value > 0) {
      group.append(svgElement('rect', { class: 'bar', x: center - barWidth / 2, y, width: barWidth, height: barHeight, rx: 3, fill: day.status === 'partial' ? '#e8b352' : day.status === 'estimated' ? 'url(#estimate-pattern)' : '#4278ec' }));
    } else {
      group.append(svgElement('line', { class: 'bar', x1: center - 8, x2: center + 8, y1: top + plotHeight - 1, y2: top + plotHeight - 1, stroke: usable ? '#4278ec' : '#cdd6e3', 'stroke-width': 3 }));
    }
    const suffix = day.status === 'partial' ? ' 暂计' : day.status === 'estimated' ? ' 估' : '';
    group.append(svgElement('text', { x: center, y: usable ? y - 9 : top + plotHeight - 12, 'text-anchor': 'middle', fill: usable ? '#667c9d' : '#a4aebe', 'font-size': days.length > 10 ? 10 : 12 }, usable ? `${number(value)}${suffix}` : day.status === 'recharge' ? '待核算' : '缺测'));
    group.append(svgElement('text', { x: center, y: height - bottom + 23, 'text-anchor': 'middle', fill: '#8a99ae', 'font-size': 11 }, day.date.slice(5).replace('-', '/')));
    svg.append(group);
  });
  svg.append(svgElement('text', { x: width / 2, y: height - 9, 'text-anchor': 'middle', fill: '#a0aabb', 'font-size': 10 }, values.length ? '悬停或点选柱子可查看统计依据 · 宽图可左右滑动' : '所选范围尚无可靠的每日用电量；缺测没有按零值计算'));
  host.append(svg, selection);
}

function appendReading(row, slot) {
  const readingCell = element('td');
  readingCell.append(element('div', 'reading-value', Number.isFinite(slot?.reading) ? `${number(slot.reading)} 度` : '—'));
  if (slot?.actualAt) readingCell.append(element('div', 'actual-time', `实查 ${dateTime(slot.actualAt).slice(5)}`));
  const statusCell = element('td');
  const state = slot?.status || 'missing';
  const badge = element('span', `slot-status ${state}`, slotNames[state] || '未确认');
  if (slot?.scheduledFor) badge.title = `计划：${dateTime(slot.scheduledFor)}${slot.actualAt ? `\n实际：${dateTime(slot.actualAt)}` : ''}`;
  statusCell.append(badge);
  row.append(readingCell, statusCell);
}
function appendHistoricalReadings(row, readings) {
  const cell = element('td', 'history-cell');
  cell.colSpan = 4;
  const wrapper = element('div', 'history-readings');
  wrapper.append(element('span', 'slot-status historical', '实际查询 · 时段未归类'));
  const sorted = [...readings].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const displayed = sorted.length > 2 ? [sorted[0], sorted[sorted.length - 1]] : sorted;
  for (const reading of displayed) {
    const time = reading.precision === 'date' ? `${dateTime(reading.observedAt).slice(0, 10)} 时间不详` : dateTime(reading.observedAt).slice(11);
    const value = element('span', 'history-reading');
    value.append(element('span', 'history-time', time), element('b', '', `${number(reading.remainingKwh)} 度`));
    wrapper.append(value);
  }
  if (sorted.length > 2) wrapper.append(element('span', 'history-count', `显示首末次 / 共 ${sorted.length} 次`));
  cell.append(wrapper);
  row.append(cell);
}
function renderTable(dashboard) {
  const host = $('record-rows');
  host.replaceChildren();
  $('row-count').textContent = `${dashboard.days.length} 天 · 每天一行`;
  for (const day of [...dashboard.days].reverse()) {
    const row = element('tr');
    const dateCell = element('td');
    dateCell.append(element('div', 'day-label', day.date));
    if (day.historyCount) dateCell.append(element('div', 'day-note', `${day.historyCount} 条实查记录，未分配早晚时段`));
    row.append(dateCell);
    const historical = Array.isArray(day.historyReadings) ? day.historyReadings : [];
    if (historical.length && !Number.isFinite(day.morning?.reading) && !Number.isFinite(day.night?.reading)) {
      appendHistoricalReadings(row, historical);
    } else {
      appendReading(row, day.morning);
      appendReading(row, day.night);
    }
    host.append(row);
  }
  if (!dashboard.days.length) { const row = element('tr'); const cell = element('td', 'empty-row', '所选日期范围没有记录'); cell.colSpan = 5; row.append(cell); host.append(row); }
}
function render() {
  if (!snapshot || !analytics) return;
  lastDashboard = analytics.buildDashboard(snapshot, { nowIso: new Date().toISOString(), ...(selectedRange || defaultRange()) });
  renderCards(lastDashboard);
  renderSummary(lastDashboard);
  renderChart(lastDashboard);
  renderTable(lastDashboard);
}
function queryRange(single = false) {
  if (!analytics || !snapshot) return;
  const startDate = $('start-date').value;
  const endDate = single ? startDate : $('end-date').value;
  try {
    if (!startDate || !endDate) throw new Error('请先选择开始和结束日期。');
    if (endDate > today()) throw new Error('结束日期不能晚于今天。');
    analytics.buildDashboard(snapshot, { startDate, endDate });
    selectedRange = { startDate, endDate };
    setInputs(selectedRange);
    render();
    showFieldMessage(`已显示 ${startDate} 至 ${endDate}。日期不受当前历史记录起止限制；没有记录的日期会标记缺测。`);
  } catch (error) {
    showFieldMessage(error.message || '日期范围无效，请选择连续 1 至 14 天。', true);
  }
}
async function loadData() {
  if (loading) return;
  loading = true;
  $('refresh').disabled = true;
  $('refresh').textContent = '读取中…';
  try {
    if (!analytics) analytics = await import('./analytics.mjs');
    const response = await fetch('./snapshot.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`记录文件读取失败（HTTP ${response.status}）`);
    const next = await response.json();
    if (!next || next.schemaVersion !== 2 || !Array.isArray(next.readings)) throw new Error('记录文件格式异常，未覆盖此前已显示的数据');
    snapshot = next;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch { /* Storage may be disabled; in-memory results still work. */ }
    if (!$('start-date').value) setInputs(defaultRange());
    render();
    $('loaded-at').textContent = `本页读取 ${dateTime(new Date().toISOString())}`;
  } catch (error) {
    if (!snapshot && analytics) {
      try {
        const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (saved?.schemaVersion === 2 && Array.isArray(saved.readings)) {
          snapshot = saved;
          if (!$('start-date').value) setInputs(defaultRange());
          render();
          $('loaded-at').textContent = '正在显示此浏览器上次保存的历史快照';
        }
      } catch { /* A bad or unavailable cache cannot replace valid data. */ }
    }
    const message = error instanceof TypeError ? '暂时无法连接记录文件' : error.message || '暂时无法读取记录';
    notice('error', `${message}。${lastDashboard ? '保留上次已加载内容，稍后可刷新重试。' : '请稍后刷新；页面尚无可展示数据。'}`);
    if (!lastDashboard) { $('chart').replaceChildren(element('div', 'chart-empty', '电量记录暂时无法加载')); $('range-summary').textContent = '等待记录文件恢复'; $('record-rows').replaceChildren(); const row = element('tr'); const cell = element('td', 'empty-row', '记录暂不可用'); cell.colSpan = 5; row.append(cell); $('record-rows').append(row); }
  } finally {
    loading = false;
    $('refresh').disabled = false;
    $('refresh').textContent = '刷新数据';
  }
}

$('range-form').addEventListener('submit', event => { event.preventDefault(); queryRange(); });
$('single-day').addEventListener('click', () => queryRange(true));
$('start-date').addEventListener('change', () => {
  if (!analytics || !$('start-date').value) return;
  try { constrainEnd(); $('end-date').value = $('end-date').max; showFieldMessage('已从开始日期向后选取最多 14 天；也可以缩短结束日期。'); }
  catch { showFieldMessage('开始日期无效，请重新选择。', true); }
});
$('recent').addEventListener('click', () => { if (!analytics) return; selectedRange = null; setInputs(defaultRange()); render(); showFieldMessage('显示截至今天的最近 14 天；未来数据不会被计入。'); });
$('refresh').addEventListener('click', loadData);
setInterval(() => { if (!document.hidden) loadData(); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData(); });
loadData();
