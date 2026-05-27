import { useStore } from '../stores';
import { listLoreEntries } from './xingye-lore-store';
import { getVirtualContacts } from './xingye-phone-store';
import { getXingyePersistenceStorage } from './xingye-persistence';
import { readXingyeRoleProfile } from './xingye-profile-store';
import {
  collectHiddenPasswordCandidates,
  pickRandomCandidate,
} from './xingye-files-secret-passwords';
import {
  maybeRelockOnHeartbeat,
  readHiddenFolderState,
  type XingyeHiddenFolderState,
} from './xingye-files-secret-store';

export const DEFAULT_HIDDEN_FOLDER_RELOCK_PROBABILITY = 0.02;

/**
 * 心跳成功后调用：如果隐藏文件夹当前处于解锁状态，**以 2% 概率**让 agent 自己换密码 + 重新锁上。
 *
 * 这是有意为之的「随机性」——每次心跳成功才滚一次骰子，
 * 用户必须重新猜密码，恢复仪式感。永远不会重锁也是可以的（运气好）。
 *
 * 为什么不在服务端做：候选池只在客户端能算出来（lore / contacts 都在 localStorage）。
 * 服务端 heartbeat 也无法 hash 密码 / 写隐藏 state 之外的事情。
 *
 * 失败语义：所有错误都 swallow——重锁是 best-effort，不能阻塞心跳 UI。
 */
export async function tryRelockHiddenFolderAfterHeartbeat(
  agent: { id: string; name?: string; yuan?: string } | null,
  options: {
    probability?: number;
    randomSource?: () => number;
  } = {},
): Promise<{ relocked: boolean; state: XingyeHiddenFolderState | null }> {
  if (!agent?.id) return { relocked: false, state: null };
  const aid = agent.id;
  try {
    const state = await readHiddenFolderState(aid);
    if (state.locked) return { relocked: false, state };

    const storage = getXingyePersistenceStorage();
    const lore = listLoreEntries(aid, storage);
    const contacts = getVirtualContacts(aid, storage);
    const userName = useStore.getState().userName;
    const profile = await readXingyeRoleProfile(aid);

    const candidates = collectHiddenPasswordCandidates({
      agent: { id: aid, name: agent.name ?? '', yuan: agent.yuan ?? '' },
      profile,
      userName,
      loreEntries: lore,
      virtualContacts: contacts,
    });
    if (!candidates.length) return { relocked: false, state };

    const picked = pickRandomCandidate(candidates, {
      randomSource: options.randomSource,
    });
    if (!picked) return { relocked: false, state };

    return await maybeRelockOnHeartbeat(aid, {
      nextPassword: picked.value,
      nextCandidateLabel: picked.label,
      probability: options.probability ?? DEFAULT_HIDDEN_FOLDER_RELOCK_PROBABILITY,
      randomSource: options.randomSource,
    });
  } catch (error) {
    console.warn('[xingye-files-secret-heartbeat] relock check failed:', error);
    return { relocked: false, state: null };
  }
}
