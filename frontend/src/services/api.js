import axios from 'axios';

// VITE_API_BASE_URL = backend origin e.g. https://api.cultureholidays.com
// Leave blank in development — Vite proxy handles /api → localhost:3001
const API_ORIGIN = import.meta.env.VITE_API_BASE_URL || '';

const api = axios.create({
  baseURL: `${API_ORIGIN}/api`,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

export const API_ORIGIN_EXPORT = API_ORIGIN;

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const message = err.response?.data?.error || err.message || 'Request failed';
    return Promise.reject(new Error(message));
  }
);

// ── Calls ──────────────────────────────────────────────────────────────────────
export const callApi = {
  initiateOutbound: (data)     => api.post('/call/outbound', data),
  getHistory:       (limit)    => api.get('/call/history', { params: { limit } }),
  getStats:         ()         => api.get('/call/stats'),
  getDetail:        (callSid)  => api.get(`/call/detail/${callSid}`),
  getFiles:         ()         => api.get('/call/files'),
};

// ── Agents ─────────────────────────────────────────────────────────────────────
export const agentApi = {
  getAll: () => api.get('/agents'),
  create: (data) => api.post('/agents', data),
  update: (id, data) => api.put(`/agents/${id}`, data),
  remove: (id) => api.delete(`/agents/${id}`),
};

export default api;
