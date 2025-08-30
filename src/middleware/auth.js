const jwt = require('jsonwebtoken')

function auth(requiredRole) {
  return (req, res, next) => {
    try {
      const header = req.headers.authorization || ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : null
      if (!token) return res.status(401).json({ error: '토큰 필요' })

      const payload = jwt.verify(token, process.env.JWT_SECRET)
      req.user = payload // { id, role, email }

      if (requiredRole && payload.role !== requiredRole) {
        return res.status(403).json({ error: '권한 없음' })
      }
      next()
    } catch (e) {
      return res.status(401).json({ error: '유효하지 않은 토큰' })
    }
  }
}
module.exports = { auth }
