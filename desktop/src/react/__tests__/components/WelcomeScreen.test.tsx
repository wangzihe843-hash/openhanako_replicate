/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../stores';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(async (_path: string, _opts?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  loadModels: vi.fn(),
}));

vi.mock('../../hooks/use-hana-fetch', () => ({
  hanaFetch: (path: string, opts?: RequestInit) => mocks.hanaFetch(path, opts),
}));

vi.mock('../../utils/ui-helpers', () => ({
  loadModels: () => mocks.loadModels(),
}));

const translations: Record<string, string | string[] | Record<string, { avatar: string }>> = {
  'input.workspace': '工作台：',
  'input.project': '项目：',
  'input.currentWorkspace': '本次工作台',
  'input.cwdProject': '工作台项目：{name}',
  'input.customProjects': '自定义项目',
  'input.selectProject': '选择项目',
  'input.noCustomProjects': '暂无自定义项目',
  'input.selectOtherFolder': '选择其他文件夹',
  'input.removeRecentWorkspace': '从列表移除',
  'input.extraFolders': '额外文件夹',
  'input.addExternalFolder': '添加工作台以外的文件夹',
  'welcome.messages': ['想到什么就说什么吧~'],
  'yuan.welcome.hanako': ['想到什么就说什么吧~'],
  'welcome.memoryOn': '记忆',
  'welcome.memoryOff': '此次聊天不参考记忆',
  'welcome.memoryDisabled': '记忆已关闭',
  'yuan.types': { hanako: { avatar: 'Hanako.png' } },
};

describe('WelcomeScreen workspace picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const t = vi.fn((key: string, vars?: Record<string, string | number>) => {
      const template = translations[key] ?? key;
      return typeof template === 'string'
        ? template.replace(/\{(\w+)\}/g, (_match, name) => String(vars?.[name] ?? `{${name}}`))
        : template;
    });
    vi.stubGlobal('t', t);
    window.t = t as typeof window.t;
    window.platform = { selectFolder: vi.fn() } as unknown as typeof window.platform;
    useStore.setState({
      welcomeVisible: true,
      agents: [],
      agentName: 'Hanako',
      agentAvatarUrl: null,
      agentYuan: 'hanako',
      currentAgentId: null,
      selectedAgentId: null,
      memoryEnabled: true,
      selectedFolder: '/workspace/Desktop',
      homeFolder: '/workspace/Desktop/project-hana',
      cwdHistory: ['/workspace/Desktop/project-hana'],
      workspaceFolders: ['/workspace/Reference'],
      serverPort: 62950,
      serverToken: 'test-token',
      pendingProjectId: null,
      sessionProjectCatalog: {
        folders: [],
        projects: [
          { id: 'project-writing', name: '写作项目', folderId: null, order: 0 },
        ],
      },
      sessionProjectCatalogLoaded: true,
      locale: 'zh',
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('groups primary workspace selection before extra folders', async () => {
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /工作台：Desktop/ }));

    const currentLabel = screen.getByText('本次工作台');
    const selectOther = screen.getByText('选择其他文件夹');
    const extraLabel = screen.getByText('额外文件夹');
    const addExternal = screen.getByText('添加工作台以外的文件夹');

    expect(currentLabel.compareDocumentPosition(selectOther) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(selectOther.compareDocumentPosition(extraLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(extraLabel.compareDocumentPosition(addExternal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('removes a recent workspace from the picker without switching workspace', async () => {
    mocks.hanaFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      cwd_history: [],
    }), { status: 200 }));
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /工作台：Desktop/ }));
    fireEvent.click(screen.getByRole('button', { name: '从列表移除' }));

    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(useStore.getState().cwdHistory).toEqual([]);
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/config/workspaces/recent', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ path: '/workspace/Desktop/project-hana' }),
    }));
  });

  it('shows the cwd project as the default new-session project', async () => {
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);

    expect(screen.getByRole('button', { name: /项目：Desktop/ })).toBeInTheDocument();
    expect(useStore.getState().pendingProjectId).toBeNull();
  });

  it('lets the pending new-session draft choose a custom project without changing the workspace', async () => {
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /项目：Desktop/ }));
    fireEvent.click(screen.getByText('写作项目'));

    expect(useStore.getState().pendingProjectId).toBe('project-writing');
    expect(useStore.getState().selectedFolder).toBe('/workspace/Desktop');
    expect(screen.getByRole('button', { name: /项目：写作项目/ })).toBeInTheDocument();
  });

  it('disables the memory toggle when the selected agent has memory disabled in settings', async () => {
    useStore.setState({
      agents: [
        { id: 'hana', name: 'Hanako', yuan: 'hanako', isPrimary: true, memoryMasterEnabled: false },
      ],
      currentAgentId: 'hana',
      memoryEnabled: true,
    } as never);
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    const button = screen.getByRole('button', { name: '记忆已关闭' });
    fireEvent.click(button);

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(useStore.getState().memoryEnabled).toBe(true);
  });

  it('selects the target agent workbench when choosing an agent on the welcome screen', async () => {
    useStore.setState({
      agents: [
        {
          id: 'hana',
          name: 'Hanako',
          yuan: 'hanako',
          isPrimary: true,
          homeFolder: '/workspace/Hana',
          chatModel: { id: 'deepseek-chat', provider: 'deepseek' },
        },
        {
          id: 'mio',
          name: 'Mio',
          yuan: 'hanako',
          isPrimary: false,
          homeFolder: '/workspace/Mio',
          chatModel: { id: 'gpt-5.2', provider: 'openai' },
        },
      ],
      currentAgentId: 'hana',
      selectedAgentId: null,
      selectedFolder: '/workspace/Hana',
      homeFolder: '/workspace/Hana',
      workspaceFolders: ['/workspace/Reference'],
    } as never);
    const { WelcomeScreen } = await import('../../components/WelcomeScreen');

    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Mio/ }));

    expect(useStore.getState().selectedAgentId).toBe('mio');
    expect(useStore.getState().selectedFolder).toBe('/workspace/Mio');
    expect(useStore.getState().workspaceFolders).toEqual([]);
    expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/models/set', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ modelId: 'gpt-5.2', provider: 'openai' }),
    }));
  });
});
