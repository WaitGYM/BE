const router = require("express").Router();
const prisma = require("../lib/prisma");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const asyncRoute = require("../utils/asyncRoute");
const { auth } = require("../middleware/auth");
const { cleanupUserActivities } = require("../services/user-cleanup.service");

// GET /api/auth/google
router.get("/google", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
  });
  res.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
});

// GET /api/auth/google/callback
router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: `${process.env.FRONTEND_URL}/?error=auth_failed`,
  }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );
    const user = {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      avatar: req.user.avatar,
    };
    const redirectUrl = `${process.env.FRONTEND_URL}/oauth-success?token=${token}&user=${encodeURIComponent(JSON.stringify(user))}`;
    res.redirect(redirectUrl);
  },
);

// 🆕 POST /api/auth/guest - 게스트 로그인
router.post(
  "/guest",
  asyncRoute(async (req, res) => {
    const guestName = `Guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const guestEmail = `${guestName.toLowerCase()}@guest.temp`;

    // 게스트 계정 생성 (12시간 후 자동 삭제)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 12);

    const guestUser = await prisma.user.create({
      data: {
        email: guestEmail,
        name: guestName,
        googleId: null,
        isGuest: true,
        guestExpiresAt: expiresAt,
        avatar: null,
      },
    });

    // JWT 토큰 생성
    const token = jwt.sign(
      {
        id: guestUser.id,
        email: guestUser.email,
        isGuest: true,
      },
      process.env.JWT_SECRET,
      { expiresIn: "12h" },
    );

    res.json({
      message: "게스트로 로그인했습니다",
      token,
      user: {
        id: guestUser.id,
        email: guestUser.email,
        name: guestUser.name,
        isGuest: true,
        expiresAt: guestUser.guestExpiresAt,
      },
    });
  }),
);

// GET /api/auth/me
router.get(
  "/me",
  auth(),
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
      },
    });
    if (!user)
      return res.status(404).json({ error: "사용자를 찾을 수 없습니다" });
    res.json(user);
  }),
);

// POST /api/auth/terminate-session
router.post(
  "/terminate-session",
  auth(),
  asyncRoute(async (req, res) => {
    const userId = req.user.id;

    try {
      const cleaned = await cleanupUserActivities(userId, "logout");

      res.json({
        success: true,
        message: "로그아웃 완료",
        cleaned,
      });
    } catch (error) {
      console.error("로그아웃 처리 오류:", error);

      res.json({
        success: true,
        message: "로그아웃 완료 (일부 정리 작업 실패)",
        error: error.message,
      });
    }
  }),
);

module.exports = router;
