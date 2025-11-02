// src/services/workout-stats.service.js
const prisma = require('../lib/prisma');

/**
 * 시간 포맷팅 함수
 */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  const parts = [];
  if (h > 0) parts.push(`${h}시간`);
  if (m > 0) parts.push(`${m}분`);
  if (s > 0 || parts.length === 0) parts.push(`${s}초`);
  
  return parts.join(' ');
}

/**
 * 기간별 운동 통계 조회
 */
async function getWorkoutStats(userId, startDate, endDate = new Date()) {
  const stats = await prisma.equipmentUsage.findMany({
    where: {
      userId,
      status: 'COMPLETED',
      endedAt: { gte: startDate, lte: endDate }
    },
    include: {
      equipment: { 
        select: { 
          id: true, 
          name: true, 
          category: true,
          imageUrl: true,
          muscleGroup: true
        } 
      }
    },
    orderBy: { endedAt: 'desc' },
  });

  return processWorkoutStats(stats);
}

/**
 * 운동 통계 처리
 */
function processWorkoutStats(stats) {
  const equipmentStats = {};
  const categoryStats = {};
  const workoutDetails = [];
  let totalSets = 0;
  let totalSeconds = 0;

  stats.forEach((workout) => {
    const equipmentId = workout.equipmentId;
    
    // 기구별 통계
    if (!equipmentStats[equipmentId]) {
      equipmentStats[equipmentId] = {
        equipment: workout.equipment,
        count: 0,
        totalSets: 0,
        totalSeconds: 0,
        lastUsed: null
      };
    }
    
    equipmentStats[equipmentId].count += 1;
    equipmentStats[equipmentId].totalSets += (workout.currentSet || 0);
    
    // 시간 계산
    if (workout.startedAt && workout.endedAt) {
      const durationSeconds = Math.round((workout.endedAt - workout.startedAt) / 1000);
      
      equipmentStats[equipmentId].totalSeconds += durationSeconds;
      equipmentStats[equipmentId].lastUsed = workout.endedAt;
      totalSeconds += durationSeconds;
      
      // 상세 운동 기록
      workoutDetails.push({
        id: workout.id,
        equipmentId: workout.equipmentId,
        equipmentName: workout.equipment.name,
        category: workout.equipment.category,
        imageUrl: workout.equipment.imageUrl,
        muscleGroup: workout.equipment.muscleGroup,
        sets: workout.currentSet,
        totalSets: workout.totalSets,
        durationSeconds: durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        startedAt: workout.startedAt,
        endedAt: workout.endedAt,
        wasFullyCompleted: workout.setStatus === 'COMPLETED',
        wasInterrupted: ['STOPPED', 'FORCE_COMPLETED'].includes(workout.setStatus),
        setStatus: workout.setStatus
      });
    }
    
    totalSets += (workout.currentSet || 0);

    // 카테고리별 통계
    const category = workout.equipment?.category || '기타';
    if (!categoryStats[category]) {
      categoryStats[category] = { 
        category,
        count: 0, 
        totalSets: 0,
        totalSeconds: 0
      };
    }
    categoryStats[category].count += 1;
    categoryStats[category].totalSets += (workout.currentSet || 0);
    if (workout.startedAt && workout.endedAt) {
      const durationSeconds = Math.round((workout.endedAt - workout.startedAt) / 1000);
      categoryStats[category].totalSeconds += durationSeconds;
    }
  });

  // 기구별 통계 포맷팅
  const formattedEquipmentStats = Object.values(equipmentStats).map(stat => ({
    ...stat,
    totalMinutes: Math.round(stat.totalSeconds / 60),
    totalTimeFormatted: formatDuration(stat.totalSeconds)
  })).sort((a, b) => b.totalSeconds - a.totalSeconds);

  // 카테고리별 통계 포맷팅
  const formattedCategoryStats = Object.values(categoryStats).map(stat => ({
    ...stat,
    totalMinutes: Math.round(stat.totalSeconds / 60),
    totalTimeFormatted: formatDuration(stat.totalSeconds),
    percentage: totalSeconds > 0 
      ? Math.round((stat.totalSeconds / totalSeconds) * 100) 
      : 0
  })).sort((a, b) => b.totalSeconds - a.totalSeconds);

  return {
    summary: {
      totalWorkouts: stats.length,
      totalSets,
      totalSeconds,
      totalMinutes: Math.round(totalSeconds / 60),
      totalHours: (totalSeconds / 3600).toFixed(2),
      totalTimeFormatted: formatDuration(totalSeconds),
      averageSetsPerWorkout: stats.length > 0 
        ? Math.round(totalSets / stats.length) 
        : 0,
      averageSecondsPerWorkout: stats.length > 0 
        ? Math.round(totalSeconds / stats.length) 
        : 0
    },
    equipmentStats: formattedEquipmentStats,
    categoryStats: formattedCategoryStats,
    workoutDetails: workoutDetails,
    recentWorkouts: workoutDetails.slice(0, 5)
  };
}

/**
 * 오늘 하루 운동 통계 조회
 */
async function getTodayWorkoutStats(userId) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  return await getWorkoutStats(userId, startOfToday, now);
}

module.exports = {
  formatDuration,
  getWorkoutStats,
  processWorkoutStats,
  getTodayWorkoutStats
};