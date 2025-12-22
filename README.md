# 🏋️ 헬스장 웨이팅 시스템

> **실시간 기구 대기열 관리 시스템** - 줄서기 방식으로 공정하고 효율적인 헬스장 기구 사용

## 🛠 기술 스택

- **Backend**: Node.js, Express.js, WebSocket(ws)
- **Database**: PostgreSQL + Prisma ORM
- **Auth**: Passport.js (Google OAuth), JWT
- **Real-time**: WebSocket 실시간 통신

## 🚀 주요 API

### 🔐 인증
```http
POST  /api/auth/guest                  # 게스트 로그인
GET   /api/auth/google                 # Google OAuth 로그인
GET   /api/auth/google/callback        # OAuth 콜백
GET   /api/auth/me                     # 사용자 정보
POST  /api/auth/logout                 # 로그아웃
```

### 🏋️ 기구 관리
```http
GET   /api/equipment                        # 기구 목록
GET   /api/equipment/search                 # 기구 검색
GET   /api/equipment/categories             # 카테고리 목록
GET   /api/equipment/:id                    # 기구 상세
GET   /api/equipment/status?equipmentIds=   # 여러 기구 상태 조회
POST  /api/equipment/:id/quick-start        # 즉시 사용 시작
GET   /api/equipment/my-completed           # 완료 운동 내역
GET   /api/equipment/my-stats               # 운동 통계
GET   /api/equipment/today-total-time       # 오늘 총 운동시간
```

### ⏰ 웨이팅 시스템
```http
POST   /api/waiting/queue/:equipmentId        # 대기열 등록
DELETE /api/waiting/queue/:queueId            # 대기 취소
GET    /api/waiting/my-queues                 # 내 대기 목록
GET    /api/waiting/status/:equipmentId       # 기구 상태 조회
POST   /api/waiting/start-using/:equipmentId  # 운동 시작
POST   /api/waiting/complete-set              # 세트 완료
POST   /api/waiting/skip-rest                 # 휴식 건너뛰기
POST   /api/waiting/stop-exercise             # 운동 중단
GET    /api/waiting/current-usage             # 현재 사용중인 기구
POST   /api/waiting/update-eta/:equipmentId   # ETA 수동 업데이트
```

### 📋 루틴 관리
```http
GET    /api/routines                                    # 루틴 목록
POST   /api/routines                                    # 루틴 생성
GET    /api/routines/:id                                # 루틴 상세
PATCH  /api/routines/:id                                # 루틴 부분 수정
PUT    /api/routines/:id                                # 루틴 전체 수정
DELETE /api/routines/:id                                # 루틴 삭제

# 루틴 실행
POST   /api/routines/:id/start-first                    # 첫 운동 시작
POST   /api/routines/:id/start/:equipmentId             # 특정 운동 시작
POST   /api/routines/:id/next                           # 다음 운동

# 루틴 대기
POST   /api/routines/:id/queue/:equipmentId             # 루틴 운동 대기 등록
POST   /api/routines/:id/queue-next                     # 다음 운동 자동 대기
GET    /api/routines/:id/queue-status                   # 루틴 대기 상태

# 운동 조정
PUT    /api/routines/active-usage/rest-time             # 휴식 시간 조정(±10초)
GET    /api/routines/active-usage/status                # 현재 운동 상태

# 루틴 세부 수정
PATCH  /api/routines/:id/name                           # 이름 변경
POST   /api/routines/:id/exercises/add                  # 운동 추가
DELETE /api/routines/:id/exercises/:equipmentId         # 운동 제거
PATCH  /api/routines/:id/exercises/:equipmentId/sets    # 세트 수 변경
PATCH  /api/routines/:id/exercises/:equipmentId/rest    # 휴식 시간 변경
PATCH  /api/routines/:id/exercises/:equipmentId/order   # 순서 변경
```

### 🔔 알림
```http
GET    /api/notifications                  # 알림 목록
GET    /api/notifications/unread-count     # 안읽은 알림 수
GET    /api/notifications/stats            # 알림 통계
PATCH  /api/notifications/:id/read         # 특정 알림 읽음
PATCH  /api/notifications/read             # 여러 알림 읽음
PATCH  /api/notifications/read-all         # 전체 읽음
```

### ⭐ 즐겨찾기
```http
GET    /api/favorites                            # 즐겨찾기 목록
POST   /api/favorites/:equipmentId               # 추가
DELETE /api/favorites/equipment/:equipmentId     # 제거
GET    /api/favorites/check/:equipmentId         # 상태 확인
```

## 🔔 WebSocket 실시간 알림

