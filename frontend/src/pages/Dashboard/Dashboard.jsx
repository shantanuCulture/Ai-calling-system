import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { callApi } from '../../services/api';
import './Dashboard.css';

const STAT_CARDS = [
  { key: 'total',       label: 'Total Calls',      icon: '📞', color: '#4f46e5', sub: 'all time'        },
  { key: 'today',       label: 'Today',             icon: '📅', color: '#0ea5e9', sub: 'calls today'     },
  { key: 'inbound',     label: 'Inbound',           icon: '↙',  color: '#22c55e', sub: 'calls received'  },
  { key: 'outbound',    label: 'Outbound',          icon: '↗',  color: '#8b5cf6', sub: 'calls made'      },
  { key: 'transferred', label: 'Transferred',       icon: '↔',  color: '#f59e0b', sub: 'to human agent'  },
  { key: 'avgDuration', label: 'Avg Duration',      icon: '⏱',  color: '#06b6d4', sub: 'per call (secs)' },
];

const STATUS_BADGE = {
  completed:   'badge-success',
  in_progress: 'badge-info',
  failed:      'badge-danger',
  busy:        'badge-warning',
  'no-answer': 'badge-warning',
};

function fmtDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats,   setStats]   = useState({});
  const [calls,   setCalls]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [form,    setForm]    = useState({ to: '', customerName: '', notes: '' });
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, histRes] = await Promise.all([
        callApi.getStats(),
        callApi.getHistory(10),
      ]);
      setStats(statsRes.stats || {});
      setCalls(histRes.calls || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleChange = (e) => setForm(f => ({ ...f, [e.target.name]: e.target.value }));

  const handleCall = async (e) => {
    e.preventDefault();
    setCalling(true);
    setCallResult(null);
    try {
      const res = await callApi.initiateOutbound(form);
      setCallResult({ ok: true, msg: res.message, sid: res.callSid });
      setForm({ to: '', customerName: '', notes: '' });
      setTimeout(load, 3000);
    } catch (err) {
      setCallResult({ ok: false, msg: err.message });
    }
    setCalling(false);
  };

  return (
    <div className="dash">
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Dashboard</h1>
          <p className="dash-sub">Culture Holidays · AI Call System</p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>
          {loading ? '…' : '↺ Refresh'}
        </button>
      </div>

      {/* Stats grid */}
      <div className="dash-stats">
        {STAT_CARDS.map(({ key, label, icon, color, sub }) => {
          const val = stats[key];
          const display = key === 'avgDuration'
            ? (val ? fmtDuration(Math.round(val)) : '—')
            : (val ?? '—');
          return (
            <div className="dash-stat" key={key} style={{ '--c': color }}>
              <div className="dash-stat-icon">{icon}</div>
              <div className="dash-stat-body">
                <div className="dash-stat-val">{display}</div>
                <div className="dash-stat-label">{label}</div>
                <div className="dash-stat-sub">{sub}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="dash-main">
        {/* Recent calls */}
        <div className="card dash-calls">
          <div className="dash-section-head">
            <span className="section-title">Recent Calls</span>
            <button className="btn-link" onClick={() => navigate('/call-logs')}>View all →</button>
          </div>

          {loading ? (
            <div className="dash-placeholder">Loading…</div>
          ) : calls.length === 0 ? (
            <div className="dash-placeholder">No calls yet.</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Caller</th>
                  <th>Direction</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Agent</th>
                </tr>
              </thead>
              <tbody>
                {calls.map(c => (
                  <tr
                    key={c.CallID}
                    className="dash-table-row"
                    onClick={() => navigate(`/call-logs?sid=${c.TwilioCallSID}`)}
                    title="Click to view detail"
                  >
                    <td className="td-mono">{fmtTime(c.CallStartedAt)}</td>
                    <td>
                      <div className="td-phone">{c.CallerPhone}</div>
                      {c.CallerName && <div className="td-sub">{c.CallerName}</div>}
                    </td>
                    <td>
                      <span className={`badge ${c.Direction === 'inbound' ? 'badge-info' : 'badge-neutral'}`}>
                        {c.Direction === 'inbound' ? '↙ In' : '↗ Out'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[c.CallStatus] || 'badge-neutral'}`}>
                        {c.CallStatus || '—'}
                      </span>
                    </td>
                    <td className="td-mono">{fmtDuration(c.DurationSecs)}</td>
                    <td className="td-sub">{c.AgentID || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Outbound call form */}
        <div className="card dash-outbound">
          <div className="section-title" style={{ marginBottom: 4 }}>Trigger Outbound Call</div>
          <p className="dash-form-sub">Dial a number and connect to the AI assistant.</p>

          {callResult && (
            <div className={`alert ${callResult.ok ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 12 }}>
              {callResult.msg}
              {callResult.sid && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>SID: {callResult.sid}</div>}
            </div>
          )}

          <form onSubmit={handleCall}>
            <div className="form-group">
              <label className="form-label">Phone Number *</label>
              <input className="form-input" name="to" value={form.to} onChange={handleChange}
                placeholder="+91 98765 43210" required />
            </div>
            <div className="form-group">
              <label className="form-label">Customer Name</label>
              <input className="form-input" name="customerName" value={form.customerName}
                onChange={handleChange} placeholder="Optional" />
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <input className="form-input" name="notes" value={form.notes}
                onChange={handleChange} placeholder="e.g. Interested in Dubai tour" />
            </div>
            <button type="submit" className="btn btn-primary" disabled={calling} style={{ width: '100%' }}>
              {calling ? 'Initiating…' : '☎ Start Call'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
