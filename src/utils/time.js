// 분↔초 변환과 날짜 경계 계산 유틸
const MIN = 60;
const toSeconds = (minutes) => Math.max(0, Number(minutes || 0)) * MIN;
const toMinutes = (seconds) => Math.round(Math.max(0, Number(seconds || 0)) / MIN);

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d = new Date()) => new Date(startOfDay(d).getTime() + 24*60*60*1000 - 1);
const KST_OFFSET_MIN = 9 * 60; // +09:00

function rangeTodayKST(now = new Date()) {
  // now(UTC) -> KST 기준 '오늘'의 UTC 경계 계산
  const utcMs = now.getTime();
  const kstMs = utcMs + KST_OFFSET_MIN * 60 * 1000;
  const kst = new Date(kstMs);

  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();

  // KST 00:00~23:59:59.999에 대응하는 UTC 시각
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - KST_OFFSET_MIN * 60 * 1000);
  const end   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - KST_OFFSET_MIN * 60 * 1000);

  return { start, end };
}

module.exports = { toSeconds, toMinutes, startOfDay, endOfDay, rangeTodayKST };
