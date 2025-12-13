# 헬스장 웨이팅 시스템 (Gym Waiting System)

> **실시간 기구 대기열 관리 시스템** - 줄서기 방식으로 공정하고 효율적인 헬스장 기구 사용

## 📖 개요
시간 예약 없이 **현장 대기열(웨이팅)** 방식으로 헬스장 기구를 관리하는 시스템입니다.
- 줄서기 방식의 공정한 순서 관리
- 세트별 운동 진행 실시간 추적
- 자동으로 다음 사람에게 순서 넘김

## ✨ 주요 기능
- **Google OAuth 인증** - 간편한 소셜 로그인
- **실시간 웨이팅 시스템** - 대기열 자동 관리
- **세트별 운동 추적** - 운동 진행 상황 실시간 모니터링
- **루틴 관리** - 개인 맞춤 운동 루틴 생성/관리
- **실시간 알림** - WebSocket 기반 즉시 알림
- **즐겨찾기** - 자주 사용하는 기구 저장

## 🛠 기술 스택
- **Backend**: Node.js, Express.js, WebSocket(ws)
- **Database**: PostgreSQL + Prisma ORM
- **Auth**: Passport.js (Google OAuth), JWT
- **Real-time**: WebSocket 실시간 통신

## 🚀 핵심 API

### 인증
```http
GET  /api/auth/google              # Google OAuth 로그인
GET  /api/auth/google/callback     # OAuth 콜백
GET  /api/auth/me                  # 사용자 정보
POST /api/auth/logout              # 로그아웃
```

### 기구 관리
```http
GET  /api/equipment                        # 기구 목록 (카테고리/검색)
GET  /api/equipment/:id                    # 기구 상세
GET  /api/equipment/status?equipmentIds=   # 여러 기구 상태 조회
POST /api/equipment/:id/quick-start        # 즉시 사용 시작
GET  /api/equipment/my-completed           # 완료 운동 내역
GET  /api/equipment/my-stats               # 운동 통계
GET  /api/equipment/today-total-time       # 오늘 총 운동시간
```

### 웨이팅 시스템
```http
POST   /api/waiting/queue/:equipmentId        # 대기열 등록
DELETE /api/waiting/queue/:queueId            # 대기 취소
POST   /api/waiting/start-using/:equipmentId  # 운동 시작
POST   /api/waiting/complete-set              # 세트 완료
POST   /api/waiting/skip-rest                 # 휴식 건너뛰기
POST   /api/waiting/stop-exercise             # 운동 중단
GET    /api/waiting/status/:equipmentId       # 실시간 상태
GET    /api/waiting/current-usage             # 현재 사용중인 기구
```

### 루틴 관리
```http
GET    /api/routines                                    # 루틴 목록
POST   /api/routines                                    # 루틴 생성
GET    /api/routines/:id                                # 루틴 상세
PATCH  /api/routines/:id                                # 루틴 수정
DELETE /api/routines/:id                                # 루틴 삭제
POST   /api/routines/:routineId/start-first            # 첫 운동 시작
POST   /api/routines/:routineId/start/:equipmentId     # 특정 운동 시작
POST   /api/routines/:routineId/next                   # 다음 운동
POST   /api/routines/:routineId/queue/:equipmentId     # 루틴 운동 대기 등록
```

### 알림
```http
GET   /api/notifications                  # 알림 목록
GET   /api/notifications/unread-count     # 안읽은 알림 수
PATCH /api/notifications/:id/read         # 알림 읽음 처리
PATCH /api/notifications/read-all         # 모든 알림 읽음
```

### 즐겨찾기
```http
GET    /api/favorites                            # 즐겨찾기 목록
POST   /api/favorites/:equipmentId               # 즐겨찾기 추가
DELETE /api/favorites/equipment/:equipmentId     # 즐겨찾기 제거
```

## 🔔 WebSocket 실시간 알림

### 연결 및 인증
```javascript
const ws = new WebSocket('ws://localhost:4000/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'auth',
    token: 'your-jwt-token'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('알림:', data);
};
```

### 알림 타입
1. **EQUIPMENT_AVAILABLE** - 기구 사용 가능
2. **QUEUE_EXPIRED** - 대기 만료 
3. **WAITING_COUNT** - 내 뒤 대기자 수

## 📱 사용 흐름

### 기구가 비어있을 때
```
1. 기구 선택
2. 운동 설정 (세트 수, 휴식 시간)
3. "바로 시작"
4. 세트별 진행 → 자동 완료
```

### 기구가 사용 중일 때
```
1. 기구 선택
2. "대기열 등록"
3. 대기 (실시간 순번 확인)
4. 알림 수신 (5분 유예)
5. "운동 시작"
6. 세트별 진행 → 자동 완료
```

## 🔐 인증 방식
모든 인증 필요 API는 헤더에 JWT 토큰 포함:
```http
Authorization: Bearer <your-jwt-token>
```

## ⚠️ 주요 에러 코드
- `400` - 잘못된 요청
- `401` - 인증 필요
- `403` - 권한 없음
- `404` - 리소스 없음
- `409` - 충돌 (이미 사용중, 중복 대기 등)
- `500` - 서버 오류

## 💡 특징
- ✅ 시간 예약 없는 간단한 대기열 시스템
- ✅ 세트별 자동 진행 및 추적
- ✅ WebSocket 실시간 알림
- ✅ 공정한 FIFO 순서 관리
- ✅ 자동 대기열 재배치
- ✅ 개인 운동 루틴 관리

---

