const router = require("express").Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const jwt = require("jsonwebtoken");
const passport = require("passport");

// 구글 OAuth 로그인 시작 - 프론트에서 직접 fetch 불가능하므로 백에서 리디렉션 필요
router.get("/google", (req, res) => {
  const redirectUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}` +
    `&response_type=code` +
    `&scope=profile email`;
  res.redirect(redirectUrl);
});

// 구글 OAuth 콜백
router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: `${process.env.FRONTEND_URL}/?error=auth_failed`,
  }),
  (req, res) => {
    try {
      // JWT 토큰 생성
      const token = jwt.sign(
        {
          id: req.user.id,
          email: req.user.email,
          role: req.user.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      // 사용자 정보
      const user = {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        avatar: req.user.avatar,
        role: req.user.role,
      };

      // 프론트엔드로 리다이렉트 (토큰을 쿼리로 전달)
      const redirectUrl = `${
        process.env.FRONTEND_URL
      }/oauth-success?token=${token}&user=${encodeURIComponent(
        JSON.stringify(user)
      )}`;
      res.redirect(redirectUrl);
    } catch (error) {
      console.error("Token generation error:", error);
      res.redirect(`${process.env.FRONTEND_URL}/?error=token_failed`);
    }
  }
);

// 로그아웃
router.post("/logout", (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: "로그아웃 실패" });
    }
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "세션 삭제 실패" });
      }
      res.json({ message: "로그아웃 성공" });
    });
  });
});

// 현재 사용자 정보 조회 (JWT 토큰 기반)
router.get("/me", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "토큰이 필요합니다" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "사용자를 찾을 수 없습니다" });
    }

    res.json(user);
  } catch (error) {
    return res.status(401).json({ error: "유효하지 않은 토큰" });
  }
});

module.exports = router;

// src/routes/auth.js에 추가 (개발환경에서만 사용)
if (process.env.NODE_ENV === "development") {
  router.post("/make-admin/:userId", async (req, res) => {
    const userId = Number(req.params.userId);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { role: "ADMIN" },
    });
    res.json({ message: "관리자 권한이 부여되었습니다", user });
  });
}
