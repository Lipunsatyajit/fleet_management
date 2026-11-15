const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { getSnapshot, getHistory, getReplay } = require('../controllers/metricsController');

const router = express.Router();

router.use(authenticate);
router.get('/snapshot', getSnapshot);
router.get('/history', getHistory);
router.get('/replay', getReplay);

module.exports = router;
