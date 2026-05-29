import { useEffect, useRef, useState, useCallback } from 'react';
import { API_ORIGIN_EXPORT } from '../../services/api';
import './LiveLogs.css';

const LEVEL_ORDER = ['all', 'info', 'warn', 'error'];

const LEVEL_CLASS = {
  error:  'log-error',
  warn:   'log-warn',
  info:   'log-info',
  debug:  'log-debug',
  system: 'log-system',
  http:   'log-http',
};

function formatMeta(entry) {
  const skip = new Set(['level', 'message', 'timestamp', 'service']);
  const pairs = Object.entries(entry)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
  return pairs;
}

export default function LiveLogs() {
  const [logs, setLogs]           = useState([]);
  const [filter, setFilter]       = useState('all');
  const [search, setSearch]       = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [status, setStatus]       = useState('connecting');
  const bottomRef     = useRef(null);
  const esRef         = useRef(null);
  const reconnectRef  = useRef(null);

  const connect = useCallback(() => {
    if (esRef.current) esRef.current.close();
    setStatus('connecting');

    const url = `${API_ORIGIN_EXPORT}/api/logs/stream`;
    const es  = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setStatus('connected');

    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        setLogs(prev => {
          const next = [...prev, { ...entry, id: Date.now() + Math.random() }];
          return next.length > 2000 ? next.slice(-2000) : next; // keep last 2000 lines
        });
      } catch {}
    };

    es.onerror = () => {
      setStatus('disconnected');
      es.close();
      reconnectRef.current = setTimeout(connect, 3000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      esRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, autoScroll]);

  const visible = logs.filter(entry => {
    if (filter !== 'all' && entry.level !== filter) return false;
    if (search) {
      const hay = `${entry.message} ${formatMeta(entry)}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="live-logs">
      {/* ── Toolbar ── */}
      <div className="ll-toolbar">
        <div className="ll-toolbar-left">
          <span className={`ll-status ll-status--${status}`}>
            <span className="ll-status-dot" />
            {status === 'connected'    ? 'Live'         :
             status === 'connecting'   ? 'Connecting…'  : 'Reconnecting…'}
          </span>
          <span className="ll-count">{visible.length} lines</span>
        </div>

        <div className="ll-toolbar-right">
          <input
            className="ll-search"
            placeholder="Search logs…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <div className="ll-filters">
            {LEVEL_ORDER.map(l => (
              <button
                key={l}
                className={`ll-filter ll-filter--${l} ${filter === l ? 'active' : ''}`}
                onClick={() => setFilter(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>

          <button
            className={`ll-btn ${autoScroll ? 'll-btn--active' : ''}`}
            onClick={() => setAutoScroll(v => !v)}
            title="Toggle auto-scroll"
          >
            ↓ Auto
          </button>

          <button
            className="ll-btn ll-btn--danger"
            onClick={() => setLogs([])}
          >
            Clear
          </button>
        </div>
      </div>

      {/* ── Log output ── */}
      <div className="ll-output">
        {visible.length === 0 && (
          <div className="ll-empty">
            {status === 'connected' ? 'Waiting for logs…' : 'Connecting to log stream…'}
          </div>
        )}

        {visible.map(entry => {
          const meta = formatMeta(entry);
          const time = entry.timestamp ? entry.timestamp.slice(11, 19) : '';
          const cls  = LEVEL_CLASS[entry.level] || 'log-info';
          return (
            <div key={entry.id} className={`ll-line ${cls}`}>
              <span className="ll-time">{time}</span>
              <span className="ll-level">{(entry.level || '').toUpperCase().padEnd(5)}</span>
              <span className="ll-msg">{entry.message}</span>
              {meta && <span className="ll-meta">{meta}</span>}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
