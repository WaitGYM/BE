const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcrypt')
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } }
})

async function main() {
  // Admin user
  const adminEmail = 'admin@example.com'
  const adminPass = 'admin1234'
  const hash = await bcrypt.hash(adminPass, 10)

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      password: hash,
      name: 'Admin',
      role: 'ADMIN'
    }
  })

  // Sample equipment
  await prisma.equipment.createMany({
    data: [
      { name: '스쿼트 랙', location: 'A-1' },
      { name: '레그 프레스', location: 'A-2' },
      { name: '바벨 벤치', location: 'B-1' }
    ],
    skipDuplicates: true
  })

  console.log('Seed complete. Admin login ->', adminEmail, adminPass)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})
