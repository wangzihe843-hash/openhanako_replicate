import type { PhoneContactsSectionId } from './PhoneContactsSectionView';
import {
  getPhoneContactListMeta,
  getPhoneContactListSubtitle,
  getPhoneContactListTitle,
  type XingyePhoneContactView,
} from './xingye-phone-store';
import styles from './XingyeShell.module.css';

interface PhoneContactSectionsProps {
  contacts: XingyePhoneContactView[];
  onSelect: (contact: XingyePhoneContactView) => void;
  onOpenSection: (section: PhoneContactsSectionId) => void;
}

const SHORTCUTS: { id: PhoneContactsSectionId; label: string }[] = [
  { id: 'new_friends', label: '新的朋友' },
  { id: 'groups', label: '群聊' },
  { id: 'tags', label: '标签' },
  { id: 'factions', label: '势力阵营' },
  { id: 'blocked', label: '黑名单' },
  { id: 'deleted', label: '已删除' },
];

export function PhoneContactSections({ contacts, onSelect, onOpenSection }: PhoneContactSectionsProps) {
  const important = contacts.filter(item => item.targetType === 'user' || item.tags.includes('亲近的人')).slice(0, 4);
  const virtuals = contacts.filter(item => item.targetType === 'virtual_contact' && item.status !== 'deleted');
  const agents = contacts.filter(item => item.targetType === 'agent' && item.status !== 'deleted');
  const blocked = contacts.filter(item => item.status === 'blocked');
  const deleted = contacts.filter(item => item.status === 'deleted');

  const renderList = (title: string, items: XingyePhoneContactView[]) => (
    <section className={styles.phoneAppCard}>
      <h4 className={styles.phoneSectionTitle}>{title}</h4>
      {items.length ? (
        <div className={styles.phoneList}>
          {items.map(contact => (
            <button key={`${contact.targetType}:${contact.targetId}`} type="button" className={styles.phoneListItem} onClick={() => onSelect(contact)}>
              <span className={styles.phoneListAvatar}>
                {getPhoneContactListTitle(contact).slice(0, 1)}
              </span>
              <span className={styles.phoneListText}>
                <strong>{getPhoneContactListTitle(contact)}</strong>
                <span>{getPhoneContactListSubtitle(contact)}</span>
                <span className={styles.phoneListMeta}>{getPhoneContactListMeta(contact)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.phoneEmptyStateCard}>暂无联系人</div>
      )}
    </section>
  );

  return (
    <>
      <section className={styles.phoneShortcutGrid}>
        {SHORTCUTS.map(item => (
          <button
            key={item.id}
            type="button"
            className={styles.phoneShortcutButton}
            onClick={() => onOpenSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </section>
      {renderList('重要联系人', important)}
      {renderList('虚拟联系人', virtuals)}
      {renderList('真实角色联系人', agents)}
      {renderList('黑名单 / 已拉黑', blocked)}
      {renderList('已删除', deleted)}
    </>
  );
}
