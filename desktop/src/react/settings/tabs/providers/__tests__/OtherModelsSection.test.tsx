/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSettingsStore } from '../../../store';

const mocks = vi.hoisted(() => ({
  autoSaveGlobalModels: vi.fn(),
  hanaFetch: vi.fn(),
}));

vi.mock('../../../helpers', () => ({
  t: (key: string) => key,
  lookupModelMeta: vi.fn(),
  formatContext: (n: number) => String(n),
  autoSaveGlobalModels: mocks.autoSaveGlobalModels,
}));

vi.mock('../../../api', () => ({
  hanaFetch: mocks.hanaFetch,
}));

vi.mock('../../../actions', () => ({
  loadSettingsConfig: vi.fn(),
}));

vi.mock('../../../widgets/ModelWidget', () => ({
  ModelWidget: () => <div data-testid="model-widget">model-widget</div>,
}));

vi.mock('@/ui', () => ({
  SelectWidget: ({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) => (
    <select data-testid="select-widget" value={value} onChange={event => onChange(event.currentTarget.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
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

  it('pins the sole official account only when DeepSeek is selected and excludes its key from Auto', () => {
    render(<OtherModelsSection providers={{ official: { base_url: 'https://api.deepseek.com/v1' }, proxy: { base_url: 'https://proxy.test' } }} />);
    expect(screen.getAllByTestId('key-input')).toHaveLength(4);
    fireEvent.change(screen.getAllByTestId('select-widget')[0], { target: { value: 'deepseek' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({ search: { provider: 'deepseek', credential_provider: 'official' } });
  });

  it('requires an explicit choice when there are multiple official accounts', () => {
    render(<OtherModelsSection providers={{ first: { base_url: 'https://api.deepseek.com' }, second: { base_url: 'https://api.deepseek.com/v1' } }} />);
    fireEvent.change(screen.getAllByTestId('select-widget')[0], { target: { value: 'deepseek' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({ search: { provider: 'deepseek' } });
    act(() => useSettingsStore.setState({ globalModelsConfig: { search: { provider: 'deepseek', api_keys: {} } } }));
    fireEvent.change(screen.getAllByTestId('select-widget')[1], { target: { value: 'second' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenLastCalledWith({ search: { credential_provider: 'second' } });
  });

  it('verifies a selected reference without asking for the model key and shows the charge notice', async () => {
    useSettingsStore.setState({ globalModelsConfig: { search: { provider: 'deepseek', credential_provider: 'official', api_keys: {} } } });
    mocks.hanaFetch.mockResolvedValue(Response.json({ ok: true }));
    render(<OtherModelsSection providers={{ official: { base_url: 'https://api.deepseek.com' } }} />);
    expect((screen.getByTestId('key-input') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('settings.api.deepseekCostHint')).toBeTruthy();
    fireEvent.click(screen.getByText('settings.search.verify'));
    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(mocks.hanaFetch.mock.calls[0][1].body)).toEqual({ provider: 'deepseek', search_provider: 'deepseek', api_key: '', credential_provider: 'official' });
  });

  it('retains and marks a stale reference instead of silently replacing it with another account', () => {
    useSettingsStore.setState({ globalModelsConfig: { search: { provider: 'deepseek', credential_provider: 'removed', api_keys: {} } } });
    render(<OtherModelsSection providers={{ replacement: { base_url: 'https://api.deepseek.com' } }} />);
    expect(screen.getByText('removed (settings.api.deepseekReferenceUnavailable)')).toBeTruthy();
    fireEvent.change(screen.getAllByTestId('select-widget')[0], { target: { value: 'deepseek' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({ search: { provider: 'deepseek' } });
  });

  it('keeps Fetch direct despite saved Search credentials, then opts in without sending a verification request', () => {
    useSettingsStore.setState({ globalModelsConfig: { search: { provider: 'deepseek', credential_provider: 'chosen', api_keys: {} } } });
    render(<OtherModelsSection providers={{ chosen: { base_url: 'https://api.deepseek.com' } }} />);
    const fetchSelect = screen.getAllByTestId('select-widget')[2] as HTMLSelectElement;
    expect(fetchSelect.value).toBe('direct');
    expect(screen.getByText('settings.api.fetchCostHint')).toBeTruthy();
    expect(mocks.autoSaveGlobalModels).not.toHaveBeenCalled();
    fireEvent.change(fetchSelect, { target: { value: 'deepseek' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({ web_fetch: { provider: 'deepseek' } });
    expect(mocks.hanaFetch).not.toHaveBeenCalled();
  });

  it('pins the sole official account for explicit Fetch opt-in only when there is no Search credential', () => {
    render(<OtherModelsSection providers={{ official: { base_url: 'https://api.deepseek.com' }, proxy: { base_url: 'https://proxy.example' } }} />);
    fireEvent.change(screen.getAllByTestId('select-widget')[1], { target: { value: 'deepseek' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({ web_fetch: { provider: 'deepseek', credential_provider: 'official' } });
    expect(mocks.hanaFetch).not.toHaveBeenCalled();
  });

  it('keeps multiple Fetch accounts unselected and preserves an unavailable explicit reference', () => {
    const providers = { first: { base_url: 'https://api.deepseek.com' }, second: { base_url: 'https://api.deepseek.com/v1' } };
    render(<OtherModelsSection providers={providers} />);
    fireEvent.change(screen.getAllByTestId('select-widget')[1], { target: { value: 'deepseek' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenCalledWith({ web_fetch: { provider: 'deepseek' } });
    act(() => useSettingsStore.setState({ globalModelsConfig: { search: { provider: 'auto' }, web_fetch: { provider: 'deepseek', credential_provider: 'removed' } } }));
    expect(screen.getByText('removed (settings.api.deepseekReferenceUnavailable)')).toBeTruthy();
    fireEvent.change(screen.getAllByTestId('select-widget')[2], { target: { value: 'second' } });
    expect(mocks.autoSaveGlobalModels).toHaveBeenLastCalledWith({ web_fetch: { credential_provider: 'second' } });
  });

  it('saves or clears a Fetch override locally without a paid verification', async () => {
    useSettingsStore.setState({ globalModelsConfig: { search: { provider: 'bing_browser' }, web_fetch: { provider: 'deepseek', api_key: '********' } } });
    mocks.hanaFetch.mockResolvedValue(Response.json({ ok: true }));
    render(<OtherModelsSection providers={{}} />);
    fireEvent.change(screen.getByTestId('key-input'), { target: { value: '' } });
    fireEvent.click(screen.getByText('settings.api.fetchSaveKey'));
    await waitFor(() => expect(mocks.hanaFetch).toHaveBeenCalledTimes(1));
    expect(mocks.hanaFetch.mock.calls[0][0]).toBe('/api/preferences/models');
    expect(JSON.parse(mocks.hanaFetch.mock.calls[0][1].body)).toEqual({ web_fetch: { api_key: '' } });
  });

  it('retains an edited Fetch key when the local settings save fails', async () => {
    useSettingsStore.setState({ globalModelsConfig: { search: { provider: 'bing_browser' }, web_fetch: { provider: 'deepseek', api_key: '********' } } });
    const showToast = vi.fn();
    useSettingsStore.setState({ showToast });
    mocks.hanaFetch.mockResolvedValue(Response.json({ error: 'save rejected' }, { status: 500 }));
    render(<OtherModelsSection providers={{}} />);
    fireEvent.change(screen.getByTestId('key-input'), { target: { value: 'synthetic-draft' } });
    fireEvent.click(screen.getByText('settings.api.fetchSaveKey'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('settings.saveFailed', 'error'));
    expect((screen.getByTestId('key-input') as HTMLInputElement).value).toBe('synthetic-draft');
  });

});
