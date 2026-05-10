export type XingyeTabId = 'characters' | 'chat' | 'group-chat' | 'phone' | 'moments' | 'secret-space';

export interface XingyeTab {
  id: XingyeTabId;
  label: string;
  title: string;
  description: string;
  items: string[];
}

export const xingyeTabs: XingyeTab[] = [
  {
    id: 'characters',
    label: '角色',
    title: '角色',
    description: '角色列表与角色资料的占位区，后续再接入 OpenHanako 的角色数据。',
    items: ['角色卡片占位', '角色详情占位', '角色关系占位'],
  },
  {
    id: 'chat',
    label: '聊天',
    title: '聊天',
    description: '单聊入口占位区，当前不读取 session，也不调用聊天 API。',
    items: ['最近聊天占位', '聊天预览占位', '会话入口占位'],
  },
  {
    id: 'group-chat',
    label: '群聊',
    title: '群聊',
    description: '多角色群聊入口占位区，当前不读取 channel，也不创建群聊数据。',
    items: ['群聊列表占位', '群聊成员占位', '群聊动态占位'],
  },
  {
    id: 'phone',
    label: '小手机',
    title: '小手机',
    description: '角色生活 dashboard 占位区，后续可承载日记、相册、短信与音频入口。',
    items: ['日记', '相册', '短信', '音频', '角色生活 dashboard'],
  },
  {
    id: 'moments',
    label: '朋友圈',
    title: '朋友圈',
    description: '朋友圈 feed 占位区，当前不生成动态，也不触发自动评论。',
    items: ['动态流占位', '发布入口占位', '评论区占位'],
  },
  {
    id: 'secret-space',
    label: '秘密空间',
    title: '秘密空间',
    description: '角色侧隐藏内容占位区，用于承载 TA 私下保存但暂不公开的内容线索。',
    items: ['TA 的草稿箱', 'TA 的内心戏', 'TA 收藏的东西', 'TA 未发送的朋友圈', '私藏回忆'],
  },
];
