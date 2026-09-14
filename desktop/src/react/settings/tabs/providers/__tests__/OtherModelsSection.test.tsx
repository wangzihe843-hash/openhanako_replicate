/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSettingsStore } from '../../../store';

const mocks = vi.hoisted(() => ({
  autoSaveGlobalModels: vi.fn(),
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
  lookupModelMeta: vi.fn(),
  formatContext: (n: number) => String(n),
  autoSaveGlobalModels: mocks.autoSaveGlobalModels,
}));

vi.mock('../../../api', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../../actions', () => ({
  loadSettingsConfig: vi.fn(),
}));

vi.mock('../../../widgets/ModelWidget', () => ({
  ModelWidget: () => <div data-testid="model-widget">model-widget</div>,
}));

vi.mock('@/ui', () => ({
  SelectWidget: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <button type="button" data-testid="select-widget" onClick={() => onChange(value)}>
      select-widget
    </button>
  ),
  Toggle: ({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label?: string }) => (
    <button
      type="button"
      data-testid={`toggle-${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  ),
}));

vi.mock('../../../widgets/KeyInput', () => ({
  KeyInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input data-testid="key-input" value={value} onChange={event => onChange(event.currentTarget.value)} />,
}));

import { OtherModelsSection } from '../OtherModelsSection';

describe('OtherModelsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      globalModelsConfig: {
        models: {
          utility: null,
          utility_large: null,
          vision: { id: 'gpt-4o', provider: 'openai' },
          vision_enabled: false,
        },
        search: { provider: '', api_key: '' },
        utility_api: {},
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the auxiliary vision toggle above the vision model picker and saves it as a global model preference', () => {
    render(<OtherModelsSection providers={{ openai: { models: ['gpt-4o'] } }} />);

    const visionLabel = screen.getByText('settings.api.visionModel');
    const toggle = screen.getByRole('button', { name: 'settings.api.visionAuxiliaryToggle' });
    const firstModelWidget = screen.getAllByTestId('model-widget')[2];

    expect(visionLabel.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.compareDocumentPosition(firstModelWidget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);

    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({
      models: { vision_enabled: true },
    });
  });

  it('updates saved search keys by content while preserving an edited draft', () => {
    const setSavedKey = (value: string) => useSettingsStore.setState({
      globalModelsConfig: {
        ...useSettingsStore.getState().globalModelsConfig,
        search: { provider: 'tavily', api_keys: { tavily: value } },
      },
    });
    setSavedKey('test-saved-a');
    render(<OtherModelsSection providers={{}} />);
    const input = screen.getByTestId('key-input') as HTMLInputElement;
    expect(input.value).toBe('test-saved-a');
    act(() => setSavedKey('test-saved-b'));
    expect(input.value).toBe('test-saved-b');
    fireEvent.change(input, { target: { value: 'test-edited-draft' } });
    act(() => setSavedKey('test-saved-c'));
    expect(input.value).toBe('test-edited-draft');
    act(() => setSavedKey('test-saved-c'));
    expect(input.value).toBe('test-edited-draft');
  });

});
