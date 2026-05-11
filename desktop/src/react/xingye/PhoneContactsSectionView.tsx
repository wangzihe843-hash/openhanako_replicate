import type { Agent, Channel } from '../types';
import type { XingyeRoleProfileMap } from './xingye-profile-store';
import { PhoneContactGroupList } from './PhoneContactGroupList';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import {
  clearPendingNewFriend,
  getBlockedContacts,
  getContactsByFaction,
  getContactsByTag,
  getDefaultContactFactions,
  getDefaultContactTags,
  getDeletedContacts,
  getPendingNewContacts,
  restorePhoneContact,
  unblockPhoneContact,
  type XingyePhoneContactView,
} from './xingye-phone-store';
import styles from './XingyeShell.module.css';

export type PhoneContactsSectionId =
  | 'new_friends'
  | 'groups'
  | 'tags'
  | 'tag_detail'
  | 'factions'
  | 'faction_detail'
  | 'blocked'
  | 'deleted';

interface SectionBaseProps {
  ownerAgentId: string;
  agents: Agent[];
  profiles: XingyeRoleProfileMap;
  onBackHome: () => void;
  onSelectContact: (contact: XingyePhoneContactView) => void;
  onTriggerAiUpdate?: () => void;
  aiUpdateBusy?: boolean;
}

export function PhoneContactsNewFriendsView({
  ownerAgentId,
  agents,
  profiles,
  onBackHome,
  onSelectContact,
  onTriggerAiUpdate,
  aiUpdateBusy,
}: SectionBaseProps) {
  const pending = getPendingNewContacts(ownerAgentId, agents, profiles);
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>新的朋友</h3>
      <p className={styles.phoneAppHint}>
        以后这里会显示 TA 新认识的人、关系变化和待确认的社交请求。以下为 AI 最近生成、尚未标记已读的新联系人。
      </p>
      {pending.length ? (
        <div className={styles.phoneList}>
          {pending.map(contact => (
            <div key={`${contact.targetType}:${contact.targetId}`} className={styles.phoneSubpageBlock}>
              <button type="button" className={styles.phoneListItem} onClick={() => onSelectContact(contact)}>
                <span className={styles.phoneListAvatar}>{contact.remark?.slice(0, 1) ?? '?'}</span>
                <span className={styles.phoneListText}>
                  <strong>{contact.remark}</strong>
                  <span>{contact.impression}</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.phoneWeakAction}
                onClick={() => {
                  clearPendingNewFriend(ownerAgentId, contact.targetType, contact.targetId);
                }}
              >
                标记已读
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.phoneEmptyStateCard}>暂无新的朋友</div>
      )}
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackHome}>
          返回通讯录
        </button>
        {onTriggerAiUpdate ? (
          <button type="button" className={styles.secondaryButton} onClick={onTriggerAiUpdate} disabled={aiUpdateBusy}>
            去 AI 更新联系人
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function PhoneContactsGroupsView({
  channels,
  onBackHome,
  onOpenNativeGroupTab,
}: {
  channels: Channel[];
  onBackHome: () => void;
  onOpenNativeGroupTab?: () => void;
}) {
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>群聊</h3>
      <p className={styles.phoneAppHint}>
        这里列出 OpenHanako 当前账号下的频道/群聊入口。聊天与记录仍在原生频道中，不在小手机短信里。
      </p>
      {channels.length ? (
        <div className={styles.phoneList}>
          {channels.map(ch => (
            <button
              key={ch.id}
              type="button"
              className={styles.phoneListItem}
              onClick={() => {
                if (onOpenNativeGroupTab) {
                  onOpenNativeGroupTab();
                  return;
                }
                window.alert('请返回星野顶栏「群聊」tab，在 OpenHanako 原生频道中打开该群。');
              }}
            >
              <span className={styles.phoneListAvatar}>{ch.name.slice(0, 1)}</span>
              <span className={styles.phoneListText}>
                <strong>{ch.name}</strong>
                <span>{ch.description?.trim() || '频道'}</span>
                <span className={styles.phoneListMeta}>
                  成员 {ch.members?.length ?? 0} · 消息约 {ch.messageCount ?? '—'}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.phoneEmptyStateCard}>当前没有频道。可在 OpenHanako 侧创建或加入频道后，再回到此处查看。</div>
      )}
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackHome}>
          返回通讯录
        </button>
        {onOpenNativeGroupTab ? (
          <button type="button" className={styles.phoneWeakAction} onClick={onOpenNativeGroupTab}>
            打开星野群聊 tab
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function PhoneContactsTagsHomeView({
  ownerAgentId,
  agents,
  profiles,
  onBackHome,
  onOpenTag,
}: SectionBaseProps & { onOpenTag: (tag: string) => void }) {
  const rows = getDefaultContactTags(ownerAgentId, agents, profiles);
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>标签</h3>
      <p className={styles.phoneAppHint}>按当前角色视角的分组标签浏览联系人（读取各联系人 tags 字段）。</p>
      <div className={styles.phoneList}>
        {rows.map(row => (
          <button key={row.tag} type="button" className={styles.phoneListItem} onClick={() => onOpenTag(row.tag)}>
            <span className={styles.phoneListAvatar}>{row.tag.slice(0, 1)}</span>
            <span className={styles.phoneListText}>
              <strong>{row.tag}</strong>
              <span>{row.count} 位联系人</span>
            </span>
          </button>
        ))}
      </div>
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackHome}>
          返回通讯录
        </button>
      </div>
    </section>
  );
}

export function PhoneContactsTagDetailView({
  ownerAgentId,
  agents,
  profiles,
  tag,
  onBackHome,
  onBackTags,
  onSelectContact,
}: SectionBaseProps & { tag: string; onBackTags: () => void }) {
  const list = getContactsByTag(ownerAgentId, tag, agents, profiles);
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>标签：{tag}</h3>
      <PhoneContactGroupList
        contacts={list}
        onSelect={onSelectContact}
        emptyLabel="该标签下暂无联系人。可在联系人详情里编辑标签。"
      />
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackTags}>
          返回标签列表
        </button>
        <button type="button" className={styles.phoneWeakAction} onClick={onBackHome}>
          返回通讯录
        </button>
      </div>
    </section>
  );
}

export function PhoneContactsFactionsHomeView({
  ownerAgentId,
  agents,
  profiles,
  onBackHome,
  onOpenFaction,
}: SectionBaseProps & { onOpenFaction: (faction: string) => void }) {
  const rows = getDefaultContactFactions(ownerAgentId, agents, profiles);
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>势力阵营</h3>
      <p className={styles.phoneAppHint}>按当前角色对联系人阵营的判断浏览（读取 faction；未填写归入「未知」）。</p>
      <div className={styles.phoneList}>
        {rows.map(row => (
          <button key={row.faction} type="button" className={styles.phoneListItem} onClick={() => onOpenFaction(row.faction)}>
            <span className={styles.phoneListAvatar}>{row.faction.slice(0, 1)}</span>
            <span className={styles.phoneListText}>
              <strong>{row.faction}</strong>
              <span>{row.count} 位联系人</span>
            </span>
          </button>
        ))}
      </div>
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackHome}>
          返回通讯录
        </button>
      </div>
    </section>
  );
}

export function PhoneContactsFactionDetailView({
  ownerAgentId,
  agents,
  profiles,
  faction,
  onBackHome,
  onBackFactions,
  onSelectContact,
}: SectionBaseProps & { faction: string; onBackFactions: () => void }) {
  const list = getContactsByFaction(ownerAgentId, faction, agents, profiles);
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>阵营：{faction}</h3>
      <PhoneContactGroupList
        contacts={list}
        onSelect={onSelectContact}
        emptyLabel="该阵营下暂无联系人。可在联系人详情里编辑阵营。"
      />
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackFactions}>
          返回阵营列表
        </button>
        <button type="button" className={styles.phoneWeakAction} onClick={onBackHome}>
          返回通讯录
        </button>
      </div>
    </section>
  );
}

