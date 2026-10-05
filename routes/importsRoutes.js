const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const requireCompanyHeader = require('../middleware/requireCompanyHeader');
const controller = require('../controllers/importsController');

router.use(protect, requireCompanyHeader);

router.get('/entity-types', controller.getEntityTypes);
router.post('/parse-headers', controller.uploadImportFile, controller.parseHeaders);
router.post('/ocr/purchase-invoice', controller.uploadOcrFile, controller.scanPurchaseInvoice);
router.post('/ocr/purchase-invoice/direct-purchase', controller.uploadOcrFile, controller.createPurchaseFromScannedInvoice);
router.get('/templates/:entityType', controller.getTemplates);
router.post('/templates', controller.createTemplate);
router.put('/templates/:id', controller.updateTemplate);
router.delete('/templates/:id', controller.deleteTemplate);
router.post('/validate', controller.uploadImportFile, controller.validate);
router.post('/process', controller.process);
router.get('/progress/:jobId', controller.progress);
router.get('/history', controller.history);
router.delete('/history/:id', controller.deleteHistory);
router.post('/history/:id/delete', controller.deleteHistory);
router.get('/history/:id/error-report', controller.downloadErrorReport);
router.get('/history/:id/results-report', controller.downloadResultsReport);
router.get('/download-template/:entityType', controller.downloadTemplate);

module.exports = router;
