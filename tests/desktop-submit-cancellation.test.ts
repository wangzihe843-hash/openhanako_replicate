import { it, expect, vi } from 'vitest';
import * as submit from '../core/desktop-session-submit.ts';
const gate = () => (Promise as any).withResolvers();
const session = () => ({ subscribe: vi.fn(() => vi.fn()) });
it('R05 releases a stopped load promptly and prevents its late prompt', async () => {
  const loading = gate();
  const engine = { ensureSessionLoaded: vi.fn(() => loading.promise), promptSession: vi.fn(), emitEvent: vi.fn() };
  const observed = submit.submitDesktopSessionMessage(engine, { sessionPath: '/s.jsonl', text: 'old' }).catch(e => e);
  expect((submit as any).cancelDesktopSessionSubmission?.(engine, '/s.jsonl')).toBe(true);
  expect(await observed).toMatchObject({ name: 'AbortError' });
  loading.resolve(session());
  await new Promise(r => setTimeout(r, 0));
  expect(engine.promptSession).not.toHaveBeenCalled();
});
it('R05 late completion cannot clear a replacement submission or publish idle', async () => {
  const old = gate(); const fresh = gate();
  const engine = { ensureSessionLoaded: vi.fn(async () => session()), promptSession: vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise), emitEvent: vi.fn() };
  const first = submit.submitDesktopSessionMessage(engine, { sessionPath: '/s.jsonl', text: 'old' }).catch(e => e);
  await vi.waitFor(() => expect(engine.promptSession).toHaveBeenCalledTimes(1));
  expect((submit as any).cancelDesktopSessionSubmission?.(engine, '/s.jsonl')).toBe(true);
  expect(await first).toMatchObject({ name: 'AbortError' });
  const second = submit.submitDesktopSessionMessage(engine, { sessionPath: '/s.jsonl', text: 'new' });
  await vi.waitFor(() => expect(engine.promptSession).toHaveBeenCalledTimes(2));
  engine.emitEvent.mockClear(); old.resolve();
  await new Promise(r => setTimeout(r, 0));
  expect(engine.emitEvent).not.toHaveBeenCalled();
  await expect(submit.submitDesktopSessionMessage(engine, { sessionPath: '/s.jsonl', text: 'third' })).rejects.toThrow('session_busy');
  fresh.resolve(); await second;
});
