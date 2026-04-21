const mongoose = require('mongoose');

const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/fk521ai';

async function connectDb() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || DEFAULT_MONGO_URI;
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
  });
  return mongoose.connection;
}

async function indexSync() {
  const models = Object.values(mongoose.models || {});
  await Promise.all(
    models.map(async (model) => {
      if (typeof model.syncIndexes === 'function') {
        await model.syncIndexes();
      }
    }),
  );
  return true;
}

module.exports = { connectDb, indexSync };
