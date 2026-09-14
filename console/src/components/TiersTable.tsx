// 档位表编辑器（M8）：8 taskType × 3 complexity 矩阵，每格模型下拉
// 「继承全局默认」开=tiers=null（用 settings.tiers_default_json）；关=编辑本方案档位
import type { Complexity, PolicyTiers, TierEntry } from '../types';
import { ChevronRight } from 'lucide-react';
import { Select, Toggle } from './ui';

const TASK_TYPES: Array<{ value: string; label: string }> = [
  { value: 'chat', label: '聊天' },
  { value: 'code', label: '代码' },
  { value: 'write', label: '写作' },
  { value: 'summarize', label: '总结' },
  { value: 'translate', label: '翻译' },
  { value: 'analyze', label: '分析' },
  { value: 'reason', label: '推理' },
  { value: 'unknown', label: '未知' },
];
const LEVELS: Array<{ value: Complexity; label: string }> = [
  { value: 'low', label: '低' },
  { value: 'mid', label: '中' },
  { value: 'high', label: '高' },
];

// 归一化：保证 8×3 全格有值（缺格用默认模型补），未知格不落 dirty 误报
export function normalizeTiers(t: PolicyTiers | null | undefined, fallbackModel: string): PolicyTiers {
  const entries = t?.entries ?? [];
  const all: TierEntry[] = [];
  for (const tt of TASK_TYPES) {
    for (const lv of LEVELS) {
      const hit = entries.find((e) => e.taskType === tt.value && e.complexity === lv.value);
      all.push(hit ?? { taskType: tt.value, complexity: lv.value, model: fallbackModel });
    }
  }
  return { entries: all };
}

export function TiersTable({ value, onChange, models, title = '档位表', noInherit = false }: {
  value: PolicyTiers | null;
  onChange: (v: PolicyTiers | null) => void;
  models: string[];
  title?: string;
  noInherit?: boolean; // 设置页全局默认：无上层可继承，隐藏开关恒显示矩阵
}) {
  const opts = models.map((m) => ({ value: m, label: m }));
  const inherit = !noInherit && (value === null || value === undefined);
  const table = inherit ? { entries: [] } : (value ?? { entries: [] });
  const setCell = (taskType: string, complexity: Complexity, model: string) => {
    onChange({
      entries: [
        ...table.entries.filter((e) => !(e.taskType === taskType && e.complexity === complexity)),
        { taskType, complexity, model },
      ],
    });
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          {title}
          {/* 流程说明：步骤 chip + 图标箭头（替代裸文字箭头） */}
          <span className="flex items-center gap-1 text-[11px] font-normal text-dim">
            {['规则未命中', '裁判分类', '查表选模型'].map((step, i) => (
              <span key={step} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={11} className="text-dim/50" />}
                <span className="rounded border border-line/70 bg-panel2 px-1.5 py-px">{step}</span>
              </span>
            ))}
          </span>
        </div>
        {!noInherit && (
          <div className="flex items-center gap-2 text-xs text-dim">
            继承全局默认
            <Toggle checked={inherit} onChange={(v) => onChange(v ? null : { entries: [] })} />
          </div>
        )}
      </div>
      {inherit ? (
        <div className="rounded-lg border border-dashed border-line bg-panel p-3 text-xs text-dim">
          本方案使用全局默认档位（设置页可改）；关闭开关可为本方案单独配置
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-panel2">
          <table className="w-full min-w-[480px] table-fixed text-xs">
            <thead>
              <tr className="border-b border-line text-left text-dim">
                <th className="w-[92px] whitespace-nowrap px-3 py-2 font-normal">任务类型</th>
                {LEVELS.map((lv) => (
                  <th key={lv.value} className="whitespace-nowrap px-2 py-2 text-center font-normal">{lv.label}复杂度</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TASK_TYPES.map((tt) => {
                const row = table.entries;
                return (
                  <tr key={tt.value} className="border-b border-line/60 last:border-0">
                    <td className="whitespace-nowrap px-3 py-1.5 text-dim">{tt.label}</td>
                    {LEVELS.map((lv) => {
                      const cur = row.find((e) => e.taskType === tt.value && e.complexity === lv.value);
                      return (
                        <td key={lv.value} className="px-2 py-1.5 text-center">
                          <Select
                            value={cur?.model ?? ''}
                            onChange={(v) => setCell(tt.value, lv.value, v)}
                            options={cur?.model ? opts : [{ value: '', label: '—' }, ...opts]}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