**Backend API Server** | Node.js + Express.js + PostgreSQL + WebSocket
# 📋 요청 바디, 응답 바디
## 수정 API 1119
- **루틴 수정(멀티 수정)**
  - `GET /api/routines` — 루틴 목록 응답에 estimatedMinutes 필드 추가
  ```json
  [
    {
        "id": 9,
        "name": "기본 루틴",
        "isActive": true,
        "exerciseCount": 5,
        "estimatedMinutes": 66,
        "createdAt": "2025-11-12T02:30:46.953Z",
        "updatedAt": "2025-11-12T17:24:51.558Z",
        "exercises": [
            {
                "id": 47,
                "order": 1,
                "targetSets": 2,
                "targetReps": "12-15",
                "restSeconds": 90,
                "notes": "레그컬 - 마지막 세트 드롭셋",
                "equipment": {
                    "id": 17,
                    "name": "레그컬",
                    "category": "다리",
                    "muscleGroup": "햄스트링",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png"
                }
            },
            {
                "id": 48,
                "order": 2,
                "targetSets": 3,
                "targetReps": null,
                "restSeconds": 180,
                "notes": null,
                "equipment": {
                    "id": 14,
                    "name": "케이블머신",
                    "category": "어깨",
                    "muscleGroup": "삼각근, 승모근",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-cable.png"
                }
            },
            {
                "id": 45,
                "order": 3,
                "targetSets": 4,
                "targetReps": "8-12",
                "restSeconds": 180,
                "notes": "스미스 머신 - 무게 점진적으로 증가",
                "equipment": {
                    "id": 12,
                    "name": "스미스 머신",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png"
                }
            },
            {
                "id": 46,
                "order": 4,
                "targetSets": 3,
                "targetReps": "10-15",
                "restSeconds": 120,
                "notes": "레그프레스",
                "equipment": {
                    "id": 16,
                    "name": "레그프레스",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png"
                }
            },
            {
                "id": 52,
                "order": 5,
                "targetSets": 2,
                "targetReps": "10",
                "restSeconds": 270,
                "notes": "스미스머신",
                "equipment": {
                    "id": 18,
                    "name": "풀업",
                    "category": "등",
                    "muscleGroup": "광배근, 이두, 어깨",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
                }
            }
        ]
    },
    {
        "id": 11,
        "name": "하체 새로운 루틴 - 추가",
        "isActive": false,
        "exerciseCount": 4,
        "estimatedMinutes": 71,
        "createdAt": "2025-11-15T16:57:29.128Z",
        "updatedAt": "2025-11-15T18:25:37.538Z",
        "exercises": [
            {
                "id": 64,
                "order": 1,
                "targetSets": 4,
                "targetReps": null,
                "restSeconds": 180,
                "notes": null,
                "equipment": {
                    "id": 12,
                    "name": "스미스 머신",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png"
                }
            },
            {
                "id": 65,
                "order": 2,
                "targetSets": 3,
                "targetReps": null,
                "restSeconds": 120,
                "notes": null,
                "equipment": {
                    "id": 16,
                    "name": "레그프레스",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png"
                }
            },
            {
                "id": 66,
                "order": 3,
                "targetSets": 3,
                "targetReps": null,
                "restSeconds": 90,
                "notes": null,
                "equipment": {
                    "id": 17,
                    "name": "레그컬",
                    "category": "다리",
                    "muscleGroup": "햄스트링",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png"
                }
            },
            {
                "id": 67,
                "order": 4,
                "targetSets": 4,
                "targetReps": null,
                "restSeconds": 270,
                "notes": null,
                "equipment": {
                    "id": 18,
                    "name": "풀업",
                    "category": "등",
                    "muscleGroup": "광배근, 이두, 어깨",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
                }
            }
        ]
    },
    {
        "id": 10,
        "name": "기본 루틴",
        "isActive": false,
        "exerciseCount": 4,
        "estimatedMinutes": 51,
        "createdAt": "2025-11-12T04:43:41.906Z",
        "updatedAt": "2025-11-12T04:43:41.906Z",
        "exercises": [
            {
                "id": 51,
                "order": 1,
                "targetSets": 2,
                "targetReps": "12-15",
                "restSeconds": 90,
                "notes": "레그컬 - 마지막 세트 드롭셋",
                "equipment": {
                    "id": 17,
                    "name": "레그컬",
                    "category": "다리",
                    "muscleGroup": "햄스트링",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png"
                }
            },
            {
                "id": 49,
                "order": 2,
                "targetSets": 4,
                "targetReps": "8-12",
                "restSeconds": 180,
                "notes": "스미스 머신 - 무게 점진적으로 증가",
                "equipment": {
                    "id": 12,
                    "name": "스미스 머신",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png"
                }
            },
            {
                "id": 50,
                "order": 3,
                "targetSets": 3,
                "targetReps": "10-15",
                "restSeconds": 120,
                "notes": "레그프레스",
                "equipment": {
                    "id": 16,
                    "name": "레그프레스",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png"
                }
            },
            {
                "id": 53,
                "order": 4,
                "targetSets": 2,
                "targetReps": "10",
                "restSeconds": 270,
                "notes": "스미스머신",
                "equipment": {
                    "id": 18,
                    "name": "풀업",
                    "category": "등",
                    "muscleGroup": "광배근, 이두, 어깨",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
                }
            }
        ]
    }
  ]
  ```

## 추가 API 1116
- **루틴 수정(멀티 수정)**
- 기본 루틴
{
    "id": 11,
    "name": "기본 루틴",
    "isActive": false,
    "exerciseCount": 3,
    "exercises": [
        {
            "id": 54,
            "routineId": 11,
            "equipmentId": 12,
            "order": 1,
            "targetSets": 4,
            "targetReps": "8-12",
            "restSeconds": 180,
            "notes": "스미스 머신 - 무게 점진적으로 증가",
            "createdAt": "2025-11-15T16:57:29.189Z",
            "equipment": {
                "id": 12,
                "name": "스미스 머신",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png",
                "category": "다리",
                "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
                "createdAt": "2025-09-29T06:43:19.261Z"
            }
        },
        {
            "id": 55,
            "routineId": 11,
            "equipmentId": 16,
            "order": 2,
            "targetSets": 3,
            "targetReps": "10-15",
            "restSeconds": 120,
            "notes": "레그프레스",
            "createdAt": "2025-11-15T16:57:29.189Z",
            "equipment": {
                "id": 16,
                "name": "레그프레스",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png",
                "category": "다리",
                "muscleGroup": "대퇴사두근, 둔근",
                "createdAt": "2025-09-29T06:43:19.360Z"
            }
        },
        {
            "id": 56,
            "routineId": 11,
            "equipmentId": 17,
            "order": 3,
            "targetSets": 3,
            "targetReps": "12-15",
            "restSeconds": 90,
            "notes": "레그컬 - 마지막 세트 드롭셋",
            "createdAt": "2025-11-15T16:57:29.189Z",
            "equipment": {
                "id": 17,
                "name": "레그컬",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png",
                "category": "다리",
                "muscleGroup": "햄스트링",
                "createdAt": "2025-09-29T06:43:19.372Z"
            }
        }
    ],
    "createdAt": "2025-11-15T16:57:29.128Z",
    "updatedAt": "2025-11-15T16:57:29.128Z"
}
  - `PUT /api/routines/:routineId` — 전체 루틴 수정
  - 요청바디
    ```json
    {
    "name": "하체 새로운 루틴 - 추가",
  "exercises": [
    { "equipmentId": 12, "targetSets": 4, "restSeconds": 180 },
    { "equipmentId": 16, "targetSets": 3, "restSeconds": 120 },
    { "equipmentId": 17, "targetSets": 3, "restSeconds": 90 },
    {"equipmentId" : 18, "targetSets": 4, "restSeconds": 270}
  ]
  }

    ```
  - 응답바디 
  
    ```json
    {
    "message": "루틴이 성공적으로 업데이트되었습니다",
    "routine": {
        "id": 11,
        "name": "하체 새로운 루틴 - 추가",
        "isActive": false,
        "exerciseCount": 4,
        "createdAt": "2025-11-15T16:57:29.128Z",
        "updatedAt": "2025-11-15T18:25:37.538Z",
        "exercises": [
            {
                "id": 64,
                "order": 1,
                "targetSets": 4,
                "targetReps": null,
                "restSeconds": 180,
                "notes": null,
                "equipment": {
                    "id": 12,
                    "name": "스미스 머신",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
                    "createdAt": "2025-09-29T06:43:19.261Z"
                }
            },
            {
                "id": 65,
                "order": 2,
                "targetSets": 3,
                "targetReps": null,
                "restSeconds": 120,
                "notes": null,
                "equipment": {
                    "id": 16,
                    "name": "레그프레스",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근",
                    "createdAt": "2025-09-29T06:43:19.360Z"
                }
            },
            {
                "id": 66,
                "order": 3,
                "targetSets": 3,
                "targetReps": null,
                "restSeconds": 90,
                "notes": null,
                "equipment": {
                    "id": 17,
                    "name": "레그컬",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png",
                    "category": "다리",
                    "muscleGroup": "햄스트링",
                    "createdAt": "2025-09-29T06:43:19.372Z"
                }
            },
            {
                "id": 67,
                "order": 4,
                "targetSets": 4,
                "targetReps": null,
                "restSeconds": 270,
                "notes": null,
                "equipment": {
                    "id": 18,
                    "name": "풀업",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png",
                    "category": "등",
                    "muscleGroup": "광배근, 이두, 어깨",
                    "createdAt": "2025-09-29T06:43:19.391Z"
                }
            }
        ]
    }
  }

```
## 추가 API 1113
- **루틴에서의 대기 등록**
- 루틴 아이디 : 9
- 기존 루틴 기구 순서 : 17 -> 14 -> 12 -> 16 -> 18

  - `POST /api/routines/:routineId/queue/:equipmentId` — 루틴에서 특정 운동 대기 등록
 
  - 응답 바디 : 루틴 Id : 9, equipment_id : 12
  ```json
  {
      "message": "기본 루틴: 스미스 머신 대기열에 등록되었습니다",
      "routine": {
          "id": 9,
          "name": "기본 루틴"
      },
      "equipment": {
          "id": 12,
          "name": "스미스 머신",
          "category": "다리",
          "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png"
      },
      "queue": {
          "queueId": 8,
          "queuePosition": 1,
          "estimatedWaitMinutes": 0
      },
      "exerciseInfo": {
          "order": 3,
          "targetSets": 4,
          "targetReps": "8-12",
          "restSeconds": 180,
          "notes": "스미스 머신 - 무게 점진적으로 증가"
      }
  }
  ```

  - `POST /api/routines/:routineId/queue-next` — 루틴의 다음 운동 자동 대기 등록
  
  - 응답 바디 : 루틴에서 운동하고 있을시에만
  ```json
  {
    "message": "다음 운동: 케이블머신 대기열 등록",
    "routine": {
        "id": 9,
        "name": "기본 루틴"
    },
    "currentExercise": {
        "equipmentId": 17,
        "equipmentName": "레그컬",
        "order": 1
    },
    "nextExercise": {
        "equipmentId": 14,
        "equipmentName": "케이블머신",
        "order": 2,
        "targetSets": 3,
        "restSeconds": 180
    },
    "queue": {
        "queueId": 9,
        "queuePosition": 1,
        "estimatedWaitMinutes": 0
    }
  }
  ```

  - `GET /api/routines/:routineId/queue-status` — 루틴 전체 운동의 대기 상태 조회
 
  - 응답 바디
  ```json
  {
    "routineId": 9,
    "routineName": "기본 루틴",
    "isActive": true,
    "exercises": [
        {
            "exerciseId": 47,
            "order": 1,
            "equipment": {
                "id": 17,
                "name": "레그컬",
                "category": "다리",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png"
            },
            "targetSets": 2,
            "restSeconds": 90,
            "status": {
                "isAvailable": false,
                "currentUser": "박수현",
                "waitingCount": 0,
                "myQueuePosition": null,
                "myQueueStatus": null,
                "myQueueId": null,
                "canQueue": true
            }
        },
        {
            "exerciseId": 48,
            "order": 2,
            "equipment": {
                "id": 14,
                "name": "케이블머신",
                "category": "어깨",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-cable.png"
            },
            "targetSets": 3,
            "restSeconds": 180,
            "status": {
                "isAvailable": true,
                "currentUser": null,
                "waitingCount": 1,
                "myQueuePosition": 1,
                "myQueueStatus": "WAITING",
                "myQueueId": 9,
                "canQueue": false
            }
        },
        {
            "exerciseId": 45,
            "order": 3,
            "equipment": {
                "id": 12,
                "name": "스미스 머신",
                "category": "다리",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png"
            },
            "targetSets": 4,
            "restSeconds": 180,
            "status": {
                "isAvailable": true,
                "currentUser": null,
                "waitingCount": 1,
                "myQueuePosition": 1,
                "myQueueStatus": "WAITING",
                "myQueueId": 8,
                "canQueue": false
            }
        },
        {
            "exerciseId": 46,
            "order": 4,
            "equipment": {
                "id": 16,
                "name": "레그프레스",
                "category": "다리",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png"
            },
            "targetSets": 3,
            "restSeconds": 120,
            "status": {
                "isAvailable": true,
                "currentUser": null,
                "waitingCount": 0,
                "myQueuePosition": null,
                "myQueueStatus": null,
                "myQueueId": null,
                "canQueue": false
            }
        },
        {
            "exerciseId": 52,
            "order": 5,
            "equipment": {
                "id": 18,
                "name": "풀업",
                "category": "등",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
            },
            "targetSets": 2,
            "restSeconds": 270,
            "status": {
                "isAvailable": true,
                "currentUser": null,
                "waitingCount": 0,
                "myQueuePosition": null,
                "myQueueStatus": null,
                "myQueueId": null,
                "canQueue": false
            }
        }
    ],
    "summary": {
        "totalExercises": 5,
        "availableCount": 4,
        "myQueuedCount": 2
    }
  }
  ```

