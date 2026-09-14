// ECharts 取色：运行时从 CSS 变量读取，随主题切换联动
export interface ChartColors {
  axisLine: string;
  splitLine: string;
  label: string;
  accent: string;
  accentSoft: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
}

export function getChartColors(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    axisLine: v('--border'),
    splitLine: v('--border'),
    label: v('--text-dim'),
    accent: v('--accent'),
    accentSoft: v('--accent-soft'),
    tooltipBg: v('--panel'),
    tooltipBorder: v('--border'),
    tooltipText: v('--text'),
  };
}

export function tooltipStyle(c: ChartColors) {
  return {
    backgroundColor: c.tooltipBg,
    borderColor: c.tooltipBorder,
    borderWidth: 1,
    textStyle: { color: c.tooltipText, fontSize: 12 },
    extraCssText: 'border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.12); backdrop-filter:blur(6px);',
  };
}
