const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { requireRole } = require('../middleware/requireRole');
const {
  getRules,
  getRule,
  checkName,
  createRule,
  updateRule,
  deleteRule,
} = require('../controllers/rulesController');

const router = express.Router();

router.use(authenticate);
router.get('/check-name', checkName);
router.get('/:id', getRule);
router.get('/', getRules);
router.post('/', requireRole('operator'), createRule);
router.put('/', requireRole('operator'), updateRule);
router.put('/:id', requireRole('operator'), updateRule);
router.delete('/', requireRole('operator'), deleteRule);
router.delete('/:id', requireRole('operator'), deleteRule);

module.exports = router;
