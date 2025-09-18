// src/websocket.js
const WebSocket = require('ws')
const jwt = require('jsonwebtoken')
const { registerWSClient } = require('./routes/waiting')

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
  })

  wss.on('connection', (ws, req) => {
    console.log('WebSocket 연결 시도')

    // 인증 토큰 확인
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message)
        
        if (data.type === 'auth' && data.token) {
          const payload = jwt.verify(data.token, process.env.JWT_SECRET)
          ws.userId = payload.id
          ws.userEmail = payload.email
          
          // 웨이팅 시스템에 클라이언트 등록
          registerWSClient(payload.id, ws)
          
          ws.send(JSON.stringify({
            type: 'auth_success',
            message: '실시간 알림이 연결되었습니다'
          }))
          
          console.log(`사용자 ${payload.email} WebSocket 연결됨`)
        }
      } catch (error) {
        console.error('WebSocket 메시지 처리 오류:', error)
        ws.send(JSON.stringify({
          type: 'error',
          message: '인증에 실패했습니다'
        }))
        ws.close()
      }
    })

    ws.on('close', () => {
      if (ws.userId) {
        console.log(`사용자 ${ws.userEmail} WebSocket 연결 해제`)
      }
    })

    ws.on('error', (error) => {
      console.error('WebSocket 오류:', error)
    })
  })

  return wss
}

module.exports = { setupWebSocket }