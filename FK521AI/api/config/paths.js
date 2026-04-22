const path = require('path');

const root = process.cwd();

module.exports = {
  uploads: path.join(root, 'uploads'),
  publicPath: path.join(root, 'public'),
  imageOutput: path.join(root, 'public', 'images'),
};
