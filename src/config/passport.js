const passport = require('passport')
const GoogleStrategy = require('passport-google-oauth20').Strategy
const prisma = require('../lib/prisma')

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_REDIRECT_URI // 환경변수 사용
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // Google ID로 기존 사용자 확인
    let user = await prisma.user.findUnique({
      where: { googleId: profile.id }
    })

    if (user) {
      // 기존 사용자 정보 업데이트 (이름, 아바타 변경 가능성)
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          name: profile.displayName,
          avatar: profile.photos[0]?.value
        }
      })
      return done(null, user)
    }

    // 새 사용자 생성
    user = await prisma.user.create({
      data: {
        email: profile.emails[0].value,
        name: profile.displayName,
        googleId: profile.id,
        avatar: profile.photos[0]?.value
      }
    })

    return done(null, user)
  } catch (error) {
    console.error('Google OAuth error:', error)
    return done(error, null)
  }
}))

passport.serializeUser((user, done) => {
  done(null, user.id)
})

passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ 
      where: { id },
      select: { id: true, email: true, name: true, avatar: true }
    })
    done(null, user)
  } catch (error) {
    done(error, null)
  }
})

module.exports = passport