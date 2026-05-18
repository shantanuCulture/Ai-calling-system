import { useState, useEffect } from 'react';
import { callApi } from '../../services/api';
import './Dashboard.css';

const StatCard = ({ label, value, sub, color }) => (
  <div className="stat-card" style={{ '--accent': color }}>
    <div className="stat-value">{value}</div>
    <div className="stat-label">{label}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

export default function Dashboard() {
  const [form, setForm] = useState({ to: '', customerName: '', notes: '' });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [stats, setStats] = useState({ total: 0, inbound: 0, outbound: 0, leads: 0 });

  useEffect(() => {
    Promise.all([callApi.getLogs(), callApi.getLeads()])
      .then(([logsRes, leadsRes]) => {
        const logs = logsRes.callLogs || [];
        setStats({
          total: logs.length,
          inbound: logs.filter((l) => l.direction === 'inbound').length,
          outbound: logs.filter((l) => l.direction === 'outbound').length,
          leads: leadsRes.leads?.length || 0,
        });
      })
      .catch(() => {});
  }, [result]);

  const handleChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await callApi.initiateOutbound(form);
      setResult({ type: 'success', message: res.message || 'Call initiated!', callSid: res.callSid });
      setForm({ to: '', customerName: '', notes: '' });
    } catch (err) {
      setResult({ type: 'error', message: err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Overview and quick actions</p>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <StatCard label="Total Calls" value={stats.total} sub="all time" color="#4f46e5" />
        <StatCard label="Inbound" value={stats.inbound} sub="calls received" color="#0ea5e9" />
        <StatCard label="Outbound" value={stats.outbound} sub="calls made" color="#8b5cf6" />
        <StatCard label="Leads Saved" value={stats.leads} sub="from AI calls" color="#22c55e" />
      </div>

      {/* Flow Diagram */}
      <div className="card flow-card">
        <h2 className="section-title">System Flow</h2>
        <div className="flow-grid">
          <FlowBox
            title="Inbound Flow"
            color="#4f46e5"
            steps={[
              'Customer calls toll-free number',
              'Twilio → POST /api/twilio/incoming-call',
              'Backend returns TwiML (SIP → Vapi)',
              'Vapi AI handles conversation (STT + LLM + TTS)',
              'AI calls /api/vapi/tool for data (tours, leads)',
              'If human needed → transfer-call webhook',
            ]}
          />
          <FlowBox
            title="Outbound Flow"
            color="#8b5cf6"
            steps={[
              'Trigger POST /api/call/outbound from dashboard',
              'Twilio dials the customer number',
              'Customer answers → Twilio fetches outbound-vapi URL',
              'Backend returns TwiML to connect to Vapi assistant',
              'AI starts the conversation automatically',
            ]}
          />
          <FlowBox
            title="Human Escalation"
            color="#f59e0b"
            steps={[
              'AI detects it cannot answer OR user asks for human',
              'AI calls transferToHuman tool → backend looks up agent',
              'POST /api/twilio/transfer-call returns <Dial> TwiML',
              'Twilio bridges customer ↔ agent',
              'If agent no answer → fallback message plays',
            ]}
          />
        </div>
      </div>

      {/* Outbound Call Form */}
      <div className="card outbound-card">
        <h2 className="section-title">Trigger Outbound Call</h2>
        <p className="section-sub">
          Dial a customer and connect them to the AI assistant automatically.
        </p>

        {result && (
          <div className={`alert alert-${result.type === 'success' ? 'success' : 'error'}`} style={{ marginBottom: 16 }}>
            {result.message}
            {result.callSid && <span style={{ marginLeft: 8, opacity: 0.7, fontSize: 12 }}>SID: {result.callSid}</span>}
          </div>
        )}

        <form onSubmit={handleSubmit} className="outbound-form">
          <div className="form-group">
            <label className="form-label">Phone Number *</label>
            <input
              className="form-input"
              name="to"
              value={form.to}
              onChange={handleChange}
              placeholder="+1 555 123 4567"
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Customer Name</label>
            <input
              className="form-input"
              name="customerName"
              value={form.customerName}
              onChange={handleChange}
              placeholder="Optional"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Notes</label>
            <input
              className="form-input"
              name="notes"
              value={form.notes}
              onChange={handleChange}
              placeholder="e.g. Interested in Paris tour"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Initiating…' : '☎ Start Call'}
          </button>
        </form>
      </div>
    </div>
  );
}

function FlowBox({ title, color, steps }) {
  return (
    <div className="flow-box" style={{ '--flow-color': color }}>
      <div className="flow-title">{title}</div>
      <ol className="flow-steps">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
