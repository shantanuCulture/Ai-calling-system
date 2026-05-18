require('dotenv').config();
const app = require('./src/app');
const config = require('./src/config');
const logger = require('./src/utils/logger');

const PORT = config.PORT;

app.listen(PORT, () => {
  logger.info('─────────────────────────────────────────');
  logger.info(`  AI Call System Backend — port ${PORT}`);
  logger.info(`  Environment : ${config.NODE_ENV}`);
  logger.info(`  Base URL    : ${config.BASE_URL}`);
  logger.info('─────────────────────────────────────────');
});
