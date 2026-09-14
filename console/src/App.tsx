import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { Debug } from './pages/Debug'
import { Logs } from './pages/Logs'
import { Models } from './pages/Models'
import { Policies } from './pages/Policies'
import { Settings } from './pages/Settings'
import './App.css'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/models" element={<Models />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/debug" element={<Debug />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App