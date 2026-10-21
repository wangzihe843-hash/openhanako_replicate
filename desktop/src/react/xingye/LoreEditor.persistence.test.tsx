/** @vitest-environment jsdom */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoreEditor } from './LoreEditor';
import * as lore from './xingye-lore-store';
import { captureXingyePersistenceBinding, flushXingyePersistenceNow, refreshXingyeAgentPersistence, resetXingyePersistenceForTests } from './xingye-persistence';

const fixture = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  readGate: null as null | { agentId: string; promise: Promise<void> },
  writeGate: null as null | Promise<void>,
  readFailure: false,
  writeFailure: false,
  reads: 0,
  writes: 0,
}));
vi.mock('../stores', () => {
  const state = { userName: 'Fixture', agents: [], activeServerConnection: { baseUrl: 'http://synthetic.invalid' } };
  return { useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('../hooks/use-config', () => ({ useConfig: () => ({ config: { user: { name: 'Fixture' } } }) }));
vi.mock('./LoreDiagnostics', () => ({ LoreDiagnostics: () => null }));
vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: vi.fn(async (body: Record<string, unknown>) => {
    const key = `${body.agentId}:${body.relativePath}`;
    if (body.action === 'readJson') {
      fixture.reads += 1;
      const gate = fixture.readGate;
      if (gate && gate.agentId === body.agentId) await gate.promise;
      if (fixture.readFailure) throw new Error('synthetic read failure');
      return { ok: true, data: fixture.files.get(key) ?? null };
    }
    if (body.action === 'writeJson') {
      fixture.writes += 1;
      if (fixture.writeGate) await fixture.writeGate;
      if (fixture.writeFailure) throw new Error('synthetic write failure');
      fixture.files.set(key, structuredClone(body.data));
      return { ok: true };
    }
    throw new Error('Unexpected fixture operation');
  }),
}));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const input = { title: 'Lore fixture', content: 'Unsent fixture text' };
const title = () => screen.getByRole('textbox', { name: '标题' });
const content = () => screen.getByRole('textbox', { name: '条目正文（按预算引用）' });
const saveButton = () => screen.getByRole('button', { name: /^(新增|保存)设定条目$/ });
function fill(text = input.content) {
  fireEvent.change(title(), { target: { value: input.title } });
  fireEvent.change(content(), { target: { value: text } });
}
function stored(agentId = 'a') { return Object.values(fixture.files.get(`${agentId}:lore/entries.json`) ?? {}) as lore.XingyeLoreEntry[]; }
async function bind(agentId = 'a') { await act(() => refreshXingyeAgentPersistence(agentId)); }
async function saved() { await waitFor(() => expect(content()).toHaveValue('')); }
beforeEach(() => {
  resetXingyePersistenceForTests(); fixture.files.clear(); fixture.readGate = null; fixture.writeGate = null;
  fixture.readFailure = false; fixture.writeFailure = false; fixture.reads = 0; fixture.writes = 0;
  delete (window as unknown as { __XINGYE_PERSISTENCE_DEV_LOCAL__?: boolean }).__XINGYE_PERSISTENCE_DEV_LOCAL__;
  window.localStorage.clear();
});
afterEach(() => { cleanup(); resetXingyePersistenceForTests(); vi.restoreAllMocks(); });

