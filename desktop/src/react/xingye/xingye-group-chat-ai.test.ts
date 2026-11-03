/**
 * 群聊「流式反重复锚点」单测：buildGroupChatOwnReplyContinuityAnchorBlock。
 *
 * 这是 group-chat 的去重核心——抽取 agent 自己在群里最近说过的话，作为反重复
 * 锚点喂回 prompt。和 news / journal 之类「卡片型 anchor」不同，这里是对
 * 流式上下文的轻量抽样：仅 sender 命中 agent.id 且没有身份冲突时视为自己发言。
 *
 * 单独测试这个纯函数（不走 hanaFetch），让跨会话隔离 / 空历史 / 长截断行为
 * 都能稳定回归。
 */
import { describe, expect, it } from 'vitest';
import { buildGroupChatOwnReplyContinuityAnchorBlock } from './xingye-group-chat-ai';

describe('buildGroupChatOwnReplyContinuityAnchorBlock', () => {
  it('does not claim a sender string shared by the user name and agent ID', () => {
    expect(buildGroupChatOwnReplyContinuityAnchorBlock({
      agentId: 'agent-a', agentName: '角色名', userName: 'agent-a',
      recentMessages: [{ sender: 'agent-a', timestamp: 't', body: '原文仍属于身份不明的来源。' }],
    })).toBe('');
  });

  it('does not turn same-name user/NPC quotes into the current agent’s own reply anchor', () => {
    const quoted = '阿陶说：「我把吉他借给你。」';
    const recentMessages = [
      { sender: '小岑', timestamp: 't1', body: quoted },
      { sender: 'agent-b', timestamp: 't2', body: '我自己的事。' },
      { sender: 'agent-a', timestamp: 't3', body: '我收到了转述。' },
    ];
    const before = structuredClone(recentMessages);
    const anchor = buildGroupChatOwnReplyContinuityAnchorBlock({
      agentId: 'agent-a', agentName: '小岑', recentMessages,
    });
    expect(anchor).toContain('[t3] 我收到了转述。');
    expect(anchor).not.toContain(quoted);
    expect(anchor).not.toContain('我自己的事。');
    expect(recentMessages).toEqual(before);
  });

  it('无 recentMessages → 空串', () => {
    expect(
      buildGroupChatOwnReplyContinuityAnchorBlock({
        agentId: 'a',
        agentName: 'A',
        recentMessages: [],
      }),
    ).toBe('');
  });

  it('agent 在群里发过言 → 抽自己的近期发言，渲染反重复指令', () => {
    const block = buildGroupChatOwnReplyContinuityAnchorBlock({
      agentId: 'agent-a',
      agentName: 'Linwu',
      recentMessages: [
        { sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'A 在吗？' },
        { sender: 'agent-a', timestamp: '2026-05-15 09:01', body: '在的，我刚处理完伤员。' },
        { sender: 'agent-b', timestamp: '2026-05-15 09:02', body: '你休息一下吧。' },
        { sender: 'agent-a', timestamp: '2026-05-15 09:03', body: '没事，体力还撑得住。' },
      ],
    });
    expect(block).toContain('Linwu');
    expect(block).toContain('避免再写几乎相同');
    // 倒序展示：最近的在最上面
    expect(block).toContain('体力还撑得住');
    expect(block).toContain('刚处理完伤员');
    // 别人的发言不应该混进 anchor（那是 history 的活）
    expect(block).not.toContain('你休息一下吧');
    expect(block).not.toContain('A 在吗');
  });

  it('agent 从未发言 → 空串', () => {
    expect(
      buildGroupChatOwnReplyContinuityAnchorBlock({
        agentId: 'agent-a',
        agentName: 'Linwu',
        recentMessages: [
          { sender: 'liyu', timestamp: '2026-05-15 09:00', body: 'A 在吗？' },
          { sender: 'agent-b', timestamp: '2026-05-15 09:01', body: '不知道。' },
        ],
      }),
    ).toBe('');
  });

  it('跨群隔离：只取入参 recentMessages 中的发言，不混入其它来源', () => {
    // 函数本身是纯函数；它只看入参 recentMessages，所以"跨群隔离"在调用方
    // 已经天然保证（不同 channel 调 fetchChannel 取不同 messages）。这条测试
    // 是把契约钉死：传 channelA 的 recentMessages，渲染结果里绝不可能出现
    // channelB 的内容。
    const channelA = buildGroupChatOwnReplyContinuityAnchorBlock({
      agentId: 'agent-a',
      agentName: 'Linwu',
      recentMessages: [
        { sender: 'agent-a', timestamp: '2026-05-15 09:00', body: 'A 群里的话题：占卜' },
      ],
    });
    const channelB = buildGroupChatOwnReplyContinuityAnchorBlock({
      agentId: 'agent-a',
      agentName: 'Linwu',
      recentMessages: [
        { sender: 'agent-a', timestamp: '2026-05-15 10:00', body: 'B 群里的话题：报纸' },
      ],
    });
    expect(channelA).toContain('A 群里的话题');
    expect(channelA).not.toContain('B 群里的话题');
    expect(channelB).toContain('B 群里的话题');
    expect(channelB).not.toContain('A 群里的话题');
  });

  it('agent 自己发过很多 → 最多保留 8 条，最近的优先', () => {
    const messages = [];
    for (let i = 0; i < 12; i += 1) {
      messages.push({
        sender: 'agent-a',
        timestamp: `2026-05-15 09:${String(i).padStart(2, '0')}`,
        body: `第${i}条`,
      });
    }
    const block = buildGroupChatOwnReplyContinuityAnchorBlock({
      agentId: 'agent-a',
      agentName: 'Linwu',
      recentMessages: messages,
    });
    // 最新（i=11）必出现
    expect(block).toContain('第11条');
    // 8 条窗口外（i=0..3）不应出现
    expect(block).not.toContain('第0条');
    expect(block).not.toContain('第3条');
  });

  it('body 超过 30 字 → 截断', () => {
    const long = '一'.repeat(80);
    const block = buildGroupChatOwnReplyContinuityAnchorBlock({
      agentId: 'agent-a',
      agentName: 'Linwu',
      recentMessages: [
        { sender: 'agent-a', timestamp: '2026-05-15 09:00', body: long },
      ],
    });
    // 30 字 + prefix + timestamp，但绝不能全 80 字
    expect(block.length).toBeLessThan(long.length + 100);
  });
});


describe('own-reply continuity Unicode budget', () => {
  it.each(['😀', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', 'e\u0301'])('keeps the 30 UTF-16-unit snippet limit without splitting %s', cluster => {
    const messages = [{ sender: 'agent-a', timestamp: 't', body: 'x' + cluster.repeat(40) }];
    const before = structuredClone(messages);
    const text = buildGroupChatOwnReplyContinuityAnchorBlock({ agentId: 'agent-a', agentName: 'Role', userName: '访客', recentMessages: messages });
    const snippet = text.split('  · [t] ')[1];
    expect(snippet).toBe('x' + cluster.repeat(Math.floor(29 / cluster.length)));
    expect(snippet.length).toBeLessThanOrEqual(30);
    expect(messages).toEqual(before);
  });
});