## 추가 API 1112
-  `PATCH /api/routines/:routineId` - 루틴 수정(멀티 수정)
- 기존 루틴:
```json
 {
    "id": 10,
    "name": "기본 루틴",
    "isActive": false,
    "exerciseCount": 3,
    "exercises": [
        {
            "id": 49,
            "routineId": 10,
            "equipmentId": 12,
            "order": 1,
            "targetSets": 4,
            "targetReps": "8-12",
            "restSeconds": 180,
            "notes": "스미스 머신 - 무게 점진적으로 증가",
            "createdAt": "2025-11-12T04:43:41.958Z",
            "equipment": {
                "id": 12,
                "name": "스미스 머신",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png",
                "category": "다리",
                "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
                "createdAt": "2025-09-29T06:43:19.261Z"
            }
        },
        {
            "id": 50,
            "routineId": 10,
            "equipmentId": 16,
            "order": 2,
            "targetSets": 3,
            "targetReps": "10-15",
            "restSeconds": 120,
            "notes": "레그프레스",
            "createdAt": "2025-11-12T04:43:41.958Z",
            "equipment": {
                "id": 16,
                "name": "레그프레스",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png",
                "category": "다리",
                "muscleGroup": "대퇴사두근, 둔근",
                "createdAt": "2025-09-29T06:43:19.360Z"
            }
        },
        {
            "id": 51,
            "routineId": 10,
            "equipmentId": 17,
            "order": 3,
            "targetSets": 3,
            "targetReps": "12-15",
            "restSeconds": 90,
            "notes": "레그컬 - 마지막 세트 드롭셋",
            "createdAt": "2025-11-12T04:43:41.958Z",
            "equipment": {
                "id": 17,
                "name": "레그컬",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png",
                "category": "다리",
                "muscleGroup": "햄스트링",
                "createdAt": "2025-09-29T06:43:19.372Z"
            }
        }
    ],
    "createdAt": "2025-11-12T04:43:41.906Z",
    "updatedAt": "2025-11-12T04:43:41.906Z"
}
  ```
- 요청 바디
  ```json
  {
  "exercises": [
    {
      "equipmentId": 18,
      "targetSets": 2,
      "targetReps": "10",
      "restSeconds": 270,
      "notes": "스미스머신"
    },
    {
      "equipmentId": 17,
      "order": 1,
      "targetSets": 2
    }
     ]
  }

  ```
- 응답(예시)
  ```json
  {
    "message": "1개 운동 수정, 1개 운동 추가",
    "routine": {
        "id": 10,
        "userId": 1,
        "name": "기본 루틴",
        "isActive": false,
        "createdAt": "2025-11-12T04:43:41.906Z",
        "updatedAt": "2025-11-12T04:43:41.906Z",
        "exercises": [
            {
                "id": 51,
                "routineId": 10,
                "equipmentId": 17,
                "order": 1,
                "targetSets": 2,
                "targetReps": "12-15",
                "restSeconds": 90,
                "notes": "레그컬 - 마지막 세트 드롭셋",
                "createdAt": "2025-11-12T04:43:41.958Z",
                "equipment": {
                    "id": 17,
                    "name": "레그컬",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legcurl.png",
                    "category": "다리",
                    "muscleGroup": "햄스트링",
                    "createdAt": "2025-09-29T06:43:19.372Z"
                }
            },
            {
                "id": 49,
                "routineId": 10,
                "equipmentId": 12,
                "order": 2,
                "targetSets": 4,
                "targetReps": "8-12",
                "restSeconds": 180,
                "notes": "스미스 머신 - 무게 점진적으로 증가",
                "createdAt": "2025-11-12T04:43:41.958Z",
                "equipment": {
                    "id": 12,
                    "name": "스미스 머신",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-smith.png",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
                    "createdAt": "2025-09-29T06:43:19.261Z"
                }
            },
            {
                "id": 50,
                "routineId": 10,
                "equipmentId": 16,
                "order": 3,
                "targetSets": 3,
                "targetReps": "10-15",
                "restSeconds": 120,
                "notes": "레그프레스",
                "createdAt": "2025-11-12T04:43:41.958Z",
                "equipment": {
                    "id": 16,
                    "name": "레그프레스",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-legpress.png",
                    "category": "다리",
                    "muscleGroup": "대퇴사두근, 둔근",
                    "createdAt": "2025-09-29T06:43:19.360Z"
                }
            },
            {
                "id": 53,
                "routineId": 10,
                "equipmentId": 18,
                "order": 4,
                "targetSets": 2,
                "targetReps": "10",
                "restSeconds": 270,
                "notes": "스미스머신",
                "createdAt": "2025-11-12T04:46:16.273Z",
                "equipment": {
                    "id": 18,
                    "name": "풀업",
                    "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png",
                    "category": "등",
                    "muscleGroup": "광배근, 이두, 어깨",
                    "createdAt": "2025-09-29T06:43:19.391Z"
                }
            }
        ]
    }
  }
  
  ```

