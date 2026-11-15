const express = require('express');
const { openSseStream } = require('../controllers/streamController');

const router = express.Router();

router.get('/sse', openSseStream);

module.exports = router;
