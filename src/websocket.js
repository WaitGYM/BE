// src/websocket.js
const WebSocket = require('ws')
const jwt = require('jsonwebtoken')

// userId -> Set<ws>
const clients = new Map()

function registerWSClient(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set())
  clients.get(userId).add(ws)
  ws.on('close', () => {
    const set = clients.get(userId)
    if (set) set.delete(ws)
  })
}

function sendNotification(userId, payload) {
  const set = clients.get(userId)
  if (!set || set.size === 0) return false
  const msg = JSON.stringify({ type: 'notify', ...payload })
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg)
  }
  return true
}

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' })
  wss.on('connection', (ws) => {
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message)
        if (data.type === 'auth' && data.token) {
          const payload = jwt.verify(data.token, process.env.JWT_SECRET)
          ws.userId = payload.id
          registerWSClient(ws.userId, ws)
          ws.send(JSON.stringify({ type: 'auth_success', message: '실시간 알림 연결 완료' }))
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'WebSocket 인증 실패' }))
        ws.close()
      }
    })
  })
}

module.exports = { setupWebSocket, sendNotification }
