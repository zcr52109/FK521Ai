const fs = require('fs');
const express = require('express');

function staticCache(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return (_req, _res, next) => next();
  }
  return express.static(dir, { maxAge: 0, etag: false });
}

module.exports = staticCache;
