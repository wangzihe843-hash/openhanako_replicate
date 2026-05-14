import { useState } from 'react';
import { useStore } from '../stores';
import type { Agent } from '../types';
import {
  getXingyeRoleProfileDisplay,
  useXingyeRoleProfiles,
  useXingyeRoleProfile,
} from './xingye-profile-store';
import { PhoneContactsApp } from './PhoneContactsApp';
import type { XingyeTabId } from './xingye-tabs';
import { PhoneJournalApp } from './PhoneJournalApp';
import { PhoneMmChatApp } from './PhoneMmChatApp';
import { PhoneHome } from './PhoneHome';
import { PhoneScheduleApp } from './PhoneScheduleApp';
import { PhoneDivinationApp } from './PhoneDivinationApp';
import { PhoneSmsApp } from './PhoneSmsApp';
import styles from './XingyeShell.module.css';

interface AgentPhonePanelProps {
  agent: Agent | null;
  agents: Agent[];
  onNavigate: (tabId: XingyeTabId) => void;
  onOpenGroupChatTab?: () => void;
}

type PhonePage = 'home' | 'sms' | 'contacts' | 'mm-chat' | 'journal' | 'schedule' | 'divination';

export function AgentPhonePanel({ agent, agents, onNavigate, onOpenGroupChatTab }: AgentPhonePanelProps) {
  const channels = useStore(state => state.channels);
  const profile = useXingyeRoleProfile(agent?.id);
  const profiles = useXingyeRoleProfiles();
  const display = agent ? getXingyeRoleProfileDisplay(agent, profile) : null;
  const [phonePage, setPhonePage] = useState<PhonePage>('home');
  const [smsTarget, setSmsTarget] = useState<{ targetType: 'agent' | 'virtual_contact' | 'user'; targetId: string } | null>(null);

  const handleOpenSms = (targetType: 'agent' | 'virtual_contact' | 'user' = 'agent', targetId?: string) => {
    setSmsTarget(targetId ? { targetType, targetId } : null);
    setPhonePage('sms');
  };

  return (
    <div className={styles.phonePanel}>
      <h2 className={styles.panelTitle}>小手机</h2>
      <p className={styles.panelDescription}>
        当前为角色侧本地模拟手机：短信/通讯录、日记、占卜与 MM Chat 会话列表写入当前 agent 在 HANA_HOME 下的 <code className={styles.inlineCode}>agents/&lt;agentId&gt;/xingye/</code>（需已连接服务且星野持久化已绑定该角色；未就绪时不写入、不回退到全局 localStorage）。MM Chat 支持一键「生成对话」（走与日记/秘密空间相同的服务端模型接口），并持久化到当前角色的 MM Chat 数据；占卜记录走应用条目存储（<code className={styles.inlineCode}>apps/divination/</code>）。不写入短信、群聊、朋友圈、秘密空间或 TA 状态。
      </p>
      {phonePage === 'home' ? (
        <PhoneHome
          agent={agent}
          display={display}
          onNavigate={onNavigate}
          onOpenSms={() => handleOpenSms()}
          onOpenContacts={() => setPhonePage('contacts')}
          onOpenMmChat={() => setPhonePage('mm-chat')}
          onOpenJournal={() => setPhonePage('journal')}
          onOpenSchedule={() => setPhonePage('schedule')}
          onOpenDivination={() => setPhonePage('divination')}
        />
      ) : null}

      {phonePage === 'sms' ? (
        <PhoneSmsApp
          ownerAgent={agent}
          agents={agents}
          profiles={profiles}
          initialTarget={smsTarget}
          onBack={() => setPhonePage('home')}
        />
      ) : null}

      {phonePage === 'contacts' ? (
        <PhoneContactsApp
          ownerAgent={agent}
          agents={agents}
          profiles={profiles}
          channels={channels}
          onBack={() => setPhonePage('home')}
          onOpenSms={(targetType, targetId) => handleOpenSms(targetType, targetId)}
          onOpenGroupChatTab={onOpenGroupChatTab}
        />
      ) : null}

      {phonePage === 'mm-chat' ? (
        <PhoneMmChatApp
          ownerAgent={agent}
          ownerProfile={profile}
          displayName={display?.displayName ?? agent?.name ?? 'TA'}
          onBack={() => setPhonePage('home')}
        />
      ) : null}

      {phonePage === 'journal' ? (
        <PhoneJournalApp
          ownerAgent={agent}
          displayName={display?.displayName ?? agent?.name ?? 'TA'}
          onBack={() => setPhonePage('home')}
        />
      ) : null}

      {phonePage === 'schedule' ? (
        <PhoneScheduleApp
          ownerAgent={agent}
          ownerProfile={profile}
          displayName={display?.displayName ?? agent?.name ?? 'TA'}
          onBack={() => setPhonePage('home')}
        />
      ) : null}

      {phonePage === 'divination' ? (
        <PhoneDivinationApp
          ownerAgent={agent}
          ownerProfile={profile}
          displayName={display?.displayName ?? agent?.name ?? 'TA'}
          onBack={() => setPhonePage('home')}
        />
      ) : null}
    </div>
  );
}
