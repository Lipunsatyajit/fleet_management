const express = require('express');
const { getChaos, updateChaos, resetChaos } = require('../controllers/chaosController');

const router = express.Router();

router.get('/', getChaos);
router.post('/', updateChaos);
router.delete('/', resetChaos);

module.exports = router;
