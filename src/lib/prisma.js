// ⚠️ 이 파일에서는 어떤 라우터/서비스/웹소켓도 import 하지 말 것!
// 프로세스당 PrismaClient 인스턴스 1개 원칙
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
    log: ['error', 'warn'],
});
module.exports = prisma;
