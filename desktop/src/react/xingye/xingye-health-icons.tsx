/**
 * xingye-health-icons.tsx — 健康模块内部用的线条图标。
 * SVG path 直接取自设计稿原型 icons.jsx（心率心电融合 / 双鞋印 / 月牙 / 情绪脸 / 建议气泡）。
 */

export interface HealthModuleIconProps {
  size?: number;
  color?: string;
  /** stroke width。 */
  sw?: number;
}

/** 心率：心形轮廓 + 心电波。 */
export function ModuleHeart({ size = 24, color = '#fff', sw = 1.8 }: HealthModuleIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16 26 C9 22, 5 17.5, 5 13 C5 10, 7 7.5, 10 7.5 C12.5 7.5, 14.5 9, 16 11.5 C17.5 9, 19.5 7.5, 22 7.5 C25 7.5, 27 10, 27 13 C27 14, 26.8 14.8, 26.5 15.6"
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 18 L12 18 L13.5 14.5 L15.5 21 L17 17.5 L18.5 19 L20 16.5 L21.5 18 L24 18"
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 步数：两只对脚鞋印，轻微内八。 */
export function ModuleSteps({ size = 24, color = '#fff', sw = 1.8 }: HealthModuleIconProps) {
  const print = (
    <>
      <path
        d="M3 0 C5 0, 6.6 1.8, 6.6 4.2 C6.6 6.4, 5.6 8.4, 4.6 10 C4 11, 3 11, 2.4 10 C1.4 8.4, 0.4 6.4, 0.4 4.2 C0.4 1.8, 1.5 0, 3 0 Z"
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      <ellipse cx="3" cy="13.6" rx="2.3" ry="2" fill="none" stroke={color} strokeWidth={sw} />
    </>
  );
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <g transform="translate(8 6) rotate(-14 4 9)">{print}</g>
      <g transform="translate(18 14) rotate(14 4 9)">{print}</g>
    </svg>
  );
}

/** 睡眠：月牙 + 星。 */
export function ModuleSleep({ size = 24, color = '#fff', sw = 1.8 }: HealthModuleIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M23 20A9 9 0 1 1 12 8.5a7 7 0 0 0 11 11.5z"
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M22 8l1.2 2.2L25.5 11l-2.3.8L22 14l-1.2-2.2L18.5 11l2.3-.8z" fill={color} />
      <circle cx="26" cy="16" r="0.9" fill={color} />
    </svg>
  );
}

export interface ModuleStressIconProps extends HealthModuleIconProps {
  /** low → 笑脸；mid → 中性；high → 担忧哭脸。 */
  level?: 'low' | 'mid' | 'high';
}

/** 压力：情绪脸，按 level 切笑/中性/哭。 */
export function ModuleStress({ size = 24, color = '#fff', sw = 1.8, level = 'mid' }: ModuleStressIconProps) {
  const isHigh = level === 'high';
  const isLow = level === 'low';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="10" fill="none" stroke={color} strokeWidth={sw} />
      {isHigh ? (
        <>
          <path d="M11 13 L14 14.2" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <path d="M21 13 L18 14.2" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="12.5" cy="13.5" r={sw * 0.7} fill={color} />
          <circle cx="19.5" cy="13.5" r={sw * 0.7} fill={color} />
        </>
      )}
      {isLow && (
        <path d="M11.5 19 Q16 22.5 20.5 19" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />
      )}
      {isHigh && (
        <path d="M11.5 21 Q16 17.5 20.5 21" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />
      )}
      {!isLow && !isHigh && (
        <path d="M12 20 L20 20" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />
      )}
    </svg>
  );
}

/** 建议：对话气泡 + 闪光。 */
export function ModuleAdvice({ size = 24, color = '#fff', sw = 1.8 }: HealthModuleIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M5 11 C5 8.5, 7 7, 9 7 H23 C25 7, 27 8.5, 27 11 V19 C27 21.5, 25 23, 23 23 H14 L9 27 V23 C7 23, 5 21.5, 5 19 Z"
        fill="none"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M16 11 L17 14 L20 15 L17 16 L16 19 L15 16 L12 15 L15 14 Z" fill={color} />
      <circle cx="22" cy="12" r="0.8" fill={color} />
      <circle cx="11" cy="19" r="0.7" fill={color} />
    </svg>
  );
}