## 추가된 API 1108
### 1. **루틴 수정(부분 변경) 전용 엔드포인트**
  - `PATCH /api/routines/:routineId/name` — 루틴 이름만 변경
- 요청 바디
  ```json
  { "name": "강화된 하체 루틴" }
  ```
- 응답(예시)
  ```json
  { "message": "루틴 이름이 변경되었습니다", "id": 7, "name": "강화된 하체 루틴" }
  ```
  - `POST  /api/routines/:routineId/exercises/add` — 루틴에 기구 추가
  - 요청 바디
  ```json
  { "equipmentId": 10, "targetSets": 3, "restSeconds": 120, "notes": "폼 집중" }
  ```
- 응답(예시)
  ```json
  {
    "message": "기구가 추가되었습니다",
    "routineId": 7,
    "exercise": { "equipmentId": 10, "targetSets": 3, "restSeconds": 120, "order": 4, "notes": "폼 집중" }
  }
  ```

  - `DELETE /api/routines/:routineId/exercises/:equipmentId` — 루틴에서 기구 제거
  - 응답(예시) `{ "message": "기구가 삭제되었습니다", "routineId": 7, "equipmentId": 5 }`

  - `PATCH /api/routines/:routineId/exercises/:equipmentId/sets` — 세트 수만 변경
  - 요청 바디
  ```json
  { "targetSets": 5 }
  ```
- 응답(예시)
  ```json
  { "message": "세트 수가 변경되었습니다", "routineId": 7, "equipmentId": 1, "targetSets": 5 }
  ```

  - `PATCH /api/routines/:routineId/exercises/:equipmentId/rest` — 휴식 시간만 변경
  - 요청 바디
  ```json
  { "restSeconds": 90 }
  ```
- 응답(예시)
  ```json
  { "message": "휴식 시간이 변경되었습니다", "routineId": 7, "equipmentId": 1, "restSeconds": 90 }
  ```

  - `PATCH /api/routines/:routineId/exercises/:equipmentId/order` — 순서만 변경
  - 요청 바디
  ```json
  { "newOrder": 1 }
  ```
- 응답(예시)
  ```json
  { "message": "순서가 변경되었습니다", "routineId": 7, "equipmentId": 5, "order": 1 }

### 2. **루틴 운동 시작**
  - `POST /api/routines/:routineId/start-first` — 첫 운동 자동 시작
  - 요청 바디(예시)
  ```json
  { "totalSets": 3, "restSeconds": 180 }
  ```
- 성공 응답(예시)
  ```json
  {
    "message": "하체 루틴 시작: 스쿼트",
    "routineId": 7,
    "routineName": "하체 루틴",
    "equipmentId": 1,
    "equipmentName": "스쿼트",
    "totalSets": 3,
    "restSeconds": 180,
    "usageId": 42,
    "nextExercises": [ { "equipmentId": 5, "equipmentName": "레그프레스", "order": 2 }, { "equipmentId": 6, "equipmentName": "레그컬", "order": 3 } ]
  }
  ```

  - `POST /api/routines/:routineId/start/:equipmentId` — 특정 기구부터 시작
  - 요청 바디(예시)
  ```json
  { "totalSets": 4, "restSeconds": 90 }
  ```
- 성공 응답(예시)
  ```json
  {
    "message": "하체 루틴 시작: 레그프레스",
    "routineId": 7,
    "routineName": "하체 루틴",
    "equipmentId": 5,
    "equipmentName": "레그프레스",
    "totalSets": 4,
    "restSeconds": 90,
    "usageId": 43,
    "nextExercises": [ { "equipmentId": 6, "equipmentName": "레그컬", "order": 3 } ]
  }
  ```

  - `POST /api/routines/:routineId/next` - 루틴 상 다음 운동 시작
  - 성공 응답(예시)
  ```json
  {
    "message": "루틴 시작: 랫풀다운",
    "equipmentName": "랫풀다운",
    "totalSets": 3,
    "restSeconds": 120,
    "usageId": 14
  }
  ```

## 0. 알림 리스트 API
### 0.1 알림목록조회
```
GET /api/notifications
```
**요청바디**: 없음  Authorization: Bearer <token>
**응답바디**:
```json
{
    "notifications": [
        {
            "id": 3,
            "userId": 5,
            "type": "WAITING_COUNT",
            "category": "eta",
            "priority": 4,
            "title": "대기자 알림",
            "message": "내 뒤에 기다리는 사람이 1명 있어요",
            "isRead": false,
            "equipmentId": 18,
            "equipmentName": "풀업",
            "queueId": null,
            "usageId": null,
            "metadata": {
                "at": "2025-10-21T00:51:26.532Z",
                "waitingCount": 1
            },
            "createdAt": "2025-10-21T00:51:26.536Z",
            "readAt": null,
            "equipment": {
                "id": 18,
                "name": "풀업",
                "category": "등",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
            }
        },
        {
            "id": 2,
            "userId": 5,
            "type": "WAITING_COUNT",
            "category": "eta",
            "priority": 4,
            "title": "대기자 알림",
            "message": "내 뒤에 기다리는 사람이 2명 있어요",
            "isRead": false,
            "equipmentId": 18,
            "equipmentName": "풀업",
            "queueId": null,
            "usageId": null,
            "metadata": {
                "at": "2025-10-21T00:51:11.113Z",
                "waitingCount": 2
            },
            "createdAt": "2025-10-21T00:51:11.116Z",
            "readAt": null,
            "equipment": {
                "id": 18,
                "name": "풀업",
                "category": "등",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
            }
        },
        {
            "id": 1,
            "userId": 5,
            "type": "WAITING_COUNT",
            "category": "eta",
            "priority": 4,
            "title": "대기자 알림",
            "message": "내 뒤에 기다리는 사람이 1명 있어요",
            "isRead": false,
            "equipmentId": 18,
            "equipmentName": "풀업",
            "queueId": null,
            "usageId": null,
            "metadata": {
                "at": "2025-10-21T00:50:59.821Z",
                "waitingCount": 1
            },
            "createdAt": "2025-10-21T00:50:59.826Z",
            "readAt": null,
            "equipment": {
                "id": 18,
                "name": "풀업",
                "category": "등",
                "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
            }
        }
    ],
    "grouped": {
        "today": {
            "label": "오늘",
            "count": 3,
            "items": [
                {
                    "id": 3,
                    "userId": 5,
                    "type": "WAITING_COUNT",
                    "category": "eta",
                    "priority": 4,
                    "title": "대기자 알림",
                    "message": "내 뒤에 기다리는 사람이 1명 있어요",
                    "isRead": false,
                    "equipmentId": 18,
                    "equipmentName": "풀업",
                    "queueId": null,
                    "usageId": null,
                    "metadata": {
                        "at": "2025-10-21T00:51:26.532Z",
                        "waitingCount": 1
                    },
                    "createdAt": "2025-10-21T00:51:26.536Z",
                    "readAt": null,
                    "equipment": {
                        "id": 18,
                        "name": "풀업",
                        "category": "등",
                        "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
                    }
                },
                {
                    "id": 2,
                    "userId": 5,
                    "type": "WAITING_COUNT",
                    "category": "eta",
                    "priority": 4,
                    "title": "대기자 알림",
                    "message": "내 뒤에 기다리는 사람이 2명 있어요",
                    "isRead": false,
                    "equipmentId": 18,
                    "equipmentName": "풀업",
                    "queueId": null,
                    "usageId": null,
                    "metadata": {
                        "at": "2025-10-21T00:51:11.113Z",
                        "waitingCount": 2
                    },
                    "createdAt": "2025-10-21T00:51:11.116Z",
                    "readAt": null,
                    "equipment": {
                        "id": 18,
                        "name": "풀업",
                        "category": "등",
                        "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
                    }
                },
                {
                    "id": 1,
                    "userId": 5,
                    "type": "WAITING_COUNT",
                    "category": "eta",
                    "priority": 4,
                    "title": "대기자 알림",
                    "message": "내 뒤에 기다리는 사람이 1명 있어요",
                    "isRead": false,
                    "equipmentId": 18,
                    "equipmentName": "풀업",
                    "queueId": null,
                    "usageId": null,
                    "metadata": {
                        "at": "2025-10-21T00:50:59.821Z",
                        "waitingCount": 1
                    },
                    "createdAt": "2025-10-21T00:50:59.826Z",
                    "readAt": null,
                    "equipment": {
                        "id": 18,
                        "name": "풀업",
                        "category": "등",
                        "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-pullup.png"
                    }
                }
            ]
        },
        "yesterday": {
            "label": "어제",
            "count": 0,
            "items": []
        },
        "thisWeek": {
            "label": "이번 주",
            "count": 0,
            "items": []
        },
        "older": {
            "label": "이전",
            "count": 0,
            "items": []
        }
    },
    "totalCount": 3,
    "unreadCount": 3,
    "hasMore": false,
    "pagination": {
        "limit": 50,
        "offset": 0
    }
}
```
### 0.2 읽지 않은 알림 개수
```
GET /api/notifications/unread-count
```
**요청바디**: 없음  Authorization: Bearer <token>
**응답바디**:
```json
{
    "unreadCount": 3
}
```
### 0.3 특정 알림 읽음 처리
```
 PATCH /api/notifications/:id/read
