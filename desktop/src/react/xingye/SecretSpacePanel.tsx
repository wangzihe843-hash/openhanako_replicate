import type { Agent } from '../types';
import { getXingyeRoleProfileDisplay, useXingyeRoleProfile } from './xingye-profile-store';
import { RelationshipStatePanel } from './RelationshipStatePanel';
import styles from './XingyeShell.module.css';

interface SecretSpacePanelProps {
  agent: Agent | null;
}

export function SecretSpacePanel({ agent }: SecretSpacePanelProps) {
  const profile = useXingyeRoleProfile(agent?.id);

  if (!agent) {
    return (
      <div className={styles.panelInner}>
        <h2 className={styles.panelTitle}>秘密空间</h2>
        <p className={styles.panelDescription}>
          请在「角色」页选择一个角色后，再查看 TA 的状态与秘密空间占位内容。
        </p>
      </div>
    );
  }

  const displayProfile = getXingyeRoleProfileDisplay(agent, profile);

  return (
    <div className={styles.panelInner}>
      <h2 className={styles.panelTitle}>秘密空间</h2>
      <p className={styles.panelDescription}>
        角色侧隐藏内容占位区，用于承载 TA 私下保存但暂不公开的内容线索。
      </p>

      <div className={styles.secretSpaceStack}>
        <section className={styles.secretSpaceSection} aria-labelledby="secret-space-state-heading">
          <h3 id="secret-space-state-heading" className={styles.secretSpaceSectionTitle}>TA 的状态</h3>
          <RelationshipStatePanel agent={agent} profile={displayProfile} />
        </section>

        <section className={styles.secretSpaceSection} aria-labelledby="secret-space-draft-heading">
          <h3 id="secret-space-draft-heading" className={styles.secretSpaceSectionTitle}>TA 的草稿箱</h3>
          <p className={styles.secretSpacePlaceholder}>后续承载 draft_reply。</p>
        </section>

        <section className={styles.secretSpaceSection} aria-labelledby="secret-space-dream-heading">
          <h3 id="secret-space-dream-heading" className={styles.secretSpaceSectionTitle}>TA 的梦境</h3>
          <p className={styles.secretSpacePlaceholder}>
            梦境碎片用于承载 TA 在休眠/回忆/情绪波动时生成的象征化内容。当前仅占位，后续可接入 heartbeat 或手动生成。
          </p>
        </section>

        <section className={styles.secretSpaceSection} aria-labelledby="secret-space-saved-heading">
          <h3 id="secret-space-saved-heading" className={styles.secretSpaceSectionTitle}>TA 收藏的东西</h3>
          <p className={styles.secretSpacePlaceholder}>后续承载 saved_item。</p>
        </section>

        <section className={styles.secretSpaceSection} aria-labelledby="secret-space-unsent-heading">
          <h3 id="secret-space-unsent-heading" className={styles.secretSpaceSectionTitle}>TA 未发送的朋友圈</h3>
          <p className={styles.secretSpacePlaceholder}>后续承载 unsent_moment。</p>
        </section>

        <section className={styles.secretSpaceSection} aria-labelledby="secret-space-memory-heading">
          <h3 id="secret-space-memory-heading" className={styles.secretSpaceSectionTitle}>私藏回忆</h3>
          <p className={styles.secretSpacePlaceholder}>后续承载 memory_fragment。</p>
        </section>
      </div>
    </div>
  );
}
