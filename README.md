# 🏋️ Gym Reservation Backend (Express + Prisma + PostgreSQL)

## 1) 🛠️ 기술 스택
- Backend: Node.js + Express
- Database: PostgreSQL + Prisma ORM
- Authentication: Google OAuth 2.0 + JWT
- Deployment: Docker 지원
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

# Google OAuth 로그인 시작
GET /api/auth/google

# Google OAuth 콜백 (자동 처리)
GET /api/auth/google/callback

# 현재 사용자 정보 조회
GET /api/auth/me
Authorization: Bearer {token}

# 로그아웃
POST /api/auth/logout

# 관리자 권한 부여 (개발환경 전용)
POST /api/auth/make-admin/:userId

🏋️ Equipment

# 장비 목록 조회 (공개)
GET /api/equipment

# 장비 생성 (관리자만)
POST /api/equipment
Authorization: Bearer {token}
Content-Type: application/json
{
  "name": "스쿼트 랙",
  "location": "A-1"
}

# 장비 수정 (관리자만)
PUT /api/equipment/:id
Authorization: Bearer {token}

# 장비 삭제 (관리자만)
DELETE /api/equipment/:id
Authorization: Bearer {token}

📅 Reservations
# 예약 생성
POST /api/reservations
Authorization: Bearer {token}
Content-Type: application/json
{
  "equipmentId": 1,
  "startAt": "2025-09-03T10:00:00.000Z",
  "endAt": "2025-09-03T11:00:00.000Z"
}

# 내 예약 목록
GET /api/reservations/me
Authorization: Bearer {token}

# 예약 상세 조회 (본인 또는 관리자)
GET /api/reservations/:id
Authorization: Bearer {token}

# 예약 수정 (본인 또는 관리자)
PUT /api/reservations/:id
Authorization: Bearer {token}

# 예약 삭제 (본인 또는 관리자)
DELETE /api/reservations/:id
Authorization: Bearer {token}

# 예약 가능 시간 조회
GET /api/reservations/availability?equipmentId=1&date=2025-09-03&open=09:00&close=18:00&slotMinutes=30

## 4) 권한
- USER: 예약 생성/조회/수정/삭제 (본인 것만)
- ADMIN: 모든 예약 관리 + 장비 관리

## 5) 테스트
- 브라우저에서 http://localhost:4000/api/auth/google 접속
- Google 로그인 완료 후 토큰 획득
- Postman에서 Authorization: Bearer {token} 헤더 설정
- 보호된 API 테스트

## 6) 데이터베이스스키마
- User
id: 사용자 고유 ID
email: 이메일 (Google에서 제공)
name: 사용자 이름
role: 권한 (USER/ADMIN)
googleId: Google OAuth ID (고유)
avatar: 프로필 이미지 URL

- Equipment
id: 장비 고유 ID
name: 장비명
location: 위치 (선택)

- Reservation
id: 예약 고유 ID
userId: 예약자 ID
equipmentId: 장비 ID
startAt: 시작 시간
endAt: 종료 시간
status: 예약 상태 (BOOKED)

## 7) 🔧 주요 기능
- 예약 시스템
시간 중복 방지
실시간 예약 가능 시간 조회
사용자별 예약 관리
- 보안
Google OAuth 2.0 인증
JWT 토큰 기반 API 보호
역할 기반 접근 제어 (RBAC)

- 관리 기능
관리자 장비 관리
모든 예약 관리 권한
> 주의: 시간/타임존은 데모용으로 단순화했습니다. 실환경에서는 타임존/운영시간 로직을 더 정교하게 적용하세요.