```
**요청바디**: 없음   Authorization: Bearer <token>, 알림 아이디
**응답바디**:
```json
{
    "message": "알림을 읽음 처리했습니다",
    "count": 1
}
```
### 0.4 여러 특정 알림 읽음 처리
```
PATCH /api/notifications/read
```
**요청바디**: Authorization: Bearer <token>
```json
{
   "notificationIds": [1, 2, 3, 4, 5]
}
```
**응답바디**:
```json
{
   "message": "5개의 알림을 읽음 처리했습니다",
   "count": 5
}
```
### 0.5 모든 알림 읽음 처리
```
 PATCH /api/notifications/read-all
```
**요청바디**: 없음  Authorization: Bearer <token>
**응답바디**:
```json
Response:
 {
 "message": "3개의 알림을 읽음 처리했습니다",
 "count": 3
 }
```

## 1. 인증 (Auth) API

### 1.1 Google OAuth 로그인 시작
```
GET /api/auth/google
```
**요청바디**: 없음  
**응답바디**: 구글 OAuth 페이지로 리다이렉트

### 1.2 Google OAuth 콜백
```
GET /api/auth/google/callback
```
**요청바디**: 구글에서 제공하는 code 파라미터  
**응답바디**: 프론트엔드로 리다이렉트 (토큰과 사용자 정보 포함)

### 1.3 로그아웃
```
POST /api/auth/logout
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "message": "로그아웃 성공"
}
```

### 1.4 현재 사용자 정보 조회
```
GET /api/auth/me
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "id": 1,
  "email": "user@example.com",
  "name": "사용자명",
  "avatar": "https://avatar-url.com",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

## 2. 기구 (Equipment) API
### 2.0 기구 전체 목록 조회
GET /api/equipment
```
**요청바디**: 없음
**쿼리 파라미터**:
{
        "id": 4,
        "name": "랫풀다운",
        "imageUrl": null,
        "category": "등",
        "muscleGroup": "광배근, 이두",
        "createdAt": "2025-09-25T08:31:11.471Z",
        "isFavorite": false,
        "status": {
            "isAvailable": true,
            "equipmentStatus": "available",
            "statusMessage": "사용 가능",
            "statusColor": "green",
            "currentUser": null,
            "currentUserStartedAt": null,
            "currentUsageInfo": null,
            "waitingCount": 0,
            "myQueuePosition": null,
            "myQueueStatus": null,
            "canStart": false,
            "canQueue": false,
            "completedToday": false,
            "lastCompletedAt": null,
            "lastCompletedSets": null,
            "lastCompletedTotalSets": null,
            "lastCompletedDurationSeconds": null,
            "wasFullyCompleted": false,
            "recentCompletion": null
        }
    },.... 모든 기구 조회 가능
```

### 2.1 기구 목록 조회
```
GET /api/equipment?category=all&search=&include_status=true
Authorization: Bearer <token> (선택사항)
```
**요청바디**: 없음  
**쿼리 파라미터**:
- `category`: 카테고리 필터 (기본값: all)
- `search`: 검색어
- `include_status`: 실시간 상태 포함 여부 (기본값: true)

**응답바디**:
```json
[
  {
    "id": 1,
    "name": "벤치프레스",
    "imageUrl": "https://image-url.com",
    "category": "가슴",
    "muscleGroup": "대흉근",
    "createdAt": "2025-01-15T10:30:00.000Z",
    "reservationCount": 5,
    "isFavorite": true,
    "status": {
      "isAvailable": false,
      "currentUser": "홍길동",
      "currentUserStartedAt": "2025-01-15T10:30:00.000Z",
      "currentUsageInfo": {
        "totalSets": 3,
        "currentSet": 2,
        "setStatus": "EXERCISING",
        "restSeconds": 180,
        "progress": 67,
        "estimatedEndAt": "2025-01-15T11:00:00.000Z"
      },
      "waitingCount": 2,
      "myQueuePosition": null,
      "myQueueStatus": null,
      "canStart": false,
      "canQueue": true,
      "completedToday": true,
      "lastCompletedAt": "2025-01-15T09:00:00.000Z",
      "lastCompletedSets": 3,
      "lastCompletedDuration": 15,
      "wasFullyCompleted": true
    }
  }
]
```

### 2.2 기구 검색
```
GET /api/equipment/search?q=스쿼트
Authorization: Bearer <token> (선택사항)
```
**요청바디**: 없음  
**쿼리 파라미터**:
- `q`: 검색어
- `category`: 카테고리 필터
- `available_only`: 사용 가능한 기구만 필터링
**응답바디**: 기구 목록 조회와 동일
```json
[
    {
        "id": 1,
        "name": "스미스 머신 스쿼트",
        "imageUrl": null,
        "category": "다리",
        "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
        "createdAt": "2025-09-25T08:31:11.403Z",
        "isFavorite": false,
        "status": {
            "isAvailable": true,
            "equipmentStatus": "available",
            "statusMessage": "사용 가능",
            "statusColor": "green",
            "currentUser": null,
            "currentUserStartedAt": null,
            "currentUsageInfo": null,
            "waitingCount": 0,
            "myQueuePosition": null,
            "myQueueStatus": null,
            "myQueueId": null,
            "canStart": true,
            "canQueue": false,
            "isUsingOtherEquipment": false,
            "currentlyUsedEquipmentId": null,
            "currentUserETA": 0,
            "estimatedWaitMinutes": 0,
            "queueETAs": [],
            "averageWaitTime": 0,
            "completedToday": false,
            "lastCompletedAt": null,
            "lastCompletedSets": null,
            "lastCompletedTotalSets": null,
            "lastCompletedDurationSeconds": null,
            "wasFullyCompleted": false,
            "recentCompletion": null
        }
    },
    {
        "id": 12,
        "name": "스쿼트 랙",
        "imageUrl": null,
        "category": "다리",
        "muscleGroup": "대퇴사두근, 둔근, 햄스트링",
        "createdAt": "2025-09-25T08:31:11.572Z",
        "isFavorite": false,
        "status": {
            "isAvailable": true,
            "equipmentStatus": "available",
            "statusMessage": "사용 가능",
            "statusColor": "green",
            "currentUser": null,
            "currentUserStartedAt": null,
            "currentUsageInfo": null,
            "waitingCount": 0,
            "myQueuePosition": null,
            "myQueueStatus": null,
            "myQueueId": null,
            "canStart": true,
            "canQueue": false,
            "isUsingOtherEquipment": false,
            "currentlyUsedEquipmentId": null,
            "currentUserETA": 0,
            "estimatedWaitMinutes": 0,
            "queueETAs": [],
            "averageWaitTime": 0,
            "completedToday": false,
            "lastCompletedAt": null,
            "lastCompletedSets": null,
            "lastCompletedTotalSets": null,
            "lastCompletedDurationSeconds": null,
            "wasFullyCompleted": false,
            "recentCompletion": null
        }
    }
]
```



