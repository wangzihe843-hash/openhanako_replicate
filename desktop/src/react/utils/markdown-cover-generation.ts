import { hanaFetch } from '../hooks/use-hana-fetch';
import registry from '../../shared/theme-registry';
import { refreshPreviewItemsFromFile } from './preview-file-refresh';

export type CoverThemeTone = 'light' | 'dark';

export function getCoverThemeTone(): CoverThemeTone {
  const theme = document.documentElement.getAttribute('data-theme') || document.documentElement.dataset.theme || '';
  return registry.isPaperTextureBlockedTheme(theme) ? 'dark' : 'light';
}

export async function requestMarkdownCoverGeneration({
  filePath,
  executorAgentId,
  userGuidance,
}: {
  filePath: string;
  executorAgentId?: string;
  userGuidance?: string;
}): Promise<{ ok: true; activity?: unknown } | { ok: false; error: string }> {
  const res = await hanaFetch('/api/desk/beautify/cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath,
      themeTone: getCoverThemeTone(),
      ...(executorAgentId ? { executorAgentId } : {}),
      ...(userGuidance?.trim() ? { userGuidance: userGuidance.trim() } : {}),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  return { ok: true, activity: data?.activity };
}

export async function applyMarkdownCoverImage({
  filePath,
  imageFilePath,
}: {
  filePath: string;
  imageFilePath: string;
}): Promise<{ ok: true; cover?: unknown } | { ok: false; error: string }> {
  const res = await hanaFetch('/api/desk/beautify/cover/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath,
      imageFilePath,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  await refreshPreviewItemsFromFile(filePath);
  return { ok: true, cover: data?.cover };
}

export async function applyMarkdownCoverPreset({
  filePath,
  presetId,
}: {
  filePath: string;
  presetId: string;
}): Promise<{ ok: true; cover?: unknown } | { ok: false; error: string }> {
  const res = await hanaFetch('/api/desk/beautify/cover/preset/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath,
      presetId,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    return { ok: false, error: data?.error || `HTTP ${res.status}` };
  }
  await refreshPreviewItemsFromFile(filePath);
  return { ok: true, cover: data?.cover };
}

export function dispatchCoverNotice(text: string, type: 'success' | 'error' = 'success'): void {
  window.dispatchEvent(new CustomEvent('hana-inline-notice', {
    detail: { text, type },
  }));
}
