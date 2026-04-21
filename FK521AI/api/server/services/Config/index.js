const fs = require('fs');
const path = require('path');

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function ensureIndex(dist) {
  const indexPath = path.join(dist, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      '<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>FK521AI</title></head><body><div id="app">FK521AI mock runtime</div></body></html>',
      'utf8',
    );
  }
}

async function getAppConfig() {
  const runtimeRoot = path.resolve(__dirname, '../../../.runtime');
  const clientPublicRoot = path.resolve(__dirname, '../../../../client/public');
  const dist = path.join(runtimeRoot, 'dist');
  const uploads = path.join(runtimeRoot, 'uploads');
  const fonts = fs.existsSync(path.join(clientPublicRoot, 'fonts'))
    ? path.join(clientPublicRoot, 'fonts')
    : path.join(runtimeRoot, 'fonts');
  const assets = fs.existsSync(path.join(clientPublicRoot, 'assets'))
    ? path.join(clientPublicRoot, 'assets')
    : path.join(runtimeRoot, 'assets');
  ensureDir(dist);
  ensureDir(uploads);
  if (!fs.existsSync(fonts)) {
    ensureDir(fonts);
  }
  if (!fs.existsSync(assets)) {
    ensureDir(assets);
  }
  ensureIndex(dist);

  return {
    paths: { dist, fonts, assets, uploads },
    secureImageLinks: false,
  };
}

module.exports = { getAppConfig };