### 2.3 카테고리 목록 조회
```
GET /api/equipment/categories
```
**요청바디**: 없음  
**응답바디**:
```json
[
    {
        "name": "가슴",
        "count": 1
    },
    {
        "name": "다리",
        "count": 5
    },
    {
        "name": "등",
        "count": 3
    },
    {
        "name": "어깨",
        "count": 1
    },
    {
        "name": "유산소",
        "count": 2
    }
]
```

### 2.4 기구 상태 조회
```
GET /api/equipment/:equipmentId
Authorization: Bearer <token> (선택사항)
```
**요청바디**: 없음  
**쿼리 파라미터**:
- `equipmentId`: 기구 ID (예: 1)

**응답바디**:
```json
{
    "id": 1,
    "name": "스미스 머신 스쿼트",
    "imageUrl": null,
    "category": "다리",
    "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근",
    "createdAt": "2025-09-25T08:31:11.403Z",
    "isFavorite": false,
    "favoriteCount": 0,
    "status": {
        "isAvailable": true,
        "equipmentStatus": "available",
        "statusMessage": "사용 가능",
        "statusColor": "green",
        "currentUser": null,
        "currentUserStartedAt": null,
        "currentUsageInfo": null,
        "waitingCount": 0,
        "myQueuePosition": null,
        "myQueueStatus": null,
        "myQueueId": null,
        "canStart": true,
        "canQueue": false,
        "isUsingOtherEquipment": false,
        "currentlyUsedEquipmentId": null,
        "currentUserETA": 0,
        "estimatedWaitMinutes": 0,
        "queueETAs": [],
        "averageWaitTime": 0,
        "completedToday": false,
        "lastCompletedAt": null,
        "lastCompletedSets": null,
        "lastCompletedTotalSets": null,
        "lastCompletedDurationSeconds": null,
        "wasFullyCompleted": false,
        "recentCompletion": null
    }
}
```

### 2.5 기구 여러개 상태 조회
```
GET /api/equipment/status?equipmentIds=1,2,3
Authorization: Bearer <token> (선택사항)
```
**요청바디**: 없음  
**쿼리 파라미터**:
- `equipmentIds`: 쉼표로 구분된 기구 ID 목록

**응답바디**:
```json
{
    "1": {
        "isAvailable": true,
        "equipmentStatus": "available",
        "statusMessage": "사용 가능",
        "statusColor": "green",
        "currentUser": null,
        "currentUserStartedAt": null,
        "currentUsageInfo": null,
        "waitingCount": 0,
        "myQueuePosition": null,
        "myQueueStatus": null,
        "myQueueId": null,
        "canStart": true,
        "canQueue": false,
        "isUsingOtherEquipment": false,
        "currentlyUsedEquipmentId": null,
        "currentUserETA": 0,
        "estimatedWaitMinutes": 0,
        "queueETAs": [],
        "averageWaitTime": 0,
        "completedToday": false,
        "lastCompletedAt": null,
        "lastCompletedSets": null,
        "lastCompletedTotalSets": null,
        "lastCompletedDurationSeconds": null,
        "wasFullyCompleted": false,
        "recentCompletion": null
    },
    "2": {
        "isAvailable": true,
        "equipmentStatus": "available",
        "statusMessage": "사용 가능",
        "statusColor": "green",
        "currentUser": null,
        "currentUserStartedAt": null,
        "currentUsageInfo": null,
        "waitingCount": 0,
        "myQueuePosition": null,
        "myQueueStatus": null,
        "myQueueId": null,
        "canStart": true,
        "canQueue": false,
        "isUsingOtherEquipment": false,
        "currentlyUsedEquipmentId": null,
        "currentUserETA": 0,
        "estimatedWaitMinutes": 0,
        "queueETAs": [],
        "averageWaitTime": 0,
        "completedToday": false,
        "lastCompletedAt": null,
        "lastCompletedSets": null,
        "lastCompletedTotalSets": null,
        "lastCompletedDurationSeconds": null,
        "wasFullyCompleted": false,
        "recentCompletion": null
    },
    "3": {
        "isAvailable": true,
        "equipmentStatus": "available",
        "statusMessage": "사용 가능",
        "statusColor": "green",
        "currentUser": null,
        "currentUserStartedAt": null,
        "currentUsageInfo": null,
        "waitingCount": 0,
        "myQueuePosition": null,
        "myQueueStatus": null,
        "myQueueId": null,
        "canStart": true,
        "canQueue": false,
        "isUsingOtherEquipment": false,
        "currentlyUsedEquipmentId": null,
        "currentUserETA": 0,
        "estimatedWaitMinutes": 0,
        "queueETAs": [],
        "averageWaitTime": 0,
        "completedToday": false,
        "lastCompletedAt": null,
        "lastCompletedSets": null,
        "lastCompletedTotalSets": null,
        "lastCompletedDurationSeconds": null,
        "wasFullyCompleted": false,
        "recentCompletion": null
    }
}
```

### 2.6 완료한 운동 목록 조회
```
GET /api/equipment/my-completed?date=2025-01-15&limit=20 // 
/api/equipment/my-completed만 해도 가능 & date로 상세 날짜 검색 가능
Authorization: Bearer <token>
```
**요청바디**: 없음  
**쿼리 파라미터**:
- `date`: 특정 날짜 (YYYY-MM-DD)
- `limit`: 조회 개수 제한

**응답바디**:
```json
[
    {
        "id": 15,
        "equipmentId": 3,
        "equipment": {
            "id": 3,
            "name": "케이블 와이 레이즈",
            "category": "어깨",
            "muscleGroup": "삼각근, 승모근",
            "imageUrl": null
        },
        "startedAt": "2025-09-26T22:53:31.975Z",
        "endedAt": "2025-09-26T22:55:12.653Z",
        "totalSets": 3,
        "completedSets": 2,
        "restSeconds": 60,
        "setStatus": "STOPPED",
        "durationSeconds": 101,
        "isFullyCompleted": false,
        "wasInterrupted": true
    }
]
```

### 2.6 운동 통계 조회
```
GET /api/equipment/my-stats?period=week
Authorization: Bearer <token>
```
**요청바디**: 없음  
**쿼리 파라미터**:
- `period`: today, week, month, year

**응답바디**:
```json
{
  "period": "week",
  "totalWorkouts": 12,
  "totalSets": 45,
  "totalMinutes": 180,
  "averageSetsPerWorkout": 4,
  "equipmentStats": [
    {
      "equipment": {
        "id": 1,
        "name": "벤치프레스",
        "category": "가슴"
      },
      "count": 3,
      "totalSets": 9,
      "totalMinutes": 45,
      "lastUsed": "2025-01-15T10:00:00.000Z"
    }
  ],
  "categoryStats": [
    {
      "category": "가슴",
      "count": 5,
      "totalSets": 15
    }
  ],
  "recentWorkouts": []
}
```

### 2.7 기구 상세 조회
```
GET /api/equipment/:id
Authorization: Bearer <token> (선택사항)
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "id": 1,
  "name": "벤치프레스",
  "imageUrl": "https://image-url.com",
  "category": "가슴",
  "muscleGroup": "대흉근",
  "createdAt": "2025-01-15T10:30:00.000Z",
  "reservations": [],
  "isFavorite": true,
  "favoriteCount": 15,
  "status": {
    "isAvailable": true,
    "currentUser": null,
    "waitingCount": 0,
    "canStart": true
  }
}
```

### 2.8 빠른 시작
```
POST /api/equipment/:id/quick-start
Authorization: Bearer <token>
```
**요청바디**:
```json
{
  "totalSets": 3,
  "restSeconds": 180
}
```
**응답바디**:
```json
{
  "message": "벤치프레스 사용을 시작했습니다",
  "equipmentName": "벤치프레스",
  "totalSets": 3,
  "restSeconds": 180,
  "usageId": 1
}
```

