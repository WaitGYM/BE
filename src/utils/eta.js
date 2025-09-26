// ETA 계산 공용 유틸 (waiting/equipment 서비스가 함께 사용)
// 프로젝트 상황에 맞게 평균 시간은 조정 가능
const AVG_SET_MIN = 3;        // 세트 수행 평균 시간(분)
const SETUP_CLEANUP_MIN = 1;  // 세팅/정리 시간(분) — 사용자 교체 등

// 한 사람(앞사람) 한 사이클이 차지하는 전형적 블록(분)
// = (세트수 평균 3 * 세트시간) + 휴식(경험치 2분) + 교체시간
const TYPICAL_BLOCK_MIN = (AVG_SET_MIN * 3) + 2 + SETUP_CLEANUP_MIN;


// 현재 사용자의 남은 시간(분) 계산
// usage: { status, totalSets, currentSet, setStatus, restSeconds, currentSetStartedAt, restStartedAt, ... }
function calculateRealTimeETA(usage) {
  if (!usage || usage.status !== 'IN_USE') return 0;

  const now = Date.now();
  const setMs = AVG_SET_MIN * 60 * 1000;
  const restMs = (usage.restSeconds || 0) * 1000;
  const remainingSets = Math.max(0, (usage.totalSets ?? 0) - (usage.currentSet ?? 0) + 1);

  if (usage.setStatus === 'EXERCISING') {
    const elapsed = usage.currentSetStartedAt ? now - new Date(usage.currentSetStartedAt).getTime() : 0;
    const currRemain = Math.max(0, setMs - elapsed);
    const futureWork = Math.max(0, (remainingSets - 1)) * setMs;
    const futureRest = Math.max(0, (remainingSets - 1)) * restMs;
    return Math.ceil((currRemain + futureWork + futureRest) / 60000);
  }

  if (usage.setStatus === 'RESTING') {
    const restElapsed = usage.restStartedAt ? now - new Date(usage.restStartedAt).getTime() : 0;
    const restRemain = Math.max(0, restMs - restElapsed);
    const futureWork = remainingSets * setMs;
    const futureRest = Math.max(0, (remainingSets - 1)) * restMs;
    return Math.ceil((restRemain + futureWork + futureRest) / 60000);
  }

  return 0;
}

// 현재 사용자의 ETA를 기준으로 대기열 각 사람의 예상 시작 시각(분)을 누적 계산
// queue: 대기열 배열(선두가 0번)
function buildQueueETAs(currentETA, queue) {
  const etas = [];
  let acc = (currentETA || 0) + SETUP_CLEANUP_MIN; // 다음 사용자 세팅 시간 포함
  for (let i = 0; i < (queue?.length ?? 0); i++) {
    etas.push(acc);
    // 경험치 기반 추정: 3세트 * AVG_SET_MIN + 휴식(대략 2분) + 교체시간
    acc += (AVG_SET_MIN * 3) + 2 + SETUP_CLEANUP_MIN;
  }
  return etas;
}

/**
* 관찰자(대기 미등록)가 "지금 줄서면" 시작까지 걸릴 예상 대기시간(분)
* - 장비가 available이면 0
* - IN_USE & queue>0: 마지막 대기자의 시작시각 + TYPICAL_BLOCK_MIN
* - IN_USE & queue=0: 현재사용자 남은시간(currentETA) + 교체시간
*/

function estimateIfJoinNow({ isAvailable, waitingCount, queueETAs, currentETA }) {
 if (isAvailable) return 0;
 if ((waitingCount || 0) > 0) {
    const tailEta = queueETAs?.[waitingCount - 1] ?? 0;
    return Math.max(0, Math.ceil(tailEta + TYPICAL_BLOCK_MIN));
    }
    return Math.max(0, Math.ceil((currentETA || 0) + SETUP_CLEANUP_MIN));
}

module.exports = { 
calculateRealTimeETA, 
buildQueueETAs, 
AVG_SET_MIN, 
SETUP_CLEANUP_MIN,
TYPICAL_BLOCK_MIN,
estimateIfJoinNow
};