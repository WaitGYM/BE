const { Server } = require("socket.io");
const eventBus = require("../events/eventBus");
const authMiddleware = require("./middleware/auth.middleware");

const clients = new Map(); // userId -> Set<socketId>
const equipmentSubscribers = new Map(); // equipmentId -> Set<userId>

function initializeSocketServer(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io/",
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      credentials: true,
      methods: ["GET", "POST"],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // 인증 미들웨어
  io.use(authMiddleware);

  io.on("connection", (socket) => {
    const { userId } = socket;
    console.log(`✅ Socket.IO 연결: userId=${userId}, socketId=${socket.id}`);

    // 사용자 등록
    if (!clients.has(userId)) {
      clients.set(userId, new Set());
    }
    clients.get(userId).add(socket.id);

    // 초기 연결 성공 메시지
    socket.emit("connected", {
      message: "실시간 알림 연결 완료",
      userId,
      timestamp: new Date().toISOString(),
    });

    // 기구 구독
    socket.on("subscribe_equipment", (data) => {
      const { equipmentId } = data;
      if (!equipmentId) return;

      socket.join(`equipment:${equipmentId}`);

      if (!equipmentSubscribers.has(equipmentId)) {
        equipmentSubscribers.set(equipmentId, new Set());
      }
      equipmentSubscribers.get(equipmentId).add(userId);

      socket.emit("subscription_confirmed", {
        equipmentId,
        message: `기구 ${equipmentId} 구독됨`,
      });
    });

    // 기구 구독 해제
    socket.on("unsubscribe_equipment", (data) => {
      const { equipmentId } = data;
      if (!equipmentId) return;

      socket.leave(`equipment:${equipmentId}`);

      const subscribers = equipmentSubscribers.get(equipmentId);
      if (subscribers) {
        subscribers.delete(userId);
        if (subscribers.size === 0) {
          equipmentSubscribers.delete(equipmentId);
        }
      }

      socket.emit("subscription_cancelled", {
        equipmentId,
        message: `기구 ${equipmentId} 구독 해제됨`,
      });
    });

    // Ping/Pong
    socket.on("ping", () => {
      socket.emit("pong", { timestamp: Date.now() });
    });

    // 연결 해제
    socket.on("disconnect", (reason) => {
      console.log(`❌ Socket.IO 연결 해제: userId=${userId}, reason=${reason}`);

      const userSockets = clients.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          clients.delete(userId);
        }
      }

      // 모든 기구 구독 해제
      equipmentSubscribers.forEach((subscribers, equipmentId) => {
        if (subscribers.has(userId)) {
          subscribers.delete(userId);
          if (subscribers.size === 0) {
            equipmentSubscribers.delete(equipmentId);
          }
        }
      });
    });
  });

  // 🔥 이벤트 버스 구독
  setupEventListeners(io);

  console.log("✅ Socket.IO 서버 초기화 완료");
  return io;
}

// 🔥 이벤트 버스 리스너 설정
function setupEventListeners(io) {
  // 알림 전송
  eventBus.onNotificationSend(({ userId, payload }) => {
    sendToUser(io, userId, "notification", payload);
  });

  // 기구 상태 변경
  eventBus.onEquipmentStatusChange(({ equipmentId, data }) => {
    broadcastToRoom(io, `equipment:${equipmentId}`, "equipment_update", {
      type: "status_changed",
      equipmentId,
      data,
    });
  });

  // ETA 업데이트
  eventBus.onETAUpdate(({ equipmentId, data }) => {
    broadcastToRoom(io, `equipment:${equipmentId}`, "equipment_update", {
      type: "eta_updated",
      equipmentId,
      data,
    });
  });

  console.log("✅ Event bus listeners registered (Socket.IO)");
}

// 특정 사용자에게 전송
function sendToUser(io, userId, event, data) {
  const userSockets = clients.get(userId);
  if (!userSockets || userSockets.size === 0) return false;

  userSockets.forEach((socketId) => {
    io.to(socketId).emit(event, {
      timestamp: new Date().toISOString(),
      ...data,
    });
  });

  return true;
}

// 룸(기구)에 브로드캐스트
function broadcastToRoom(io, room, event, data) {
  io.to(room).emit(event, {
    timestamp: new Date().toISOString(),
    ...data,
  });
}

module.exports = {
  initializeSocketServer,
  sendToUser,
  broadcastToRoom,
};