### 2.9 오늘 총 운동시간 조회
```
GET /api/equipment/today-total-time
Authorization: Bearer <token>
```
**요청바디**: 없음
**응답바디**:
```json
{
    "date": "2025-11-01",
    "summary": {
        "totalWorkouts": 2,
        "totalSets": 6,
        "totalSeconds": 83,
        "totalMinutes": 1,
        "totalHours": "0.02",
        "totalTimeFormatted": "1분 23초",
        "averageSetsPerWorkout": 3,
        "averageSecondsPerWorkout": 42
    },
    "workouts": [
        {
            "id": 12,
            "equipmentId": 22,
            "equipmentName": "트레드밀",
            "category": "유산소",
            "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-treadmill.png",
            "muscleGroup": "전신",
            "sets": 3,
            "totalSets": 3,
            "durationSeconds": 38,
            "durationFormatted": "38초",
            "startedAt": "2025-11-02T13:40:30.638Z",
            "endedAt": "2025-11-02T13:41:08.753Z",
            "wasFullyCompleted": true,
            "wasInterrupted": false,
            "setStatus": "COMPLETED"
        },
        {
            "id": 11,
            "equipmentId": 19,
            "equipmentName": "벤치 프레스",
            "category": "가슴",
            "imageUrl": "https://yrejfssusnltxpnqquzi.supabase.co/storage/v1/object/public/equipment/machine-bench.png",
            "muscleGroup": "대흉근, 삼두, 어깨",
            "sets": 3,
            "totalSets": 3,
            "durationSeconds": 45,
            "durationFormatted": "45초",
            "startedAt": "2025-11-02T13:39:09.160Z",
            "endedAt": "2025-11-02T13:39:54.458Z",
            "wasFullyCompleted": true,
            "wasInterrupted": false,
            "setStatus": "COMPLETED"
        }
    ],
    "categoryBreakdown": [
        {
            "category": "가슴",
            "count": 1,
            "totalSets": 3,
            "totalSeconds": 45,
            "totalMinutes": 1,
            "totalTimeFormatted": "45초",
            "percentage": 54
        },
        {
            "category": "유산소",
            "count": 1,
            "totalSets": 3,
            "totalSeconds": 38,
            "totalMinutes": 1,
            "totalTimeFormatted": "38초",
            "percentage": 46
        }
    ],
    "insights": {
        "mostUsedEquipment": {
            "name": "벤치 프레스",
            "count": 1,
            "totalTime": "45초"
        },
        "mostTrainedCategory": {
            "category": "가슴",
            "percentage": 54,
            "totalTime": "45초"
        },
        "longestWorkout": {
            "equipmentName": "벤치 프레스",
            "duration": "45초",
            "sets": 3
        }
    }
}
```

## 3. 즐겨찾기 (Favorites) API

### 3.1 즐겨찾기 목록 조회
```
GET /api/favorites
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
[
  {
    "id": 1,
    "createdAt": "2025-01-15T10:30:00.000Z",
    "equipment": {
      "id": 1,
      "name": "벤치프레스",
      "imageUrl": "https://image-url.com",
      "category": "가슴",
      "muscleGroup": "대흉근",
      "reservationCount": 5,
      "isFavorite": true
    }
  }
]
```

### 3.2 즐겨찾기 추가
```
POST /api/favorites
Authorization: Bearer <token>
```
**요청바디**:
```json
{
  "equipmentId": 1
}
```
**응답바디**:
```json
{
  "id": 1,
  "createdAt": "2025-01-15T10:30:00.000Z",
  "equipment": {
    "id": 1,
    "name": "벤치프레스",
    "imageUrl": "https://image-url.com",
    "category": "가슴",
    "muscleGroup": "대흉근",
    "isFavorite": true
  }
}
```

### 3.3 즐겨찾기 제거
```
DELETE /api/favorites/equipment/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**: 204 No Content

### 3.4 즐겨찾기 상태 확인
```
GET /api/favorites/check/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "isFavorite": true
}
```
## 4. 대기시스템 (Waiting) API

### 4.1 ETA 수동 업데이트
```
POST /api/waiting/update-eta/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "equipmentId": 1,
  "equipmentName": "벤치프레스",
  "updatedAt": "2025-01-15T10:30:00.000Z",
  "updatedBy": 1,
  "currentUsage": {
    "userName": "홍길동",
    "totalSets": 3,
    "currentSet": 2,
    "setStatus": "EXERCISING",
    "estimatedMinutesLeft": 8,
    "progress": 67
  },
  "waitingQueue": [
    {
      "id": 1,
      "position": 1,
      "userName": "김철수",
      "estimatedWaitMinutes": 10,
      "isYou": false
    }
  ],
  "totalWaiting": 1,
  "isManualUpdate": true
}
```

### 4.2 기구 사용 시작
```
POST /api/waiting/start-using/:equipmentId
Authorization: Bearer <token>
```
**요청바디**:
```json
{
  "totalSets": 3,
  "restSeconds": 180
}
```
**응답바디**:
```json
{
  "id": 1,
  "equipmentId": 1,
  "equipmentName": "벤치프레스",
  "totalSets": 3,
  "currentSet": 1,
  "setStatus": "EXERCISING",
  "restSeconds": 180,
  "startedAt": "2025-01-15T10:30:00.000Z",
  "estimatedEndAt": "2025-01-15T11:00:00.000Z",
  "progress": 33
}
```

### 4.3 세트 완료
```
POST /api/waiting/complete-set/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "message": "2/3 세트 완료",
  "setStatus": "RESTING",
  "restSeconds": 180
}
```

### 4.4 휴식 건너뛰기
```
POST /api/waiting/skip-rest/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "message": "휴식을 건너뛰고 3/3 세트를 시작합니다",
  "currentSet": 3,
  "totalSets": 3,
  "setStatus": "EXERCISING",
  "skippedRest": true,
  "progress": 100
}
```

### 4.5 운동 중단
```
POST /api/waiting/stop-exercise/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "message": "운동 중단 완료"
}
```

### 4.6 대기열 등록
```
POST /api/waiting/queue/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
    "message": "스미스 머신 스쿼트 대기열에 등록되었습니다",
    "equipmentName": "스미스 머신 스쿼트",
    "queuePosition": 1,
    "queueId": 8,
    "estimatedWaitMinutes": 9
}
```
### 4.6-1 운동하는 중에 다른 기구 대기열 등록
```
POST /api/waiting/queue/:equipmentId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
    "message": "바벨 벤치 프레스 대기열에 등록되었습니다",
    "equipmentName": "바벨 벤치 프레스",
    "queuePosition": 1,
    "queueId": 10,
    "estimatedWaitMinutes": 0,
    "warning": {
        "message": "현재 케이블 와이 레이즈에서 운동 중입니다. 운동 완료 전에 대기 차례가 올 수 있으니 주의하세요.",
        "currentEquipment": "케이블 와이 레이즈",
        "currentStatus": "EXERCISING",
        "canSwitchEquipment": false
    }
}

