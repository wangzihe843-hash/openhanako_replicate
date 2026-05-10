import { useState } from 'react';
import { RoleListPanel } from './RoleListPanel';
import styles from './XingyeShell.module.css';
import { xingyeTabs, type XingyeTabId } from './xingye-tabs';

interface XingyeShellProps {
  onExit: () => void;
}

export function XingyeShell({ onExit }: XingyeShellProps) {
  const [activeTabId, setActiveTabId] = useState<XingyeTabId>(xingyeTabs[0].id);
  const activeTab = xingyeTabs.find(tab => tab.id === activeTabId) ?? xingyeTabs[0];

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
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <main className={styles.panel}>
          {activeTab.id === 'characters' ? (
            <RoleListPanel onNavigate={setActiveTabId} />
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
