import { useState, useEffect } from 'react';
import { agentApi } from '../../services/api';
import './AgentManagement.css';

const EMPTY_FORM = { name: '', phone: '', email: '', department: 'sales', available: true };

export default function AgentManagement() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchAgents = async () => {
    try {
      const res = await agentApi.getAll();
      setAgents(res.agents || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAgents(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError('');
    setSuccess('');
  };

  const openEdit = (agent) => {
    setEditingId(agent.id);
    setForm({ name: agent.name, phone: agent.phone, email: agent.email || '', department: agent.department, available: agent.available });
    setShowForm(true);
    setError('');
    setSuccess('');
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (editingId) {
        await agentApi.update(editingId, form);
        setSuccess('Agent updated successfully.');
      } else {
        await agentApi.create(form);
        setSuccess('Agent added successfully.');
      }
      setShowForm(false);
      setEditingId(null);
      await fetchAgents();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete agent "${name}"?`)) return;
    try {
      await agentApi.remove(id);
      setSuccess(`Agent "${name}" deleted.`);
      await fetchAgents();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleToggleAvailable = async (agent) => {
    try {
      await agentApi.update(agent.id, { available: !agent.available });
      await fetchAgents();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Agent Management</h1>
          <p className="page-subtitle">Manage human agents for call transfers and escalations</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Add Agent</button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: 16 }}>{success}</div>}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="card agent-form-card">
          <h2 className="section-title">{editingId ? 'Edit Agent' : 'Add New Agent'}</h2>
          <form onSubmit={handleSubmit} className="agent-form">
            <div className="form-group">
              <label className="form-label">Name *</label>
              <input className="form-input" name="name" value={form.name} onChange={handleChange} placeholder="Sarah Johnson" required />
            </div>
            <div className="form-group">
              <label className="form-label">Phone *</label>
              <input className="form-input" name="phone" value={form.phone} onChange={handleChange} placeholder="+15551234567" required />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" name="email" value={form.email} onChange={handleChange} placeholder="agent@example.com" />
            </div>
            <div className="form-group">
              <label className="form-label">Department</label>
              <select className="form-select" name="department" value={form.department} onChange={handleChange}>
                <option value="sales">Sales</option>
                <option value="support">Support</option>
                <option value="billing">Billing</option>
              </select>
            </div>
            <div className="form-group availability-toggle">
              <label className="form-label">Available</label>
              <label className="toggle">
                <input type="checkbox" name="available" checked={form.available} onChange={handleChange} />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Update Agent' : 'Add Agent'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Agent Cards */}
      {loading ? (
        <div className="card"><div className="empty-state">Loading agents…</div></div>
      ) : agents.length === 0 ? (
        <div className="card"><div className="empty-state">No agents configured. Add your first agent above.</div></div>
      ) : (
        <div className="agents-grid">
          {agents.map((agent) => (
            <div key={agent.id} className="agent-card">
              <div className="agent-card-header">
                <div className="agent-avatar">{agent.name.charAt(0).toUpperCase()}</div>
                <div>
                  <div className="agent-name">{agent.name}</div>
                  <span className={`badge ${agent.department === 'sales' ? 'badge-info' : agent.department === 'support' ? 'badge-warning' : 'badge-neutral'}`}>
                    {agent.department}
                  </span>
                </div>
                <span className={`badge ${agent.available ? 'badge-success' : 'badge-danger'}`} style={{ marginLeft: 'auto' }}>
                  {agent.available ? 'Available' : 'Offline'}
                </span>
              </div>

              <div className="agent-details">
                <div className="agent-detail"><span>📞</span> {agent.phone}</div>
                {agent.email && <div className="agent-detail"><span>✉</span> {agent.email}</div>}
              </div>

              <div className="agent-card-actions">
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => openEdit(agent)}>
                  Edit
                </button>
                <button
                  className={`btn ${agent.available ? 'btn-secondary' : 'btn-primary'}`}
                  style={{ fontSize: 12, padding: '6px 12px' }}
                  onClick={() => handleToggleAvailable(agent)}
                >
                  {agent.available ? 'Set Offline' : 'Set Available'}
                </button>
                <button className="btn btn-danger" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => handleDelete(agent.id, agent.name)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
