import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import type { XingyeTabId } from './xingye-tabs';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { rememberDeskHeartbeatUiOutcome } from './xingye-desk-heartbeat-memory';
import { PhoneAppIcon } from './PhoneAppIcon';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface PhoneHomeProps {
  agent: Agent | null;
  display: XingyeRoleProfileDisplay | null;
  onNavigate: (tabId: XingyeTabId) => void;
  onOpenSms: () => void;
  onOpenContacts: () => void;
  onOpenMmChat: () => void;
  onOpenJournal: () => void;
  onOpenSchedule: () => void;
  onOpenDivination: () => void;
  onOpenFiles: () => void;
  onOpenShopping: () => void;
  onOpenMail: () => void;
  onOpenReadingNotes?: () => void;
  onOpenNews?: () => void;
  onOpenHealth?: () => void;
}

const phoneIcons = {
  notebook: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4.5h10.5A1.5 1.5 0 0 1 18 6v12a1.5 1.5 0 0 1-1.5 1.5H6A2 2 0 0 1 4 17.5v-11a2 2 0 0 1 2-2Z" />
      <path d="M8 4.5v15" />
      <path d="M11 8h4" />
      <path d="M11 11h3" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5v3" />
      <path d="M17 3.5v3" />
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9h16" />
      <path d="M8 13h2" />
      <path d="M13 13h3" />
      <path d="M8 16h5" />
    </svg>
  ),
  images: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7.5V6a2 2 0 0 1 2-2h10" />
      <path d="M8 20h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z" />
      <path d="m8.5 17 3.2-3.2 2.1 2.1 1.3-1.3L18 17" />
      <path d="M15.5 10.5h.01" />
    </svg>
  ),
  message: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5Z" />
      <path d="M8.5 11.5h7" />
      <path d="M8.5 14h4" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3Z" />
      <path d="M18 11a6 6 0 0 1-12 0" />
      <path d="M12 17v3" />
      <path d="M9 20h6" />
    </svg>
  ),
  heart: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.2 5.4a5 5 0 0 0-7.1 0L12 5.5l-.1-.1a5 5 0 0 0-7.1 7.1L12 19.7l7.2-7.2a5 5 0 0 0 0-7.1Z" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M12 14.5v2" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="8" r="3" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 5.13a3 3 0 0 1 0 5.75" />
    </svg>
  ),
  sparkles: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 9.8 8.8 4 11l5.8 2.2L12 19l2.2-5.8L20 11l-5.8-2.2Z" />
      <path d="m19 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a8.5 8.5 0 0 0 11.5 11.5Z" />
      <path d="M6 18h2" />
      <path d="M8 20v2" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z" />
      <path d="M3 10.5h18" />
    </svg>
  ),
  bag: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 8.5h12l-1 11H7L6 8.5Z" />
      <path d="M9 8.5a3 3 0 0 1 6 0" />
      <path d="M9.5 13h5" />
      <path d="M9.5 16h3" />
    </svg>
  ),
  mail: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  ),
  newspaper: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.5h13a1.5 1.5 0 0 1 1.5 1.5v10.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6.5Z" />
      <path d="M18.5 9.5H20a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1" />
      <path d="M7 9.5h7" />
      <path d="M7 12.5h7" />
      <path d="M7 15.5h4" />
    </svg>
  ),
  health: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20.3C7.5 17 4.5 13.8 4.5 10.3A3.8 3.8 0 0 1 12 8.5 3.8 3.8 0 0 1 19.5 10.3C19.5 11 19.4 11.7 19.1 12.4" />
      <path d="M4.8 13.3H8.4l1.5-3 2.5 5.6 1.5-3H19.4" />
    </svg>
  ),
};

