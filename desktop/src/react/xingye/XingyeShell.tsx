import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores';
import { AgentPhonePanel } from './AgentPhonePanel';
import { ChatEntryPanel } from './ChatEntryPanel';
import { GroupChatPanel } from './GroupChatPanel';
import { RoleDetailPanel } from './RoleDetailPanel';
import { RoleListPanel } from './RoleListPanel';
import { enterXingyeAgentChat } from './xingye-chat-actions';
import styles from './XingyeShell.module.css';
import { xingyeTabs, type XingyeTabId } from './xingye-tabs';

interface XingyeShellProps {
  onExit: () => void;
}

type CharacterPanelMode = 'list' | 'detail';

export function XingyeShell({ onExit }: XingyeShellProps) {
  const agents = useStore(state => state.agents);
  const currentAgentId = useStore(state => state.currentAgentId);
  const [activeTabId, setActiveTabId] = useState<XingyeTabId>(xingyeTabs[0].id);
  const [characterPanelMode, setCharacterPanelMode] = useState<CharacterPanelMode>('list');
  const [selectedXingyeAgentId, setSelectedXingyeAgentId] = useState<string | null>(null);
  const [enteringAgentId, setEnteringAgentId] = useState<string | null>(null);
  const [enterChatError, setEnterChatError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedXingyeAgentId && agents.some(agent => agent.id === selectedXingyeAgentId)) {
      return;
    }

    const fallbackAgentId = currentAgentId && agents.some(agent => agent.id === currentAgentId)
      ? currentAgentId
      : agents[0]?.id ?? null;
    setSelectedXingyeAgentId(fallbackAgentId);
  }, [agents, currentAgentId, selectedXingyeAgentId]);

  const selectedAgent = useMemo(
    () => agents.find(agent => agent.id === selectedXingyeAgentId) ?? null,
    [agents, selectedXingyeAgentId],
  );
  const currentAgent = useMemo(
    () => agents.find(agent => agent.id === currentAgentId) ?? null,
    [agents, currentAgentId],
  );
  const activeTab = xingyeTabs.find(tab => tab.id === activeTabId) ?? xingyeTabs[0];

  const handleSelectTab = (tabId: XingyeTabId) => {
    setActiveTabId(tabId);
    if (tabId === 'characters') {
      setCharacterPanelMode('list');
    }
  };

  const handleNavigate = (tabId: XingyeTabId) => {
    setActiveTabId(tabId);
  };

  const handleEnterChat = async (agentId: string) => {
    setSelectedXingyeAgentId(agentId);
    setActiveTabId('chat');
    setEnterChatError(null);
    setEnteringAgentId(agentId);
    try {
      await enterXingyeAgentChat(agentId);
    } catch (error) {
      setEnterChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setEnteringAgentId(null);
    }
  };

  return (
    <section className={styles.shell} aria-label="星野模式">
      <header className={styles.topbar}>
        <div className={styles.titleBlock}>
          <p className={styles.eyebrow}>Xingye Mode</p>
          <h1 className={styles.title}>星野</h1>
        </div>
        <button className={styles.exitButton} type="button" onClick={onExit}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5"></path>
            <path d="M12 19l-7-7 7-7"></path>
          </svg>
          <span>返回 OpenHanako</span>
        </button>
      </header>

      <div className={styles.content}>
        <nav className={styles.tabs} aria-label="星野功能">
          {xingyeTabs.map(tab => (
            <button
              key={tab.id}
              className={`${styles.tabButton}${tab.id === activeTabId ? ` ${styles.tabButtonActive}` : ''}`}
              type="button"
              aria-pressed={tab.id === activeTabId}
              onClick={() => handleSelectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <main className={styles.panel}>
          {activeTab.id === 'characters' && characterPanelMode === 'detail' ? (
            <RoleDetailPanel
              agent={selectedAgent}
              isOpenHanakoCurrent={selectedAgent?.id === currentAgentId}
              onBack={() => setCharacterPanelMode('list')}
              onChat={handleEnterChat}
              onPhone={() => handleNavigate('phone')}
            />
          ) : activeTab.id === 'characters' ? (
            <RoleListPanel
              selectedAgentId={selectedXingyeAgentId}
              onSelectAgent={setSelectedXingyeAgentId}
              onShowDetails={() => setCharacterPanelMode('detail')}
              onEnterChat={handleEnterChat}
              onNavigate={handleNavigate}
            />
          ) : activeTab.id === 'phone' ? (
            <AgentPhonePanel agent={selectedAgent} />
          ) : activeTab.id === 'chat' ? (
            <ChatEntryPanel
              selectedAgent={selectedAgent}
              currentAgent={currentAgent}
              currentAgentId={currentAgentId}
              enteringAgentId={enteringAgentId}
              enterChatError={enterChatError}
              onEnterChat={handleEnterChat}
              onExit={onExit}
            />
          ) : activeTab.id === 'group-chat' ? (
            <GroupChatPanel />
          ) : (
            <div className={styles.panelInner}>
              <h2 className={styles.panelTitle}>{activeTab.title}</h2>
              <p className={styles.panelDescription}>{activeTab.description}</p>
              <div className={styles.placeholderGrid}>
                {activeTab.items.map(item => (
                  <div className={styles.placeholderItem} key={item}>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
