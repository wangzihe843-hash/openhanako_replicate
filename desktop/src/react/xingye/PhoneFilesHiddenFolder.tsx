import { useEffect, useState, type CSSProperties } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import type {
  XingyeHiddenFileEntry,
  XingyeHiddenFolderState,
} from './xingye-files-secret-store';
import {
  HIDDEN_FOLDER_REACTION_POOLS,
  getWrongPasswordReaction,
} from './xingye-files-secret-reactions';

/**
 * 隐藏文件夹 UI 子组件集合。
 *
 * 这些组件不持有数据状态——业务状态全部由 PhoneFilesApp 顶层控制；
 * 这里只负责渲染（行 / 弹窗 / 详情）。这样 PhoneFilesApp 的 reload 路径
 * 仍然单点，子组件可以单独被测试。
 */

const HIDDEN_TINT = '#3a3a44';
const HIDDEN_TINT_BG = 'rgba(58, 58, 68, 0.12)';
const HIDDEN_TINT_BORDER = 'rgba(58, 58, 68, 0.35)';

function LockGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      fill="none"
      stroke={HIDDEN_TINT}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5" y="11" width="14" height="9" rx="1.8" />
      {open ? (
        <path d="M8 11V8a4 4 0 0 1 7.5-2" />
      ) : (
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      )}
      <circle cx="12" cy="15.5" r="1.1" fill={HIDDEN_TINT} stroke="none" />
    </svg>
  );
}

export interface HiddenFolderRowProps {
  hiddenState: XingyeHiddenFolderState | null;
  entryCount: number;
  disabled?: boolean;
  onClickLocked: () => void;
  onClickUnlocked: () => void;
  rowClassName: string;
  iconWrapClassName: string;
  mainClassName: string;
  nameClassName: string;
  descClassName: string;
  countClassName: string;
  timeClassName: string;
}

export function HiddenFolderRow(props: HiddenFolderRowProps) {
  const {
    hiddenState,
    entryCount,
    disabled,
    onClickLocked,
    onClickUnlocked,
    rowClassName,
    iconWrapClassName,
    mainClassName,
    nameClassName,
    descClassName,
    countClassName,
    timeClassName,
  } = props;
  const locked = hiddenState?.locked !== false;
  const handle = () => {
    if (disabled) return;
    if (locked) onClickLocked();
    else onClickUnlocked();
  };
  const iconStyle: CSSProperties = {
    background: HIDDEN_TINT_BG,
    border: `1px solid ${HIDDEN_TINT_BORDER}`,
  };
  return (
    <button
      type="button"
      className={rowClassName}
      onClick={handle}
      disabled={disabled}
      data-testid="phone-files-hidden-folder-row"
      data-locked={locked ? 'true' : 'false'}
      aria-label={locked ? '上锁的抽屉' : '已解锁的抽屉'}
    >
      <span className={iconWrapClassName} style={iconStyle}>
        <LockGlyph open={!locked} />
      </span>
      <span className={mainClassName}>
        <span className={nameClassName}>
          {locked ? '???' : '抽屉最底层'}
        </span>
        <span className={descClassName}>
          {locked
            ? '只有 TA 自己知道密码。'
            : entryCount > 0
              ? '已解锁——TA 不想被看见的小事。'
              : '已解锁，但还是空的。'}
        </span>
      </span>
      <span className={countClassName}>{locked ? '🔒' : entryCount > 0 ? entryCount : '—'}</span>
      <span className={timeClassName}>
        {locked ? '上锁' : '已开'}
      </span>
    </button>
  );
}

// ─── 密码弹窗 ────────────────────────────────────────────────────────────

export interface HiddenPasswordModalProps {
  agent: Agent | null;
  profile: XingyeRoleProfile | null | undefined;
  busy: boolean;
  error: string | null;
  /** UI 暂存的尝试次数；用来决定反应文案的语气。 */
  attemptCount: number;
  /** 上一次输错的反应文案；交给上层管理，重渲染时不会消失。 */
  lastReaction: string | null;
  /** 是否在抖动（输错时触发，动效 500ms 后由上层清掉）。 */
  shaking: boolean;
  onClose: () => void;
  onSubmit: (attempt: string) => void;
}