export function PhoneContactsBlockedView({
  ownerAgentId,
  agents,
  profiles,
  onBackHome,
  onSelectContact,
}: SectionBaseProps) {
  const list = getBlockedContacts(ownerAgentId, agents, profiles).filter(c => c.targetType !== 'user');
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>黑名单</h3>
      <p className={styles.phoneAppHint}>当前角色视角下拉黑的联系人（不含「你」）。</p>
      {!list.length ? (
        <div className={styles.phoneEmptyStateCard}>暂无黑名单联系人</div>
      ) : (
        <div className={styles.phoneList}>
          {list.map(contact => (
            <div key={`${contact.targetType}:${contact.targetId}`} className={styles.phoneSubpageBlock}>
              <button type="button" className={styles.phoneListItem} onClick={() => onSelectContact(contact)}>
                <span className={styles.phoneListAvatar}>
                  {contact.agent ? <XingyeAgentAvatar agent={contact.agent} alt={contact.remark} /> : contact.remark.slice(0, 1)}
                </span>
                <span className={styles.phoneListText}>
                  <strong>{contact.remark}</strong>
                  <span>{contact.impression}</span>
                  <span className={styles.phoneListMeta}>已拉黑</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  unblockPhoneContact(ownerAgentId, contact.targetType, contact.targetId);
                }}
              >
                取消拉黑
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackHome}>
          返回通讯录
        </button>
      </div>
    </section>
  );
}

export function PhoneContactsDeletedView({
  ownerAgentId,
  agents,
  profiles,
  onBackHome,
  onSelectContact,
}: SectionBaseProps) {
  const list = getDeletedContacts(ownerAgentId, agents, profiles);
  return (
    <section className={styles.phoneAppCard}>
      <h3 className={styles.phoneAppTitle}>已删除</h3>
      <p className={styles.phoneAppHint}>软删除的联系人，可恢复为正常状态（不物理删除数据）。</p>
      {!list.length ? (
        <div className={styles.phoneEmptyStateCard}>暂无已删除联系人</div>
      ) : (
        <div className={styles.phoneList}>
          {list.map(contact => (
            <div key={`${contact.targetType}:${contact.targetId}`} className={styles.phoneSubpageBlock}>
              <button type="button" className={styles.phoneListItem} onClick={() => onSelectContact(contact)}>
                <span className={styles.phoneListAvatar}>{contact.remark.slice(0, 1)}</span>
                <span className={styles.phoneListText}>
                  <strong>{contact.remark}</strong>
                  <span>{contact.impression}</span>
                  <span className={styles.phoneListMeta}>已删除</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  restorePhoneContact(ownerAgentId, contact.targetType, contact.targetId);
                }}
              >
                恢复联系人
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.phoneActionRow}>
        <button type="button" className={styles.secondaryButton} onClick={onBackHome}>
          返回通讯录
        </button>
      </div>
    </section>
  );
}