### 주요 이벤트
- **클라이언트 → 서버**
  - `auth` - JWT 토큰 인증
  - `subscribe_equipment` - 기구 구독
  - `unsubscribe_equipment` - 구독 해제
  - `ping` - 연결 확인

- **서버 → 클라이언트**
  - `auth_success` - 인증 성공
  - `notification` - 알림 수신
  - `equipment_update` - 기구 상태 변경
  - `eta_updated` - 예상 대기시간 업데이트
  - `workout_completed` - 운동 완료

### 저장되는 알림 타입 (3가지만 DB 저장)
1. **EQUIPMENT_AVAILABLE** - 기구 사용 가능
2. **QUEUE_EXPIRED** - 대기 만료
3. **WAITING_COUNT** - 내 뒤 대기자 수

> 나머지 알림은 WebSocket으로만 전송됩니다.

## 📱 사용 흐름

### 기구가 비어있을 때
1. 기구 선택
2. 운동 설정 (세트 수, 휴식 시간)
3. "바로 시작" 클릭
4. 세트별 운동 진행
5. 자동 완료 → 다음 대기자에게 알림

### 기구가 사용 중일 때
1. 기구 선택
2. "대기열 등록" 클릭
3. 실시간 순번 확인
4. 알림 수신 (5분 유예)
5. "운동 시작" 클릭
6. 세트별 운동 진행
7. 자동 완료 → 다음 대기자에게 알림

## 🔐 인증 방식

모든 인증 필요 API는 헤더에 JWT 토큰 포함:
```http
Authorization: Bearer <your-jwt-token>
```

### 게스트 로그인
로그인 없이 12시간 동안 사용 가능한 임시 계정을 생성합니다.
```http
POST /api/auth/guest
```

## ⚠️ 에러 코드

| 코드 | 의미 | 사용 사례 |
|------|------|-----------|
| 200 | OK | 성공 |
| 201 | Created | 리소스 생성 성공 |
| 204 | No Content | 삭제 성공 |
| 400 | Bad Request | 입력 형식 오류 |
| 401 | Unauthorized | 인증 필요 |
| 403 | Forbidden | 권한 없음 |
| 404 | Not Found | 리소스 없음 |
| 409 | Conflict | 중복/충돌 |
| 429 | Too Many Requests | Rate Limit 초과 |
| 500 | Server Error | 서버 오류 |

## 📊 Rate Limiting

### ETA 수동 업데이트 제한
- 1분당 3회 제한
- 쿨다운: 10초 (연속 요청 방지)

## 🏗 아키텍처 특징

### 이벤트 기반 아키텍처
```
┌─────────────────────────────────┐
│ Routes (API Endpoints)          │ ← HTTP 요청 처리
├─────────────────────────────────┤
│ Services (Business Logic)       │ ← 핵심 비즈니스 로직
├─────────────────────────────────┤
│ EventBus (Event Management)     │ ← 이벤트 발행/구독
├─────────────────────────────────┤
│ Prisma (Data Access)            │ ← 데이터베이스 접근
└─────────────────────────────────┘
```

### 핵심 설계 원칙
1. **단일 책임 원칙** - 각 파일은 하나의 책임만
2. **계층 분리** - 단방향 의존만 허용
3. **이벤트 중심** - 느슨한 결합
4. **트랜잭션 우선** - DB 커밋 후 이벤트 발행

## 📁 프로젝트 구조

```
gym-waiting-system/
├── prisma/
│   ├── schema.prisma          # DB 스키마
│   └── seed.js                # 초기 데이터
├── src/
│   ├── config/
│   │   └── passport.js        # OAuth 설정
│   ├── events/
│   │   └── eventBus.js        # 이벤트 버스
│   ├── middleware/
│   │   └── auth.js            # JWT 인증
│   ├── routes/               # API 라우트
│   ├── services/             # 비즈니스 로직
│   ├── schemas/              # 검증 스키마
│   ├── utils/                # 유틸리티
│   ├── server.js             # Express 서버
│   └── websocket.js          # WebSocket 서버
└── .env                      # 환경 변수
```

## 📝 주요 특징

- ✅ 시간 예약 없는 간단한 대기열 시스템
- ✅ 세트별 자동 진행 및 추적
- ✅ WebSocket 실시간 알림 (+ 브라우저 푸시)
- ✅ 공정한 FIFO 순서 관리
- ✅ 자동 대기열 재배치
- ✅ 개인 운동 루틴 관리
- ✅ 게스트 로그인 지원 (12시간)
- ✅ 30일 자동 알림 정리

---

**Backend API Server** | Node.js + Express.js + PostgreSQL + WebSocket
