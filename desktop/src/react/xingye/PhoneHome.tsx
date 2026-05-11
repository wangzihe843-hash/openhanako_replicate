import { useEffect, useState } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfileDisplay } from './xingye-profile-store';
import type { XingyeTabId } from './xingye-tabs';
import { PhoneAppIcon } from './PhoneAppIcon';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface PhoneHomeProps {
  agent: Agent | null;
  display: XingyeRoleProfileDisplay | null;
  onNavigate: (tabId: XingyeTabId) => void;
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
};

const appShortcuts = [
  { label: '日记', tone: 'journal', icon: phoneIcons.notebook },
  { label: '相册', tone: 'album', icon: phoneIcons.images },
  { label: '短信', tone: 'message', icon: phoneIcons.message },
  { label: '音频', tone: 'audio', icon: phoneIcons.mic },
] as const;

const appToastMessages: Record<(typeof appShortcuts)[number]['label'], string> = {
  日记: '日记功能将在后续接入',
  相册: '相册功能将在后续接入',
  短信: '短信功能将在后续接入',
  音频: '音频功能将在后续接入',
};

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

export function PhoneHome({ agent, display, onNavigate }: PhoneHomeProps) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const coverStyle = display?.chatBackgroundDataUrl
    ? { backgroundImage: `url(${display.chatBackgroundDataUrl})` }
    : undefined;

  useEffect(() => {
    if (!toastMessage) return undefined;

    const timeoutId = window.setTimeout(() => {
      setToastMessage(null);
    }, 1800);

    return () => window.clearTimeout(timeoutId);
  }, [toastMessage]);

  const handleAppClick = (label: keyof typeof appToastMessages) => {
    setToastMessage(appToastMessages[label]);
  };

  return (
    <div className={styles.phoneShell} aria-label="角色手机主页">
      <div className={styles.phoneStatusBar}>
        <span>9:41</span>
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
        </section>

        <section className={styles.phoneAppGrid} aria-label="手机应用占位">
          {appShortcuts.map(app => (
            <PhoneAppIcon
              key={app.label}
              icon={app.icon}
              label={app.label}
              tone={app.tone}
              onClick={() => handleAppClick(app.label)}
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
      </div>

      <div className={`${styles.phoneToast}${toastMessage ? ` ${styles.phoneToastVisible}` : ''}`} role="status" aria-live="polite">
        {toastMessage}
      </div>
    </div>
  );
}
