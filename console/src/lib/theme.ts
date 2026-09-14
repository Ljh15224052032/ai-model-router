// 主题状态：亮/暗切换 + 持久化 + 订阅（图表等非 React 场景联动）
export type ThemeMode = 'light' | 'dark';

const KEY = 'ai-router-theme';

function initial(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark'; // 默认暗色（黑紫格调）
}

let mode: ThemeMode = initial();
const listeners = new Set<(m: ThemeMode) => void>();

export function getTheme(): ThemeMode {
  return mode;
}

export function setTheme(m: ThemeMode) {
  mode = m;
  localStorage.setItem(KEY, m);
  apply(m);
  listeners.forEach((f) => f(m));
}

export function toggleTheme() {
  setTheme(mode === 'dark' ? 'light' : 'dark');
}

export function onThemeChange(f: (m: ThemeMode) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function apply(m: ThemeMode) {
  document.documentElement.classList.toggle('dark', m === 'dark');
}

// 模块加载即生效（首屏无闪烁）
apply(mode);