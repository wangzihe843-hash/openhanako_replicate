/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../../settings/api', () => ({
  hanaFetch: vi.fn(),
}));

vi.mock('../../../hooks/use-config', () => ({
  invalidateConfigCache: vi.fn(),
}));

vi.mock('../../settings/store', () => ({
  useSettingsStore: (selector: (state: { showToast: ReturnType<typeof vi.fn> }) => unknown) => selector({ showToast: vi.fn() }),
}));

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('@/ui', () => ({
  SelectWidget: ({ value, onChange, options }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

import { MediaProviderDetail } from '../../settings/tabs/media/MediaProviderDetail';

describe('MediaProviderDetail schema-driven defaults', () => {
  afterEach(cleanup);
  it('saves provider mode defaults under provider/model/mode', () => {
    const onSaveConfig = vi.fn();

    render(
      <MediaProviderDetail
        providerId="jimeng-cli"
        capability="videoGeneration"
        provider={{
          displayName: '即梦 CLI',
          hasCredentials: true,
          availableModels: [],
          models: [{
            id: 'seedance2.0_vip',
            name: 'Seedance 2.0 VIP',
            protocolId: 'jimeng-cli-videos',
            modes: [{
              id: 'text2video',
              label: '文生视频',
              parameterSchema: {
                type: 'object',
                properties: {
                  video_resolution: {
                    type: 'string',
                    enum: ['720p', '1080p'],
                    default: '720p',
                  },
                },
              },
            }],
          }],
        }}
        config={{}}
        onSaveConfig={onSaveConfig}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('video_resolution')).toBeInTheDocument();
    const selects = screen.getAllByRole('combobox');
    const option = screen.getByRole('option', { name: '1080p' }) as HTMLOptionElement;
    fireEvent.change(selects[1], { target: { value: option.value } });

    expect(onSaveConfig).toHaveBeenCalledWith({
      providerDefaults: {
        'jimeng-cli': {
          models: {
            'seedance2.0_vip': {
              modes: {
                text2video: {
                  video_resolution: '1080p',
                },
              },
            },
          },
        },
      },
    });
  });
});

function renderParameter(property: { type: string | string[]; enum?: Array<string | number | boolean> }, initial?: string | number | boolean) {
  const onSaveConfig = vi.fn(async (_updates: Record<string, unknown>) => {});
  const config = (value: string | number | boolean | undefined) => ({
    providerDefaults: { provider: { models: { model: { modes: { text2image: value === undefined ? {} : { option: value } } } } } },
  });
  const props = {
    providerId: 'provider',
    provider: {
      hasCredentials: true,
      availableModels: [],
      models: [{ id: 'model', name: 'Model', modes: [{
        id: 'text2image', parameterSchema: { properties: { option: property } },
      }] }],
    },
    onSaveConfig,
    onRefresh: vi.fn(async () => {}),
  };
  const view = render(<MediaProviderDetail {...props} config={config(initial)} />);
  return {
    onSaveConfig,
    control: screen.getAllByRole('combobox')[1] as HTMLSelectElement,
    expected: config,
    rerender: (value: string | number | boolean | undefined) => view.rerender(<MediaProviderDetail {...props} config={config(value)} />),
  };
}

describe('MediaProviderDetail typed parameter values', () => {
  afterEach(cleanup);

  it.each([true, false])('saves and displays boolean %s, and can restore the default', (value) => {
    const { onSaveConfig, control, expected, rerender } = renderParameter({ type: 'boolean' });
    expect(control.value).toBe('');
    const option = Array.from(control.options).find(item => item.text === String(value));
    expect(option).toBeDefined();
    fireEvent.change(control, { target: { value: option?.value } });
    expect(onSaveConfig).toHaveBeenLastCalledWith(expected(value));

    rerender(value);
    expect(control.selectedOptions[0].text).toBe(String(value));
    fireEvent.change(control, { target: { value: '' } });
    expect(onSaveConfig).toHaveBeenLastCalledWith({ providerDefaults: { provider: {} } });
  });

  it('preserves enum scalar types even when values have identical display text', () => {
    const values = [0, '0', false, 'false'];
    const { onSaveConfig, control, expected, rerender } = renderParameter({ type: ['number', 'string', 'boolean'], enum: values });
    const options = Array.from(control.options).slice(1);
    expect(new Set(options.map(option => option.value)).size).toBe(values.length);
    values.forEach((value, index) => {
      fireEvent.change(control, { target: { value: options[index].value } });
      expect(onSaveConfig).toHaveBeenLastCalledWith(expected(value));
      rerender(value);
      expect(control.value).toBe(options[index].value);
    });
  });
});
