import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callText } from '../core/llm-client.ts';
import { createXingyeRoute } from '../server/routes/xingye.js';
import { buildLocalSceneSections, sceneSourcePage, selectSceneRange, sceneSourceHash } from '../server/routes/xingye-scene-summary.js';

vi.mock('../core/llm-client.ts', () => ({ callText: vi.fn() }));
beforeEach(() => vi.mocked(callText).mockReset());

function fixture() {
  const agentsDir = path.join(process.cwd(), 'test-agents');
  const sessionPath = path.join(agentsDir, 'agent-a', 'sessions', 'session.jsonl');
  const branch = [
    { type: 'message', id: 'u1', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: '我们在月台见面。' } },
    { type: 'message', id: 'a1', timestamp: '2026-09-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '我会带伞，明天再谈离开的事。' }] } },
    { type: 'message', id: 'u2', timestamp: '2026-09-01T00:02:00Z', message: { role: 'user', content: '好。' } },
  ];
  const manifest = { memoryScope: undefined, ownerAgentId: 'agent-a', lifecycle: 'active', currentLocator: { path: sessionPath } };
  const engine = {
    agentsDir,
    getSessionMemoryScope: () => manifest.memoryScope,
    getSessionManifest: (id) => id === 'session-a' ? manifest : null,
    openSessionManagerAtCurrentBranch: () => ({ getBranch: () => branch }),
    resolveUtilityConfig: () => ({ utility: 'configured-scene-model', api: 'openai-completions', base_url: 'https://configured.example/v1', api_key: 'mock-key' }),
    getAgent: () => ({ config: { models: { chat: { id: 'backup', provider: 'test' } } } }),
    resolveModelWithCredentials: () => ({ api: 'openai-completions', model: 'backup', base_url: 'https://backup.example/v1', api_key: 'mock-key' }),
  };
  const app = new Hono();
  app.route('/api', createXingyeRoute(engine));
  const post = (route, body) => app.request(`/api/xingye/scene-summary/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, post, branch, manifest };
}

describe('M5 local scene evidence route', () => {
  it('pages backward and preserves a selected range across page boundaries', () => {
    const sources = Array.from({ length: 205 }, (_, index) => ({
      entryId: `entry-${index}`, role: 'user', text: `line ${index}`, hash: sceneSourceHash(`line ${index}`), timestamp: null,
    }));
    const latest = sceneSourcePage(sources, null);
    const earlier = sceneSourcePage(sources, latest.nextBefore);
    expect(latest.rows).toHaveLength(100);
    expect(latest.rows[0].ordinal).toBe(105);
    expect(earlier.rows[0].ordinal).toBe(5);
    expect(selectSceneRange(sources, 'entry-95', 'entry-110')).toHaveLength(16);
  });

  it('samples supported events across the selected range and flags uncategorized future dialogue as inference', () => {
    const sources = Array.from({ length: 20 }, (_, index) => ({
      entryId: `entry-${index}`, text: `我把第${index}个线索交给你了。`,
    }));
    const sections = buildLocalSceneSections(sources);
    expect(sections).toHaveLength(5);
    expect(sections[0].evidence[0].entryId).toBe('entry-0');
    expect(sections.at(-1).evidence[0].entryId).toBe('entry-19');
    const future = buildLocalSceneSections([{ entryId: 'future', text: '我们明天见面。' }]);
    expect(future).toMatchObject([{ kind: 'event', inference: true, evidence: [{ entryId: 'future', quote: '我们明天见面。' }] }]);
  });

  it('reads only the agent-owned current branch and creates a local cited draft', async () => {
    const { app, post } = fixture();
    const sourceResponse = await app.request('/api/xingye/scene-summary/sources?agentId=agent-a&sessionId=session-a');
    expect(sourceResponse.status).toBe(200);
    const source = await sourceResponse.json();
    expect(source.rows.map(row => row.entryId)).toEqual(['u1', 'a1', 'u2']);
    const response = await post('generate', { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1' });
    expect(response.status).toBe(200);
    const draft = await response.json();
    expect(draft.generator).toBe('local-evidence-extract');
    expect(draft.sourceRefs).toHaveLength(2);
    expect(draft.sections[0]).toMatchObject({ kind: 'location', inference: false, evidence: [{ entryId: 'u1', quote: '我们在月台见面。' }] });
    expect(callText).not.toHaveBeenCalled();
    const valid = await post('validate', { agentId: 'agent-a', sessionId: 'session-a', sourceRefs: draft.sourceRefs, sections: draft.sections });
    expect((await valid.json()).valid).toBe(true);
  });

  it('extracts cited role, place, event, and unresolved items from Chinese dialogue without truncating messages', async () => {
    const { post, branch } = fixture();
    branch[0].message.content = '我是守夜人。我们在旧月台见面。';
    branch[1].message.content = '我把钥匙交给你了。离开的决定明天再谈。';
    const response = await post('generate', { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1' });
    expect(response.status).toBe(200);
    const draft = await response.json();
    expect(draft.sections.map(section => section.kind)).toEqual(['role', 'location', 'event', 'open_thread']);
    expect(draft.sections.map(section => section.text)).toEqual([
      '我是守夜人。', '我们在旧月台见面。', '我把钥匙交给你了。', '离开的决定明天再谈。',
    ]);
    expect(draft.sections.every(section => section.evidence.length === 1 && section.evidence[0].quote === section.text)).toBe(true);
    expect(draft.sections.map(section => section.inference)).toEqual([false, false, false, true]);
    expect((await (await post('validate', {
      agentId: 'agent-a', sessionId: 'session-a', sourceRefs: draft.sourceRefs, sections: draft.sections,
    })).json()).valid).toBe(true);
    expect(callText).not.toHaveBeenCalled();
  });

  it('marks edited/deleted/off-branch sources and unsupported direct quotes stale', async () => {
    const { post, branch, manifest } = fixture();
    const draft = await (await post('generate', { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1' })).json();
    const body = { agentId: 'agent-a', sessionId: 'session-a', sourceRefs: draft.sourceRefs, sections: draft.sections };
    expect((await (await post('validate', { ...body, sections: [] })).json()).valid).toBe(false);
    branch[0].message.content = '我们换了地点。';
    expect((await (await post('validate', body)).json()).valid).toBe(false);
    branch[0].message.content = '我们在月台见面。';
    branch.splice(0, 1);
    expect((await (await post('validate', body)).json()).valid).toBe(false);
    branch.unshift({ type: 'message', id: 'u1', message: { role: 'user', content: '我们在月台见面。' } });
    const changed = structuredClone(body);
    changed.sections[0].evidence[0].quote = '从未说过的话';
    expect((await (await post('validate', changed)).json()).valid).toBe(false);
    const unsupportedClaim = structuredClone(body);
    unsupportedClaim.sections[0].text = '已经到港口见面。';
    expect((await (await post('validate', unsupportedClaim)).json()).valid).toBe(false);
    const inventedInferenceQuote = structuredClone(body);
    inventedInferenceQuote.sections[0].inference = true;
    inventedInferenceQuote.sections[0].evidence[0].quote = '从未说过的话';
    expect((await (await post('validate', inventedInferenceQuote)).json()).valid).toBe(false);
    manifest.lifecycle = 'deleted';
    expect((await post('validate', body)).status).toBe(400);
  });

  it('rejects a session owned by another agent and an oversized range', async () => {
    const { post, branch } = fixture();
    expect((await post('generate', { agentId: 'agent-b', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1' })).status).toBe(400);
    for (let i = 0; i < 30; i++) branch.push({ type: 'message', id: `extra-${i}`, message: { role: 'user', content: `extra ${i}` } });
    expect((await post('generate', { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'extra-29' })).status).toBe(400);
    expect(callText).not.toHaveBeenCalled();
  });

  it('requires an explicit provider opt-in before sending any selected transcript', async () => {
    const { post } = fixture();
    const request = { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1', generator: 'model' };
    expect((await post('generate', request)).status).toBe(400);
    expect((await post('generate', { ...request, providerConsent: 'true' })).status).toBe(400);
    expect(callText).not.toHaveBeenCalled();
  });

  it('sends only the bounded selected messages once, retaining quoted evidence and downgrading unsupported direct claims', async () => {
    const { post } = fixture();
    vi.mocked(callText).mockResolvedValue(JSON.stringify({ sections: [
      { kind: 'location', text: '我们在月台见面。', inference: false, evidence: [{ entryId: 'u1', quote: '我们在月台见面。' }] },
      { kind: 'open_thread', text: '他们已经离开', inference: false, evidence: [{ entryId: 'a1', quote: '明天再谈离开的事。' }] },
      { kind: 'event', text: '无来源的声称', inference: false, evidence: [{ entryId: 'u2', quote: '好。' }] },
    ] }));
    const response = await post('generate', {
      agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1', generator: 'model', providerConsent: true,
    });
    expect(response.status).toBe(200);
    expect(callText).toHaveBeenCalledOnce();
    const call = vi.mocked(callText).mock.calls[0][0];
    expect(call.model).toBe('configured-scene-model');
    expect(call.baseUrl).toBe('https://configured.example/v1');
    const prompt = call.messages[0].content;
    expect(prompt).toContain('我们在月台见面。');
    expect(prompt).toContain('我会带伞，明天再谈离开的事。');
    expect(prompt).not.toContain('"entryId":"u2"');
    const draft = await response.json();
    expect(draft.generator).toBe('configured-model');
    expect(draft.modelTier).toBe('utility');
    expect(draft.sections.map(section => section.inference)).toEqual([false, true, true]);
    expect(draft.sections[2].evidence).toEqual([]);
    expect(draft.sourceRefs.every(ref => !('text' in ref))).toBe(true);
    expect(JSON.stringify(draft)).not.toContain('我会带伞，明天再谈离开的事。');
  });

  it('does not send the transcript to a second provider after invalid model output', async () => {
    const { post } = fixture();
    vi.mocked(callText).mockResolvedValue('invalid-json');
    const response = await post('generate', {
      agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1', generator: 'model', providerConsent: true,
    });
    expect(response.status).toBe(502);
    expect(callText).toHaveBeenCalledOnce();
  });

  it('ignores null model entries while keeping valid cited sections', async () => {
    const { post } = fixture();
    vi.mocked(callText).mockResolvedValue(JSON.stringify({ sections: [null, { kind: 'location', text: '我们在月台见面。', evidence: [{ entryId: 'u1', quote: '我们在月台见面。' }] }] }));
    const response = await post('generate', {
      agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1', generator: 'model', providerConsent: true,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).sections).toMatchObject([{ kind: 'location', inference: false }]);
    expect(callText).toHaveBeenCalledOnce();
  });

  it('rejects a model draft if the source changes during the provider call', async () => {
    const { post, branch } = fixture();
    vi.mocked(callText).mockImplementation(async () => {
      branch[0].message.content = '我们改在港口见面。';
      return JSON.stringify({ sections: [{ kind: 'location', text: '我们在月台见面。', inference: false, evidence: [{ entryId: 'u1', quote: '我们在月台见面。' }] }] });
    });
    const response = await post('generate', {
      agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1', generator: 'model', providerConsent: true,
    });
    expect(response.status).toBe(409);
    expect(callText).toHaveBeenCalledOnce();
  });

  it('rejects a model draft if the session is deleted during the provider call', async () => {
    const { post, manifest } = fixture();
    vi.mocked(callText).mockImplementation(async () => {
      manifest.lifecycle = 'deleted';
      return JSON.stringify({ sections: [{ kind: 'location', text: '我们在月台见面。', inference: false, evidence: [{ entryId: 'u1', quote: '我们在月台见面。' }] }] });
    });
    const response = await post('generate', {
      agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1', generator: 'model', providerConsent: true,
    });
    expect(response.status).toBe(409);
    expect(callText).toHaveBeenCalledOnce();
  });
});


describe('L1 scene provenance and scope', () => {
  const story = { version: 1, agentId: 'agent-a', realm: 'story', worldId: 'same-world', branchId: 'a', knowledge: 'shared' };
  it('verifies unchanged pre-L1 legacy text hashes without allowing the fallback for new/scoped candidates', async () => {
    const { post, manifest, branch } = fixture();
    const old = { agentId: 'agent-a', sessionId: 'session-a', sourceRefs: [{ entryId: 'u1', role: 'user', hash: sceneSourceHash('我们在月台见面。') }], sections: [{ kind: 'location', text: '我们在月台见面。', inference: false, evidence: [{ entryId: 'u1', quote: '我们在月台见面。' }] }] };
    expect((await (await post('validate', old)).json()).valid).toBe(true);
    const fresh = await (await post('generate', { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'u1' })).json();
    expect((await (await post('validate', { ...old, sourceRevision: fresh.sourceRevision })).json()).valid).toBe(false);
    branch[0].message.content = '我们改在港口见面。';
    expect((await (await post('validate', old)).json()).valid).toBe(false);
    branch[0].message.content = '我们在月台见面。';
    manifest.memoryScope = story;
    expect((await (await post('validate', { ...old, memoryScope: story })).json()).valid).toBe(false);
  });
  it('returns author viewpoint separately from persisted candidate scope', async () => {
    const { app, post, manifest } = fixture();
    manifest.memoryScope = { ...story, knowledge: 'author', viewpoint: 'author' };
    const snapshot = await (await app.request('/api/xingye/scene-summary/sources?agentId=agent-a&sessionId=session-a')).json();
    expect(snapshot.memoryContext.viewpoint).toBe('author');
    expect(snapshot.memoryScope).not.toHaveProperty('viewpoint');
    const draft = await (await post('generate', { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1' })).json();
    expect(draft.memoryContext.viewpoint).toBe('author');
    expect(draft.memoryScope.knowledge).toBe('author');
    expect(draft.memoryScope).not.toHaveProperty('viewpoint');
  });
  it('uses trusted session scope rather than model/request scope and preserves original-message dependencies', async () => {
    const { post, manifest, branch } = fixture();
    manifest.memoryScope = story;
    const draft = await (await post('generate', { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1', memoryScope: { ...story, branchId: 'forged' } })).json();
    expect(draft.memoryScope).toEqual(story);
    expect(draft.sourceDependencies).toEqual([{ sessionId: 'session-a', revision: draft.sourceRevision, sourceRefs: draft.sourceRefs }]);
    const body = { agentId: 'agent-a', ...draft };
    expect((await (await post('validate', body)).json()).valid).toBe(true);
    // Revision/hash changes even when display text is unchanged.
    branch[0].message.privateRevision = 2;
    expect((await (await post('validate', body)).json()).valid).toBe(false);
  });
  it('rejects same-message validation and late model completion on a different branch', async () => {
    const { post, manifest } = fixture();
    manifest.memoryScope = story;
    const request = { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1' };
    const draft = await (await post('generate', request)).json();
    manifest.memoryScope = { ...story, branchId: 'b' };
    expect((await (await post('validate', { agentId: 'agent-a', ...draft })).json()).valid).toBe(false);
    manifest.memoryScope = story;
    vi.mocked(callText).mockImplementation(async () => {
      manifest.memoryScope = { ...story, branchId: 'b' };
      return JSON.stringify({ memoryScope: story, sections: draft.sections });
    });
    expect((await post('generate', { ...request, generator: 'model', providerConsent: true })).status).toBe(409);
  });
  it('fails closed for malformed explicit scope and omitted story validation provenance', async () => {
    const { post, manifest } = fixture();
    manifest.memoryScope = { ...story, branchId: undefined };
    const request = { agentId: 'agent-a', sessionId: 'session-a', startEntryId: 'u1', endEntryId: 'a1' };
    expect((await post('generate', request)).status).toBe(400);
    manifest.memoryScope = story;
    const draft = await (await post('generate', request)).json();
    expect((await (await post('validate', { agentId: 'agent-a', sessionId: 'session-a', sourceRefs: draft.sourceRefs, sections: draft.sections })).json()).valid).toBe(false);
  });
});
