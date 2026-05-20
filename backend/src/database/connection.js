const sql    = require('mssql');
const config = require('../config');
const logger = require('../utils/logger');

const poolConfig = {
  user:     config.DB_USER,
  password: config.DB_PASSWORD,
  server:   config.DB_SERVER,
  database: config.DB_NAME,
  port:     config.DB_PORT,
  options: {
    encrypt:               false,
    trustServerCertificate: true,
    enableArithAbort:       true,
  },
  pool: {
    max:              10,
    min:              2,
    idleTimeoutMillis: 30000,
  },
  connectionTimeout: 15000,
  requestTimeout:    30000,
};

let pool = null;

// Called once at server startup — establishes the pool before any request arrives.
const connect = async () => {
  pool = new sql.ConnectionPool(poolConfig);

  pool.on('error', err => logger.error('SQL pool error', { message: err.message }));

  await pool.connect();
  logger.info(`SQL Server connected → ${config.DB_SERVER}/${config.DB_NAME}`);
  return pool;
};

// Returns the existing pool. Throws if connect() was never called.
const getPool = () => {
  if (!pool || !pool.connected) {
    throw new Error('DB pool not initialised — call connect() at startup');
  }
  return pool;
};

process.on('SIGINT',  async () => { if (pool) { await pool.close(); logger.info('DB pool closed'); } });
process.on('SIGTERM', async () => { if (pool) { await pool.close(); logger.info('DB pool closed'); } });

module.exports = { connect, getPool, sql };
