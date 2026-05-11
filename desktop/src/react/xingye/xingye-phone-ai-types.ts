import type { XingyeContactStatus, XingyeContactTargetType } from './xingye-phone-store';

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
