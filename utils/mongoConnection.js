const mongoose = require('mongoose');

function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = { isMongoConnected };
