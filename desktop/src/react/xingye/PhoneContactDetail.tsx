/**
 * iOS 通讯录风格的联系人详情页。
 *
 * - 头像：agent 用真实头像（XingyeAgentAvatar）；user / virtual_contact 没有头像 API，
 *   降级为首字字圈（user 用用户名首字，vc 用备注首字）。
 * - ID / IP属地 / 个性签名 / 联系记录 来自 xingye-contact-profile-ai 的懒初始化：
 *   首次点开详情页自动逐条生成（每联系人一次请求），失败可重试。
 * - 印象：当前印象以 contact meta 为准；有历史时把上一次印象划掉显示在上方。
 * - 「更新联系记录」手动追加（store 端硬去重）；ip/签名旧值保留在「曾用记录」里。
 * - 原编辑表单（备注/印象/关系/标签/阵营/关联角色）收进「编辑资料」折叠区，能力不变。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { Agent } from '../types';
import type { XingyeRoleProfile } from './xingye-profile-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import {
  getContactProfile,
  getPhoneContactListTitle,
  type XingyeContactLogEntry,
  type XingyePhoneContactView,
} from './xingye-phone-store';
import {
  ensureContactProfileInitializedWithAI,
  updateContactProfileWithAI,
} from './xingye-contact-profile-ai';
import styles from './XingyeShell.module.css';

interface PhoneContactDetailProps {
  contact: XingyePhoneContactView;
  agents: Agent[];
  ownerAgent: Agent | null;
  ownerProfile: XingyeRoleProfile | null | undefined;
  userName: string;
  remarkDraft: string;
  impressionDraft: string;
  relationDraft: string;
  tagsDraft: string;
  factionDraft: string;
  onChange: (field: 'remark' | 'impression' | 'relation' | 'tags' | 'faction', value: string) => void;
  onSave: () => void;
  onBlockToggle: () => void;
  onDeleteToggle: () => void;
  onLinkAgent: (linkedAgentId: string) => void;
  onUnlinkAgent: () => void;
  onOpenSms: () => void;
}

function directionGlyph(direction: XingyeContactLogEntry['direction']): string {
  if (direction === 'incoming') return '↙';
  if (direction === 'outgoing') return '↗';
  return '⇄';
}

function ContactAvatar({ contact, userName }: { contact: XingyePhoneContactView; userName: string }) {
  const circleStyle: CSSProperties = {
    width: 56,
    height: 56,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 24,
    flex: '0 0 auto',
  };
  if (contact.targetType === 'agent' && contact.agent) {
    return (
      <XingyeAgentAvatar
        agent={contact.agent}
        alt={contact.remark}
        style={{ ...circleStyle, objectFit: 'cover' }}
      />
    );
  }
  const letter = contact.targetType === 'user'
    ? (userName.trim() || '你').slice(0, 1)
    : (contact.remark?.trim() || '?').slice(0, 1);
  return <span className={styles.phoneListAvatar} style={circleStyle}>{letter}</span>;
}

function InfoRow({ label, value, busyFallback }: { label: string; value?: string; busyFallback: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' }}>
      <span className={styles.phoneListMeta} style={{ flex: '0 0 auto' }}>{label}</span>
      <span style={{ textAlign: 'right', wordBreak: 'break-all' }}>{value?.trim() ? value : busyFallback}</span>
    </div>
  );
}

export function PhoneContactDetail({
  contact,
  agents,
  ownerAgent,
  ownerProfile,
  userName,
  remarkDraft,
  impressionDraft,
  relationDraft,
  tagsDraft,
  factionDraft,
  onChange,
  onSave,
  onBlockToggle,
  onDeleteToggle,
  onLinkAgent,
  onUnlinkAgent,
  onOpenSms,
}: PhoneContactDetailProps) {
  const linkOptions = agents.filter(agent => agent.id !== contact.ownerAgentId);
  const listTitle = getPhoneContactListTitle(contact);
  const contactKeyStr = `${contact.ownerAgentId}::${contact.targetType}::${contact.targetId}`;
  const profile = getContactProfile(contact.ownerAgentId, contact.targetType, contact.targetId);
  const initialized = Boolean(profile?.initializedAt);

  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  /** 失败后不自动重试（避免对着坏后端打请求风暴）；nonce 由「重试」按钮驱动。 */
  const [retryNonce, setRetryNonce] = useState(0);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerAgent || initialized) return;
    let cancelled = false;
    setInitBusy(true);
    setInitError(null);
    ensureContactProfileInitializedWithAI({ ownerAgent, ownerProfile, contact })
      .catch((error) => {
        if (!cancelled) setInitError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setInitBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // contact 对象每次渲染都是新引用，用 key 串而不是对象做依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactKeyStr, ownerAgent?.id, initialized, retryNonce]);

  const handleUpdateLog = async () => {
    if (!ownerAgent || updateBusy) return;
    setUpdateBusy(true);
    setUpdateNotice(null);
    try {
      const result = await updateContactProfileWithAI({ ownerAgent, ownerProfile, contact });
      if (result.appended > 0) {
        const bits = [`新增 ${result.appended} 条联系记录`];
        if (result.droppedAsDuplicate > 0) bits.push(`${result.droppedAsDuplicate} 条与已有记录重复已丢弃`);
        if (result.ipChanged) bits.push('IP属地有变（旧值已存档）');
        if (result.signatureChanged) bits.push('个性签名有变（旧签名已存档）');
        setUpdateNotice(`${bits.join('；')}。`);
      } else {
        setUpdateNotice(result.droppedAsDuplicate > 0 ? '生成结果与已有记录重复，未新增。' : '这次没有新的往来。');
      }
    } catch (error) {
      setUpdateNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdateBusy(false);
    }
  };

  const valueFallback = initBusy ? '生成中…' : '—';
  const lastImpression = profile?.impressionHistory.length
    ? profile.impressionHistory[profile.impressionHistory.length - 1]
    : null;
  const earlierImpressions = profile?.impressionHistory.slice(0, -1) ?? [];

  return (
    <section className={styles.phoneAppCard}>
      {/* —— 头部：头像 + 名字（iOS 联系人样式） —— */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 }}>
        <ContactAvatar contact={contact} userName={userName} />
        <div style={{ minWidth: 0 }}>
          <h3 className={styles.phoneAppTitle} style={{ margin: 0 }}>{listTitle}</h3>
          {contact.originalName && contact.originalName !== contact.remark ? (
            <p className={styles.phoneAppHint} style={{ margin: '2px 0 0' }}>原名：{contact.originalName}</p>
          ) : null}
          <p className={styles.phoneAppHint} style={{ margin: '2px 0 0' }}>
            {contact.targetType === 'user' ? 'user' : (contact.kind ?? contact.targetType)}
            {contact.relationshipHint?.trim() ? ` · ${contact.relationshipHint}` : ''}
            {contact.status !== 'active' ? `（${contact.status === 'blocked' ? '已拉黑' : '已删除'}）` : ''}
          </p>
        </div>
      </div>

      {initError ? (
        <div className={styles.phoneActionRow}>
          <span className={styles.phoneAppHint}>详情生成失败：{initError}</span>
          <button
            type="button"
            className={styles.phoneWeakAction}
            onClick={() => { setInitError(null); setRetryNonce(n => n + 1); }}
          >
            重试
          </button>
        </div>
      ) : null}

      {/* —— ID / IP / 签名 —— */}
      <div data-testid="contact-profile-fields" style={{ margin: '4px 0 10px' }}>
        <InfoRow label="ID" value={profile?.accountId} busyFallback={valueFallback} />
        <InfoRow label="IP属地" value={profile?.ipAddress} busyFallback={valueFallback} />
        <InfoRow label="个性签名" value={profile?.signature} busyFallback={valueFallback} />
      </div>
      {(profile?.ipHistory.length || profile?.signatureHistory.length) ? (
        <details className={styles.phoneAppHint}>
          <summary>曾用记录</summary>
          {profile.ipHistory.map((item, idx) => (
            <p key={`ip-${idx}`} style={{ margin: '2px 0' }}>曾用IP属地：{item.value}</p>
          ))}
          {profile.signatureHistory.map((item, idx) => (
            <p key={`sig-${idx}`} style={{ margin: '2px 0' }}>曾用签名：{item.value}</p>
          ))}
        </details>
      ) : null}

      {/* —— 印象（旧印象划掉 + 当前印象） —— */}
      <h4 className={styles.phoneSectionTitle}>印象</h4>
      <div data-testid="contact-profile-impression">
        {lastImpression ? (
          <p className={styles.phoneAppHint} style={{ textDecoration: 'line-through', opacity: 0.65, margin: '0 0 2px' }}>
            {lastImpression.value}
          </p>
        ) : null}
        <p style={{ margin: 0 }}>{contact.impression}</p>
        {earlierImpressions.length ? (
          <details className={styles.phoneAppHint}>
            <summary>更早的印象（{earlierImpressions.length}）</summary>
            {earlierImpressions.map((item, idx) => (
              <p key={idx} style={{ margin: '2px 0', textDecoration: 'line-through', opacity: 0.55 }}>{item.value}</p>
            ))}
          </details>
        ) : null}
      </div>

      {/* —— 联系记录 —— */}
      <div className={styles.phoneActionRow} style={{ alignItems: 'baseline' }}>
        <h4 className={styles.phoneSectionTitle} style={{ margin: 0 }}>联系记录</h4>
        <button
          type="button"
          className={styles.phoneWeakAction}
          data-testid="contact-profile-update-log"
          onClick={handleUpdateLog}
          disabled={!ownerAgent || !initialized || updateBusy}
        >
          {updateBusy ? '更新中…' : '更新联系记录'}
        </button>
      </div>
      {updateNotice ? <p className={styles.phoneAppHint}>{updateNotice}</p> : null}
      {profile?.contactLog.length ? (
        <div className={styles.phoneList} data-testid="contact-profile-log">
          {profile.contactLog.map(entry => (
            <div key={entry.id} className={styles.phoneListItem} style={{ cursor: 'default' }}>
              <span className={styles.phoneListAvatar}>{directionGlyph(entry.direction)}</span>
              <span className={styles.phoneListText}>
                <strong>{entry.channel}{entry.whenLabel ? ` · ${entry.whenLabel}` : ''}</strong>
                <span>{entry.summary}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.phoneEmptyStateCard}>
          {initBusy ? '详情生成中…' : '暂无联系记录。'}
        </div>
      )}

      {/* —— 编辑资料（原表单收进折叠区，能力不变） —— */}
      <details style={{ marginTop: 10 }}>
        <summary className={styles.phoneAppHint} style={{ cursor: 'pointer' }}>编辑资料</summary>
        <p className={styles.phoneAppHint}>
          类型：{contact.targetType} · 状态：{contact.status} · source：{contact.source ?? 'manual'}
        </p>
        {contact.shortBio?.trim() ? <p className={styles.phoneAppHint}>简介：{contact.shortBio}</p> : null}
        {contact.generatedReason?.trim() ? (
          <p className={styles.phoneGeneratedReason} title="内部生成记录，默认不在列表强调展示">
            内部记录 · {contact.generatedReason}
          </p>
        ) : null}
        {contact.linkedAgentId ? <p className={styles.phoneAppHint}>已关联角色：{contact.linkedAgentId}</p> : null}

        <label className={styles.phoneFormField}>
          <span>备注</span>
          <input value={remarkDraft} onChange={event => onChange('remark', event.target.value)} />
        </label>
        <label className={styles.phoneFormField}>
          <span>大概印象</span>
          <textarea rows={4} value={impressionDraft} onChange={event => onChange('impression', event.target.value)} />
        </label>
        <label className={styles.phoneFormField}>
          <span>关系提示</span>
          <input value={relationDraft} onChange={event => onChange('relation', event.target.value)} />
        </label>
        <label className={styles.phoneFormField}>
          <span>标签（逗号分隔）</span>
          <input value={tagsDraft} onChange={event => onChange('tags', event.target.value)} />
        </label>
        <label className={styles.phoneFormField}>
          <span>势力阵营</span>
          <input value={factionDraft} onChange={event => onChange('faction', event.target.value)} />
        </label>

        {contact.targetType === 'virtual_contact' ? (
          <div className={styles.phoneActionRow}>
            <select className={styles.phoneInlineSelect} value={contact.linkedAgentId ?? ''} onChange={event => onLinkAgent(event.target.value)}>
              <option value="">关联现有角色（占位）</option>
              {linkOptions.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
            {contact.linkedAgentId ? <button type="button" className={styles.secondaryButton} onClick={onUnlinkAgent}>取消关联</button> : null}
          </div>
        ) : null}

        <div className={styles.phoneActionRow}>
          <button type="button" className={styles.secondaryButton} onClick={onSave}>保存</button>
        </div>
      </details>

      <div className={styles.phoneActionRow} style={{ marginTop: 10 }}>
        <button type="button" className={styles.secondaryButton} onClick={onOpenSms} disabled={contact.targetType === 'user'}>
          {contact.targetType === 'user' ? '用户短信后续接入' : '查看短信'}
        </button>
      </div>
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.phoneWeakAction} onClick={onBlockToggle}>
          {contact.status === 'blocked' ? '取消拉黑' : '拉黑'}
        </button>
        <button type="button" className={styles.phoneWeakAction} onClick={onDeleteToggle}>
          {contact.status === 'deleted' ? '恢复联系人' : '删除联系人'}
        </button>
      </div>
    </section>
  );
}
