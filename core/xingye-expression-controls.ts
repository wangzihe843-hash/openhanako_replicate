import { normalizeSessionTurnContext } from './session-turn-context.ts';
import {
  normalizeXingyeExpressionPresets,
  formatXingyeExpressionPresets,
  type XingyeExpressionPresets,
} from '../shared/xingye-expression-presets.ts';

interface ExpressionEngine {
  getSessionManifest?: (sessionId: string) => {
    ownerAgentId?: string;
    lifecycle?: string;
    currentLocator?: { path?: string };
  } | null;
}

export interface XingyeSceneInstruction {
  text: string;
  remainingTurns: number | null;
  presets: XingyeExpressionPresets;
}

export interface XingyeExpressionControls {
  sessionId: string;
  agentId: string;
  revision: number;
  scene: XingyeSceneInstruction | null;
  presets: XingyeExpressionPresets;
}

// Deliberately process-local: these controls never become character or memory data.
const controlsByEngine = new WeakMap<object, Map<string, XingyeExpressionControls>>();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function owner(engine: ExpressionEngine, sessionId: string, expectedAgentId?: string): string {
  const manifest = engine.getSessionManifest?.(sessionId);
  if (!sessionId || !manifest?.ownerAgentId || manifest.lifecycle !== 'active') {
    throw new Error('expression controls require an active session');
  }
  if (expectedAgentId !== undefined && expectedAgentId !== manifest.ownerAgentId) {
    throw new Error('expression controls owner mismatch');
  }
  return manifest.ownerAgentId;
}

export function readXingyeExpressionControls(engine: ExpressionEngine, sessionId: string, agentId?: string): XingyeExpressionControls {
  const currentOwner = owner(engine, sessionId, agentId);
  const stored = controlsByEngine.get(engine)?.get(sessionId);
  if (stored && stored.agentId === currentOwner) return clone(stored);
  if (stored) controlsByEngine.get(engine)?.delete(sessionId);
  return { sessionId, agentId: currentOwner, revision: 0, scene: null, presets: {} };
}

export function clearXingyeExpressionControls(engine: ExpressionEngine, sessionId: string | null): void {
  if (sessionId) controlsByEngine.get(engine)?.delete(sessionId);
}

function validatePresets(value: unknown): XingyeExpressionPresets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid expression presets');
  const normalized = normalizeXingyeExpressionPresets(value);
  if (Object.keys(value).some(key => !Object.hasOwn(normalized, key))) throw new Error('invalid expression preset option');
  return normalized;
}

function normalizeScene(value: unknown): XingyeSceneInstruction | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid scene instruction');
  const scene = value as Record<string, unknown>;
  if (typeof scene.text !== 'string' || scene.text.length > 2000) throw new Error('scene text must be at most 2000 characters');
  if (scene.remainingTurns !== null && (!Number.isInteger(scene.remainingTurns) || Number(scene.remainingTurns) < 1 || Number(scene.remainingTurns) > 20)) {
    throw new Error('scene duration must be 1 to 20 turns or null');
  }
  const text = scene.text.trim();
  const presets = validatePresets(scene.presets ?? {});
  return text || Object.keys(presets).length ? { text, remainingTurns: scene.remainingTurns as number | null, presets } : null;
}

export function updateXingyeExpressionControls(engine: ExpressionEngine, sessionId: string, agentId: string, patch: { scene?: unknown; presets?: unknown }): XingyeExpressionControls {
  const previous = readXingyeExpressionControls(engine, sessionId, agentId);
  const next = {
    ...previous,
    revision: previous.revision + 1,
    scene: patch.scene === undefined ? previous.scene : normalizeScene(patch.scene),
    presets: patch.presets === undefined ? previous.presets : validatePresets(patch.presets),
  };
  let states = controlsByEngine.get(engine);
  if (!states) { states = new Map(); controlsByEngine.set(engine, states); }
  states.set(sessionId, next);
  return clone(next);
}

/** Capture one immutable execution snapshot; consume only at input acceptance. */
export function prepareXingyeExpressionTurn(engine: ExpressionEngine, sessionId: string | null, sessionPath: string, rawContext: unknown) {
  const base = normalizeSessionTurnContext(rawContext);
  const stored = sessionId ? controlsByEngine.get(engine)?.get(sessionId) : null;
  if (!stored || !sessionId) return { context: base, accept: () => {} };
  const state = readXingyeExpressionControls(engine, sessionId, stored.agentId);
  if (engine.getSessionManifest?.(state.sessionId)?.currentLocator?.path !== sessionPath) {
    throw new Error('expression controls session locator mismatch');
  }
  const lines = [formatXingyeExpressionPresets(state.presets, state.scene?.presets)];
  if (state.scene?.text) lines.push(`【临时场景指令】\n${state.scene.text}`);
  const content = lines.filter(Boolean).join('\n\n');
  const system = content ? [base?.system, '以下表达控制仅适用于当前角色的本次执行，不作为永久人格或长期记忆。不要替用户决定行动、心理或回应。', content].filter(Boolean).join('\n\n') : base?.system;
  let accepted = false;
  return {
    context: normalizeSessionTurnContext({ ...base, system }),
    accept: () => {
      if (accepted) return;
      accepted = true;
      // A replaced setting must never have its duration decremented by an old turn.
      const live = controlsByEngine.get(engine)?.get(state.sessionId);
      if (!live || live.revision !== state.revision || live.agentId !== state.agentId) return;
      if (owner(engine, state.sessionId, state.agentId) !== state.agentId) return;
      if (live.scene?.remainingTurns != null) {
        live.scene.remainingTurns -= 1;
        if (live.scene.remainingTurns === 0) live.scene = null;
        live.revision += 1;
      }
    },
  };
}
