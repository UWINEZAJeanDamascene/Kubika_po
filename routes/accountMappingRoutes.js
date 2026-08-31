const express = require('express');
const router = express.Router();
const mappingController = require('../controllers/accountMappingController');
const { protect } = require('../middleware/auth');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// Reference data: read constantly, changed rarely. Writes invalidate the
// whole type so an edit is visible immediately.
const cacheRef = cacheMiddleware({ type: 'account_mapping', ttl: 600 });
const invalidateRef = cacheInvalidationMiddleware({ type: 'account_mapping', invalidateAll: true });

router.use(protect);

// CRUD
router.get('/', cacheRef, mappingController.listMappings);
router.get('/resolve', cacheRef, mappingController.resolve);
router.get('/:id', cacheRef, mappingController.getMapping);
router.post('/', invalidateRef, mappingController.createMapping);
router.put('/:id', invalidateRef, mappingController.updateMapping);
router.delete('/:id', invalidateRef, mappingController.deleteMapping);

module.exports = router;
