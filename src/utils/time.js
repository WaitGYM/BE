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

/* ---------- ⬇️ 추가: 대기/운동 시간 계산 공통 ---------- */

// 안전 클램프
const clamp = (n, lo = 0, hi = Number.POSITIVE_INFINITY) =>
  Math.min(Math.max(Number(n) || 0, lo), hi);

// 두 시각 차이(초) - 음수 방지, 정수 초
const diffSec = (from, to = new Date()) => {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!isFinite(a) || !isFinite(b)) return 0;
  return clamp(Math.floor((b - a) / 1000));
};

// HH:MM:SS
const hms = (s) => {
  const n = clamp(Math.floor(s || 0));
  const h = String(Math.floor(n / 3600)).padStart(2, '0');
  const m = String(Math.floor((n % 3600) / 60)).padStart(2, '0');
  const sec = String(n % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
};

function computeCompleteSetSummary({
  startedAt,
  currentSetStartedAt,
  currentSet,
  workAccPrevSec,
  now = new Date(),
}) {
  const setStart = currentSetStartedAt || startedAt;
  const setDurationSec   = diffSec(setStart, now);
  const workAccSec       = clamp(Math.floor(workAccPrevSec || 0) + setDurationSec);
  const totalDurationSec = diffSec(startedAt, now);

  // 첫 세트 완료 직후엔 휴식 0 (요구사항)
  let totalRestSec = currentSet === 1 ? 0 : clamp(totalDurationSec - workAccSec, 0, totalDurationSec);
  const workTimeSec = clamp(totalDurationSec - totalRestSec, 0, totalDurationSec);

  const summary = {
    totalDurationSec,
    totalDuration: hms(totalDurationSec),
    totalRestSec,
    totalRest: hms(totalRestSec),
    workTimeSec,
    workTime: hms(workTimeSec),
  };

  return { setDurationSec, workAccSec, totalDurationSec, totalRestSec, workTimeSec, summary };
}

module.exports = {
  toSeconds, toMinutes, startOfDay, endOfDay, rangeTodayKST,
  // ⬇️ 추가 export
  clamp, diffSec, hms, computeCompleteSetSummary,
};