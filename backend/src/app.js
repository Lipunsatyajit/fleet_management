const express = require('express');
const cors = require('cors');

const { FRONTEND_ORIGIN } = require('./config/config');
const healthRoutes = require('./routes/healthRoutes');
const authRoutes = require('./routes/authRoutes');
const metricsRoutes = require('./routes/metricsRoutes');
const streamRoutes = require('./routes/streamRoutes');
const rulesRoutes = require('./routes/rulesRoutes');
const fleetRoutes = require('./routes/fleetRoutes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { chaosMiddleware } = require('./middleware/chaosMiddleware');
const chaosRoutes = require('./routes/chaosRoutes');

const app = express();

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(chaosMiddleware);

app.use('/health', healthRoutes);
app.use('/auth', authRoutes);
app.use('/chaos', chaosRoutes);
app.use('/metrics', metricsRoutes);
app.use('/stream', streamRoutes);
app.use('/rules', rulesRoutes);
app.use('/', fleetRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
