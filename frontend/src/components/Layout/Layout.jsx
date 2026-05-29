import { NavLink, Outlet } from 'react-router-dom';
import './Layout.css';

const navItems = [
  { to: '/', label: 'Dashboard', icon: '◉', end: true },
  { to: '/call-logs', label: 'Call Logs', icon: '☎' },
  { to: '/agents', label: 'Agents', icon: '👤' },
  { to: '/live-logs', label: 'Live Logs', icon: '⬤' },
];

export default function Layout() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">🤖</span>
          <div>
            <div className="brand-name">AI Call System</div>
            <div className="brand-sub">Culture Holidays</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(({ to, label, icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `nav-item ${isActive ? 'nav-item--active' : ''}`}
            >
              <span className="nav-icon">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot" />
          System Online
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