export function HiddenPasswordModal(props: HiddenPasswordModalProps) {
  const { agent, profile, busy, error, attemptCount, lastReaction, shaking, onClose, onSubmit } = props;
  const [input, setInput] = useState('');
  const agentName = profile?.displayName?.trim() || agent?.name || 'TA';

  useEffect(() => {
    /** 弹窗每次重开都清空输入框。 */
    setInput('');
  }, []);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setInput('');
  };

  const sheetStyle: CSSProperties = {
    animation: shaking ? 'xyHiddenShake 0.45s linear 1' : undefined,
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 30,
      }}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <style>{`@keyframes xyHiddenShake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-8px)} 40%{transform:translateX(7px)} 60%{transform:translateX(-5px)} 80%{transform:translateX(3px)} }`}</style>
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-files-hidden-modal-title"
        data-testid="phone-files-hidden-modal"
        style={{
          ...sheetStyle,
          background: '#fbf7ef',
          color: '#2b2b30',
          width: 'min(320px, 90%)',
          borderRadius: 18,
          padding: '20px 22px',
          boxShadow: '0 16px 36px rgba(0, 0, 0, 0.3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <LockGlyph open={false} />
          <h3
            id="phone-files-hidden-modal-title"
            style={{ margin: 0, fontSize: 16, fontWeight: 600 }}
          >
            抽屉上锁了
          </h3>
        </header>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: '#5b5b66' }}>
          {agentName} 在这里放了不想让人看见的东西。试着想想 TA 最可能用什么作密码。
        </p>
        {lastReaction ? (
          <p
            role="alert"
            data-testid="phone-files-hidden-reaction"
            style={{
              margin: 0,
              padding: '8px 10px',
              borderLeft: `3px solid ${HIDDEN_TINT}`,
              background: 'rgba(58, 58, 68, 0.06)',
              fontSize: 13,
              fontStyle: 'italic',
              color: '#3a3a44',
            }}
          >
            {lastReaction}
          </p>
        ) : null}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
          <span style={{ color: '#5b5b66' }}>密码</span>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            autoFocus
            autoComplete="off"
            data-testid="phone-files-hidden-password-input"
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(0,0,0,0.2)',
              background: '#fff',
              fontSize: 14,
              outline: 'none',
            }}
          />
        </label>
        {error ? (
          <p style={{ margin: 0, color: '#a13b3b', fontSize: 12 }} role="alert">
            {error}
          </p>
        ) : null}
        <p style={{ margin: 0, fontSize: 11, color: '#8a8a92' }}>
          已尝试 {attemptCount} 次 · 大小写不敏感
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: '1px solid rgba(0,0,0,0.18)',
              background: 'transparent',
              fontSize: 13,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            算了
          </button>
          <button
            type="submit"
            disabled={busy || !input.trim()}
            data-testid="phone-files-hidden-password-submit"
            style={{
              padding: '8px 14px',
              borderRadius: 10,
              border: 'none',
              background: HIDDEN_TINT,
              color: '#fff',
              fontSize: 13,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy || !input.trim() ? 0.6 : 1,
            }}
          >
            {busy ? '验证中…' : '试试'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── 解锁后的内容视图 ────────────────────────────────────────────────────

const KIND_LABEL: Record<XingyeHiddenFileEntry['kind'], string> = {
  weakness: '弱点',
  guilty_pleasure: '不光彩的喜好',
  secret_taste: '说不出口的偏好',
  secret_plan: '不可告人的计划',
  manual: '手记',
};

const KIND_TINT_HEX: Record<XingyeHiddenFileEntry['kind'], string> = {
  weakness: '#a13b3b',
  guilty_pleasure: '#864d5e',
  secret_taste: '#4a5a6a',
  secret_plan: '#6b5a2e',
  manual: '#3a3a44',
};

export interface HiddenFolderViewProps {
  agent: Agent | null;
  profile: XingyeRoleProfile | null | undefined;
  entries: XingyeHiddenFileEntry[];
  hiddenState: XingyeHiddenFolderState | null;
  seedBusy: boolean;
  seedError: string | null;
  onGenerateSeeds: () => void;
  onAddManual: () => void;
  onDelete: (entry: XingyeHiddenFileEntry) => void;
  onRelock: () => void;
  /**
   * 「去和 TA 聊聊」回调。上层把 entry 拼成 stagedChatQuote，sourceKind='secret-drawer'。
   * 不传 → 卡片不渲染按钮（兼容暂未接通的调用方）。
   */
  onShareEntryToChat?: (entry: XingyeHiddenFileEntry) => void;
  /**
   * 当前刚被分享的 entry key，形如 `'hidden:' + entry.id`。
   * 命中时在该卡片下方显示 4s 自动复位的提示。上层 state 控制，4s 后传 null 即可消失。
   */
  sharedEntryKey?: string | null;
  /** 用于按钮文案「去和 X 聊聊这条」的称呼。缺省回退到 agent.name。 */
  displayName?: string;
  /** XingyeShell.module.css 的 className 透传。 */
  scrollClassName: string;
  cardClassName: string;
  titleClassName: string;
  bodyClassName: string;
  footClassName: string;
  emptyClassName: string;
  /** 反馈行（已放进聊天输入框引用）样式。缺省时用 footClassName 兜底。 */
  hintClassName?: string;
}

export function HiddenFolderView(props: HiddenFolderViewProps) {
  const {
    profile,
    agent,
    entries,
    hiddenState,
    seedBusy,
    seedError,
    onGenerateSeeds,
    onAddManual,
    onDelete,
    onRelock,
    onShareEntryToChat,
    sharedEntryKey,
    displayName,
    scrollClassName,
    cardClassName,
    titleClassName,
    bodyClassName,
    footClassName,
    emptyClassName,
    hintClassName,
  } = props;
  const agentName = displayName?.trim() || profile?.displayName?.trim() || agent?.name || 'TA';
  const seedGenerated = hiddenState?.seedGenerated === true;

  return (
    <div className={scrollClassName} data-testid="phone-files-hidden-view">
      <header
        style={{
          padding: '18px 18px 12px',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          background: HIDDEN_TINT_BG,
          borderBottom: `1px solid ${HIDDEN_TINT_BORDER}`,
        }}
        aria-label="抽屉最底层"
      >
        <span
          style={{
            width: 42,
            height: 42,
            borderRadius: 10,
            background: 'rgba(255,255,255,0.6)',
            border: `1px solid ${HIDDEN_TINT_BORDER}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <LockGlyph open />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: HIDDEN_TINT }}>
            抽屉最底层
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#5b5b66' }}>
            {agentName} 不愿意被人翻到的东西 · {entries.length} 条
          </p>
          {hiddenState?.candidateLabel ? (
            <p style={{ margin: '6px 0 0', fontSize: 11, color: '#8a8a92' }} data-testid="phone-files-hidden-hint">
              这次的密码是 {hiddenState.candidateLabel}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRelock}
          data-testid="phone-files-hidden-relock"
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: `1px solid ${HIDDEN_TINT_BORDER}`,
            background: 'transparent',
            fontSize: 12,
            color: HIDDEN_TINT,
            cursor: 'pointer',
          }}
        >
          关上抽屉
        </button>
      </header>

      {entries.length === 0 && !seedBusy ? (
        <div className={emptyClassName} data-testid="phone-files-hidden-empty">
          <p>这里还是空的——但 TA 看起来本来想放东西的。</p>
          {!seedGenerated ? (
            <button
              type="button"
              onClick={onGenerateSeeds}
              data-testid="phone-files-hidden-seed-button"
              style={{
                marginTop: 8,
                padding: '8px 14px',
                borderRadius: 10,
                border: 'none',
                background: HIDDEN_TINT,
                color: '#fff',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              让 TA 自己写几条
            </button>
          ) : (
            <p style={{ marginTop: 8, fontSize: 12, color: '#8a8a92' }}>
              TA 已经写过一次了，剩下的请你自己加。
            </p>
          )}
          {seedError ? (
            <p style={{ marginTop: 8, fontSize: 12, color: '#a13b3b' }} role="alert">
              {seedError}
            </p>
          ) : null}
        </div>
      ) : null}

      {seedBusy ? (
        <p
          className={emptyClassName}
          data-testid="phone-files-hidden-seed-busy"
          style={{ color: '#5b5b66' }}
        >
          TA 正在写……
        </p>
      ) : null}

      {entries.length > 0 ? (
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {entries.map((entry) => (
            <article
              key={entry.id}
              className={cardClassName}
              data-testid={`phone-files-hidden-entry-${entry.id}`}
              style={{
                borderLeft: `3px solid ${KIND_TINT_HEX[entry.kind]}`,
                padding: 12,
              }}
            >
              <header style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: KIND_TINT_HEX[entry.kind],
                    fontWeight: 600,
                    letterSpacing: 0.4,
                  }}
                >
                  {KIND_LABEL[entry.kind]}
                </span>
                <h3 className={titleClassName} style={{ margin: 0, fontSize: 14 }}>
                  {entry.title}
                </h3>
              </header>
              <p className={bodyClassName} style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                {entry.body}
              </p>
              <div className={footClassName} style={{ marginTop: 8, justifyContent: 'flex-end', gap: 8 }}>
                {onShareEntryToChat ? (
                  <button
                    type="button"
                    onClick={() => onShareEntryToChat(entry)}
                    data-testid={`phone-files-hidden-entry-share-${entry.id}`}
                    title={`把这条带到和 ${agentName} 的聊天里`}
                    style={{
                      fontSize: 12,
                      background: 'transparent',
                      border: `1px solid ${HIDDEN_TINT_BORDER}`,
                      borderRadius: 8,
                      padding: '4px 10px',
                      color: HIDDEN_TINT,
                      cursor: 'pointer',
                    }}
                  >
                    去和 {agentName} 聊聊
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onDelete(entry)}
                  data-testid={`phone-files-hidden-entry-delete-${entry.id}`}
                  style={{
                    fontSize: 12,
                    background: 'transparent',
                    border: 'none',
                    color: '#a13b3b',
                    cursor: 'pointer',
                  }}
                >
                  删除
                </button>
              </div>
              {sharedEntryKey === `hidden:${entry.id}` ? (
                <p
                  className={hintClassName ?? footClassName}
                  role="status"
                  data-testid={`phone-files-hidden-entry-share-notice-${entry.id}`}
                  style={{ margin: '6px 0 0', fontSize: 12, color: '#5b5b66' }}
                >
                  已放进聊天输入框引用 —— 打开任意对话即可发出
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      <div style={{ padding: '0 14px 24px', display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onAddManual}
          data-testid="phone-files-hidden-add-manual"
          style={{
            padding: '8px 14px',
            borderRadius: 10,
            border: `1px solid ${HIDDEN_TINT_BORDER}`,
            background: 'transparent',
            fontSize: 13,
            color: HIDDEN_TINT,
            cursor: 'pointer',
          }}
        >
          ＋ 我也想加一条
        </button>
      </div>
    </div>
  );
}

/**
 * 简单暴露给上层做 reaction 拼装——保持 reactions 模块的入口在一处。
 * 上层如果想自己挑文案，也可以直接 import reactions 模块。
 */
export {
  getWrongPasswordReaction,
  HIDDEN_FOLDER_REACTION_POOLS,
};
