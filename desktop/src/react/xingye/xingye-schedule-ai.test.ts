/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../hooks/use-hana-fetch', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(),
}));

import { hanaFetch } from '../hooks/use-hana-fetch';
import { invalidateConfigCache } from '../hooks/use-config';
import { useStore } from '../stores';
import { postXingyeStorage } from './xingye-storage-api';
import { buildScheduleDraftPrompt } from './xingye-schedule-prompts';
import {
  buildScheduleAiDebugSnapshot,
  buildScheduleRecentChatExcerpts,
  formatScheduleRecentChatExcerptsForPrompt,
  generateScheduleDraftWithAI,
  normalizeScheduleDraftResult,
} from './xingye-schedule-ai';

describe('normalizeScheduleDraftResult', () => {
  it('accepts schedule draft JSON and defaults status to planned', () => {
    expect(normalizeScheduleDraftResult({
      title: '睡前发消息',
      dateLabel: '今晚睡前',
      timeText: '睡前',
      content: '确认她有没有按时休息。',
      note: '不要太晚。',
    })).toEqual({
      title: '睡前发消息',
      dateLabel: '今晚睡前',
      timeText: '睡前',
      content: '确认她有没有按时休息。',
      note: '不要太晚。',
      status: 'planned',
    });
  });

  it('rejects responses without a concrete arrangement', () => {
    expect(normalizeScheduleDraftResult({ title: '随便看看', content: '材料不足' })).toBeNull();
    expect(normalizeScheduleDraftResult({ message: '没有明确安排' })).toBeNull();
  });
});

describe('buildScheduleDraftPrompt', () => {
  it('frames entries as phone schedule records, not reminders or OpenHanako tasks', () => {
    const prompt = buildScheduleDraftPrompt({
      agent: { id: 'linwu', name: '林雾', yuan: 'hanako' as const },
      profile: null,
      userIntent: '今晚睡前记得问她有没有喝水',
      recentSceneBlock: '[用户] 今晚睡前我再问你有没有喝水。',
      stableLoreBlock: '林雾不喜欢把私事公开。',
      keywordLoreBlock: '',
      relationshipBlock: '',
      heartbeatBlock: '',
    });

    expect(prompt).toContain('小手机日程');
    expect(prompt).toContain('角色手机里的安排记录');
    expect(prompt).toContain('不是系统提醒');
    expect(prompt).toContain('不要写成 OpenHanako 任务');
    expect(prompt).toContain('如果聊天里没有明确安排，不要硬编');
    expect(prompt).toContain('"dateLabel"');
  });

  it('distinguishes user companion from supplier counterparty for inspection schedules', () => {
    for (const currentUserName of ['莉莉丝', '莫子']) {
      const recentChatBlock = formatScheduleRecentChatExcerptsForPrompt([
        {
          speaker: 'user',
          speakerLabel: `用户 ${currentUserName}`,
          text: '下次他送货，我们不直接收。我陪你一起验货：先看药盒有没有压痕，再看封条有没有拆过，批号和进货单要对上，最后闻一下气味。',
        },
      ]);

      const prompt = buildScheduleDraftPrompt({
        agent: { id: 'linwu', name: '林雾', yuan: 'hanako' as const },
        userName: currentUserName,
        profile: null,
        userIntent: '',
        recentSceneBlock: recentChatBlock,
        stableLoreBlock: '刘老板是供货商、送货方、被验收和被核查对象。',
        keywordLoreBlock: '',
        relationshipBlock: '',
        heartbeatBlock: '',
      });

      expect(prompt).toContain('currentAgent');
      expect(prompt).toContain('林雾');
      expect(prompt).toContain('currentUserName');
      expect(prompt).toContain(currentUserName);
      expect(prompt).toContain('user 消息中的“我”指');
      expect(prompt).toContain('user 消息中的“你”指');
      expect(prompt).toContain('agent 消息中的“我”指');
      expect(prompt).toContain('agent 消息中的“你”指');
      expect(prompt).toContain('companion');
      expect(prompt).toContain('counterparty');
      expect(prompt).toContain('mentionedPerson');
      expect(prompt).toContain(`[用户 ${currentUserName}]`);
      expect(prompt).toContain('我陪你一起验货');
      expect(prompt).toContain('companion=user');
      expect(prompt).toContain('counterparty');
      expect(prompt).toContain('刘老板送来的药品');
      expect(prompt).toContain(`和${currentUserName}一起验收刘老板送来的药品`);
      expect(prompt).toContain('不得写“与刘老板验药”');
      expect(prompt).toContain('“和刘老板一起验药”');
      if (currentUserName === '莫子') {
        expect(prompt).not.toContain('和莉莉丝一起验收刘老板送来的药品');
      }
    }
  });
});

