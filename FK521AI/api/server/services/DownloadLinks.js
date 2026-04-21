function verifySignedToken(token) {
  if (!token) {
    const error = new Error('Missing token');
    error.code = 'DOWNLOAD_TOKEN_MALFORMED';
    throw error;
  }
  return { token };
}

async function streamSignedDownload(_req, res) {
  res.status(200).send('mock-download');
}

module.exports = { verifySignedToken, streamSignedDownload };
