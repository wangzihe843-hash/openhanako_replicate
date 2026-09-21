/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { CharacterCardPreviewOverlay, type CharacterCardPlan } from '../../settings/overlays/CharacterCardPreviewOverlay';
vi.mock('../../settings/api', () => ({ hanaUrl: (path: string) => path }));
vi.mock('../../settings/helpers', () => ({ t: (key: string) => key }));
afterEach(cleanup);
it('shows actionable compatibility and author notes before import confirmation', () => {
  const plan: CharacterCardPlan = { token: 'token', packageName: 'Luna', agent: { name: 'Luna', yuan: 'hanako' }, memory: { available: false, count: 0 }, skills: { count: 0, bundles: [] }, assets: {}, importReport: { format: 'sillytavern-v2', mapped: ['scenario becomes default scene'], retained: ['system_prompt not activated'], manual: ['selective lore disabled'], creatorNotes: 'Read before importing' } };
  const confirm = vi.fn();
  render(<CharacterCardPreviewOverlay plan={plan} mode="import" memoryChecked={false} processing={false} onMemoryChange={vi.fn()} onConfirm={confirm} onCancel={vi.fn()} />);
  expect(screen.getByRole('region', { name: '角色卡导入兼容报告' })).toBeVisible();
  expect(screen.getByText('scenario becomes default scene')).toBeVisible();
  expect(screen.getByText('system_prompt not activated')).toBeVisible();
  expect(screen.getByText('selective lore disabled')).toBeVisible();
  expect(screen.getByText('Read before importing')).toBeVisible();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('settings.characterCard.confirm'));
  expect(confirm).toHaveBeenCalledOnce();
});