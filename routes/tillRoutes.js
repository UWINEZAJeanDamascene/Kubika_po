const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { openTill, closeTill, getActiveTill } = require('../controllers/tillController');

router.use(protect);

router.post('/open', openTill);
router.post('/close', closeTill);
router.get('/active', getActiveTill);

module.exports = router;
