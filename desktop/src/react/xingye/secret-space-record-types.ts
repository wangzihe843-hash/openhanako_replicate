export type SecretSpaceRecordKind =
  | 'draft_reply'
  | 'dream'
  | 'saved_item'
  | 'unsent_moment'
  | 'memory_fragment';

/** 分类列表与详情页共用的类型展示文案 */
export const SECRET_SPACE_RECORD_KIND_LABEL: Record<SecretSpaceRecordKind, string> = {
  draft_reply: '草稿',
  dream: '梦境',
  saved_item: '文字收藏',
  unsent_moment: '朋友圈草稿',
  memory_fragment: '回忆',
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
}
