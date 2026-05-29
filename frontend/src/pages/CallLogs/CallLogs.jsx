import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { callApi } from '../../services/api';
import './CallLogs.css';

const STATUS_BADGE = {
  completed:   'badge-success',
  in_progress: 'badge-info',
  failed:      'badge-danger',
  busy:        'badge-warning',
  'no-answer': 'badge-warning',
};

function fmtDuration(secs) {
  if (!secs && secs !== 0) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

function DetailDrawer({ callSid, onClose }) {
  const [detail,  setDetail]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab,     setTab]     = useState('transcript');

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    setTab('transcript');
    callApi.getDetail(callSid)
      .then(res => setDetail(res.call))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [callSid]);

  return (
    <div className="drawer">
      <div className="drawer-head">
        <div>
          <div className="drawer-title">Call Detail</div>
          <div className="drawer-sid">{callSid}</div>
        </div>
        <button className="drawer-close" onClick={onClose}>✕</button>
      </div>

      {loading && <div className="drawer-state">Loading…</div>}

      {!loading && !detail && (
        <div className="drawer-state">No log file found for this call yet.</div>
      )}

      {!loading && detail && (
        <>
          <div className="drawer-meta">
            <MetaItem label="Phone"     value={detail.caller?.phone} />
            <MetaItem label="Direction" value={detail.caller?.direction} />
            <MetaItem label="Started"   value={fmtTime(detail.startedAt)} />
            <MetaItem label="Ended"     value={fmtTime(detail.endedAt)} />
            <MetaItem label="DB Call ID" value={detail.caller?.callId} />
          </div>

          {detail.callSummary && (
            <div className="drawer-summary">
              <div className="drawer-summary-label">AI Summary</div>
              <p>{detail.callSummary}</p>
            </div>
          )}

          <div className="drawer-tabs">
            {[
              { key: 'transcript', label: 'Transcript' },
              { key: 'events',     label: `Events (${detail.events?.length || 0})` },
              { key: 'session',    label: 'Session' },
            ].map(t => (
              <button key={t.key} className={`drawer-tab ${tab === t.key ? 'active' : ''}`}
                onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'transcript' && (
            <div className="drawer-transcript">
              {detail.transcript?.length > 0 ? (
                detail.transcript.map((line, i) => (
                  <div key={i} className={`tr-line tr-${line.role}`}>
                    <span className="tr-role">
                      {line.role === 'assistant' ? 'AI' : line.role === 'user' ? 'User' : '—'}
                    </span>
                    <span className="tr-text">{line.text}</span>
                  </div>
                ))
              ) : (
                <div className="drawer-state" style={{ padding: '20px 0' }}>
                  Transcript not available for this call.<br />
                  <small>Future calls will save transcripts automatically.</small>
                </div>
              )}
            </div>
          )}

          {tab === 'events' && (
            <div className="drawer-events">
              {(detail.events || []).map((ev, i) => (
                <div key={i} className={`ev-row ev-${ev.type}`}>
                  <span className="ev-time">{ev.ts?.slice(11, 19)}</span>
                  <span className="ev-type">{ev.type}</span>
                  {ev.tool && <span className="ev-tool">{ev.tool}</span>}
                  {ev.type === 'tool_response' && (
                    <span className={`ev-badge ${ev.success ? 'ev-ok' : 'ev-fail'}`}>
                      {ev.success ? '✓' : '✗'} {ev.durationMs}ms
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'session' && (
            <div className="drawer-session">
              <pre>{JSON.stringify(detail.finalSession, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MetaItem({ label, value }) {
  return (
    <div className="meta-item">
      <span className="meta-label">{label}</span>
      <span className="meta-value">{String(value ?? '—')}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const FILTERS = ['all', 'inbound', 'outbound', 'transferred'];

export default function CallLogs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [calls,        setCalls]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [filter,       setFilter]       = useState('all');
  const [search,       setSearch]       = useState('');
  const [selectedSid,  setSelectedSid]  = useState(searchParams.get('sid') || null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await callApi.getHistory(200);
      setCalls(res.calls || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const sid = searchParams.get('sid');
    if (sid) setSelectedSid(sid);
  }, [searchParams]);

  const openDetail = (sid) => { setSelectedSid(sid); setSearchParams({ sid }); };
  const closeDetail = ()   => { setSelectedSid(null); setSearchParams({}); };

  const visible = calls.filter(c => {
    if (filter === 'inbound'     && c.Direction !== 'inbound')       return false;
    if (filter === 'outbound'    && c.Direction !== 'outbound')      return false;
    if (filter === 'transferred' && c.RoutedTo  !== 'human_support') return false;
    if (search) {
      const hay = `${c.CallerPhone} ${c.CallerName || ''} ${c.AgentID || ''} ${c.CallSummary || ''}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className={`cl-layout ${selectedSid ? 'cl-layout--split' : ''}`}>
      {/* Table panel */}
      <div className="cl-panel">
        <div className="cl-head">
          <div className="cl-head-top">
            <div>
              <h1 className="page-title">Call History</h1>
              <p className="page-subtitle">{calls.length} total · showing {visible.length}</p>
            </div>
            <button className="btn btn-secondary" onClick={load} disabled={loading}>
              {loading ? '…' : '↺ Refresh'}
            </button>
          </div>

          <div className="cl-toolbar">
            <input className="form-input cl-search" placeholder="Search phone, name, agent, summary…"
              value={search} onChange={e => setSearch(e.target.value)} />
            <div className="cl-filters">
              {FILTERS.map(f => (
                <button key={f} className={`cl-filter ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}>
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="cl-state">Loading calls…</div>
        ) : visible.length === 0 ? (
          <div className="cl-state">No calls match the current filter.</div>
        ) : (
          <div className="cl-table-wrap">
            <table className="cl-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Caller</th>
                  <th>Dir</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Agent</th>
                  <th>Routed</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(c => (
                  <tr key={c.CallID}
                    className={`cl-row ${selectedSid === c.TwilioCallSID ? 'cl-row--active' : ''}`}
                    onClick={() => openDetail(c.TwilioCallSID)}>
                    <td className="td-mono">{fmtTime(c.CallStartedAt)}</td>
                    <td>
                      <div className="td-phone">{c.CallerPhone}</div>
                      {c.CallerName && <div className="td-name">{c.CallerName}</div>}
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
                    <td className="td-name">{c.AgentID || '—'}</td>
                    <td>
                      {c.RoutedTo === 'human_support'
                        ? <span className="badge badge-warning">Human</span>
                        : <span className="td-name">{c.RoutedTo || '—'}</span>}
                    </td>
                    <td className="td-summary">
                      {c.CallSummary ? c.CallSummary.slice(0, 90) + (c.CallSummary.length > 90 ? '…' : '') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {selectedSid && (
        <DetailDrawer callSid={selectedSid} onClose={closeDetail} />
      )}
    </div>
  );
}
