const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
})

async function main() {
  // 헬스장 기구들 (카테고리 정보 포함)
  const equipmentData = [
    { 
      name: '스미스 머신 스쿼트', 
      imageUrl: null,
      category: '다리',
      muscleGroup: '대퇴사두근, 둔근, 햄스트링, 내전근'
    },
    { 
      name: '스텝밀', 
      imageUrl: null,
      category: '유산소',
      muscleGroup: '전신'
    },
    { 
      name: '케이블 와이 레이즈', 
      imageUrl: null,
      category: '어깨',
      muscleGroup: '삼각근, 승모근'    },
    { 
      name: '랫풀다운', 
      imageUrl: null,
      category: '등',
      muscleGroup: '광배근, 이두'    },
    { 
      name: '레그 프레스', 
      imageUrl: null,
      category: '다리',
      muscleGroup: '대퇴사두근, 둔근'    },
    { 
      name: '레그 컬', 
      imageUrl: null,
      category: '다리',
      muscleGroup: '햄스트링'    },
    { 
      name: '어시스티드 머신 친업', 
      imageUrl: null,
      category: '등',
      muscleGroup: '광배근, 이두, 어깨'    },
    { 
      name: '바벨 벤치 프레스', 
      imageUrl: null,
      category: '가슴',
      muscleGroup: '대흉근, 삼두, 어깨'    },
    { 
      name: '백 익스텐션', 
      imageUrl: null,
      category: '등',
      muscleGroup: '척추기립근, 둔근'    },
    { 
      name: '힙 어브덕션/어덕션', 
      imageUrl: null,
      category: '다리',
      muscleGroup: '둔근, 내전근'    },
    { 
      name: '트레드밀', 
      imageUrl: null,
      category: '유산소',
      muscleGroup: '전신'    },
    { 
      name: '스쿼트 랙', 
      imageUrl: null,
      category: '다리',
      muscleGroup: '대퇴사두근, 둔근, 햄스트링'    },
  ]

  for (const equipment of equipmentData) {
    await prisma.equipment.upsert({
      where: { 
        name: equipment.name
      },
      update: {
        category: equipment.category,
        muscleGroup: equipment.muscleGroup
      },
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