```

### 4.7 대기열 취소
```
DELETE /api/waiting/queue/:queueId
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
    "success": true,
    "message": "대기열이 성공적으로 취소되었습니다",
    "cancelled": {
        "queueId": 10,
        "equipmentId": 8,
        "equipmentName": "바벨 벤치 프레스",
        "previousPosition": 1,
        "previousStatus": "NOTIFIED",
        "cancelledAt": "2025-09-26T23:34:10.430Z"
    },
    "remaining": {
        "waitingCount": 0,
        "nextUserNotified": true
    }
}
```

### 4.8 실시간 상태 조회
```
GET /api/waiting/status/:equipmentId
```
**요청바디**: 없음  (예: 1)
**응답바디**:
```json
{
    "equipmentId": 1,
    "equipmentName": "스미스 머신 스쿼트",
    "status": {
        "isAvailable": false,
        "currentUser": "Postman Tester3",
        "currentUserStartedAt": "2025-09-26T22:44:32.003Z",
        "currentUsageInfo": {
            "totalSets": 3,
            "currentSet": 1,
            "setStatus": "EXERCISING",
            "restSeconds": 60,
            "progress": 33,
            "estimatedEndAt": "2025-09-26T23:01:32.001Z"
        },
        "waitingCount": 1,
        "myQueuePosition": null,
        "myQueueStatus": null,
        "myQueueId": null,
        "canStart": false,
        "canQueue": false,
        "currentUserETA": 8,
        "estimatedWaitMinutes": 21,
        "queueETAs": [
            9
        ],
        "averageWaitTime": 9,
        "completedToday": false,
        "lastCompletedAt": null,
        "lastCompletedSets": null,
        "lastCompletedTotalSets": null,
        "lastCompletedDurationSeconds": null,
        "wasFullyCompleted": false,
        "recentCompletion": null,
        "equipmentStatus": "in_use",
        "statusMessage": "Postman Tester3 사용 중",
        "statusColor": "orange",
        "isUsingOtherEquipment": false,
        "currentlyUsedEquipmentId": 1
    },
    "updatedAt": "2025-09-26T22:55:39.890Z"
}
```

### 4.9 시스템 통계 (관리자용)
```
GET /api/waiting/admin/stats
Authorization: Bearer <token>
```
**요청바디**: 없음  
**응답바디**:
```json
{
  "activeUsages": 5,
  "activeQueues": 12,
  "autoUpdateCount": 3,
  "rateLimitedUsers": 2,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

## 5. 루틴 (Routines) API(JWT 필요)
### 5.1 내 운동 루틴 목록 조회
GET /api/routines
**요청바디** : 없음
**응답바디** : 
```json
[
  {
    "id": 7,
    "name": "하체 루틴",
    "isActive": true,
    "exerciseCount": 2,
    "createdAt": "2025-09-25T23:15:28.222Z",
    "updatedAt": "2025-09-25T23:15:28.222Z",
    "exercises": [
      {
        "id": 8,
        "routineId": 7,
        "equipmentId": 1,
        "order": 1,
        "targetSets": 3,
        "targetReps": null,
        "restSeconds": 180,
        "notes": null,
        "createdAt": "2025-09-25T23:15:28.222Z",
        "equipment": {
          "id": 1,
          "name": "스미스 머신 스쿼트",
          "imageUrl": null,
          "category": "다리",
          "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근"
        }
      }
    ]
  }
]
```

### 5.2 특정 루틴 상세 조회
GET /api/routines/:id
**요청바디** : 없음 path params : id
**응답바디** : 
```json
{
  "id": 7,
  "name": "하체 루틴",
  "isActive": true,
  "createdAt": "2025-09-25T23:15:28.222Z",
  "updatedAt": "2025-09-25T23:15:28.222Z",
  "exercises": [
    {
      "id": 8,
      "order": 1,
      "targetSets": 3,
      "targetReps": null,
      "restSeconds": 180,
      "notes": null,
      "equipment": {
        "id": 1,
        "name": "스미스 머신 스쿼트",
        "imageUrl": null,
        "category": "다리",
        "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근"
      },
      "status": {
        "isAvailable": false,
        "currentUser": "홍길동",
        "currentUserStartedAt": "2025-09-25T23:05:00.000Z",
        "waitingCount": 2,
        "myQueuePosition": null,
        "myQueueStatus": null,
        "canStart": false,
        "canQueue": true
      }
    }
  ],
  "currentlyUsing": {
    "equipmentId": 1,
    "equipmentName": "스미스 머신 스쿼트"
  }
}
```

### 5.3 새로운 루틴 생성
POST /api/routines
**요청바디** :
```json 
{
  "name": "Postman Test Routine",
  "exercises": [
    { "equipmentId": 1, "targetSets": 3, "restSeconds": 180 },
    { "equipmentId": 2, "targetSets": 4, "restSeconds": 180 }
  ]
}
```
**응답바디** : (201 created)
```json
{
  "id": 7,
  "name": "Postman Test Routine",
  "isActive": true,
  "exerciseCount": 2,
  "exercises": [
    {
      "id": 8,
      "routineId": 7,
      "equipmentId": 1,
      "order": 1,
      "targetSets": 3,
      "targetReps": null,
      "restSeconds": 180,
      "notes": null,
      "createdAt": "2025-09-25T23:15:28.222Z",
      "equipment": {
        "id": 1,
        "name": "스미스 머신 스쿼트",
        "imageUrl": null,
        "category": "다리",
        "muscleGroup": "대퇴사두근, 둔근, 햄스트링, 내전근"
      }
    },
    {
      "id": 9,
      "routineId": 7,
      "equipmentId": 2,
      "order": 2,
      "targetSets": 4,
      "targetReps": null,
      "restSeconds": 180,
      "notes": null,
      "createdAt": "2025-09-25T23:15:28.222Z",
      "equipment": {
        "id": 2,
        "name": "레그 프레스",
        "imageUrl": null,
        "category": "다리",
        "muscleGroup": "대퇴사두근, 둔근, 햄스트링"
      }
    }
  ],
  "createdAt": "2025-09-25T23:15:28.222Z",
  "updatedAt": "2025-09-25T23:15:28.222Z"
}
```
### 5.4 루틴 수정
PUT /api/routines/:id
**요청바디** : 수정하고 싶은 내용 
**응답바디** : 
```json
{
  "name": "업데이트된 하체 루틴",
  "isActive": true,
  "exercises": [
    { "equipmentId": 1, "targetSets": 4, "restSeconds": 150, "notes": "스쿼트 템포 느리게" },
    { "equipmentId": 3, "targetSets": 3, "restSeconds": 180 }
  ]
}

```
### 5.5 루틴 삭제
DELETE /api/routines
**요청바디** :  
**응답바디** : (204 No Content)

### 5.6 특정 운동 즉시 시작
POST /api/routines/:routineId/exercises/:exerciseId/start
**요청바디** : 
```json
{ "totalSets": 3, "restSeconds": 180 }
```
**응답바디** : 
```json
{
  "message": "스미스 머신 스쿼트 사용을 시작했습니다",
  "equipmentName": "스미스 머신 스쿼트",
  "totalSets": 3,
  "restSeconds": 180,
  "usageId": 7
}

```

### 5.7 휴식 타이머 +- 10초 조정
PUT /api/routines/active-usage/rest-time
**요청바디** : 
```json
{ "adjustment": 10 }   // 또는 -10
```
**응답바디** : 
```json
{
  "message": "휴식시간이 증가했습니다",
  "equipmentName": "벤치프레스",
  "previousRestSeconds": 170,
  "newRestSeconds": 180,
  "adjustment": 10,
  "currentSet": 2,
  "totalSets": 3,
  "setStatus": "RESTING"
}

```

### 5.8 현재 운동 상태 
GET /api/routines/active-usage/status
**요청바디** : 없음
**응답바디** : 
응답 예시 (활성 X)
```json
{ "active": false }

```
응답 예시 (활성 O)
```json
{
  "active": true,
  "usageId": 10,
  "equipmentId": 1,
  "equipmentName": "벤치프레스",
  "totalSets": 3,
  "currentSet": 2,
  "setStatus": "RESTING",
  "restSeconds": 180,
  "restTimeLeft": 75,
  "setProgress": 0
}

```

## 🌐 WebSocket API

### WebSocket 연결
```
ws://localhost:4000/ws
```

### 인증 메시지
```json
{
  "type": "auth",
  "token": "<JWT_TOKEN>"
}
```

### 수신 알림 타입
- `EQUIPMENT_AVAILABLE`: 기구 사용 가능
- `REST_STARTED`: 휴식 시작
- `NEXT_SET_STARTED`: 다음 세트 시작
- `EXERCISE_STOPPED`: 운동 중단
- `QUEUE_CANCELLED`: 대기 취소
- `QUEUE_EXPIRED`: 대기 만료
- `FORCE_COMPLETED`: 관리자 강제 완료
- `SET_SKIPPED`: 휴식 스킵

---

## 📊 Response Format

### 성공 응답
```json
{
  "id": 1,
  "data": "..."
}
```

### 오류 응답
```json
{
  "error": "오류 메시지",
  "details": "상세 정보 (선택적)"
}
```

----
