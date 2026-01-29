const jwt = require("jsonwebtoken");

module.exports = async (socket, next) => {
  try {
    // 1. 토큰 추출
    const token =
      socket.handshake.auth?.token || // socket.auth.token (권장)
      socket.handshake.query?.token || // URL query parameter
      socket.handshake.headers?.authorization?.replace("Bearer ", ""); // HTTP Header

    if (!token) {
      return next(new Error("Authentication token required"));
    }

    // 2. JWT 검증
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log("decoded : ", decoded);

    if (!decoded.id) {
      console.error("❌ [Auth] Invalid token: missing userId");
      return next(new Error("Invalid token"));
    }

    // 3. Socket 객체에 사용자 정보 첨부
    socket.userId = decoded.id;

    // 4. 다음 미들웨어로 진행
    next();
  } catch (error) {
    // JWT 검증 실패
    if (error.name === "TokenExpiredError") {
      console.error("❌ [Auth] Token expired");
      return next(new Error("Token expired"));
    }

    if (error.name === "JsonWebTokenError") {
      console.error("❌ [Auth] Invalid token:", error.message);
      return next(new Error("Invalid token"));
    }

    console.error("❌ [Auth] Authentication error:", error);
    return next(new Error("Authentication failed"));
  }
};
