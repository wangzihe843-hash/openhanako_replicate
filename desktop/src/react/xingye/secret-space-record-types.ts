export type SecretSpaceRecordKind =
  | 'draft_reply'
  | 'dream'
  | 'saved_item'
  | 'unsent_moment'
  | 'memory_fragment'
  /**
   * AI 生成 / 心跳草稿确认 都可能往 state.jsonl 写记录（state 在
   * SECRET_SPACE_AI_GENERABLE_CATEGORIES 与 SECRET_SPACE_DRAFT_ALLOWED_CATEGORIES
   * 里都列了）。state 类目的主视图是 RelationshipStatePanel（关系状态卡），
   * 但 state.jsonl 里的具体条目应当如实标 kind='state'——之前 store 把它强行
   * 改成 'memory_fragment' 是错的（条目在列表里挂"回忆"标签）。
   */
  | 'state'
  /** TA 的独家专访（秘密空间独立模块；结构化数据存在 record.metadata 里）。 */
  | 'interview';

/** 分类列表与详情页共用的类型展示文案 */
export const SECRET_SPACE_RECORD_KIND_LABEL: Record<SecretSpaceRecordKind, string> = {
  draft_reply: '草稿',
  dream: '梦境',
  saved_item: '文字收藏',
  unsent_moment: '朋友圈草稿',
  memory_fragment: '回忆',
  state: '状态记录',
  interview: '独家专访',
};

export interface SecretSpaceSampleRecord {
  /** 与 key 相同；删除与列表统一使用的稳定主键 */
  recordId: string;
  key: string;
  title: string;
  /** 完整正文，仅在详情页展示 */
  body: string;
  /** ISO 8601，列表与详情展示创建时间 */
  createdAt: string;
  /** ISO 8601，可选；有则列表/详情可显示「更新于」 */
  updatedAt?: string;
  /** 列表索引用短摘要，勿放全文 */
  summary?: string;
  meta?: string;
  source?: string;
  tags?: string[];
  kind: SecretSpaceRecordKind;
  /**
   * 结构化 metadata（appendSecretSpaceRecord 传入时落进 jsonl 行内的 `metadata` 字段）。
   * 主要用于「独家专访」这种正文不是单字符串、需要结构化渲染的分类。
   * 普通分类的记录可以不带 metadata；读出来也允许为 undefined。
   */
  metadata?: Record<string, unknown>;
}
