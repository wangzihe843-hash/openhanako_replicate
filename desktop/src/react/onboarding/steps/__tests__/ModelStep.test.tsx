/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mocks = vi.hoisted(() => ({
  loadModels: vi.fn(),
  saveModel: vi.fn(),
}));

vi.mock('../../onboarding-actions', () => ({
  describeOnboardingError: (_error: unknown, fallback: string) => fallback,
  loadModels: (...args: unknown[]) => mocks.loadModels(...args),
  saveModel: (...args: unknown[]) => mocks.saveModel(...args),
}));

import { ModelStep } from '../ModelStep';

describe('ModelStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('t', (key: string) => key);
    mocks.loadModels.mockResolvedValue({
      models: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps discovered models out of the added-model list until the user adds one', async () => {
    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="deepseek"
        providerUrl="https://api.deepseek.com"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={vi.fn()}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    expect(screen.getByText('onboarding.model.noAddedModels')).toBeInTheDocument();
    expect(screen.queryByText('deepseek-v4-flash')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'deepseek-v4-flash' }));

    expect(screen.queryByText('onboarding.model.noAddedModels')).not.toBeInTheDocument();
    expect(screen.getByText('deepseek-v4-flash')).toBeInTheDocument();
    expect(screen.getByText('onboarding.model.mainModel')).toBeInTheDocument();
  });

  it('prefills the edit panel with known-model metadata for added models', async () => {
    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="deepseek"
        providerUrl="https://api.deepseek.com"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={vi.fn()}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'deepseek-v4-flash' }));
    fireEvent.click(screen.getByTitle('onboarding.model.editModel'));

    expect(screen.getByLabelText('onboarding.model.displayName')).toHaveValue('DeepSeek V4 Flash');
    expect(screen.getByLabelText('onboarding.model.contextLength')).toHaveValue('1048576');
    expect(screen.getByLabelText('onboarding.model.maxOutput')).toHaveValue('393216');
    // The legacy Flash ID now routes to the vision-capable V4.1 Flash backend.
    expect(screen.getByLabelText('onboarding.model.imageInput')).toBeChecked();
    expect(screen.getByLabelText('onboarding.model.audioInput')).not.toBeChecked();
    expect(screen.getByLabelText('onboarding.model.reasoning')).toBeChecked();
  });

  it('allows adding a model manually when discovery returns no models', async () => {
    mocks.loadModels.mockResolvedValueOnce({
      models: [],
      error: 'No models found for provider "custom-provider"',
    });

    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="custom-provider"
        providerUrl="https://api.example.com/v1"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={vi.fn()}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.change(
      await screen.findByPlaceholderText('onboarding.model.manualModelPlaceholder'),
      { target: { value: 'custom-chat-model' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addManualModel' }));

    expect(screen.getByText('custom-chat-model')).toBeInTheDocument();
    expect(screen.getByText('onboarding.model.mainModel')).toBeInTheDocument();
  });

  it('saves fetched model metadata when adding discovered custom provider models', async () => {
    const goToStep = vi.fn();
    mocks.loadModels.mockResolvedValueOnce({
      models: [
        {
          id: 'custom-vllm-chat',
          name: 'Custom vLLM Chat',
          context: 32768,
          maxOutput: 4096,
          image: true,
          video: true,
          audio: true,
          reasoning: true,
        },
      ],
    });

    render(
      <ModelStep
        preview={false}
        hanaFetch={vi.fn()}
        agentId="hana-primary"
        verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
        providerName="custom-vllm"
        providerUrl="http://127.0.0.1:8000/v1"
        providerApi="openai-completions"
        apiKey="sk-test"
        goToStep={goToStep}
        showError={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.loadModels).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'custom-vllm-chat' }));

    const utilityTriggers = document.querySelectorAll('.ob-select-widget button[aria-haspopup="listbox"]');
    fireEvent.click(utilityTriggers[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Custom vLLM Chat' }));
    fireEvent.click(utilityTriggers[1]);
    fireEvent.click(await screen.findByRole('option', { name: 'Custom vLLM Chat' }));

    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.next' }));

    await waitFor(() => {
      expect(mocks.saveModel).toHaveBeenCalledWith(expect.objectContaining({
        providerName: 'custom-vllm',
        selectedModel: 'custom-vllm-chat',
        selectedUtility: 'custom-vllm-chat',
        selectedUtilityLarge: 'custom-vllm-chat',
        addedModels: [
          {
            id: 'custom-vllm-chat',
            name: 'Custom vLLM Chat',
            context: 32768,
            maxOutput: 4096,
            image: true,
            video: true,
            audio: true,
            reasoning: true,
          },
        ],
      }));
    });
    expect(goToStep).toHaveBeenCalledWith(4);
  });
  it.each([undefined, 262144, 1048576, 123456])('updates the K2.8 endpoint baseline while retaining draft context %s', async context => {
    mocks.loadModels.mockResolvedValue({ models: [{ id: 'kimi-for-coding', ...(context ? { context } : {}) }] });
    const props = {
      preview: false, hanaFetch: vi.fn(), agentId: 'hana-primary',
      verificationPlan: { agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] },
      providerName: 'kimi-coding', providerUrl: 'https://api.kimi.com/coding/v1',
      providerApi: 'openai-completions', apiKey: 'sk-k28-synthetic-fixture', goToStep: vi.fn(), showError: vi.fn(),
    };
    const { rerender } = render(<ModelStep {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'kimi-for-coding' }));
    for (const [url, fallback] of [['https://api.kimi.com/coding/v1', 1048576],
      ['https://proxy.example/coding', 262144], ['https://api.kimi.ai/coding/v1', 1048576]]) {
      rerender(<ModelStep {...props} providerUrl={url as string} />);
      fireEvent.click(screen.getByTitle('onboarding.model.editModel'));
      expect(screen.getByLabelText('onboarding.model.contextLength')).toHaveValue(String(context ?? fallback));
      fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.cancelEdit' }));
    }
    expect(mocks.loadModels).toHaveBeenCalledTimes(1);
  });

  it.each([
    { context: undefined, manual: false, renamed: false },
    { context: undefined, manual: false, renamed: true },
    ...[262144, 1048576, 123456].flatMap(context => [false, true].flatMap(manual =>
      [false, true].map(renamed => ({ context, manual, renamed })))),
  ])('retains explicit K2.8 budgets through editing, URL changes and final save: %j', async c => {
    mocks.loadModels.mockResolvedValue({ models: [{ id: 'kimi-for-coding', ...(!c.manual && c.context ? { context: c.context } : {}) }] });
    const props = {
      preview: false, hanaFetch: vi.fn(), agentId: 'hana-primary',
      verificationPlan: { agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] },
      providerName: 'kimi-coding', providerUrl: 'https://api.kimi.com/coding/v1',
      providerApi: 'openai-completions', apiKey: 'sk-k28-synthetic-fixture', goToStep: vi.fn(), showError: vi.fn(),
    };
    const { rerender } = render(<ModelStep {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'kimi-for-coding' }));
    fireEvent.click(screen.getByTitle('onboarding.model.editModel'));
    if (c.manual) {
      // Deliberately edit back to the reference as well as away from it.
      fireEvent.change(screen.getByLabelText('onboarding.model.contextLength'), { target: { value: '999999' } });
      fireEvent.change(screen.getByLabelText('onboarding.model.contextLength'), { target: { value: String(c.context) } });
    }
    if (c.renamed) fireEvent.change(screen.getByLabelText('onboarding.model.displayName'), { target: { value: 'My Kimi' } });
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.saveEdit' }));
    rerender(<ModelStep {...props} providerUrl="https://proxy.example/coding/v1" />);
    fireEvent.click(screen.getByTitle('onboarding.model.editModel'));
    expect(screen.getByLabelText('onboarding.model.contextLength')).toHaveValue(String(c.context ?? 262144));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.saveEdit' }));
    const utilityTriggers = document.querySelectorAll('.ob-select-widget button[aria-haspopup="listbox"]');
    for (const trigger of utilityTriggers) {
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('option', { name: c.renamed ? 'My Kimi' : 'Kimi K2.8 Preview' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.next' }));
    await waitFor(() => expect(mocks.saveModel).toHaveBeenCalled());
    const entry = mocks.saveModel.mock.calls[0][0].addedModels[0];
    if (c.context !== undefined) expect(entry.context).toBe(c.context);
    else expect(typeof entry === 'string' ? {} : entry).not.toHaveProperty('context');
  });

  it.each(['openai-completions', 'anthropic-messages'])('uses the actual implicit projection for onboarding %s', async providerApi => {
    mocks.loadModels.mockResolvedValue({ models: [{ id: 'kimi-for-coding' }] });
    render(<ModelStep preview={false} hanaFetch={vi.fn()} agentId="fixture"
      verificationPlan={{ agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] }}
      providerName="kimi-coding" providerUrl="https://proxy.example/coding/v1" providerApi={providerApi}
      apiKey="sk-k28-synthetic-fixture" goToStep={vi.fn()} showError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.model.addModel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'kimi-for-coding' }));
    fireEvent.click(screen.getByTitle('onboarding.model.editModel'));
    expect(screen.getByLabelText('onboarding.model.contextLength')).toHaveValue(providerApi === 'anthropic-messages' ? '1048576' : '262144');
  });

});
