const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

const VAPI_BASE_URL = 'https://api.vapi.ai';

const vapiClient = axios.create({
  baseURL: VAPI_BASE_URL,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${config.VAPI_API_KEY}`,
    'Content-Type': 'application/json',
  },
});

vapiClient.interceptors.request.use((req) => {
  logger.info(`Vapi → ${req.method.toUpperCase()} ${req.url}`);
  return req;
});

vapiClient.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error('Vapi API error', { status, data, message: err.message });
    throw err;
  }
);

module.exports = vapiClient;
