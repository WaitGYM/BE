// Authorization 헤더가 있어도/없어도 동작하게 userId를 추출.
// 라우트가 공개 API일 때 "내 상태"를 곁들여 보여줄 때 사용.
const jwt = require('jsonwebtoken');

function authOptional(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { userId: null };
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return { userId: payload.id };
  } catch {
    return { userId: null };
  }
}

module.exports = { authOptional };
