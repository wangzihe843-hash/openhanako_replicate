/// <reference types="vite/client" />
/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { resolveMediaParameters, validateMediaProviderDefaults } from '../core/media/media-parameters.ts';

vi.mock('../desktop/src/react/settings/api', () => ({ hanaFetch: vi.fn() }));
vi.mock('../desktop/src/react/hooks/use-config', () => ({ invalidateConfigCache: vi.fn() }));
vi.mock('../desktop/src/react/settings/store', () => ({
  useSettingsStore: (selector: (state: { showToast: ReturnType<typeof vi.fn> }) => unknown) => selector({ showToast: vi.fn() }),
}));
vi.mock('../desktop/src/react/settings/helpers', () => ({ t: (key: string) => key }));
vi.mock('@/ui', () => ({
  SelectWidget: ({ value, onChange, options }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => <select value={value} onChange={event => onChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));

import { MediaProviderDetail } from '../desktop/src/react/settings/tabs/media/MediaProviderDetail';

describe('media defaults UI and save validation integration', () => {
  afterEach(cleanup);
  it.each([true, false])('edits and clears a saved options.watermark=%s using the displayed control', initial => {
    const model = {
      id: 'model', name: 'Model', modes: [{
        id: 'text2image', defaults: { watermark: true },
        parameterSchema: { properties: {
          watermark: { type: 'boolean' }, quality: { type: 'string', enum: ['high', 'low'] },
        } },
      }],
    };
    type ModeDefaults = { watermark?: boolean; options?: { watermark?: boolean; quality?: string } };
    let config = { providerDefaults: { provider: { models: { model: { modes: {
      text2image: { options: { watermark: initial, quality: 'high' } } as ModeDefaults,
    } } } } } };
    const original = config;
    const originalSnapshot = structuredClone(config);
    const onSaveConfig = vi.fn(async (updates: typeof config) => {
      validateMediaProviderDefaults(updates.providerDefaults, [{ providerId: 'provider', models: [model] }], config.providerDefaults);
      config = updates;
      view.rerender(form());
    });
    const form = () => <MediaProviderDetail
      providerId="provider"
      provider={{ hasCredentials: true, availableModels: [], models: [model] }}
      config={config}
      onSaveConfig={onSaveConfig}
      onRefresh={vi.fn(async () => {})}
    />;
    const view = render(form());
    const control = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    expect(control.selectedOptions[0].text).toBe(String(initial));
    const changed = !initial;
    const option = Array.from(control.options).find(item => item.text === String(changed));
    fireEvent.change(control, { target: { value: option?.value } });
    expect(onSaveConfig).toHaveBeenCalledTimes(1);
    const resolve = () => resolveMediaParameters({ kind: 'image', model, providerDefaults: config.providerDefaults.provider }).resolvedParameters;
    expect(resolve()).toEqual({ watermark: changed, quality: 'high' });
    expect(control.selectedOptions[0].text).toBe(String(changed));
    fireEvent.change(control, { target: { value: '' } });
    expect(onSaveConfig).toHaveBeenCalledTimes(2);
    expect(control.value).toBe('');
    expect(resolve()).toEqual({ watermark: true, quality: 'high' });
    expect(config.providerDefaults.provider.models.model.modes.text2image).toEqual({ options: { quality: 'high' } });
    expect(original).toEqual(originalSnapshot);
  });

  it('repairs two legacy string booleans through separate model controls without blocking the first save', () => {
    const models = ['first', 'second'].map(id => ({
      id, name: id, modes: [{ id: 'text2image', parameterSchema: { properties: { watermark: { type: 'boolean' } } } }],
    }));
    let config = { providerDefaults: { provider: { models: {
      first: { modes: { text2image: { watermark: 'true' as string | boolean } } },
      second: { modes: { text2image: { watermark: 'false' as string | boolean } } },
    } } } };
    const onSaveConfig = vi.fn(async (updates: typeof config) => {
      validateMediaProviderDefaults(updates.providerDefaults, [{ providerId: 'provider', models }], config.providerDefaults);
      config = updates;
      view.rerender(form());
    });
    const form = () => <MediaProviderDetail
      providerId="provider"
      provider={{ hasCredentials: true, availableModels: [], models }}
      config={config}
      onSaveConfig={onSaveConfig}
      onRefresh={vi.fn(async () => {})}
    />;
    const view = render(form());
    const selectBoolean = (value: boolean) => {
      const control = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
      const option = Array.from(control.options).find(item => item.text === String(value));
      fireEvent.change(control, { target: { value: option?.value } });
    };
    selectBoolean(true);
    expect(onSaveConfig).toHaveBeenCalledTimes(1);
    expect(config.providerDefaults.provider.models.first.modes.text2image.watermark).toBe(true);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'second' } });
    selectBoolean(false);
    expect(onSaveConfig).toHaveBeenCalledTimes(2);
    expect(config.providerDefaults.provider.models.second.modes.text2image.watermark).toBe(false);
  });

});
