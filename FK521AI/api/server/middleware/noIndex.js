function noIndex(_req, res, next) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

module.exports = noIndex;
