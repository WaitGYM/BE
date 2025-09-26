const router = require('express').Router()
const prisma = require('../lib/prisma')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')


const isProd = process.env.NODE_ENV === 'production'


// dev/로컬에서 시크릿 없으면 임시값 허용(운영 금지)
function getSecret() {
  return process.env.JWT_SECRET || (!isProd ? 'dev-secret-do-not-use' : null)
}


function genDevGoogleId() {
  const uuid = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex')
  return `dev-${uuid}`
}


router.post('/dev-login', async (req, res) => {
  try {
    const secret = getSecret()
    if (!secret) return res.status(500).json({ error: 'JWT_SECRET not set' })


    const { email, name } = req.body || {}
    if (!email) return res.status(400).json({ error: 'email is required' })


    // 1) 사용자 조회
    let user = await prisma.user.findUnique({ where: { email } })


    // 2) 없으면 생성 (googleId는 스키마상 필수/unique)
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: name ?? email.split('@')[0],
          googleId: genDevGoogleId(),
        }
      })
    } else {
      // 3) 있으면 보정: googleId 없거나 이름 변경
      const patch = {}
      if (!user.googleId) patch.googleId = genDevGoogleId()
      if (name && name !== user.name) patch.name = name
      if (Object.keys(patch).length) {
        user = await prisma.user.update({ where: { id: user.id }, data: patch })
      }
    }


    // 4) 토큰 발급 (미들웨어와 같은 시크릿 사용!)
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      secret,
      { expiresIn: '1h' }
    )


    return res.json({ accessToken: token, user: { id: user.id, email: user.email, name: user.name } })
  } catch (e) {
    console.error('[dev-login] error:', e?.code, e?.message, e?.meta)
    return res.status(500).json({
      error: 'dev-login failed',
      detail: (!isProd ? e?.message : undefined),
    })
  }
})


module.exports = router