describe('schedule AI context helpers', () => {
  it('prefers speaker-labeled recent chat excerpts and builds sanitized debug snapshots', () => {
    const excerpts = buildScheduleRecentChatExcerpts({
      agentName: '林雾',
      userName: '莉莉丝',
      context: {
        agentId: 'linwu',
        hasOpenHanakoMessages: true,
        sourceNotes: [],
        summaryText: '[用户] 下次他送货，我们不直接收。',
        messages: [
          {
            role: 'user',
            source: 'openhanako_chat',
            content: '下次他送货，我们不直接收。我陪你一起验货：先看药盒有没有压痕，再看封条有没有拆过，批号和进货单要对上，最后闻一下气味。',
          },
          {
            role: 'assistant',
            source: 'openhanako_chat',
            content: '我会记住，不会直接收。',
          },
        ],
      },
    });

    expect(excerpts).toEqual([
      expect.objectContaining({
        speaker: 'user',
        speakerLabel: '用户 莉莉丝',
        text: expect.stringContaining('我陪你一起验货'),
      }),
      expect.objectContaining({
        speaker: 'currentAgent',
        speakerLabel: '当前角色 林雾',
        text: '我会记住，不会直接收。',
      }),
    ]);

    const promptBlock = formatScheduleRecentChatExcerptsForPrompt(excerpts);
    expect(promptBlock).toContain('[用户 莉莉丝]');
    expect(promptBlock).toContain('[当前角色 林雾]');

    const snapshot = buildScheduleAiDebugSnapshot({
      userName: '莉莉丝',
      agentName: '林雾',
      recentChatExcerpts: excerpts,
      prompt: [
        '小手机日程草稿',
        'currentAgent=林雾',
        'user=莉莉丝',
        'recent chat excerpts with speaker labels',
        'x'.repeat(1200),
      ].join('\n'),
    });

    expect(snapshot.userName).toBe('莉莉丝');
    expect(snapshot.agentName).toBe('林雾');
    expect(snapshot.recentChatExcerpts[0]).toEqual({
      speakerLabel: '用户 莉莉丝',
      text: expect.stringContaining('我陪你一起验货'),
    });
    expect(snapshot.promptSummary.length).toBeLessThanOrEqual(900);
    expect(JSON.stringify(snapshot)).not.toContain('sk-');
  });
});

describe('generateScheduleDraftWithAI', () => {
  beforeEach(() => {
    invalidateConfigCache();
    useStore.setState({ userName: 'User' });
    vi.mocked(postXingyeStorage).mockReset();
    vi.mocked(hanaFetch).mockReset();
    vi.mocked(postXingyeStorage).mockResolvedValue({ missing: true } as never);
    vi.mocked(hanaFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          title: '睡前发消息',
          dateLabel: '今晚睡前',
          timeText: '睡前',
          content: '确认她有没有按时休息。',
          status: 'planned',
        },
      }),
    } as Response);
  });

  it('posts phone-generate with kind schedule_draft and owner agent scope', async () => {
    const agent = { id: 'linwu', name: '林雾', yuan: 'hanako' as const };
    await expect(generateScheduleDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      userIntent: '今晚睡前',
    })).resolves.toMatchObject({
      title: '睡前发消息',
      dateLabel: '今晚睡前',
      status: 'planned',
    });

    const phoneGenerateCall = vi.mocked(hanaFetch).mock.calls.find((call) => call[0] === '/api/xingye/phone-generate');
    const bodyStr = String(phoneGenerateCall?.[1]?.body ?? '');
    const body = JSON.parse(bodyStr) as { kind?: string; ownerAgentId?: string; agentId?: string; prompt?: string };
    expect(body.kind).toBe('schedule_draft');
    expect(body.ownerAgentId).toBe('linwu');
    expect(body.agentId).toBe('linwu');
    expect(body.prompt).toContain('用户输入的日程意图');
  });

  it('uses dynamic config user.name ahead of store fallback when building schedule prompts', async () => {
    useStore.setState({ userName: '莉莉丝' });
    vi.mocked(hanaFetch).mockImplementation(async (url) => {
      if (url === '/api/config') {
        return {
          ok: true,
          json: async () => ({ user: { name: '莫子' } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            title: '验收药品',
            dateLabel: '下次送货时',
            content: '和莫子一起验收刘老板送来的药品。',
            status: 'planned',
          },
        }),
      } as Response;
    });

    const agent = { id: 'linwu', name: '林雾', yuan: 'hanako' as const };
    await generateScheduleDraftWithAI({
      agent: agent as never,
      ownerProfile: null,
      userIntent: '下次验货',
    });

    const phoneGenerateCall = vi.mocked(hanaFetch).mock.calls.find((call) => call[0] === '/api/xingye/phone-generate');
    const bodyStr = String(phoneGenerateCall?.[1]?.body ?? '');
    const body = JSON.parse(bodyStr) as { prompt?: string };
    expect(body.prompt).toContain('currentUserName=莫子');
    expect(body.prompt).toContain('user 消息中的“我”指 currentUserName=莫子');
    expect(body.prompt).not.toContain('currentUserName=莉莉丝');
  });
});
