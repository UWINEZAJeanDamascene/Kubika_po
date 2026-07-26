const mongoose = require('mongoose');

// Import centralized configuration
const env = require('../src/config/environment');

/**
 * Pool and timeout options for production load (overridable via environment).
 */
function buildMongooseConnectOptions() {
  const config = env.getConfig();
  const dbConfig = config.db;
  
  const maxPoolSize = Math.max(10, dbConfig.maxPoolSize);
  const minPoolSize = Math.max(0, dbConfig.minPoolSize);

  return {
    maxPoolSize,
    minPoolSize,
    serverSelectionTimeoutMS: dbConfig.serverSelectionTimeoutMs,
    socketTimeoutMS: dbConfig.socketTimeoutMs,
    connectTimeoutMS: dbConfig.connectTimeoutMs,
    heartbeatFrequencyMS: dbConfig.heartbeatFrequencyMs,
  };
}

const connectDB = async () => {
  try {
    const config = env.getConfig();
    const dbUri = config.db.uri;
    
    if (!dbUri) {
      // MongoDB disabled — auth/tenancy runs on PostgreSQL. Domains that are
      // not yet migrated (inventory, sales, purchases, finance) will have no
      // data until their migration phases complete or MONGODB_URI is set.
      console.warn('⚠️  MONGODB_URI not set — MongoDB is DISABLED. Unmigrated domains will be unavailable.');
      // Fail fast instead of buffering queries for 10s against a dead connection.
      mongoose.set('bufferCommands', false);
      return null;
    }

    const conn = await mongoose.connect(dbUri, buildMongooseConnectOptions());

    console.log(`MongoDB Connected: ${conn.connection.host}`);

    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected');
    });

    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      console.log('MongoDB connection closed through app termination');
      process.exit(0);
    });
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
module.exports.buildMongooseConnectOptions = buildMongooseConnectOptions;
