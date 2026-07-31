require('dotenv').config();
const cacheService = require('../services/cacheService');

async function run() {
  console.log('Testing cacheService directly...');
  
  const key = cacheService.generateKey('product', { companyId: 'test123', name: 'widget' });
  console.log('Generated key:', key);

  await cacheService.set(key, { name: 'widget', price: 100 }, 30);
  const cached = await cacheService.get(key);
  console.log('Cached:', JSON.stringify(cached, null, 2));

  await cacheService.delete(key);
  const after = await cacheService.get(key);
  console.log('After delete:', after);

  console.log('\ncacheService integration OK');
  process.exit(0);
}

run().catch((e) => {
  console.error('cacheService test failed:', e);
  process.exit(1);
});
