// 분↔초 변환과 날짜 경계 계산 유틸
const MIN = 60;
const toSeconds = (minutes) => Math.max(0, Number(minutes || 0)) * MIN;
const toMinutes = (seconds) => Math.round(Math.max(0, Number(seconds || 0)) / MIN);

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d = new Date()) => new Date(startOfDay(d).getTime() + 24*60*60*1000 - 1);

module.exports = { toSeconds, toMinutes, startOfDay, endOfDay };
