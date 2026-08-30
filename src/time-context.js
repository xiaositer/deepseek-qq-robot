const DEFAULT_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const LONG_GAP_MS = 30 * 60 * 1000;

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function formatChatTime(value, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  const timestamp = finiteTimestamp(value);
  if (timestamp === null) return '时间未知';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date(timestamp));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('weekday')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

export function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes ? `${totalHours} 小时 ${minutes} 分钟` : `${totalHours} 小时`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

export function buildTimedHistory(messages, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  let previousTimestamp = null;
  return messages.map(({ role, content, timestamp }) => {
    const currentTimestamp = finiteTimestamp(timestamp);
    const meta = [`消息时间：${formatChatTime(currentTimestamp, { timeZone })}`];
    if (currentTimestamp !== null && previousTimestamp !== null) {
      const gap = currentTimestamp - previousTimestamp;
      if (gap >= LONG_GAP_MS) {
        meta.push(`与上一条相隔 ${formatElapsedTime(gap)}，可能已进入新的聊天时段`);
      }
    }
    if (currentTimestamp !== null) previousTimestamp = currentTimestamp;
    return { role, content: `[${meta.join('；')}]\n${content}` };
  });
}

export function currentTimeContext(now = Date.now(), { timeZone = DEFAULT_TIME_ZONE } = {}) {
  return `当前时间：${formatChatTime(now, { timeZone })}（时区 ${timeZone}）`;
}

export { DEFAULT_TIME_ZONE, LONG_GAP_MS };
