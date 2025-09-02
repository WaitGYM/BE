const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
})

async function main() {
  // 관리자는 구글 로그인 후 수동으로 역할 변경
  // 또는 특정 Google ID를 미리 관리자로 설정
  const adminGoogleId = process.env.ADMIN_GOOGLE_ID // 환경변수로 관리자 Google ID 설정
  
  if (adminGoogleId) {
    await prisma.user.upsert({
      where: { googleId: adminGoogleId },
      update: { role: 'ADMIN' },
      create: {
        email: 'admin@example.com', // 실제로는 구글 로그인 후 업데이트됨
        name: 'Admin',
        googleId: adminGoogleId,
        role: 'ADMIN'
      }
    })
  }

  // 샘플 장비
  await prisma.equipment.createMany({
    data: [
      { name: '스쿼트 랙', location: 'A-1' },
      { name: '레그 프레스', location: 'A-2' },
      { name: '바벨 벤치', location: 'B-1' }
    ],
    skipDuplicates: true
  })

  console.log('Seed complete. Google OAuth로 로그인하세요.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})