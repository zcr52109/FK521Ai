async function processFileURL() {
  const error = new Error('processFileURL is unavailable in this runtime build.');
  error.code = 'FILES_PROCESS_UNAVAILABLE';
  throw error;
}

async function uploadImageBuffer() {
  const error = new Error('uploadImageBuffer is unavailable in this runtime build.');
  error.code = 'FILES_UPLOAD_UNAVAILABLE';
  throw error;
}

module.exports = { processFileURL, uploadImageBuffer };