describe('Lore persistence binding and storage failures', () => {
  it('rejects a default create with null binding instead of returning an unpersisted entry', () => {
    expect(() => lore.createLoreEntry('a', input)).toThrow();
    expect(lore.listLoreEntries('a')).toEqual([]); expect(fixture.writes).toBe(0);
  });
  it('rejects explicit null storage but keeps explicit in-memory storage supported', () => {
    expect(() => lore.createLoreEntry('a', input, null)).toThrow();
    const entry = lore.createLoreEntry('a', input, window.localStorage);
    expect(lore.listLoreEntries('a', window.localStorage)).toEqual([entry]);
  });
  it('rejects the cold loading target and succeeds after binding completes', async () => {
    const gate = deferred(); fixture.readGate = { agentId: 'b', promise: gate.promise };
    const loading = refreshXingyeAgentPersistence('b');
    await waitFor(() => expect(fixture.reads).toBeGreaterThan(0));
    let rejected = false;
    try { lore.createLoreEntry('b', input); } catch { rejected = true; }
    gate.resolve(); await loading;
    expect(rejected).toBe(true);
    const entry = lore.createLoreEntry('b', input); await captureXingyePersistenceBinding('b').commit();
    expect(stored('b')).toEqual([entry]);
  });
  it('rejects B against old A binding while allowing valid A edits during B load', async () => {
    await bind(); const first = lore.createLoreEntry('a', input); await flushXingyePersistenceNow();
    const gate = deferred(); fixture.readGate = { agentId: 'b', promise: gate.promise };
    fixture.reads = 0; const loading = refreshXingyeAgentPersistence('b');
    await waitFor(() => expect(fixture.reads).toBeGreaterThan(0));
    let rejected = false;
    try { lore.createLoreEntry('b', input); } catch { rejected = true; }
    lore.updateLoreEntry(first.id, { content: 'A legitimate late edit' });
    gate.resolve(); await loading;
    expect(rejected).toBe(true); expect(stored()).toHaveLength(1);
    expect(stored()[0].content).toBe('A legitimate late edit'); expect(stored('b')).toEqual([]);
  });
  it('keeps rejected B writes absent across a read failure and explicit retry', async () => {
    await bind(); fixture.readFailure = true; await bind('b');
    expect(() => lore.createLoreEntry('b', input)).toThrow();
    fixture.readFailure = false; await bind('b');
    const entry = lore.createLoreEntry('b', input); await captureXingyePersistenceBinding('b').commit();
    expect(stored('b')).toEqual([entry]); expect(stored()).toEqual([]);
  });
  it('propagates storage write errors without reporting a successful create or change event', () => {
    const changed = vi.fn(); window.addEventListener(lore.XINGYE_LORE_ENTRIES_CHANGED_EVENT, changed);
    try {
      const storage = { getItem: () => null, setItem: () => { throw new Error('synthetic quota'); } };
      expect(() => lore.createLoreEntry('a', input, storage)).toThrow('synthetic quota');
      expect(changed).not.toHaveBeenCalled();
    } finally { window.removeEventListener(lore.XINGYE_LORE_ENTRIES_CHANGED_EVENT, changed); }
  });
  it('propagates update write errors and preserves the previously stored entry', () => {
    const entry = lore.createLoreEntry('a', input, window.localStorage);
    const storage = { getItem: (key: string) => window.localStorage.getItem(key), setItem: () => { throw new Error('synthetic quota'); } };
    expect(() => lore.updateLoreEntry(entry.id, { content: 'changed' }, storage)).toThrow('synthetic quota');
    expect(lore.listLoreEntries('a', window.localStorage)).toEqual([entry]);
  });
  it('does not revive an operation captured before A to B to A', async () => {
    await bind(); const old = captureXingyePersistenceBinding('a'); await bind('b'); await bind();
    expect(old.isCurrent()).toBe(false); await expect(old.commit()).rejects.toThrow();
  });
});

