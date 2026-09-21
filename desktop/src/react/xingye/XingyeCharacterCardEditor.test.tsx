/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XingyeCharacterCardEditor } from './XingyeCharacterCardEditor';
import type { XingyeRoleProfile } from './xingye-profile-store';

const mocks = vi.hoisted(() => ({ save: vi.fn(), connection: 'local' }));
vi.mock('./xingye-profile-store', () => ({
  saveXingyeRoleProfile: (...args: unknown[]) => mocks.save(...args),
  xingyeProfileConnectionKey: () => mocks.connection,
}));
vi.mock('../stores', () => ({ useStore: (select: (state: object) => unknown) => select({}) }));
const profile: XingyeRoleProfile = { agentId: 'luna', scenario: 'Observatory', firstMessage: 'Welcome', alternateGreetings: ['First line\nSecond line'], messageExample: 'Sample', updatedAt: 'now' };

describe('character card text editor', () => {
  afterEach(cleanup);
  beforeEach(() => { mocks.save.mockReset(); mocks.connection = 'local'; });

  it('saves explicit clears and keeps multiline alternatives intact', async () => {
    mocks.save.mockResolvedValue({ ...profile, scenario: '', firstMessage: '' });
    const onSaved = vi.fn();
    render(<XingyeCharacterCardEditor agentId="luna" profile={profile} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('角色卡场景、开场与表达示例'));
    fireEvent.change(screen.getByLabelText('默认场景'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('默认开场'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('表达示例'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('备用开场 1'), { target: { value: 'First line\nRevised second line' } });
    fireEvent.click(screen.getByText('保存角色卡文本'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledWith('luna', { scenario: '', firstMessage: '', alternateGreetings: ['First line\nRevised second line'], messageExample: '' });
  });

  it('shows failed save and retains the editable draft', async () => {
    mocks.save.mockRejectedValue(new Error('Disk unavailable'));
    render(<XingyeCharacterCardEditor agentId="luna" profile={profile} />);
    fireEvent.click(screen.getByText('角色卡场景、开场与表达示例'));
    fireEvent.change(screen.getByLabelText('默认开场'), { target: { value: 'My new greeting' } });
    fireEvent.click(screen.getByText('保存角色卡文本'));
    expect(await screen.findByRole('status')).toHaveTextContent('Disk unavailable');
    expect(screen.getByLabelText('默认开场')).toHaveValue('My new greeting');
    expect(screen.getByText('保存角色卡文本')).toBeEnabled();
  });

  it('does not deliver a stale save result after switching roles', async () => {
    let finish!: (value: XingyeRoleProfile) => void;
    mocks.save.mockReturnValue(new Promise<XingyeRoleProfile>(resolve => { finish = resolve; }));
    const onSaved = vi.fn();
    const view = render(<XingyeCharacterCardEditor agentId="luna" profile={profile} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('角色卡场景、开场与表达示例'));
    fireEvent.change(screen.getByLabelText('默认开场'), { target: { value: 'Changed greeting' } });
    fireEvent.click(screen.getByText('保存角色卡文本'));
    view.rerender(<XingyeCharacterCardEditor agentId="nova" profile={{ ...profile, agentId: 'nova', firstMessage: 'Nova here' }} onSaved={onSaved} />);
    finish(profile);
    await waitFor(() => expect(screen.getByLabelText('默认开场')).toHaveValue('Nova here'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('retains unsaved edits when another field refreshes the same role profile', () => {
    const view = render(<XingyeCharacterCardEditor agentId="luna" profile={profile} />);
    fireEvent.click(screen.getByText('角色卡场景、开场与表达示例'));
    fireEvent.change(screen.getByLabelText('默认开场'), { target: { value: 'Unsaved greeting' } });
    view.rerender(<XingyeCharacterCardEditor agentId="luna" profile={{ ...profile, relationshipLabel: 'Friend', firstMessage: 'Saved elsewhere' }} />);
    expect(screen.getByLabelText('默认开场')).toHaveValue('Unsaved greeting');
    expect(screen.getByRole('status')).toHaveTextContent('未保存编辑仍然保留');
    fireEvent.click(screen.getByText('重新载入已保存文本'));
    expect(screen.getByLabelText('默认开场')).toHaveValue('Saved elsewhere');
  });

  it('merges a fresh unedited scene and saves only the locally edited greeting', async () => {
    mocks.save.mockResolvedValue({ ...profile, scenario: 'New shared scene', firstMessage: 'My greeting' });
    const view = render(<XingyeCharacterCardEditor agentId="luna" profile={profile} />);
    fireEvent.click(screen.getByText('角色卡场景、开场与表达示例'));
    fireEvent.change(screen.getByLabelText('默认开场'), { target: { value: 'My greeting' } });
    view.rerender(<XingyeCharacterCardEditor agentId="luna" profile={{ ...profile, scenario: 'New shared scene' }} />);
    expect(screen.getByLabelText('默认场景')).toHaveValue('New shared scene');
    fireEvent.click(screen.getByText('保存角色卡文本'));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('luna', { firstMessage: 'My greeting' }));
  });

  it('waits for a fresh profile before writing through a switched connection', async () => {
    const view = render(<XingyeCharacterCardEditor agentId="luna" profile={profile} />);
    fireEvent.click(screen.getByText('角色卡场景、开场与表达示例'));
    mocks.connection = 'remote';
    view.rerender(<XingyeCharacterCardEditor agentId="luna" profile={profile} />);
    expect(screen.getByText('保存角色卡文本')).toBeDisabled();
    fireEvent.click(screen.getByText('保存角色卡文本'));
    expect(mocks.save).not.toHaveBeenCalled();
    view.rerender(<XingyeCharacterCardEditor agentId="luna" profile={{ ...profile, firstMessage: 'Remote greeting' }} />);
    expect(screen.getByLabelText('默认开场')).toHaveValue('Remote greeting');
    expect(screen.getByText('保存角色卡文本')).toBeEnabled();
  });
});