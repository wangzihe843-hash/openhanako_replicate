/**
 * @vitest-environment jsdom
 *
 * 覆盖健康 App 的三件事：
 *  - 空数据 → 点「AI 生成」走通生成 + upsert 并落地当天；
 *  - 跨角色 reload 竞态守卫（reloadSeqRef）：旧角色后落地的读取不覆盖新角色；
 *  - 生成失败时显示错误且不写入。
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { makeHealthDay, todayIsoDate, type XingyeHealthDay } from './xingye-health-data';

const healthStoreMock = vi.hoisted(() => ({
  listHealthDays: vi.fn().mockResolvedValue([]),
  upsertHealthDay: vi.fn(),
  getHealthDay: vi.fn().mockResolvedValue(null),
}));

const healthAiMock = vi.hoisted(() => ({
  generateHealthDayWithAI: vi.fn(),
}));

const profileMock = vi.hoisted(() => ({
  useXingyeRoleProfile: vi.fn(() => null),
  useXingyeRoleProfiles: vi.fn(() => ({})),
}));

vi.mock('./xingye-health-store', () => healthStoreMock);
vi.mock('./xingye-health-ai', () => healthAiMock);
vi.mock('./xingye-profile-store', () => profileMock);

import { PhoneHealthApp } from './PhoneHealthApp';

const linwu: Agent = {
  id: 'linwu',
  name: '林雾',
  yuan: 'hanako',
  isPrimary: false,
  hasAvatar: false,
};

function renderApp(agent: Agent | null = linwu) {
  return render(<PhoneHealthApp ownerAgent={agent} displayName={agent?.name ?? 'TA'} onBack={vi.fn()} />);
}

function dayWithAdvice(isoDate: string, body: string): XingyeHealthDay {
  return makeHealthDay({
    isoDate,
    scenario: 'calm',
    advice: { title: '今日分析', body, generatedAt: '09:00' },
    source: 'ai',
  });
}

beforeEach(() => {
  healthStoreMock.listHealthDays.mockReset();
  healthStoreMock.listHealthDays.mockResolvedValue([]);
  healthStoreMock.upsertHealthDay.mockReset();
  healthAiMock.generateHealthDayWithAI.mockReset();
  profileMock.useXingyeRoleProfile.mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PhoneHealthApp · 生成', () => {
  it('空数据时点「AI 生成」→ 调用生成 + upsert 并落地当天', async () => {
    healthStoreMock.listHealthDays.mockResolvedValue([]);
    healthAiMock.generateHealthDayWithAI.mockResolvedValue({
      scenario: 'calm',
      advice: { title: '今日分析', body: '今天状态平稳。', generatedAt: '09:00' },
    });
    healthStoreMock.upsertHealthDay.mockImplementation(async (_aid: string, day: XingyeHealthDay) => [day]);

    renderApp();
    await screen.findByTestId('phone-health-empty');

    fireEvent.click(screen.getByText('AI 生成今日健康'));

    await waitFor(() => {
      expect(healthAiMock.generateHealthDayWithAI).toHaveBeenCalled();
      expect(healthStoreMock.upsertHealthDay).toHaveBeenCalledWith(
        'linwu',
        expect.objectContaining({ isoDate: todayIsoDate(), source: 'ai' }),
      );
    });
    // 落地后建议正文出现、空态消失。
    await screen.findByText('今天状态平稳。');
    expect(screen.queryByTestId('phone-health-empty')).not.toBeInTheDocument();
  });

  it('生成失败 → 显示错误且不写入', async () => {
    healthStoreMock.listHealthDays.mockResolvedValue([]);
    healthAiMock.generateHealthDayWithAI.mockRejectedValue(new Error('模型抽风'));

    renderApp();
    await screen.findByTestId('phone-health-empty');

    fireEvent.click(screen.getByText('AI 生成今日健康'));

    await screen.findByText(/生成失败/);
    expect(healthStoreMock.upsertHealthDay).not.toHaveBeenCalled();
  });
});

/**
 * 跨角色 reload 竞态：见 PhoneAccountingApp/PhoneSecondhandApp 的同款守卫。
 * reloadSeqRef 单调请求号 + effect cleanup 让上一个角色还在飞的 listHealthDays
 * 最后才落地时无法 setState 覆盖新角色。
 */
describe('PhoneHealthApp · 跨角色 reload 竞态', () => {
  const agentB: Agent = { ...linwu, id: 'agentB', name: 'B' };

  it('切换角色后，旧角色后落地的 reload 不覆盖新角色健康数据', async () => {
    // 受控 deferred：让 A 的 listHealthDays 一直挂着，切到 B 后再 resolve A。
    let resolveA: (days: XingyeHealthDay[]) => void = () => {};
    const aPromise = new Promise<XingyeHealthDay[]>((resolve) => {
      resolveA = resolve;
    });

    healthStoreMock.listHealthDays.mockImplementation((aid: string) => {
      if (aid === 'linwu') return aPromise;
      if (aid === 'agentB') return Promise.resolve([dayWithAdvice('2026-05-21', '乙的建议正文')]);
      return Promise.resolve([]);
    });

    const { rerender } = render(
      <PhoneHealthApp ownerAgent={linwu} displayName="林雾" onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(healthStoreMock.listHealthDays).toHaveBeenCalledWith('linwu');
    });

    // 切到 B：触发新一轮 reload（cleanup 让上一轮失效）。
    rerender(<PhoneHealthApp ownerAgent={agentB} displayName="B" onBack={vi.fn()} />);
    await screen.findByText('乙的建议正文');

    // 现在 A 的旧读取才落地——必须被请求号守卫丢弃，不能覆盖 B。
    resolveA([dayWithAdvice('2026-05-21', '甲的建议正文')]);
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText('乙的建议正文')).toBeInTheDocument();
    expect(screen.queryByText('甲的建议正文')).not.toBeInTheDocument();
  });
});
