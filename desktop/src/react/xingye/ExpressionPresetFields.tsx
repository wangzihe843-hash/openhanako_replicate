import { useId } from 'react';
import {
  XINGYE_EXPRESSION_GROUPS,
  normalizeXingyeExpressionPresets,
  resolveXingyeExpressionPresets,
  type XingyeExpressionPresets,
} from '../../../../shared/xingye-expression-presets';
import styles from './XingyeExpressionControls.module.css';

export function ExpressionPresetFields({ value, onChange, mode = 'preset', disabled = false }: {
  value: XingyeExpressionPresets;
  onChange: (value: XingyeExpressionPresets) => void;
  mode?: 'preset' | 'scene';
  disabled?: boolean;
}) {
  const id = useId();
  const normalized = normalizeXingyeExpressionPresets(value);
  return <div className={styles.fields}>
    {XINGYE_EXPRESSION_GROUPS.map(group => <label key={group.key} htmlFor={`${id}-${group.key}`}>
      {mode === 'scene' ? '临时' : ''}{group.label}
      <select id={`${id}-${group.key}`} disabled={disabled} value={normalized[group.key] ?? ''}
        onChange={event => onChange(normalizeXingyeExpressionPresets({ ...normalized, [group.key]: event.target.value }))}>
        <option value="">{mode === 'scene' ? '沿用会话预设' : '沿用角色设定'}</option>
        {group.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>)}
  </div>;
}

export function EffectiveExpressionPresets({ presets, overrides }: {
  presets: XingyeExpressionPresets;
  overrides?: XingyeExpressionPresets;
}) {
  return <ul className={styles.effective} aria-label="当前有效表达配置">
    {resolveXingyeExpressionPresets(presets, overrides).map(row => <li key={row.key}>
      {row.label}：{row.valueLabel} · {row.source === 'scene' ? '来源：临时场景覆盖' : row.source === 'preset' ? '来源：会话预设' : '来源：角色设定'}
    </li>)}
  </ul>;
}
