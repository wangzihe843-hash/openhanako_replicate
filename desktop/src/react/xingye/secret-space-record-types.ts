export type SecretSpaceRecordKind =
  | 'draft_reply'
  | 'dream'
  | 'saved_item'
  | 'unsent_moment'
  | 'memory_fragment';

export interface SecretSpaceSampleRecord {
  key: string;
  title: string;
  body: string;
  meta?: string;
  kind: SecretSpaceRecordKind;
}
