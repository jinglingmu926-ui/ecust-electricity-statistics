const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MAX_GAP_MS = 20 * HOUR_MS;
const CN_OFFSET = 8 * HOUR_MS;
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;

export function chinaDay(time) {
  return new Date(Number(time) + CN_OFFSET).toISOString().slice(0, 10);
}

export function dayTimestamp(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式应为YYYY-MM-DD');
  const time = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(time) || chinaDay(time) !== day) throw new Error('日期无效');
  return time;
}

export function addChinaDays(day, count) {
  return chinaDay(dayTimestamp(day) + count * DAY_MS);
}

function normalize(readings, now) {
  const valid = (Array.isArray(readings) ? readings : [])
    .map(r => ({ ...r, time: Date.parse(r.observedAt), remainingKwh: Number(r.remainingKwh) }))
    .filter(r => Number.isFinite(r.time) && r.time <= now && Number.isFinite(r.remainingKwh))
    .sort((a, b) => a.time - b.time);
  const unique = new Map();
  for (const record of valid) unique.set(`${record.time}:${record.precision || 'minute'}`, record);
  return [...unique.values()];
}

function boundaryAt(readings, target) {
  let before = null;
  for (const r of readings) {
    if (r.time === target) return { value: r.remainingKwh, exact: true };
    if (r.time > target) {
      if (!before) return null;
      const span = r.time - before.time;
      if (span > MAX_GAP_MS || r.remainingKwh > before.remainingKwh + 0.001) return null;
      const fraction = (target - before.time) / span;
      return { value: before.remainingKwh + fraction * (r.remainingKwh - before.remainingKwh), exact: false };
    }
    before = r;
  }
  return null;
}

function usageFor(day, timed, now) {
  const start = dayTimestamp(day);
  const calendarEnd = start + DAY_MS;
  const today = chinaDay(now);
  const isToday = day === today;
  const inDay = timed.filter(r => r.time >= start && r.time < Math.min(calendarEnd, now + 1));
  const endpoint = isToday && inDay.length ? inDay[inDay.length - 1].time : calendarEnd;
  if (start > now || (isToday && !inDay.length)) {
    return { usageKwh: null, status: 'missing', reason: start > now ? '尚未到查询日期' : '今天尚无成功查询' };
  }

  // A balance increase reveals a net top-up, not its exact amount or simultaneous use.
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1], b = timed[i];
    if (b.time > start && a.time < endpoint && b.remainingKwh > a.remainingKwh + 0.001) {
      return { usageKwh: null, status: 'recharge', reason: '检测到余额净增，充值期间用电需核算' };
    }
  }

  const first = boundaryAt(timed, start);
  const last = boundaryAt(timed, endpoint);
  if (!first || !last || endpoint <= start) {
    return { usageKwh: null, status: 'missing', reason: '缺少日界读数，不能计算整日用电' };
  }

  for (let i = 1; i < timed.length; i++) {
    if (timed[i].time > start && timed[i - 1].time < endpoint && timed[i].time - timed[i - 1].time > MAX_GAP_MS) {
      return { usageKwh: null, status: 'missing', reason: '连续查询间隔超过20小时，不分摊到单日' };
    }
  }

  return {
    usageKwh: round(Math.max(0, first.value - last.value)),
    status: isToday ? 'partial' : first.exact && last.exact ? 'complete' : 'estimated',
    reason: isToday ? '截至本日最后一次查询，尚非整日数据' : first.exact && last.exact ? '按两次午夜实际读数计算' : '按午夜两侧读数线性估算，非整日实测'
  };
}

function slotFor(day, slot, readings, attempts, now) {
  const due = dayTimestamp(day) + (slot === 'morning' ? 9 * HOUR_MS : DAY_MS);
  const found = readings.filter(r => r.logicalDay === day && r.slot === slot && r.source !== 'legacy');
  const r = found[0]; // The successful scheduled reading is immutable.
  if (r) {
    const planned = Number.isFinite(Date.parse(r.scheduledFor)) ? Date.parse(r.scheduledFor) : due;
    return { reading: r.remainingKwh, status: Math.abs(r.time - planned) > 15 * 60000 ? 'late' : 'success', actualAt: r.observedAt, scheduledFor: r.scheduledFor, remainingKwh: r.remainingKwh };
  }
  const failures = attempts.filter(a => a.logicalDay === day && a.slot === slot && a.status === 'failed').length;
  const status = now < due ? 'pending' : now <= due + 45 * 60000 && failures < 3 ? failures ? 'retrying' : 'pending' : 'missing';
  return { reading: null, status, actualAt: null, scheduledFor: new Date(due).toISOString() };
}

