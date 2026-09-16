// 关于/更多：作者简介、GitHub 入口、开源赞助、检测更新
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, Coffee, ExternalLink } from 'lucide-react';
import { Card } from '../components/ui';

// vite define 注入的当前版本号（取自 console/package.json 的 version）
declare const __APP_VERSION__: string;

const CURRENT_VERSION: string = __APP_VERSION__;
const GITHUB_HOME = 'https://github.com/Ljh15224052032';
const GITHUB_REPO = 'https://github.com/Ljh15224052032/ai-model-router';
// 线上最新版号：GitHub 仓库根目录的 VERSION 文件（raw 免登录读取）
const VERSION_URL =
  'https://raw.githubusercontent.com/Ljh15224052032/ai-model-router/main/VERSION';
// 检测间隔：10 分钟一次（进入 About 页立即检测一次）
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

// 简单 semver 比较：a>b→1，a<b→-1，相等→0
function compareVersions(a: string, b: string): number {
  const toParts = (v: string) =>
    v
      .trim()
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = toParts(a);
  const pb = toParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
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
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    const check = () => {
      fetch(VERSION_URL, { cache: 'no-store' })
        .then((res) => (res.ok ? res.text() : undefined))
        .then((text) => {
          if (text) {
            const v = text.trim();
            if (v && compareVersions(v, CURRENT_VERSION) > 0) {
              setLatest(v);
              return;
            }
          }
          setLatest(null); // 已是最新或读取失败：恢复为不提示
        })
        .catch(() => setLatest(null)); // 离线/失败：静默降级，不报错
    };
    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const hasUpdate = latest !== null;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-ink">关于 / About</h1>
        <p className="mt-1 text-xs text-dim">AI Router 的开发者信息与开源支持入口。</p>
      </div>

      <div className="space-y-4">
        {hasUpdate && (
          <Card title="发现新版本" className="!border-accent/40">
            <p className="text-sm leading-relaxed text-ink">
              当前版本 <span className="font-medium">v{CURRENT_VERSION}</span>
              ，发现新版本 <span className="font-medium text-accent">v{latest}</span>
              。可前往 GitHub 拉取最新代码升级（git pull）。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <External href={GITHUB_REPO}>
                <ArrowUpRight size={14} /> 前往 GitHub 更新
              </External>
            </div>
          </Card>
        )}

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