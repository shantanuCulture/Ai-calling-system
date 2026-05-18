const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/countryController');

router.get('/', ctrl.getAll.bind(ctrl));

module.exports = router;
