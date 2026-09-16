// 布局：左侧导航 + 主内容（页面切换淡入动效 + 明暗主题切换）
import { Activity, FlaskConical, FileCog, Gauge, Info, ListOrdered, Moon, Package, Settings, Sun } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { getTheme, toggleTheme } from '../lib/theme';
import { UsageIndicator } from './usage';

const nav = [
  { to: '/', label: '仪表盘', icon: Gauge, end: true },
  { to: '/policies', label: '路由方案', icon: FileCog },
  { to: '/models', label: '模型库', icon: Package },
  { to: '/logs', label: '请求日志', icon: ListOrdered },
  { to: '/debug', label: '路由调试', icon: FlaskConical },
  { to: '/settings', label: '设置', icon: Settings },
  { to: '/about', label: '关于', icon: Info },
];

function ThemeButton() {
  const [mode, setMode] = useState(getTheme());
  return (
    <button
      type="button"
      title={mode === 'dark' ? '切换到浅色' : '切换到深色'}
      onClick={() => {
        toggleTheme();
        setMode(getTheme());
      }}
      className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-dim transition-all duration-150 hover:bg-panel2 hover:text-ink active:scale-95"
    >
      {mode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

export function Layout() {
  const location = useLocation();
  return (
    <div className="flex h-screen">
      <aside className="relative z-50 flex w-52 shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 px-4 py-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-dim shadow-[var(--glow)]">
            <Activity size={15} className="text-accent-contrast" />
          </div>
          <span className="font-mono text-[15px] font-semibold tracking-[-0.01em] text-ink">AI Router</span>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium tracking-[-0.006em] transition-all duration-150 ${
                  isActive ? 'bg-accent-soft text-accent' : 'text-dim hover:bg-panel2 hover:text-ink active:scale-[0.98]'
                }`
              }
            >
              <Icon size={15} className="shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
        <UsageIndicator />
        <div className="flex items-center justify-between border-t border-line px-4 py-3">
          <span className="font-mono text-xs text-dim/70">v0.1 · 本机</span>
          <ThemeButton />
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div key={location.pathname} className="h-full animate-page-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
