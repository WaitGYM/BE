# 🏋️ Gym Reservation Backend (Express + Prisma + PostgreSQL)

## 1) 준비물
- Node.js 18+
- PostgreSQL (Supabase 또는 로컬 DB)
- Docker (선택: Postgres를 Docker로 띄우려면)

## 2) 실행
```bash
# 1. DB (Docker 사용 시)
docker compose up -d

# 2. 패키지 설치
npm install

# 3. Prisma 마이그레이션 적용
npm run migrate   # (= npx prisma migrate deploy)

# 4. Seed (관리자 계정/예시 데이터 추가)
npm run seed

# 5. 서버 실행
npm run dev

```

- 서버: http://localhost:4000
- 헬스 체크: `GET /health`

관리자 계정(Seed):
- email: `admin@example.com`
- password: `admin1234`

## 3) 주요 API
🔑 Auth

- POST /api/auth/register → { email, password, name }
- POST /api/auth/login → { email, password } → { token }

🏋️ Equipment

- GET /api/equipment
- POST /api/equipment (ADMIN) → { name, location? }
- PUT /api/equipment/:id (ADMIN)
- DELETE /api/equipment/:id (ADMIN)

📅 Reservations
- POST /api/reservations (USER) → { equipmentId, startAt, endAt }
- GET /api/reservations/me (USER)
- GET /api/reservations/:id (USER 본인 / ADMIN)
- PUT /api/reservations/:id (USER 본인 / ADMIN)
- DELETE /api/reservations/:id (USER 본인 / ADMIN)
- GET /api/reservations/availability?equipmentId=1&date=YYYY-MM-DD&slotMinutes=30

## 4) 권한
- Bearer 토큰 필요: 대부분의 예약/개인 데이터 관련 API
- 관리자만: 장비 생성/수정/삭제

## 5) 테스트(포스트맨)
1. `gym-reservation-api.postman_collection.json` 임포트
2. 환경 변수 `baseUrl` = `http://localhost:4000`
3. `Auth / Register` → 테스트 계정 생성
4. `Auth / Login` → 토큰 자동 저장 (collection test script)
5. 이후 요청은 자동으로 `Authorization: Bearer {{token}}` 헤더가 붙습니다.

> 주의: 시간/타임존은 데모용으로 단순화했습니다. 실환경에서는 타임존/운영시간 로직을 더 정교하게 적용하세요.
