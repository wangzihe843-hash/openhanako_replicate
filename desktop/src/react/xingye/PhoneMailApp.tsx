import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import styles from './XingyeShell.module.css';
import {
  appendMailMessage,
  appendMailMessages,
  confirmMailDraft,
  deleteMailMessage,
  discardMailDraft,
  ensureMailProfile,
  getMailProfile,
  listMailDrafts,
  listMailMessages,
  setMailMessageStar,
  updateMailMessage,
  XINGYE_MAIL_DOMAIN,
  XINGYE_MAIL_MAILBOXES,
  type XingyeMailMailbox,
  type XingyeMailMessage,
  type XingyeMailMessageDraft,
  type XingyeMailProfile,
  type XingyePendingMailDraft,
} from './xingye-mail-store';
import {
  buildFallbackMailDrafts,
  generateMailInitDraftsWithAI,
  toMailMessageDrafts,
} from './xingye-mail-ai';
import type { XingyeRoleProfile } from './xingye-profile-store';

export interface PhoneMailAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

type Page =
  | { kind: 'home' }
  | { kind: 'list'; mailbox: XingyeMailMailbox }
  | { kind: 'detail'; messageId: string }
  | { kind: 'draft-edit'; draftId: string | null };

const MAILBOX_LABELS: Record<XingyeMailMailbox, string> = {
  inbox: '收件箱',
  sent: '发件箱',
  drafts: '草稿箱',
  promotions: '推广邮件',
  spam: '垃圾邮件',
};

const MAILBOX_SUBTITLES: Record<XingyeMailMailbox, string> = {
  inbox: '模拟收到的邮件',
  sent: '历史发件（仅模拟，未真实发送）',
  drafts: '本地保存的草稿',
  promotions: '模拟订阅 / 营销邮件',
  spam: '模拟钓鱼 / 低质邮件',
};

