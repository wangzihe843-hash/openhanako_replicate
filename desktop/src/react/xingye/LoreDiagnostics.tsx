import { useState } from 'react';
import {
  buildXingyeRuntimeLoreContext,
  buildXingyeStableLoreMemoryContext,
  type XingyeLoreDecision,
} from '../../../../shared/xingye-lore-context.js';
import { collectXingyeLoreRuntimeContext } from './xingye-lore-runtime-context';
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
  const stableResult = buildXingyeStableLoreMemoryContext({ entries, agentId, maxChars: budget, onDecision: (row) => stable.push(row) });
  const keywordResult = buildXingyeRuntimeLoreContext({ entries, agentId, userText: query, maxChars: budget, onDecision: (row) => keyword.push(row) });
  // One immutable snapshot feeds all three paths; no persistence reads or writes during preview.
  const snapshot = JSON.stringify(Object.fromEntries(entries.filter((entry) => entry.agentId === agentId).map((entry) => [entry.id, entry])));
  const desktopResult = collectXingyeLoreRuntimeContext(agentId, {
    queryText: query, maxChars: budget, onDecision: (row) => desktop.push(row),
  }, { getItem: (key) => key === XINGYE_LORE_ENTRIES_STORAGE_KEY ? snapshot : null, setItem: () => {} });
  const paths = [
    { label: '共享始终设定选择器', rows: stable, used: stableResult.text.length, unit: '含标题、说明与分隔符' },
    { label: '共享关键词选择器', rows: keyword, used: keywordResult.text.length, unit: '含标题、说明与分隔符' },
    { label: '桌面通用选择器', rows: desktop, used: desktopResult.totalChars, unit: '仅条目块；不含外层标题与块间分隔符' },
  ];
  return (
    <details className={styles.panel}>
      <summary>设定选择诊断（模拟预览）</summary>
      <p>用已保存设定比较同一输入下的三条选择路径。这里不是最后一次模型请求记录：实际调用还可能使用最近消息、独立预算、分类优先及插入模式开关。</p>
      <div className={styles.fields}>
        <label>诊断查询文本<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入本轮话题或关键词" /></label>
        <label>各路径字符预算<input type="number" min={0} max={20000} value={budget} onChange={(event) => setBudget(Math.min(20000, Math.max(0, Math.floor(Number(event.target.value) || 0))))} /></label>
      </div>
      <p>预算是字符数，不是 token。共享路径可能截断正文；桌面通用路径跳过过大条目后继续选择。三项预算分别计算，不相加作为真实请求总预算。</p>
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
