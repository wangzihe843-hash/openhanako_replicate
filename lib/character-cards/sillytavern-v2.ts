import type { CharacterCardCompatibility, CharacterCardImportReport } from '../../shared/xingye-character-card.ts';

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function adaptSillyTavernV2Card(input: unknown) {
  if (!record(input) || !('spec' in input)) return null;
  if (input.spec !== 'chara_card_v2' || input.spec_version !== '2.0' || !record(input.data)) {
    throw new Error('Only SillyTavern V2 JSON (chara_card_v2, version 2.0) is supported. PNG/V3 are not supported yet.');
  }
  const data = input.data;
  if (!text(data.name).trim()) throw new Error('SillyTavern data.name is required');
  const report: CharacterCardImportReport = {
    format: 'sillytavern-v2',
    mapped: ['name → 角色名', 'description / personality → 人设', 'scenario → 默认场景（2000 字符预算）', 'first_mes / alternate_greetings → 可选开场', 'mes_example → 表达示例（4000 字符预算）'],
    retained: ['原始 JSON、作者/标签/版本、未知字段与 extensions 保留；导出包含更新后的 SillyTavern V2 JSON', '这是字段子集适配，不等同完整 V2 前端语义；场景/开场/示例仅替换 {{char}} / {{user}}'],
    manual: [],
    creatorNotes: text(data.creator_notes),
  };
  for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']) {
    if (data[field] !== undefined && typeof data[field] !== 'string') report.manual.push(`${field} 类型不正确：原值仅保留，不生效`);
  }
  if (data.alternate_greetings !== undefined && (!Array.isArray(data.alternate_greetings) || data.alternate_greetings.some(value => typeof value !== 'string'))) {
    report.manual.push('alternate_greetings 非文本项仅保留，不作为开场');
  }
  for (const field of ['system_prompt', 'post_history_instructions']) {
    if (data[field]) report.retained.push(`${field}：仅保留，不替换平台提示或授权`);
  }
  if (record(data.extensions) && Object.keys(data.extensions).length) report.retained.push('卡片扩展、正则、脚本、资源引用不执行');
  const promptValues = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'].map(key => text(data[key]));
  promptValues.push(...strings(data.alternate_greetings));
  if (promptValues.some(value => /\{\{(?!char\}\}|user\}\})[^}]+\}\}|<%/i.test(value))) report.manual.push('仅替换 {{char}} / {{user}}；其它宏和模板保持文本，请人工调整');
  if ([text(data.first_mes), ...strings(data.alternate_greetings)].some(value => value.length > 16_000)) report.manual.push('开场超过 16000 字符：保留原文，开始新聊天前需缩短');
  if ([text(data.description), text(data.personality)].some(value => /\{\{|<%/.test(value))) report.manual.push('人格文本中的宏保持原文，请人工替换；不会执行模板');
  const lore: JsonRecord[] = [];
  const book = data.character_book;
  if (book !== undefined && (!record(book) || !Array.isArray(book.entries))) report.manual.push('character_book 结构无效：仅保留原始数据');
  if (record(book) && Array.isArray(book.entries)) {
    if (book.scan_depth !== undefined || book.token_budget !== undefined || book.recursive_scanning === true) report.retained.push('世界书 scan_depth / token_budget / recursive_scanning 不生效，采用现有选择与预算');
    if (record(book.extensions) && Object.keys(book.extensions).length) report.retained.push('世界书 extensions 仅保留，不执行');
    book.entries.forEach((raw, index) => {
      if (!record(raw) || !text(raw.content).trim()) {
        report.manual.push(`character_book.entries[${index}] 内容无效：仅保留`);
        return;
      }
      if (/\{\{|<%/.test(text(raw.content))) report.manual.push(`世界书条目 ${index + 1} 的宏保持原文，请人工替换`);
      const unsupported = raw.selective === true || raw.case_sensitive === true
        || (record(raw.extensions) && Object.keys(raw.extensions).length > 0);
      const keywords = strings(raw.keys).map(item => item.trim()).filter(Boolean);
      const validMode = raw.constant === true || keywords.length > 0;
      if (unsupported || !validMode) report.manual.push(`世界书条目 ${index + 1}：${unsupported ? '选择/大小写/扩展规则尚未适配' : '没有激活关键词'}，以禁用的手动条目导入`);
      lore.push({
        id: `st-v2-${index}`, title: text(raw.name) || text(raw.comment) || `Worldbook ${index + 1}`,
        content: text(raw.content), category: 'worldview', keywords,
        enabled: raw.enabled === true && !unsupported && validMode,
        priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? Math.max(0, Math.min(100, Math.round(raw.priority))) : 100,
        insertionMode: unsupported || !validMode ? 'manual' : raw.constant === true ? 'always' : 'keyword',
        visibility: 'canonical',
      });
    });
    report.mapped.push(`character_book → ${lore.length} 条角色设定（constant / keys / enabled；使用现有 canonical 可见性和优先级）`);
    report.retained.push('世界书 insertion_order / position 保留，不复刻酒馆插入位置；priority 限定为现有 0–100');
  }
  const metadata: CharacterCardCompatibility = { format: 'sillytavern-v2', sourceCard: copy(input), loreEntryIds: lore.map(entry => String(entry.id)) };
  return {
    card: {
      kind: 'CharacterCard',
      agent: { name: text(data.name).trim(), description: text(data.description) },
      prompts: {
        identity: [text(data.name), text(data.description)].filter(Boolean).join('\n\n'),
        agents: text(data.personality) ? `Character personality (writing reference only):\n${text(data.personality)}` : undefined,
      },
      xingye: {
        profile: {
          displayName: text(data.name).trim(), identitySummary: text(data.description), personalitySummary: text(data.personality),
          scenario: text(data.scenario), firstMessage: text(data.first_mes), alternateGreetings: strings(data.alternate_greetings), messageExample: text(data.mes_example),
          characterCardCompatibility: metadata,
        },
        lore,
      },
    },
    report,
  };
}

/** Export current normalized values over source data; empty/deleted values never resurrect. */
export function exportSillyTavernV2Card(profile: JsonRecord | null, lore: JsonRecord[], name: string): JsonRecord | null {
  const metadata = profile?.characterCardCompatibility;
  if (!record(metadata) || metadata.format !== 'sillytavern-v2' || !record(metadata.sourceCard)) return null;
  const card = copy(metadata.sourceCard);
  const data = record(card.data) ? card.data : {};
  card.data = data;
  data.name = text(profile?.displayName) || name;
  data.description = text(profile?.identitySummary);
  data.personality = text(profile?.personalitySummary);
  data.scenario = text(profile?.scenario);
  data.first_mes = text(profile?.firstMessage);
  data.alternate_greetings = strings(profile?.alternateGreetings);
  data.mes_example = text(profile?.messageExample);
  const book = record(data.character_book) ? data.character_book : {};
  const originals = Array.isArray(book.entries) ? book.entries : [];
  const mappedIds = new Set(strings(metadata.loreEntryIds));
  const currentIds = new Set(lore.map(entry => text(entry.id)));
  const entries: unknown[] = originals.filter((_entry, index) => !mappedIds.has(`st-v2-${index}`));
  for (const entry of lore) {
    const id = text(entry.id);
    const index = /^st-v2-(\d+)$/.exec(id);
    const raw = index && mappedIds.has(id) ? originals[Number(index[1])] : null;
    const original = record(raw) ? copy(raw) : {};
    entries.push({
      ...original,
      name: text(entry.title), content: text(entry.content), keys: strings(entry.keywords),
      enabled: entry.enabled === true && entry.visibility === 'canonical' && entry.insertionMode !== 'manual',
      constant: entry.insertionMode === 'always', priority: entry.priority,
      insertion_order: typeof original.insertion_order === 'number' ? original.insertion_order : entries.length,
      extensions: record(original.extensions) ? original.extensions : {},
    });
  }
  // The source list is archival; only still-present mapped entries enter the exported book.
  if (record(data.character_book) || entries.length || currentIds.size) data.character_book = { ...book, extensions: record(book.extensions) ? book.extensions : {}, entries };
  return card;
}
/** Accept the declared native package subset without trusting source-owned paths/agent IDs. */
export function normalizePackagedXingye(value: unknown) {
  if (!record(value) || !record(value.profile)) return null;
  const input = value.profile;
  const profile: JsonRecord = {};
  for (const key of ['displayName', 'shortBio', 'relationshipLabel', 'speakingStyle', 'identitySummary', 'backgroundSummary', 'personalitySummary', 'behaviorLogic', 'values', 'taboos', 'relationshipMode', 'scenario', 'firstMessage', 'messageExample']) {
    if (typeof input[key] === 'string') profile[key] = input[key];
  }
  if (Array.isArray(input.alternateGreetings)) profile.alternateGreetings = strings(input.alternateGreetings);
  if (['female', 'male', 'nonbinary', 'unspecified'].includes(text(input.gender))) profile.gender = input.gender;
  if (['none', 'latent', 'marked'].includes(text(input.corruptionTendency))) profile.corruptionTendency = input.corruptionTendency;
  if (typeof input.corruptionSeed === 'number' && Number.isFinite(input.corruptionSeed)) profile.corruptionSeed = Math.max(0, Math.min(100, input.corruptionSeed));
  const metadata = input.characterCardCompatibility;
  if (record(metadata) && metadata.format === 'sillytavern-v2' && record(metadata.sourceCard)) {
    profile.characterCardCompatibility = { format: 'sillytavern-v2', sourceCard: copy(metadata.sourceCard), loreEntryIds: strings(metadata.loreEntryIds) };
  }
  const categories = ['background', 'worldview', 'relationship', 'event', 'location', 'organization', 'character', 'rule'];
  const seen = new Set<string>();
  const lore = (Array.isArray(value.lore) ? value.lore : []).filter(record).map((entry, index) => {
    let id = text(entry.id).trim() || `card-lore-${index}`;
    const baseId = id;
    let suffix = 0;
    while (seen.has(id)) { id = `card-lore-${index}-${suffix}-${baseId}`; suffix += 1; }
    seen.add(id);
    return {
      id, title: text(entry.title), content: text(entry.content),
      category: categories.includes(text(entry.category)) ? text(entry.category) : 'background',
      keywords: strings(entry.keywords), enabled: entry.enabled === true,
      priority: typeof entry.priority === 'number' && Number.isFinite(entry.priority) ? Math.max(0, Math.min(100, entry.priority)) : 100,
      insertionMode: ['always', 'keyword', 'manual'].includes(text(entry.insertionMode)) ? text(entry.insertionMode) : 'manual',
      visibility: ['canonical', 'private', 'draft'].includes(text(entry.visibility)) ? text(entry.visibility) : 'draft',
    };
  });
  return { profile, lore };
}