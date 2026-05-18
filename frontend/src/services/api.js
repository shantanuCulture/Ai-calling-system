import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const message = err.response?.data?.error || err.message || 'Request failed';
    return Promise.reject(new Error(message));
  }
);

// ── Calls ──────────────────────────────────────────────────────────────────────
export const callApi = {
  initiateOutbound: (data) => api.post('/call/outbound', data),
  getLogs: () => api.get('/call/logs'),
  getLeads: () => api.get('/call/leads'),
};

// ── Agents ─────────────────────────────────────────────────────────────────────
export const agentApi = {
  getAll: () => api.get('/agents'),
  create: (data) => api.post('/agents', data),
  update: (id, data) => api.put(`/agents/${id}`, data),
  remove: (id) => api.delete(`/agents/${id}`),
};

export default api;
