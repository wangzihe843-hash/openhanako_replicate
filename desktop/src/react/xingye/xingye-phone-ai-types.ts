import type { XingyeContactStatus, XingyeContactTargetType } from './xingye-phone-store';

/** 通讯录 enrichment / 其他流程可能带齐字段；`sms_history` 仅消费 targetType、targetId、messages。 */
export type XingyePhoneAiContactResult = {
  targetType: XingyeContactTargetType;
  targetId: string;
  remark?: string;
  impression?: string;
  relationshipHint?: string;
  tags?: string[];
  faction?: string;
  status?: XingyeContactStatus;
  generatedReason?: string;
  messages?: Array<{
    from: 'owner' | 'target';
    content: string;
    createdAt: string;
  }>;
};

export type XingyePhoneAiPayload = {
  contacts: XingyePhoneAiContactResult[];
};
