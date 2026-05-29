import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout/Layout';
import Dashboard from './pages/Dashboard/Dashboard';
import CallLogs from './pages/CallLogs/CallLogs';
import AgentManagement from './pages/AgentManagement/AgentManagement';
import LiveLogs from './pages/LiveLogs/LiveLogs';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="call-logs" element={<CallLogs />} />
        <Route path="agents" element={<AgentManagement />} />
        <Route path="live-logs" element={<LiveLogs />} />
      </Route>
    </Routes>
  );
}
