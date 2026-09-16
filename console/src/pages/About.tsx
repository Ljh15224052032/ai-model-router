// 关于/更多：作者简介、GitHub 入口、开源赞助
import type { ReactNode } from 'react';
import { Coffee, ExternalLink } from 'lucide-react';
import { Card } from '../components/ui';

const GITHUB_HOME = 'https://github.com/Ljh15224052032';
const GITHUB_REPO = 'https://github.com/Ljh15224052032/ai-model-router';
// 爱发电：默认公开主页，可用 console/.env 的 VITE_AFDIAN_URL 覆盖
const DEFAULT_AFDIAN = 'https://ifdian.net/a/aikaid666';
const AFDIAN_URL = import.meta.env.VITE_AFDIAN_URL || DEFAULT_AFDIAN;
// GitHub Sponsors 需海外/香港收款主体（Stripe HK）落地后启用：
// const SPONSOR_GITHUB = 'https://github.com/sponsors/Ljh15224052032';

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel2 px-3 py-2 text-[13px] font-medium text-ink transition-all duration-150 hover:border-accent hover:text-accent active:scale-[0.98]"
    >
      {children}
    </a>
  );
}

export function About() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-ink">关于 / About</h1>
        <p className="mt-1 text-xs text-dim">AI Router 的开发者信息与开源支持入口。</p>
      </div>

      <div className="space-y-4">
        <Card title="关于作者">
          <p className="text-sm leading-relaxed text-ink">
            <span className="font-medium">AIKaid</span>，独立开发爱好者，对 AI 应用与游戏开发感兴趣。欢迎到我的 GitHub 参观。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <External href={GITHUB_REPO}>
              <ExternalLink size={14} /> 项目仓库
            </External>
            <External href={GITHUB_HOME}>
              <ExternalLink size={14} /> 我的主页
            </External>
          </div>
        </Card>

        <Card title="开源赞助">
          <p className="text-sm leading-relaxed text-ink">
            如果这个工具节省了你的成本或时间，欢迎支持一下，你的打赏会激励我持续维护与开发。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <External href={AFDIAN_URL}>
              <Coffee size={14} /> 爱发电支持
            </External>
          </div>
        </Card>
      </div>
    </div>
  );
}