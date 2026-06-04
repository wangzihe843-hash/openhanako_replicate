/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../settings/api', () => ({
  hanaFetch: (...args: unknown[]) => mocks.hanaFetch(...args),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/components/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock('../../settings/components/SettingsRow', () => ({
  SettingsRow: ({ label, control }: { label: string; control: React.ReactNode }) => (
    <label>
      <span>{label}</span>
      {control}
    </label>
  ),
}));

vi.mock('../../settings/tabs/media/MediaProviderDetail', () => ({
  MediaProviderDetail: ({ providerId }: { providerId: string }) => (
    <div data-testid="media-provider-detail">{providerId}</div>
  ),
}));

vi.mock('@/ui', () => ({
  SelectWidget: ({ value, onChange, options, disabled }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    disabled?: boolean;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
      ))}
    </select>
  ),
}));

import { MediaTab } from '../../settings/tabs/MediaTab';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as Response;
}

describe('MediaTab image-gen config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            volcengine: {
              providerId: 'volcengine',
              displayName: 'Volcengine',
              hasCredentials: true,
              models: [{ id: 'seedream-5', name: 'Seedream 5.0' }],
              availableModels: [],
            },
          },
          config: {},
        }));
      }
      return Promise.resolve(jsonResponse({ values: { defaultImageModel: { provider: 'volcengine', id: 'seedream-5' } } }));
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('loads global image-gen config without agent scope and saves through the generic config envelope', async () => {
    render(<MediaTab />);

    const select = await screen.findByLabelText('settings.media.defaultModel');
    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/plugins/image-gen/providers');
    });

    fireEvent.change(select, { target: { value: 'volcengine/seedream-5' } });

    await waitFor(() => {
      expect(mocks.hanaFetch.mock.calls.some(([path]) => path === '/api/plugins/image-gen/config')).toBe(true);
    });
    const saveCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/plugins/image-gen/config');
    expect(saveCall?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((saveCall?.[1] as RequestInit).body))).toEqual({
      values: {
        defaultImageModel: { provider: 'volcengine', id: 'seedream-5' },
      },
    });
    expect(mocks.hanaFetch.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('agentId=');
  });

  it('sends null to clear the global default model over HTTP', async () => {
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            volcengine: {
              providerId: 'volcengine',
              displayName: 'Volcengine',
              hasCredentials: true,
              models: [{ id: 'seedream-5', name: 'Seedream 5.0' }],
              availableModels: [],
            },
          },
          config: { defaultImageModel: { provider: 'volcengine', id: 'seedream-5' } },
        }));
      }
      return Promise.resolve(jsonResponse({ values: {} }));
    });

    render(<MediaTab />);

    const select = await screen.findByLabelText('settings.media.defaultModel');
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/plugins/image-gen/config', expect.objectContaining({
        body: JSON.stringify({ values: { defaultImageModel: null } }),
      }));
    });
  });

  it('auto-selects the first credentialed image provider instead of the first provider in transport order', async () => {
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            openai: {
              providerId: 'openai',
              displayName: 'OpenAI',
              hasCredentials: false,
              models: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
              availableModels: [],
            },
            volcengine: {
              providerId: 'volcengine',
              displayName: 'Volcengine',
              hasCredentials: true,
              models: [{ id: 'seedream-5', name: 'Seedream 5.0' }],
              availableModels: [],
            },
          },
          config: {},
        }));
      }
      return Promise.resolve(jsonResponse({ values: {} }));
    });

    render(<MediaTab />);

    expect(await screen.findByTestId('media-provider-detail')).toHaveTextContent('volcengine');
  });

  it('does not offer image models with missing runtime adapters as selectable defaults', async () => {
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            axis: {
              providerId: 'axis',
              displayName: 'Axis',
              hasCredentials: true,
              models: [{ id: 'gpt-image-2', name: 'GPT Image 2', protocolId: 'axis-images', adapterAvailable: false }],
              availableModels: [],
            },
          },
          config: {},
        }));
      }
      return Promise.resolve(jsonResponse({ values: {} }));
    });

    render(<MediaTab />);

    const select = await screen.findByLabelText('settings.media.defaultModel');
    const option = Array.from(select.querySelectorAll('option')).find((item) => item.value === 'axis/gpt-image-2');
    expect(option).toBeTruthy();
    expect(option).toBeDisabled();
    expect(option?.textContent).toContain('settings.media.adapterMissing');
  });

  it('loads speech-recognition providers from the speech endpoint', async () => {
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({ providers: {}, config: {} }));
      }
      if (path === '/api/speech-recognition/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            openai: {
              providerId: 'openai',
              displayName: 'OpenAI Speech',
              hasCredentials: true,
              models: [{ id: 'whisper-1', name: 'Whisper 1', adapterAvailable: true }],
            },
          },
          config: { enabled: false },
        }));
      }
      return Promise.resolve(jsonResponse({ values: {} }));
    });

    render(<MediaTab />);

    expect(await screen.findByText('OpenAI Speech')).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/speech-recognition/providers');
    });
  });

  it('saves speech-recognition enabled state through the speech config endpoint', async () => {
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({ providers: {}, config: {} }));
      }
      if (path === '/api/speech-recognition/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            openai: {
              providerId: 'openai',
              displayName: 'OpenAI Speech',
              hasCredentials: true,
              models: [{ id: 'whisper-1', name: 'Whisper 1', adapterAvailable: true }],
            },
          },
          config: { enabled: false },
        }));
      }
      if (path === '/api/speech-recognition/config') {
        return Promise.resolve(jsonResponse({ ok: true, config: { enabled: true } }));
      }
      return Promise.resolve(jsonResponse({ values: {} }));
    });

    render(<MediaTab />);

    const toggle = await screen.findByRole('switch', { name: '语音识别启用' });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mocks.hanaFetch).toHaveBeenCalledWith('/api/speech-recognition/config', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ values: { enabled: true } }),
      }));
    });
  });

  it('saves the default speech-recognition model through the speech config endpoint', async () => {
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({ providers: {}, config: {} }));
      }
      if (path === '/api/speech-recognition/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            openai: {
              providerId: 'openai',
              displayName: 'OpenAI Speech',
              hasCredentials: true,
              models: [{ id: 'whisper-1', name: 'Whisper 1', adapterAvailable: true }],
            },
          },
          config: { enabled: true },
        }));
      }
      if (path === '/api/speech-recognition/config') {
        return Promise.resolve(jsonResponse({
          values: { enabled: true, defaultModel: { provider: 'openai', id: 'whisper-1' } },
        }));
      }
      return Promise.resolve(jsonResponse({ values: {} }));
    });

    render(<MediaTab />);

    const select = await screen.findByLabelText('默认语音识别模型');
    fireEvent.change(select, { target: { value: 'openai/whisper-1' } });

    await waitFor(() => {
      expect(mocks.hanaFetch.mock.calls.some(([path]) => path === '/api/speech-recognition/config')).toBe(true);
    });
    const saveCall = mocks.hanaFetch.mock.calls.find(([path]) => path === '/api/speech-recognition/config');
    expect(saveCall?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((saveCall?.[1] as RequestInit).body))).toEqual({
      values: { defaultModel: { provider: 'openai', id: 'whisper-1' } },
    });
  });

  it('does not offer speech models without runnable adapters as selectable defaults', async () => {
    mocks.hanaFetch.mockImplementation((path: string) => {
      if (path === '/api/plugins/image-gen/providers') {
        return Promise.resolve(jsonResponse({ providers: {}, config: {} }));
      }
      if (path === '/api/speech-recognition/providers') {
        return Promise.resolve(jsonResponse({
          providers: {
            openai: {
              providerId: 'openai',
              displayName: 'OpenAI Speech',
              hasCredentials: true,
              models: [{ id: 'whisper-1', name: 'Whisper 1', adapterAvailable: false }],
              availableModels: [],
            },
          },
          config: { enabled: true },
        }));
      }
      return Promise.resolve(jsonResponse({ values: {} }));
    });

    render(<MediaTab />);

    const select = await screen.findByLabelText('默认语音识别模型');
    const option = Array.from(select.querySelectorAll('option')).find((item) => item.value === 'openai/whisper-1');
    expect(option).toBeUndefined();
    expect(select).toBeDisabled();
  });
});
