function cleanFileName(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

module.exports = { cleanFileName };
