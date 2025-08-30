# Supabase 연결 가이드 (Express + Prisma)

## 1) Supabase에서 프로젝트 생성
- Project Settings → Database → Connection strings
  - **Pooled**(port 6543) URL 복사 → `.env`의 `DATABASE_URL`에 입력
  - **Direct**(port 5432) URL 복사 → `.env`의 `DIRECT_URL`에 입력
  - 두 URL 모두 `sslmode=require` 유지

예시:
```
DATABASE_URL="postgresql://postgres:<PW>@aws-xxx.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true&connect_timeout=15"
DIRECT_URL="postgresql://postgres:<PW>@db.xxxxx.supabase.co:5432/postgres?sslmode=require"
```

## 2) Prisma 마이그레이션/시드
```bash
npm i
npx prisma generate
# 운영/공유 DB에는 dev보다 deploy 권장
npx prisma migrate deploy
node prisma/seed.js    # 필요 시
```

## 3) 서버 실행
```
npm run start    # 또는 npm run dev
```

## 4) Postman 테스트
- baseUrl = http://localhost:4000
- 컬렉션: gym-reservation-api.postman_collection.json
- Login → token 저장 → 보호 API 호출
```