const KIND_LABELS: Record<string, string> = {
  agent: 'AGENT',
  virtual_contact: '联系人',
  system: '系统',
  promotion: '推广',
  spam: '垃圾',
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function snippetFor(message: XingyeMailMessage, max = 80): string {
  if (message.snippet && message.snippet.trim()) return message.snippet;
  const body = message.body.replace(/\s+/g, ' ').trim();
  if (!body) return '';
  if (body.length <= max) return body;
  return `${body.slice(0, Math.max(1, max - 1))}…`;
}

function countUnread(messages: XingyeMailMessage[], mailbox: XingyeMailMailbox): number {
  return messages.reduce(
    (acc, m) => (m.mailbox === mailbox && !m.isRead ? acc + 1 : acc),
    0,
  );
}

const DEFAULT_AVATAR_INITIAL = '@';

export function PhoneMailApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneMailAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [profile, setProfile] = useState<XingyeMailProfile | null>(null);
  const [messages, setMessages] = useState<XingyeMailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>({ kind: 'home' });
  const [starBusyId, setStarBusyId] = useState<string | null>(null);
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [draftSaveBusy, setDraftSaveBusy] = useState(false);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [pendingDrafts, setPendingDrafts] = useState<XingyePendingMailDraft[]>([]);
  /**
   * 「待确认草稿」行内编辑缓冲。Key = draft.id。
   * 用户在小手机里改了字、还没按「确认生成」前先在内存里保留改动；
   * 离开页面再回来时回退到 drafts.jsonl 的最新内容（草稿本身已落盘，不会丢）。
   */
  const [pendingDraftEdits, setPendingDraftEdits] = useState<
    Record<string, { subject: string; body: string; toAddress: string }>
  >({});
  const [pendingDraftBusyId, setPendingDraftBusyId] = useState<string | null>(null);
  const [pendingDraftError, setPendingDraftError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setProfile(null);
      setMessages([]);
      setPendingDrafts([]);
      setPendingDraftEdits({});
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [p, m, drafts] = await Promise.all([
        getMailProfile(ownerAgentId),
        listMailMessages(ownerAgentId),
        listMailDrafts(ownerAgentId),
      ]);
      setProfile(p);
      setMessages(m);
      setPendingDrafts(drafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  const pendingDraftWorkingValue = useCallback(
    (d: XingyePendingMailDraft) => {
      const edit = pendingDraftEdits[d.id];
      if (edit) return edit;
      return {
        subject: d.subject,
        body: d.body,
        toAddress: d.toAddress ?? '',
      };
    },
    [pendingDraftEdits],
  );

  const handlePendingDraftFieldChange = (
    draftId: string,
    patch: Partial<{ subject: string; body: string; toAddress: string }>,
  ) => {
    setPendingDraftEdits((prev) => {
      const d = pendingDrafts.find((entry) => entry.id === draftId);
      if (!d) return prev;
      const base = prev[draftId] ?? {
        subject: d.subject,
        body: d.body,
        toAddress: d.toAddress ?? '',
      };
      return { ...prev, [draftId]: { ...base, ...patch } };
    });
  };

  const handleConfirmPendingDraft = async (d: XingyePendingMailDraft) => {
    if (!ownerAgentId || !profile) return;
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const working = pendingDraftWorkingValue(d);
      const message = await confirmMailDraft(ownerAgentId, d.id, profile, {
        subject: working.subject,
        body: working.body,
        toAddress: working.toAddress.trim() ? working.toAddress : null,
      });
      setMessages((prev) =>
        [message, ...prev.filter((m) => m.id !== message.id)].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        ),
      );
      setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
      setPendingDraftEdits((prev) => {
        if (!(d.id in prev)) return prev;
        const { [d.id]: _omitted, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  const handleDiscardPendingDraft = async (d: XingyePendingMailDraft) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定丢弃这条待确认邮件草稿？此操作不可恢复，但角色可在下次巡检里重新提议。')) {
      return;
    }
    setPendingDraftBusyId(d.id);
    setPendingDraftError(null);
    try {
      const ok = await discardMailDraft(ownerAgentId, d.id);
      if (ok) {
        setPendingDrafts((prev) => prev.filter((p) => p.id !== d.id));
        setPendingDraftEdits((prev) => {
          if (!(d.id in prev)) return prev;
          const { [d.id]: _omitted, ...rest } = prev;
          return rest;
        });
      } else {
        await reload();
      }
    } catch (err) {
      setPendingDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingDraftBusyId(null);
    }
  };

  useEffect(() => {
    setPage({ kind: 'home' });
    setError(null);
    setAiError(null);
  }, [ownerAgentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const ta = displayName || ownerAgent?.name || 'TA';

  const handleInitProfile = async () => {
    if (!ownerAgentId || initBusy) return;
    setInitBusy(true);
    setError(null);
    try {
      const p = await ensureMailProfile(ownerAgentId, {
        displayName: ownerProfile?.displayName?.trim() || ownerAgent?.name || ta,
        agentName: ownerAgent?.name,
      });
      setProfile(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitBusy(false);
    }
  };

  const handleGenerateHistory = async () => {
    if (!ownerAgent || !profile || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      let drafts;
      try {
        drafts = await generateMailInitDraftsWithAI({
          agent: ownerAgent,
          ownerProfile: ownerProfile ?? null,
          ownerAddress: profile.address,
        });
      } catch (err) {
        drafts = buildFallbackMailDrafts({
          ownerAddress: profile.address,
          displayName: profile.displayName,
        });
        setAiError(
          err instanceof Error
            ? `模型未返回历史邮件，已使用本地模拟样例：${err.message}`
            : '模型未返回历史邮件，已使用本地模拟样例。',
        );
      }
      const toAddress = { name: profile.displayName, address: profile.address };
      const ready = toMailMessageDrafts(drafts, toAddress);
      if (!ready.length) {
        throw new Error('未生成任何模拟邮件');
      }
      const stored = await appendMailMessages(ownerAgentId, ready);
      setMessages((prev) => [...stored, ...prev].sort((a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ));
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const handleToggleStar = async (message: XingyeMailMessage) => {
    if (!ownerAgentId) return;
    setStarBusyId(message.id);
    try {
      const updated = await setMailMessageStar(ownerAgentId, message.id, !message.isStarred);
      if (updated) {
        setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarBusyId(null);
    }
  };

  const handleOpenDetail = async (message: XingyeMailMessage) => {
    setPage({ kind: 'detail', messageId: message.id });
    if (!message.isRead && ownerAgentId) {
      try {
        const updated = await updateMailMessage(ownerAgentId, message.id, { isRead: true });
        if (updated) {
          setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        }
      } catch {
        // 软失败：不阻塞详情页展示。
      }
    }
  };

  const openDraftCreate = () => {
    setDraftSubject('');
    setDraftBody('');
    setDraftTo('');
    setDraftSaveError(null);
    setPage({ kind: 'draft-edit', draftId: null });
  };

  const openDraftEdit = (message: XingyeMailMessage) => {
    setDraftSubject(message.subject);
    setDraftBody(message.body);
    setDraftTo(message.to.map((t) => t.address).join(', '));
    setDraftSaveError(null);
    setPage({ kind: 'draft-edit', draftId: message.id });
  };

  const parseToAddresses = (raw: string) => {
    return raw
      .split(/[,，;；\n]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((address) => ({ name: address.split('@')[0] || address, address }));
  };

  const handleSaveDraft = async (mode: 'draft' | 'simulated-send') => {
    if (!ownerAgentId || !profile) return;
    const subject = draftSubject.trim();
    const body = draftBody;
    if (!subject && !body.trim()) {
      setDraftSaveError('请填写主题或正文。');
      return;
    }
    setDraftSaveBusy(true);
    setDraftSaveError(null);
    try {
      const recipients = parseToAddresses(draftTo);
      const targetMailbox: XingyeMailMailbox = mode === 'draft' ? 'drafts' : 'sent';
      const from = { name: profile.displayName, address: profile.address, kind: 'agent' as const };
      const currentDraftId = page.kind === 'draft-edit' ? page.draftId : null;
      if (currentDraftId) {
        const updated = await updateMailMessage(ownerAgentId, currentDraftId, {
          subject,
          body,
          mailbox: targetMailbox,
          to: recipients,
        });
        if (updated) {
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== updated.id);
            return [updated, ...filtered].sort(
              (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
            );
          });
          setPage({ kind: 'list', mailbox: targetMailbox });
        } else {
          await reload();
          setPage({ kind: 'list', mailbox: targetMailbox });
        }
      } else {
        const draft: XingyeMailMessageDraft = {
          mailbox: targetMailbox,
          from,
          to: recipients,
          subject,
          body,
          isRead: true,
          source: mode === 'draft' ? 'draft' : 'simulated-send',
        };
        const saved = await appendMailMessage(ownerAgentId, draft);
        setMessages((prev) => [saved, ...prev].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        ));
        setPage({ kind: 'list', mailbox: targetMailbox });
      }
    } catch (err) {
      setDraftSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftSaveBusy(false);
    }
  };

  const handleDeleteMessage = async (message: XingyeMailMessage) => {
    if (!ownerAgentId) return;
    if (!window.confirm('确定删除这封模拟邮件？此操作不可恢复。')) return;
    setDeleteBusy(true);
    try {
      const ok = await deleteMailMessage(ownerAgentId, message.id);
      if (ok) {
        setMessages((prev) => prev.filter((m) => m.id !== message.id));
        if (page.kind === 'detail' && page.messageId === message.id) {
          setPage({ kind: 'list', mailbox: message.mailbox });
        }
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteBusy(false);
    }
  };

  const mailboxCounts = useMemo(() => {
    const out: Record<XingyeMailMailbox, { total: number; unread: number }> = {
      inbox: { total: 0, unread: 0 },
      sent: { total: 0, unread: 0 },
      drafts: { total: 0, unread: 0 },
      promotions: { total: 0, unread: 0 },
      spam: { total: 0, unread: 0 },
    };
    for (const m of messages) {
      const slot = out[m.mailbox];
      if (slot) {
        slot.total += 1;
        if (!m.isRead) slot.unread += 1;
      }
    }
    return out;
  }, [messages]);

  if (!ownerAgentId) {
    return (
      <div className={styles.phoneShell} aria-label="模拟邮箱">
        <div className={styles.phoneStatusBar}>
          <button type="button" className={styles.phoneBackButton} onClick={onBack}>
            返回首页
          </button>
          <span>邮箱</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneAppCard}>
            <h3 className={styles.phoneAppTitle}>模拟邮箱不可用</h3>
            <p className={styles.phoneAppHint}>请选择有效角色后再打开模拟邮箱。</p>
          </section>
        </div>
      </div>
    );
  }

  if (page.kind === 'list') {
    const mailbox = page.mailbox;
    const list = messages
      .filter((m) => m.mailbox === mailbox)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return (
      <div className={styles.phoneShell} aria-label={`${MAILBOX_LABELS[mailbox]}列表`}>
        <div className={styles.phoneStatusBar}>
          <button
            type="button"
            className={styles.phoneBackButton}
            onClick={() => setPage({ kind: 'home' })}
          >
            返回邮箱主页
          </button>
          <span>{MAILBOX_LABELS[mailbox]}</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneShoppingLayout}>
            <header className={styles.phoneShoppingHeader}>
              <p className={styles.phoneShoppingKicker}>SIMULATED MAILBOX</p>
              <h2 className={styles.phoneShoppingTitle}>{MAILBOX_LABELS[mailbox]}</h2>
              <p className={styles.phoneShoppingSafeNote}>
                {MAILBOX_SUBTITLES[mailbox]}。所有邮件都是 TA 小手机里的模拟数据，不连接任何真实邮件服务。
              </p>
            </header>
            {mailbox === 'drafts' ? (
              <button
                type="button"
                className={styles.phoneJournalPrimaryButton}
                onClick={openDraftCreate}
                data-testid="phone-mail-new-draft"
              >
                新增草稿
              </button>
            ) : null}
            {list.length === 0 ? (
              <p className={styles.phoneJournalEmpty} data-testid="phone-mail-list-empty">
                {mailbox === 'drafts' ? '草稿箱里还没有草稿。' : '这个邮箱里还没有邮件。'}
              </p>
            ) : null}
            <div className={styles.phoneShoppingList}>
              {list.map((message) => (
                <div
                  key={message.id}
                  className={styles.phoneShoppingCard}
                  data-testid={`phone-mail-row-${message.id}`}
                >
                  <button
                    type="button"
                    aria-label={message.isStarred ? '取消星标' : '加星标'}
                    className={styles.phoneShoppingStatusChip}
                    onClick={() => void handleToggleStar(message)}
                    disabled={starBusyId === message.id}
                    data-testid={`phone-mail-star-${message.id}`}
                  >
                    {message.isStarred ? '★' : message.autoStarred ? '☆ 自动' : '☆'}
                  </button>
                  <button
                    type="button"
                    className={styles.phoneShoppingCardMain}
                    onClick={() => void handleOpenDetail(message)}
                  >
                    <strong>
                      {message.isRead ? '' : '● '}
                      {message.from.name} · {message.subject}
                    </strong>
                    <span>{snippetFor(message)}</span>
                  </button>
                  <span className={styles.phoneShoppingPrice}>
                    {KIND_LABELS[message.from.kind] ?? '邮件'} · {shortDateTime(message.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (page.kind === 'detail') {
    const message = messages.find((m) => m.id === page.messageId) ?? null;
    if (!message) {
      return (
        <div className={styles.phoneShell} aria-label="邮件详情">
          <div className={styles.phoneStatusBar}>
            <button
              type="button"
              className={styles.phoneBackButton}
              onClick={() => setPage({ kind: 'home' })}
            >
              返回邮箱主页
            </button>
            <span>邮件详情</span>
          </div>
          <div className={styles.phoneBody}>
            <section className={styles.phoneAppCard}>
              <h3 className={styles.phoneAppTitle}>邮件已不存在</h3>
              <p className={styles.phoneAppHint}>这封邮件可能已被删除。</p>
            </section>
          </div>
        </div>
      );
    }
    return (
      <div className={styles.phoneShell} aria-label="邮件详情">
        <div className={styles.phoneStatusBar}>
          <button
            type="button"
            className={styles.phoneBackButton}
            onClick={() => setPage({ kind: 'list', mailbox: message.mailbox })}
          >
            返回 {MAILBOX_LABELS[message.mailbox]}
          </button>
          <span>邮件详情</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneShoppingDetail}>
            <p className={styles.phoneShoppingSafeNote}>
              这是 TA 小手机里的模拟邮件，未连接 Gmail / Outlook / SMTP / IMAP。
            </p>
            <div className={styles.phoneShoppingDetailHead}>
              <span className={styles.phoneShoppingStatusChip}>
                {KIND_LABELS[message.from.kind] ?? '邮件'}
              </span>
              <span className={styles.phoneShoppingPlatformChip}>{MAILBOX_LABELS[message.mailbox]}</span>
              {message.autoStarred ? (
                <span className={styles.phoneShoppingPlatformChip}>自动星标</span>
              ) : null}
            </div>
            <h2 className={styles.phoneShoppingDetailTitle}>{message.subject}</h2>
            <p className={styles.phoneShoppingMeta}>
              发件人：{message.from.name} &lt;{message.from.address}&gt;
            </p>
            <p className={styles.phoneShoppingMeta}>
              收件人：
              {message.to.length
                ? message.to.map((t) => `${t.name} <${t.address}>`).join('；')
                : '（无）'}
            </p>
            <p className={styles.phoneShoppingMeta}>{formatDateTime(message.createdAt)}</p>
            {message.labels.length ? (
              <div className={styles.phoneTagRow}>
                {message.labels.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            ) : null}
            <p className={styles.phoneShoppingBody} style={{ whiteSpace: 'pre-wrap' }}>
              {message.body || '（这封邮件没有正文。）'}
            </p>
            <div className={styles.phoneShoppingActions}>
              <button
                type="button"
                className={styles.phoneShortcutButton}
                onClick={() => void handleToggleStar(message)}
                disabled={starBusyId === message.id}
              >
                {message.isStarred ? '取消星标' : '手动星标'}
              </button>
              {message.mailbox === 'drafts' ? (
                <button
                  type="button"
                  className={styles.phoneShortcutButton}
                  onClick={() => openDraftEdit(message)}
                >
                  编辑草稿
                </button>
              ) : null}
              <button
                type="button"
                className={styles.phoneShortcutButton}
                onClick={() => void handleDeleteMessage(message)}
                disabled={deleteBusy}
              >
                删除这封邮件
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (page.kind === 'draft-edit') {
    return (
      <div className={styles.phoneShell} aria-label="草稿编辑">
        <div className={styles.phoneStatusBar}>
          <button
            type="button"
            className={styles.phoneBackButton}
            onClick={() => setPage({ kind: 'list', mailbox: 'drafts' })}
          >
            取消
          </button>
          <span>草稿编辑</span>
        </div>
        <div className={styles.phoneBody}>
          <section className={styles.phoneShoppingEditor}>
            <header className={styles.phoneShoppingHeader}>
              <p className={styles.phoneShoppingKicker}>SIMULATED DRAFT</p>
              <h2 className={styles.phoneShoppingTitle}>{page.draftId ? '编辑草稿' : '新增草稿'}</h2>
              <p className={styles.phoneShoppingSafeNote}>
                这只是 TA 小手机里的模拟草稿。「模拟发送」只会把它移到本地发件箱，不会真的寄出。
              </p>
            </header>
            <label className={styles.phoneFormField}>
              <span>收件人（多个用逗号分隔，仅模拟）</span>
              <input
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
                placeholder={`例如：friend@${XINGYE_MAIL_DOMAIN}`}
                data-testid="phone-mail-draft-to"
              />
            </label>
            <label className={styles.phoneFormField}>
              <span>主题</span>
              <input
                value={draftSubject}
                onChange={(e) => setDraftSubject(e.target.value)}
                data-testid="phone-mail-draft-subject"
              />
            </label>
            <label className={styles.phoneFormField}>
              <span>正文</span>
              <textarea
                rows={8}
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                data-testid="phone-mail-draft-body"
              />
            </label>
            {draftSaveError ? (
              <p className={styles.phoneAppHint} role="alert">
                {draftSaveError}
              </p>
            ) : null}
            <div className={styles.phoneShoppingActions}>
              <button
                type="button"
                className={styles.phoneJournalPrimaryButton}
                onClick={() => void handleSaveDraft('draft')}
                disabled={draftSaveBusy}
                data-testid="phone-mail-draft-save"
              >
                保存为草稿
              </button>
              <button
                type="button"
                className={styles.phoneShortcutButton}
                onClick={() => void handleSaveDraft('simulated-send')}
                disabled={draftSaveBusy}
                data-testid="phone-mail-draft-simulated-send"
              >
                模拟发送到发件箱
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  // home
  return (
    <div className={styles.phoneShell} aria-label="模拟邮箱">
      <div className={styles.phoneStatusBar}>
        <button type="button" className={styles.phoneBackButton} onClick={onBack}>
          返回首页
        </button>
        <span>邮箱</span>
      </div>
      <div className={styles.phoneBody}>
        <section className={styles.phoneShoppingLayout}>
          <header className={styles.phoneShoppingHeader}>
            <div
              className={styles.phoneAvatarFrame}
              aria-hidden="true"
              data-testid="phone-mail-default-avatar"
              style={{
                width: 56,
                height: 56,
                fontSize: '1.4rem',
                fontWeight: 600,
              }}
            >
              {DEFAULT_AVATAR_INITIAL}
            </div>
            <p className={styles.phoneShoppingKicker}>SIMULATED MAILBOX</p>
            <h2 className={styles.phoneShoppingTitle}>{ta} 的模拟邮箱</h2>
            <p className={styles.phoneShoppingSafeNote}>
              这是 TA 小手机里的虚拟邮箱外观（Gmail / Outlook 风格）。
              所有数据只是本地模拟，不连接任何真实邮件服务，也不会真的发送邮件。
            </p>
            {profile ? (
              <p className={styles.phoneShoppingMeta} data-testid="phone-mail-address">
                {profile.displayName} &lt;{profile.address}&gt;
              </p>
            ) : null}
          </header>

          {error ? (
            <p className={styles.phoneAppHint} role="alert">
              加载失败：{error}
            </p>
          ) : null}
          {loading && !profile && messages.length === 0 ? (
            <p className={styles.phoneAppHint}>加载中…</p>
          ) : null}

          {!profile ? (
            <section className={styles.phoneAppCard}>
              <h3 className={styles.phoneAppTitle}>邮箱尚未初始化</h3>
              <p className={styles.phoneAppHint}>
                给 {ta} 生成一个 agent 风格的模拟邮箱号；这只是 UI 层外观，不连接任何真实邮件服务。
              </p>
              <button
                type="button"
                className={styles.phoneJournalPrimaryButton}
                onClick={() => void handleInitProfile()}
                disabled={initBusy}
                data-testid="phone-mail-init-button"
              >
                {initBusy ? '初始化中…' : '初始化邮箱'}
              </button>
            </section>
          ) : (
            <>
              {pendingDrafts.length > 0 ? (
                <section
                  aria-label="待确认邮件草稿"
                  data-testid="phone-mail-pending-drafts"
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <p className={styles.phoneShoppingSafeNote}>
                    待确认草稿 · 来自心跳巡检。这些是 TA 在巡检里想写的信，还没出现在任何邮箱里。
                    点「确认生成」会写进草稿箱；离开页面再回来不会丢草稿。
                  </p>
                  {pendingDraftError ? (
                    <p className={styles.phoneAppHint} role="alert">
                      {pendingDraftError}
                    </p>
                  ) : null}
                  {pendingDrafts.map((d) => {
                    const working = pendingDraftWorkingValue(d);
                    const busy = pendingDraftBusyId === d.id;
                    return (
                      <div
                        key={d.id}
                        className={styles.phoneShoppingCard}
                        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
                        data-testid={`phone-mail-pending-draft-${d.id}`}
                      >
                        <input
                          type="text"
                          value={working.subject}
                          onChange={(e) => handlePendingDraftFieldChange(d.id, { subject: e.target.value })}
                          placeholder="主题（可空，但与正文不能同时为空）"
                          aria-label="待确认邮件草稿主题"
                          data-testid={`phone-mail-pending-draft-subject-${d.id}`}
                          disabled={busy}
                          style={{ font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                        />
                        <input
                          type="text"
                          value={working.toAddress}
                          onChange={(e) => handlePendingDraftFieldChange(d.id, { toAddress: e.target.value })}
                          placeholder={`收件人邮箱（可选，例 someone@${XINGYE_MAIL_DOMAIN}）`}
                          aria-label="待确认邮件草稿收件人"
                          data-testid={`phone-mail-pending-draft-to-${d.id}`}
                          disabled={busy}
                          style={{ font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '4px 6px' }}
                        />
                        <textarea
                          value={working.body}
                          onChange={(e) => handlePendingDraftFieldChange(d.id, { body: e.target.value })}
                          rows={4}
                          placeholder="正文"
                          aria-label="待确认邮件草稿正文"
                          data-testid={`phone-mail-pending-draft-body-${d.id}`}
                          disabled={busy}
                          style={{ width: '100%', font: 'inherit', background: 'transparent', border: '1px dashed rgba(0,0,0,0.2)', padding: '6px' }}
                        />
                        {d.reason ? (
                          <p className={styles.phoneAppHint} style={{ margin: 0 }}>
                            理由：{d.reason}
                          </p>
                        ) : null}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className={styles.phoneJournalPrimaryButton}
                            onClick={() => void handleConfirmPendingDraft(d)}
                            disabled={busy}
                            data-testid={`phone-mail-pending-draft-confirm-${d.id}`}
                          >
                            {busy ? '处理中…' : '确认生成（进草稿箱）'}
                          </button>
                          <button
                            type="button"
                            className={styles.phoneModalGhostButton}
                            onClick={() => void handleDiscardPendingDraft(d)}
                            disabled={busy}
                            data-testid={`phone-mail-pending-draft-discard-${d.id}`}
                          >
                            丢弃
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : null}

              <div className={styles.phoneShoppingList}>
                {XINGYE_MAIL_MAILBOXES.map((mailbox) => {
                  const meta = mailboxCounts[mailbox];
                  return (
                    <button
                      key={mailbox}
                      type="button"
                      className={styles.phoneShoppingCard}
                      onClick={() => setPage({ kind: 'list', mailbox })}
                      data-testid={`phone-mail-open-${mailbox}`}
                    >
                      <span className={styles.phoneShoppingStatusChip}>
                        {MAILBOX_LABELS[mailbox]}
                      </span>
                      <span className={styles.phoneShoppingCardMain}>
                        <strong>{MAILBOX_LABELS[mailbox]}</strong>
                        <span>{MAILBOX_SUBTITLES[mailbox]}</span>
                      </span>
                      <span className={styles.phoneShoppingPrice}>
                        {meta.unread ? `${meta.unread} 未读 / ` : ''}共 {meta.total} 封
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className={styles.phoneShoppingActions}>
                <button
                  type="button"
                  className={styles.phoneJournalPrimaryButton}
                  onClick={() => void handleGenerateHistory()}
                  disabled={aiBusy}
                  data-testid="phone-mail-generate-history"
                >
                  {aiBusy ? '整理中…' : '整理一批历史邮件'}
                </button>
                <button
                  type="button"
                  className={styles.phoneShortcutButton}
                  onClick={openDraftCreate}
                  data-testid="phone-mail-open-draft-edit"
                >
                  写一封模拟邮件
                </button>
              </div>
              {aiError ? (
                <p className={styles.phoneAppHint} role="alert">
                  {aiError}
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
