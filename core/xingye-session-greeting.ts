import { renderCharacterCardText } from '../shared/xingye-character-card.ts';

export const MAX_XINGYE_GREETING_CHARS = 16_000;
export type InitialXingyeGreeting = { agentId: string; text: string };
type GreetingProfile = { firstMessage?: unknown; alternateGreetings?: unknown } | null;

function greetingError(message: string, code: string, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/** Select only the saved, explicitly previewed card text. -1 means a blank chat. */
export function resolveXingyeSessionGreeting({
  agentId, index, expectedText, profile, character, user,
}: {
  agentId: string; index: unknown; expectedText: unknown; profile: GreetingProfile;
  character: string; user: string;
}): InitialXingyeGreeting {
  if (!Number.isSafeInteger(index) || Number(index) < -1) {
    throw greetingError('请选择有效的角色开场白。', 'xingye_greeting_invalid');
  }
  const alternatives = Array.isArray(profile?.alternateGreetings) ? profile.alternateGreetings : [];
  const raw = index === -1 ? '' : index === 0 ? profile?.firstMessage : alternatives[Number(index) - 1];
  if (typeof raw !== 'string' || (index !== -1 && !raw.trim())) {
    throw greetingError('所选开场白为空，请重新选择或新建空白聊天。', 'xingye_greeting_empty');
  }
  if (typeof expectedText !== 'string' || raw !== expectedText) {
    throw greetingError('角色开场白已更新，请重新读取并预览后再创建。', 'xingye_greeting_changed', 409);
  }
  const text = renderCharacterCardText(raw, character, user);
  if (raw.length > MAX_XINGYE_GREETING_CHARS || text.length > MAX_XINGYE_GREETING_CHARS) {
    throw greetingError('开场白超过 16000 字符，请缩短后再创建聊天。', 'xingye_greeting_too_long');
  }
  return { agentId, text };
}

type GreetingSession = {
  isStreaming?: boolean;
  isCompacting?: boolean;
  agent: { state: { messages: unknown[] } };
  sessionManager: {
    buildSessionContext: () => { messages: unknown[] };
    appendMessage: (message: ReturnType<typeof greetingMessage>) => string;
  };
};

/** Called only inside fresh session construction, before registration or publication. */
export function seedXingyeSessionGreeting(session: GreetingSession, greeting: InitialXingyeGreeting, agentId: string) {
  if (greeting.agentId !== agentId) {
    throw greetingError('角色已变化，无法创建开场聊天。', 'xingye_greeting_owner_mismatch', 409);
  }
  if (session.isStreaming || session.isCompacting || session.agent.state.messages.length
    || session.sessionManager.buildSessionContext().messages.length) {
    throw greetingError('开场白只能用于全新的空白聊天。', 'xingye_greeting_session_not_empty', 409);
  }
  if (!greeting.text) return;
  if (greeting.text.length > MAX_XINGYE_GREETING_CHARS) {
    throw greetingError('开场白超过 16000 字符。', 'xingye_greeting_too_long');
  }
  // Authored text is an assistant message, never a generated response or user/custom input.
  // No prompt, lifecycle event, tool execution, usage charge or memory notification runs here.
  const message = greetingMessage(greeting.text);
  session.sessionManager.appendMessage(message);
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
}

function greetingMessage(text: string) {
  return {
    role: 'assistant' as const, content: [{ type: 'text' as const, text }],
    api: 'openai-completions' as const, provider: 'hana', model: 'authored-greeting',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const, timestamp: Date.now(),
  };
}
