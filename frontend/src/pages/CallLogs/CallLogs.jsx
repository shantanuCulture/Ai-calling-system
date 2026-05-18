import { useState, useEffect } from 'react';
import { callApi } from '../../services/api';
import './CallLogs.css';

const DIRECTION_BADGE = {
  inbound: 'badge-info',
  outbound: 'badge-neutral',
};

const STATUS_BADGE = {
  completed: 'badge-success',
  'in-progress': 'badge-warning',
  answered: 'badge-success',
  ringing: 'badge-warning',
  initiated: 'badge-neutral',
  failed: 'badge-danger',
  'no-answer': 'badge-danger',
  busy: 'badge-danger',
};

function formatDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export default function CallLogs() {
  const [logs, setLogs] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [activeTab, setActiveTab] = useState('calls');

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      const [logsRes, leadsRes] = await Promise.all([callApi.getLogs(), callApi.getLeads()]);
      setLogs(logsRes.callLogs || []);
      setLeads(leadsRes.leads || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const filteredLogs = filter === 'all' ? logs : logs.filter((l) => l.direction === filter);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Call Logs & Leads</h1>
        <p className="page-subtitle">All calls handled by the system and leads captured by the AI</p>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="tabs">
        <button className={`tab ${activeTab === 'calls' ? 'tab--active' : ''}`} onClick={() => setActiveTab('calls')}>
          Call Logs ({logs.length})
        </button>
        <button className={`tab ${activeTab === 'leads' ? 'tab--active' : ''}`} onClick={() => setActiveTab('leads')}>
          Leads ({leads.length})
        </button>
      </div>

      {activeTab === 'calls' && (
        <div className="card">
          <div className="table-toolbar">
            <div className="filter-group">
              {['all', 'inbound', 'outbound'].map((f) => (
                <button
                  key={f}
                  className={`filter-btn ${filter === f ? 'filter-btn--active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <button className="btn btn-secondary" onClick={fetchData}>
              ↻ Refresh
            </button>
          </div>

          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : filteredLogs.length === 0 ? (
            <div className="empty-state">
              No call logs yet. Calls will appear here automatically once the system is live.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Direction</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Customer</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="cell-muted">{formatDate(log.timestamp)}</td>
                      <td>{log.from || '—'}</td>
                      <td>{log.to || '—'}</td>
                      <td>
                        <span className={`badge ${DIRECTION_BADGE[log.direction] || 'badge-neutral'}`}>
                          {log.direction || '—'}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[log.status] || 'badge-neutral'}`}>
                          {log.status || '—'}
                        </span>
                      </td>
                      <td>{formatDuration(log.duration)}</td>
                      <td>{log.customerName || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'leads' && (
        <div className="card">
          {loading ? (
            <div className="empty-state">Loading…</div>
          ) : leads.length === 0 ? (
            <div className="empty-state">
              No leads yet. The AI assistant will save leads during calls when it collects customer details.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Email</th>
                    <th>Destination</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      <td className="cell-muted">{formatDate(lead.createdAt)}</td>
                      <td>{lead.name || '—'}</td>
                      <td>{lead.phone}</td>
                      <td>{lead.email || '—'}</td>
                      <td>{lead.destination || '—'}</td>
                      <td className="cell-muted">{lead.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
