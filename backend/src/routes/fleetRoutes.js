const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { getServices, getMetrics } = require('../controllers/fleetController');

const router = express.Router();

router.get('/services', authenticate, getServices);
// Keep the Phase 2 metrics list while the new snapshot/history/replay routes are added.
router.get('/metrics', authenticate, getMetrics);

module.exports = router;