describe('LoreEditor preserves drafts until the intended save succeeds', () => {
  it('retains a cold-start draft and disables save until the binding is ready', async () => {
    render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton());
    expect(content()).toHaveValue(input.content); expect(saveButton()).toBeDisabled(); expect(fixture.writes).toBe(0);
    await bind(); expect(saveButton()).toBeEnabled(); fireEvent.click(saveButton()); await saved();
    expect(stored()).toHaveLength(1);
  });
  it('retains B text while A is bound, through a failed load, then saves B exactly once on retry', async () => {
    await bind(); render(<LoreEditor agentId="b" />); fill('B draft');
    expect(saveButton()).toBeDisabled(); fixture.readFailure = true; await bind('b');
    expect(content()).toHaveValue('B draft'); expect(saveButton()).toBeDisabled();
    fixture.readFailure = false; await bind('b'); fireEvent.click(saveButton()); await saved();
    expect(stored('b')).toHaveLength(1); expect(stored('b')[0].content).toBe('B draft'); expect(stored()).toEqual([]);
  });
  it('waits for the storage acknowledgment and ignores repeated save clicks', async () => {
    await bind(); const gate = deferred(); fixture.writeGate = gate.promise;
    render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton()); fireEvent.click(saveButton());
    const retained = (content() as HTMLTextAreaElement).value; const busy = (saveButton() as HTMLButtonElement).disabled;
    await act(async () => { gate.resolve(); await Promise.resolve(); }); await saved();
    expect(retained).toBe(input.content); expect(busy).toBe(true); expect(stored()).toHaveLength(1); expect(fixture.writes).toBe(1);
  });
  it('keeps a failed create draft and retries the same entry without duplicates', async () => {
    await bind(); fixture.writeFailure = true; render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('lore-editor-flash')).toHaveTextContent('synthetic write failure'));
    expect(content()).toHaveValue(input.content); expect(stored()).toEqual([]);
    const id = lore.listLoreEntries('a')[0].id;
    fixture.writeFailure = false; fireEvent.click(saveButton()); await saved();
    expect(stored()).toHaveLength(1); expect(stored()[0].id).toBe(id);
  });
  it('does not duplicate after an automatic flush succeeds before a manual retry', async () => {
    await bind(); fixture.writeFailure = true; render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(content()).toHaveValue(input.content);
    fixture.writeFailure = false; await act(() => flushXingyePersistenceNow());
    const id = stored()[0].id; fireEvent.click(saveButton()); await saved(); expect(stored().map(e => e.id)).toEqual([id]);
  });
  it('preserves updated text typed during a successful save and saves it to the same entry', async () => {
    await bind(); const gate = deferred(); fixture.writeGate = gate.promise;
    render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton());
    fireEvent.change(content(), { target: { value: 'New unsent input' } });
    await act(async () => { gate.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(saveButton()).toBeEnabled()); expect(content()).toHaveValue('New unsent input');
    expect(stored()).toHaveLength(1); expect(stored()[0].content).toBe(input.content);
    const id=stored()[0].id; fireEvent.click(saveButton()); await saved();
    expect(stored()).toHaveLength(1); expect(stored()[0]).toMatchObject({id,content:'New unsent input'});
  });
  it('preserves a newly emptied draft instead of treating it as the submitted revision', async () => {
    await bind(); const gate=deferred(); fixture.writeGate=gate.promise;
    render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton());
    fireEvent.change(content(), { target: { value: '' } });
    await act(async () => { gate.resolve(); await Promise.resolve(); }); await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(content()).toHaveValue(''); expect(title()).toHaveValue(input.title); expect(stored()).toHaveLength(1);
  });
  it('retains a new edit batched with the acknowledgment, even when text returns to its original value', async () => {
    await bind(); const gate=deferred(); fixture.writeGate=gate.promise;
    render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton());
    await act(async () => {
      fireEvent.change(content(), { target: { value: 'Intermediate edit' } });
      fireEvent.change(content(), { target: { value: input.content } });
      gate.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(content()).toHaveValue(input.content); expect(title()).toHaveValue(input.title); expect(stored()).toHaveLength(1);
  });
  it('keeps newer input after a failed save and updates the same ID on retry', async () => {
    await bind(); const gate=deferred(); fixture.writeGate=gate.promise; fixture.writeFailure=true;
    render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton()); fill('Revised while saving');
    await act(async () => { gate.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByTestId('lore-editor-flash')).toHaveTextContent('synthetic write failure'));
    expect(content()).toHaveValue('Revised while saving'); fixture.writeFailure=false;
    fireEvent.click(saveButton()); await saved(); expect(stored()).toHaveLength(1); expect(stored()[0].content).toBe('Revised while saving');
  });
  it('retains an existing entry draft when update returns null and supports retry', async () => {
    await bind(); const entry=lore.createLoreEntry('a',input); await flushXingyePersistenceNow();
    render(<LoreEditor agentId="a" />); fireEvent.click(screen.getByRole('button',{name:'编辑'})); fill('Edited fixture');
    const update=vi.spyOn(lore,'updateLoreEntry').mockReturnValueOnce(null); fireEvent.click(saveButton());
    expect(content()).toHaveValue('Edited fixture'); expect(screen.getByTestId('lore-editor-flash')).toHaveTextContent('保存失败');
    expect(stored()[0].content).toBe(input.content); update.mockRestore(); fireEvent.click(saveButton()); await saved();
    expect(stored()).toHaveLength(1); expect(stored()[0]).toMatchObject({id:entry.id,content:'Edited fixture'});
  });
  it('retains an existing entry draft after a failed durable update', async () => {
    await bind(); const entry=lore.createLoreEntry('a',input); await flushXingyePersistenceNow(); fixture.writeFailure=true;
    render(<LoreEditor agentId="a" />); fireEvent.click(screen.getByRole('button',{name:'编辑'})); fill('Edited fixture'); fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('lore-editor-flash')).toHaveTextContent('synthetic write failure'));
    expect(content()).toHaveValue('Edited fixture'); expect(stored()[0].content).toBe(input.content);
    fixture.writeFailure=false; fireEvent.click(saveButton()); await saved(); expect(stored()[0]).toMatchObject({id:entry.id,content:'Edited fixture'});
  });
  it('does not mistake a temporarily null binding for deletion of the entry being edited', async () => {
    await bind(); const entry=lore.createLoreEntry('a',input); await flushXingyePersistenceNow();
    render(<LoreEditor agentId="a" />); fireEvent.click(screen.getByRole('button',{name:'编辑'})); fill('Survive null binding');
    await bind(''); expect(content()).toHaveValue('Survive null binding'); expect(saveButton()).toBeDisabled();
    await bind(); expect(content()).toHaveValue('Survive null binding'); fireEvent.click(saveButton()); await saved();
    expect(stored()).toHaveLength(1); expect(stored()[0]).toMatchObject({id:entry.id,content:'Survive null binding'});
  });
  it('still lets the user cancel an existing edit while its binding is unavailable', async () => {
    await bind(); lore.createLoreEntry('a',input); await flushXingyePersistenceNow();
    render(<LoreEditor agentId="a" />); fireEvent.click(screen.getByRole('button',{name:'编辑'})); fill('Discard unavailable draft');
    await bind(''); fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));
    expect(content()).toHaveValue(''); await bind(); expect(stored()[0].content).toBe(input.content);
  });
  it('switching roles discards only the old form and never writes old text to the new role', async () => {
    await bind(); const view=render(<LoreEditor agentId="a" />); fill('A unsaved');
    view.rerender(<LoreEditor agentId="b" />); await bind('b');
    expect(content()).toHaveValue(''); fill('B new'); fireEvent.click(saveButton()); await saved();
    expect(stored()).toEqual([]); expect(stored('b')[0].content).toBe('B new');
  });
  it('an old save completion cannot clear B input after switching roles', async () => {
    await bind(); const gate=deferred(); fixture.writeGate=gate.promise;
    const view=render(<LoreEditor agentId="a" />); fill('A snapshot'); fireEvent.click(saveButton());
    view.rerender(<LoreEditor agentId="b" />); fill('B unsent');
    const switching=refreshXingyeAgentPersistence('b');
    await act(async () => { gate.resolve(); await switching; });
    expect(content()).toHaveValue('B unsent'); expect(stored()[0].content).toBe('A snapshot'); expect(stored('b')).toEqual([]);
  });
  it('an old save cannot clear a fresh A form after A to B to A', async () => {
    await bind(); const gate=deferred(); fixture.writeGate=gate.promise;
    const view=render(<LoreEditor agentId="a" />); fill('A snapshot'); fireEvent.click(saveButton());
    view.rerender(<LoreEditor agentId="b" />); view.rerender(<LoreEditor agentId="a" />); fill('Fresh A draft');
    await act(async () => { gate.resolve(); await Promise.resolve(); });
    expect(content()).toHaveValue('Fresh A draft'); expect(stored()[0].content).toBe('A snapshot');
  });
  it('cancel editing still discards only unsaved changes and performs no write', async () => {
    await bind(); lore.createLoreEntry('a',input); await flushXingyePersistenceNow(); const count=fixture.writes;
    render(<LoreEditor agentId="a" />); fireEvent.click(screen.getByRole('button',{name:'编辑'})); fill('Discard this');
    fireEvent.click(screen.getByRole('button',{name:'取消编辑'}));
    expect(content()).toHaveValue(''); expect(title()).toHaveValue(''); expect(stored()[0].content).toBe(input.content); expect(fixture.writes).toBe(count);
  });
  it('cancel during a save prevents its completion from clearing a new draft', async () => {
    await bind(); lore.createLoreEntry('a',input); await flushXingyePersistenceNow(); const gate=deferred(); fixture.writeGate=gate.promise;
    render(<LoreEditor agentId="a" />); fireEvent.click(screen.getByRole('button',{name:'编辑'})); fill('Submitted edit'); fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole('button',{name:'取消编辑'})); fill('Fresh unsaved draft');
    await act(async () => { gate.resolve(); await Promise.resolve(); });
    expect(content()).toHaveValue('Fresh unsaved draft'); expect(stored()[0].content).toBe('Submitted edit');
  });
  it('normal create and edit clear only after persistence and survive reload', async () => {
    await bind(); render(<LoreEditor agentId="a" />); fill(); fireEvent.click(saveButton()); await saved();
    fireEvent.click(screen.getByRole('button',{name:'编辑'})); fill('Saved edit'); fireEvent.click(saveButton()); await saved();
    resetXingyePersistenceForTests(); await bind(); expect(lore.listLoreEntries('a')).toHaveLength(1); expect(lore.listLoreEntries('a')[0].content).toBe('Saved edit');
  });
});
