const sql = require('mssql');
const config = require('../config');
const logger = require('../utils/logger');

const poolConfig = {
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  server: config.DB_SERVER,
  database: config.DB_NAME,
  port: config.DB_PORT,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  connectionTimeout: 15000,
  requestTimeout: 30000,
};

let pool = null;

const getPool = async () => {
  if (pool && pool.connected) return pool;

  try {
    pool = await sql.connect(poolConfig);
    logger.info(`SQL Server connected → ${config.DB_SERVER}/${config.DB_NAME}`);
    return pool;
  } catch (err) {
    logger.error('SQL Server connection failed', { message: err.message });
    throw err;
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  if (pool) await pool.close();
});

module.exports = { getPool, sql };
