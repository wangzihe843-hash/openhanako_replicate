import { useState } from 'react';
import {
  selectXingyeLoreEntries,
  type XingyeLoreDecision,
} from '../../../../shared/xingye-lore-context.js';
import { collectXingyeLoreRuntimeContext, formatXingyeLoreRuntimeBudgetBlock } from './xingye-lore-runtime-context';
import { XINGYE_LORE_ENTRIES_STORAGE_KEY, type XingyeLoreEntry } from './xingye-lore-store';
import styles from './LoreDiagnostics.module.css';

const REASONS: Record<XingyeLoreDecision['reason'], string> = {
  selected: '完整选入', truncated: '截断选入：预算不足', budget: '排除：预算不足',
  disabled: '排除：未启用', visibility: '排除：私有备注或草稿', mode: '排除：本路径不使用此插入模式',
  empty: '排除：正文为空', 'no-keywords': '排除：未配置关键词', 'no-query': '排除：未提供查询文本',
  'no-match': '排除：关键词未命中',
};

export function LoreDiagnostics({ agentId, entries }: { agentId: string; entries: XingyeLoreEntry[] }) {
  const [query, setQuery] = useState('');
  const [budget, setBudget] = useState(2000);
  const stable: XingyeLoreDecision[] = [];
  const keyword: XingyeLoreDecision[] = [];
  const desktop: XingyeLoreDecision[] = [];
  const formatBlock = formatXingyeLoreRuntimeBudgetBlock;
  const compose = (blocks: string[]) => blocks.join('\n');
  const stableResult = selectXingyeLoreEntries({ entries, agentId, mode: 'always', maxChars: budget, formatBlock, compose, onDecision: (row) => stable.push(row) });
  const keywordResult = selectXingyeLoreEntries({ entries, agentId, mode: 'keyword', queryText: query, maxChars: budget, formatBlock, compose, onDecision: (row) => keyword.push(row) });
  // One immutable snapshot feeds all three paths; no persistence reads or writes during preview.
  const snapshot = JSON.stringify(Object.fromEntries(entries.filter((entry) => entry.agentId === agentId).map((entry) => [entry.id, entry])));
  const desktopResult = collectXingyeLoreRuntimeContext(agentId, {
    queryText: query, maxChars: budget, onDecision: (row) => desktop.push(row),
  }, { getItem: (key) => key === XINGYE_LORE_ENTRIES_STORAGE_KEY ? snapshot : null, setItem: () => {} });
  const paths = [
    { label: '共享始终设定选择器', rows: stable, used: stableResult.usedChars, unit: '统一条目预算' },
    { label: '共享关键词选择器', rows: keyword, used: keywordResult.usedChars, unit: '统一条目预算' },
    { label: '桌面通用选择器', rows: desktop, used: desktopResult.selectionChars, unit: '统一条目预算' },
  ];
  return (
    <details className={styles.panel}>
      <summary>设定选择诊断（模拟预览）</summary>
      <p>用已保存设定预览同一选择规则在不同插入模式下的结果。这里不是最后一次模型请求记录：实际调用还可能使用最近消息、独立预算、分类优先及插入模式开关。</p>
      <div className={styles.fields}>
        <label>诊断查询文本<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入本轮话题或关键词" /></label>
        <label>各路径条目字符预算<input type="number" min={0} max={20000} value={budget} onChange={(event) => setBudget(Math.min(20000, Math.max(0, Math.floor(Number(event.target.value) || 0))))} /></label>
      </div>
      <p>预算是字符数，不是 token。过大的条目先让位给可完整选入的短条目，再尝试用剩余空间截断一条。外层标题另计；三项预算分别计算，不相加作为真实请求总预算。</p>
      {paths.map((path) => (
        <section key={path.label} aria-label={path.label} className={styles.path}>
          <h4>{path.label}</h4>
          <p>已用 {path.used} / {budget} 字符（{path.unit}）；选入 {path.rows.filter((row) => row.reason === 'selected' || row.reason === 'truncated').length} 条。</p>
          {path.rows.length ? <ul>{path.rows.map((row) => (
            <li key={row.id}>
              <strong>{row.title}</strong>：{REASONS[row.reason]}
              {row.matchedKeywords.length > 0 && <span>；命中：{row.matchedKeywords.join('、')}</span>}
              {row.blockChars > 0 && <span>；条目块 {row.blockChars} 字符</span>}
            </li>
          ))}</ul> : <p>当前角色没有已保存设定。</p>}
        </section>
      ))}
    </details>
  );
}
