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
import { PhoneMmChatApp } from './PhoneMmChatApp';
import { PhoneHome } from './PhoneHome';
import { PhoneSmsApp } from './PhoneSmsApp';
import styles from './XingyeShell.module.css';

interface AgentPhonePanelProps {
  agent: Agent | null;
  agents: Agent[];
  currentAgentId: string | null;
  onNavigate: (tabId: XingyeTabId) => void;
  onOpenGroupChatTab?: () => void;
}

type PhonePage = 'home' | 'sms' | 'contacts' | 'mm-chat';

export function AgentPhonePanel({ agent, agents, currentAgentId, onNavigate, onOpenGroupChatTab }: AgentPhonePanelProps) {
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
        当前为角色侧本地模拟手机：短信/通讯录/MM Chat 只存 localStorage，不接 OpenHanako 原生聊天与记忆管线。
      </p>
      {phonePage === 'home' ? (
        <PhoneHome
          agent={agent}
          display={display}
          onNavigate={onNavigate}
          onOpenSms={() => handleOpenSms()}
          onOpenContacts={() => setPhonePage('contacts')}
          onOpenMmChat={() => setPhonePage('mm-chat')}
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
          currentAgentId={currentAgentId}
          channels={channels}
          onBack={() => setPhonePage('home')}
          onOpenSms={(targetType, targetId) => handleOpenSms(targetType, targetId)}
          onOpenGroupChatTab={onOpenGroupChatTab}
        />
      ) : null}

      {phonePage === 'mm-chat' ? (
        <PhoneMmChatApp
          ownerAgent={agent}
          displayName={display?.displayName ?? agent?.name ?? 'TA'}
          onBack={() => setPhonePage('home')}
        />
      ) : null}
    </div>
  );
}