const appShortcuts = [
  { label: '通讯录', subtitle: '联系人与印象', tone: 'contacts', icon: phoneIcons.users, action: 'contacts' },
  { label: '短信', subtitle: '角色间短信模拟', tone: 'message', icon: phoneIcons.message, action: 'sms' },
  { label: 'MM Chat', subtitle: 'TA 咨询 AI 助手', tone: 'mmchat', icon: phoneIcons.sparkles, action: 'mm-chat' },
  { label: '日程', subtitle: '安排与约定记录', tone: 'schedule', icon: phoneIcons.calendar, action: 'schedule' },
  { label: '占卜', subtitle: '角色视角叙事占断', tone: 'divination', icon: phoneIcons.moon, action: 'divination' },
  { label: '文件', subtitle: '资料柜与发现记录', tone: 'files', icon: phoneIcons.folder, action: 'files' },
  { label: '购物', subtitle: 'TA 的购物记录', tone: 'shopping', icon: phoneIcons.bag, action: 'shopping' },
  { label: '阅读笔记', subtitle: '本地书目与手动笔记', tone: 'journal', icon: phoneIcons.notebook, action: 'reading-notes' },
  { label: '邮箱', subtitle: 'TA 的私人邮箱', tone: 'mail', icon: phoneIcons.mail, action: 'mail' },
  { label: '报纸', subtitle: '第三方视角的世态与情事', tone: 'news', icon: phoneIcons.newspaper, action: 'news' },
  { label: '健康', subtitle: 'TA 的身体状态模拟', tone: 'health', icon: phoneIcons.health, action: 'health' },
  { label: '相册', subtitle: '功能占位', tone: 'album', icon: phoneIcons.images, action: 'placeholder' },
  { label: '日记', subtitle: '纯文本，按角色持久化', tone: 'journal', icon: phoneIcons.notebook, action: 'journal' },
  { label: '音频', subtitle: '功能占位', tone: 'audio', icon: phoneIcons.mic, action: 'placeholder' },
] as const;

const futureEntries = [
  {
    title: '朋友圈',
    text: '查看角色动态与生活片段入口。',
    icon: phoneIcons.heart,
    tabId: 'moments',
  },
  {
    title: '秘密空间',
    text: '进入更私密的角色资料空间。',
    icon: phoneIcons.lock,
    tabId: 'secret-space',
  },
] as const;

