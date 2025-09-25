// 한 줄짜리 비동기 라우트 에러 래퍼
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
