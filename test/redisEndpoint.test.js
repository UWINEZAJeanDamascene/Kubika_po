require('dotenv').config();
const { redisHealth } = require('../controllers/healthController');

async function runEndpointTest() {
  const req = {};
  const res = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      console.log('HTTP', this.statusCode);
      console.log(JSON.stringify(data, null, 2));
    },
  };

  await redisHealth(req, res);
  if (res.statusCode === 200) {
    console.log('\n=== /api/health/redis endpoint is working ===');
    process.exit(0);
  } else {
    console.log('\n=== Redis health check returned non-200 ===');
    process.exit(1);
  }
}

runEndpointTest().catch((e) => {
  console.error('Endpoint test failed:', e);
  process.exit(1);
});
