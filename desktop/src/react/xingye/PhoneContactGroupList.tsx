import {
  getPhoneContactListMeta,
  getPhoneContactListSubtitle,
  getPhoneContactListTitle,
  type XingyePhoneContactView,
} from './xingye-phone-store';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

interface PhoneContactGroupListProps {
  contacts: XingyePhoneContactView[];
  onSelect: (contact: XingyePhoneContactView) => void;
  emptyLabel: string;
  /** 在副标题行后展示状态徽记（如 已拉黑） */
  statusNote?: (contact: XingyePhoneContactView) => string | null;
}

export function PhoneContactGroupList({ contacts, onSelect, emptyLabel, statusNote }: PhoneContactGroupListProps) {
  if (!contacts.length) {
    return <div className={styles.phoneEmptyStateCard}>{emptyLabel}</div>;
  }
  return (
    <div className={styles.phoneList}>
      {contacts.map(contact => (
        <button
          key={`${contact.targetType}:${contact.targetId}`}
          type="button"
          className={styles.phoneListItem}
          onClick={() => onSelect(contact)}
        >
          <span className={styles.phoneListAvatar}>
            {contact.agent ? (
              <XingyeAgentAvatar agent={contact.agent} alt={getPhoneContactListTitle(contact)} />
            ) : (
              getPhoneContactListTitle(contact).slice(0, 1)
            )}
          </span>
          <span className={styles.phoneListText}>
            <strong>{getPhoneContactListTitle(contact)}</strong>
            <span>{getPhoneContactListSubtitle(contact)}</span>
            <span className={styles.phoneListMeta}>
              {statusNote?.(contact) ?? getPhoneContactListMeta(contact)}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
