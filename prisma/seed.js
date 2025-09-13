const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
})

async function main() {
  // 헬스장 기구들
  const equipmentData = [
    { name: '스미스 머신', imageUrl: null },
    { name: '스텝밀', imageUrl: null },
    { name: '케이블 와이 레이즈', imageUrl: null },
    { name: '랫풀다운', imageUrl: null },
    { name: '레그 프레스', imageUrl: null },
    { name: '레그 컬', imageUrl: null },
    { name: '어시스티드 머신 친업', imageUrl: null },
    { name: '바벨 벤치 프레스', imageUrl: null },
    { name: '백 익스텐션', imageUrl: null },
    { name: '힙 어브덕션/어덕션', imageUrl: null },
    { name: '트레드밀', imageUrl: null },
    { name: '스쿼트 랙', imageUrl: null },
  ]

  for (const equipment of equipmentData) {
    await prisma.equipment.upsert({
      where: { 
        name: equipment.name
      },
      update: {},
      create: equipment
    })
  }

  console.log(`${equipmentData.length}개의 기구가 등록되었습니다.`)
  console.log('Seed complete. Google OAuth로 로그인하세요.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})