function getFreshness(latest, now) {
  if (!latest) return { state: 'empty', message: '尚无成功查询记录' };
  const today = dayTimestamp(chinaDay(now));
  const latestDue = now >= today + 9 * HOUR_MS ? today + 9 * HOUR_MS : today;
  const lateness = now - latestDue;
  const predatesDue = latest.time < latestDue - 15 * 60000;
  if (now - latest.time > 26 * HOUR_MS || predatesDue && lateness > 45 * 60000) {
    return { state: 'stale', message: '本时段数据未更新，当前展示上次成功结果' };
  }
  if (predatesDue) return { state: 'late', message: '等待本时段查询结果，仍展示上次记录' };
  return { state: 'fresh', message: '最近一个应查询时段已有数据' };
}

export function buildDashboard(snapshot = {}, options = {}) {
  const now = Date.parse(options.nowIso || new Date().toISOString());
  if (!Number.isFinite(now)) throw new Error('当前时间无效');
  const today = chinaDay(now);
  const startDate = options.startDate || addChinaDays(today, -13);
  const endDate = options.endDate || today;
  const start = dayTimestamp(startDate), end = dayTimestamp(endDate);
  if (end < start || (end - start) / DAY_MS >= 14) throw new Error('请选择1至14天的连续日期');

  const readings = normalize(snapshot.readings, now);
  const timed = readings.filter(r => r.precision !== 'date');
  const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : [];
  const makeDay = day => {
    const historical = readings.filter(r => (r.source === 'legacy' || r.slot === 'historical') && chinaDay(r.time) === day);
    const morning = slotFor(day, 'morning', readings, attempts, now);
    const night = slotFor(day, 'night', readings, attempts, now);
    if (historical.length) {
      if (morning.reading === null && morning.status !== 'pending') morning.status = 'historical';
      if (night.reading === null && night.status !== 'pending') night.status = 'historical';
    }
    return { date: day, ...usageFor(day, timed, now), morning, night, historyCount: historical.length,
      historyReadings: historical.map(r => ({ observedAt: r.observedAt, remainingKwh: r.remainingKwh, precision: r.precision })) };
  };
  const days = [];
  for (let t = start; t <= end; t += DAY_MS) days.push(makeDay(chinaDay(t)));

  const averageDays = [];
  for (let n = 7; n >= 1; n--) {
    const day = makeDay(addChinaDays(today, -n));
    if (['complete', 'estimated'].includes(day.status) && day.usageKwh !== null) averageDays.push(day);
  }
  const averageUsage = averageDays.length ? round(averageDays.reduce((sum, d) => sum + d.usageKwh, 0) / averageDays.length) : null;
  const latest = timed.at(-1) || null;
  const valid = days.filter(d => ['complete', 'estimated'].includes(d.status) && d.usageKwh !== null);
  const previous = timed.at(-2);
  return {
    latest,
    lastChange: latest && previous ? round(previous.remainingKwh - latest.remainingKwh) : null,
    freshness: getFreshness(latest, now),
    today: makeDay(today),
    average: { usageKwh: averageUsage, dayCount: averageDays.length },
    estimatedDays: latest && averageDays.length >= 3 && averageUsage > 0 ? round(Math.max(0, latest.remainingKwh) / averageUsage) : null,
    range: { startDate, endDate },
    days,
    summary: { usageKwh: valid.length ? round(valid.reduce((sum, d) => sum + d.usageKwh, 0)) : null, validDays: valid.length, excludedDays: days.length - valid.length },
    historyStart: readings.length ? chinaDay(readings[0].time) : today,
    latestDate: latest ? chinaDay(latest.time) : null,
    service: snapshot.service || {}
  };
}
