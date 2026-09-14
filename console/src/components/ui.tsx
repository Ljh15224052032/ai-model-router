// UI 原语（Tailwind，OKLCH 双主题）：苹果风基底 + 克制动效
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

export function Card({ title, action, children, className = '', hoverable = false }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; hoverable?: boolean }) {
  return (
    <div
      className={`rounded-xl border border-line bg-panel shadow-[var(--shadow-card)] p-5 transition-all duration-200 ${
        hoverable ? 'hover:-translate-y-0.5 hover:shadow-[var(--shadow-pop)] hover:border-accent/30' : ''
      } ${className}`}
    >
      {title &&
        (action ? (
          <div className="mb-3.5 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium tracking-[-0.01em] text-ink">{title}</h3>
            {action}
          </div>
        ) : (
          <h3 className="mb-3.5 text-sm font-medium tracking-[-0.01em] text-ink">{title}</h3>
        ))}
      {children}
    </div>
  );
}

export function Button({
  children, onClick, variant = 'primary', disabled, type = 'button',
}: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium tracking-[-0.006em] transition-all duration-150 active:scale-[0.97] disabled:opacity-45 disabled:pointer-events-none select-none';
  const styles = {
    primary: 'bg-accent text-accent-contrast shadow-[var(--glow)] hover:bg-accent-dim',
    ghost: 'border border-line bg-transparent text-ink hover:bg-panel2 hover:border-dim/40',
    danger: 'border border-err/35 bg-transparent text-err hover:bg-err/10',
  }[variant];
  return (
    <button type={type} className={`${base} ${styles}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Input({ value, onChange, placeholder, className = '', type = 'text', onBlur }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; type?: string; onBlur?: () => void }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-line bg-panel2 px-3 py-1.5 text-sm text-ink placeholder:text-dim/50 outline-none transition-all duration-150 focus:border-accent/60 ${className}`}
    />
  );
}

// 下拉选择：Radix Select 无头组件 + token 样式（原生弹出列表是 OS 渲染的，无法定制，故替换）
// API 保持 { value, onChange, options } 不变；Radix 禁止空 value，空串映射哨兵 '__ALL__'
const ALL = '__ALL__';

export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <SelectPrimitive.Root
      value={value === '' ? ALL : value}
      onValueChange={(v) => onChange(v === ALL ? '' : v)}
    >
      <SelectPrimitive.Trigger className="select-trigger group inline-flex min-w-0 items-center justify-between gap-1.5 whitespace-nowrap rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-sm text-ink outline-none transition-all duration-150 hover:border-dim/40 hover:text-ink focus:border-accent/40 data-[state=open]:border-accent/40 data-[state=open]:bg-accent-soft/50">
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown size={13} className="shrink-0 text-dim transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          data-select-content=""
          className="z-50 min-w-[var(--radix-select-trigger-width)] rounded-lg border border-line bg-panel p-1 shadow-[var(--shadow-pop)]"
        >
          <SelectPrimitive.Viewport className="max-h-56 overflow-y-auto">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value === '' ? ALL : o.value}
                value={o.value === '' ? ALL : o.value}
                className="flex cursor-pointer select-none items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent data-[state=checked]:font-medium"
              >
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check size={13} className="shrink-0 text-accent" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Tag({ children, color = 'accent', title }: { children: ReactNode; color?: 'accent' | 'ok' | 'warn' | 'err' | 'dim'; title?: string }) {
  const map = {
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-ok/12 text-ok',
    warn: 'bg-warn/12 text-warn',
    err: 'bg-err/12 text-err',
    dim: 'bg-panel2 text-dim border border-line',
  }[color];
  return <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${map}`}>{children}</span>;
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
        checked ? 'bg-accent' : 'border border-line bg-panel2'
      }`}
    >
      <span
        className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-all duration-200 ease-[cubic-bezier(0.34,1.4,0.64,1)] ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

export function StatCard({ label, value, sub, color }: { label: string; value: ReactNode; sub?: string; color?: string }) {
  return (
    <div className="group rounded-xl border border-line bg-panel p-5 shadow-[var(--shadow-card)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-pop)]">
      <div className="text-xs text-dim">{label}</div>
      <div className="tnum mt-1.5 text-[26px] font-semibold leading-none tracking-[-0.02em]" style={{ color: color ?? undefined }}>
        {value}
      </div>
      {sub && <div className="mt-1.5 text-xs text-dim/80">{sub}</div>}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="py-12 text-center text-sm text-dim">{text}</div>;
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />;
}