function formatPhoneStatusTime(date: Date): string {
  const h = date.getHours();
  const m = date.getMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function PhoneHome({
  agent,
  display,
  onNavigate,
  onOpenSms,
  onOpenContacts,
  onOpenMmChat,
  onOpenJournal,
  onOpenSchedule,
  onOpenDivination,
  onOpenFiles,
  onOpenShopping,
  onOpenMail,
  onOpenReadingNotes,
  onOpenNews,
  onOpenHealth,
}: PhoneHomeProps) {
  const [statusTime, setStatusTime] = useState(() => formatPhoneStatusTime(new Date()));
  const [heartbeatStatus, setHeartbeatStatus] = useState('等待手动巡检');
  const [heartbeatBusy, setHeartbeatBusy] = useState(false);
  useEffect(() => {
    setStatusTime(formatPhoneStatusTime(new Date()));
    const id = window.setInterval(() => {
      setStatusTime(formatPhoneStatusTime(new Date()));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const coverStyle = display?.chatBackgroundDataUrl
    ? { backgroundImage: `url(${display.chatBackgroundDataUrl})` }
    : undefined;

  const handleAppClick = (action: (typeof appShortcuts)[number]['action']) => {
    if (action === 'sms') {
      onOpenSms();
      return;
    }
    if (action === 'contacts') {
      onOpenContacts();
      return;
    }
    if (action === 'mm-chat') {
      onOpenMmChat();
      return;
    }
    if (action === 'journal') {
      onOpenJournal();
      return;
    }
    if (action === 'schedule') {
      onOpenSchedule();
      return;
    }
    if (action === 'divination') {
      onOpenDivination();
      return;
    }
    if (action === 'files') {
      onOpenFiles();
      return;
    }
    if (action === 'shopping') {
      onOpenShopping();
      return;
    }
    if (action === 'mail') {
      onOpenMail();
      return;
    }
    if (action === 'reading-notes') {
      onOpenReadingNotes?.();
      return;
    }
    if (action === 'news') {
      onOpenNews?.();
      return;
    }
    if (action === 'health') {
      onOpenHealth?.();
      return;
    }
  };

  const handleHeartbeatTrigger = async () => {
    if (!agent?.id || heartbeatBusy) return;
    setHeartbeatBusy(true);
    setHeartbeatStatus('巡检触发中...');
    try {
      const res = await hanaFetch(`/api/desk/heartbeat?agentId=${encodeURIComponent(agent.id)}`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        throw new Error(typeof data?.error === 'string' ? data.error : res.statusText || 'heartbeat failed');
      }
      const statusLine = data?.cooldown ? '冷却中，请稍后再试' : '巡检已触发';
      const detail = typeof data?.message === 'string' && data.message.trim() ? data.message.trim() : '';
      const eventsSummary = typeof data?.summaryZh === 'string' ? data.summaryZh.trim() : '';
      const composed = [statusLine, detail, eventsSummary].filter(Boolean).join(' · ');
      setHeartbeatStatus(composed);
      rememberDeskHeartbeatUiOutcome(agent.id, composed);
    } catch (error) {
      const fail = `巡检失败：${error instanceof Error ? error.message : String(error)}`;
      setHeartbeatStatus(fail);
      rememberDeskHeartbeatUiOutcome(agent.id, fail);
    } finally {
      setHeartbeatBusy(false);
    }
  };

  return (
    <div className={styles.phoneShell} aria-label="角色手机主页">
      <div className={styles.phoneStatusBar}>
        <span>{statusTime}</span>
        <span>星野</span>
      </div>

      <section className={styles.phoneHero} style={coverStyle}>
        <div className={styles.phoneHeroScrim} />
        <div className={styles.phoneHeroContent}>
          <div className={styles.phoneAvatarFrame}>
            {agent ? (
              <XingyeAgentAvatar agent={agent} alt={display?.displayName ?? agent.name} />
            ) : (
              <span>未</span>
            )}
          </div>

          <div className={styles.phoneIdentity}>
            <p className={styles.phoneHeroKicker}>TA 的手机</p>
            <h3 className={styles.phoneDisplayName}>{display?.displayName ?? '未选择角色'}</h3>
            <p className={styles.phoneAgentId}>{agent?.id ?? 'selectedXingyeAgentId: null'}</p>
          </div>
        </div>
      </section>

      <div className={styles.phoneBody}>
        <section className={styles.phoneProfileCard} aria-label="角色资料">
          <p className={styles.phoneBio}>{display?.shortBio ?? '选择一个角色后，这里会显示角色简介。'}</p>
          <div className={styles.phoneTags}>
            <span>{display?.relationshipLabel ?? '关系未设置'}</span>
            <span>{display?.speakingStyle ?? '说话风格未设置'}</span>
          </div>
          <div className={styles.phoneHeartbeatRow}>
            <button
              className={styles.phoneHeartbeatButton}
              type="button"
              disabled={!agent?.id || heartbeatBusy}
              onClick={handleHeartbeatTrigger}
            >
              {heartbeatBusy ? '巡检中...' : '立即巡检'}
            </button>
            <span className={styles.phoneHeartbeatStatus} role="status">
              {heartbeatStatus}
            </span>
          </div>
        </section>

        <section className={styles.phoneAppGrid} aria-label="手机应用">
          {appShortcuts.map(app => (
            <PhoneAppIcon
              key={app.label}
              icon={app.icon}
              label={app.label}
              subtitle={app.subtitle}
              tone={app.tone}
              onClick={() => handleAppClick(app.action)}
            />
          ))}
        </section>

        <section className={styles.phoneFutureGrid} aria-label="后续入口">
          {futureEntries.map(entry => (
            <button
              className={styles.phoneFutureEntry}
              key={entry.title}
              type="button"
              onClick={() => onNavigate(entry.tabId)}
            >
              <span className={styles.phoneFutureIcon}>{entry.icon}</span>
              <span className={styles.phoneFutureText}>
                <strong>{entry.title}</strong>
                <span>{entry.text}</span>
              </span>
            </button>
          ))}
        </section>

        <section className={styles.phoneEmptyStateCard}>
          日记、占卜与 MM Chat 会话列表为按角色本地持久化；MM Chat 仍未接模型。相册/音频仍为占位；短信与通讯录保持原有本地模拟逻辑。
        </section>
      </div>
    </div>
  );
}
