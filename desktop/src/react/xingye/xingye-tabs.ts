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
    description: 'OpenHanako 原生聊天系统的入口包装层，只展示星野选中角色与当前聊天角色的关系。',
    items: ['selectedXingyeAgentId', 'OpenHanako currentAgentId', '返回 OpenHanako 聊天'],
  },
  {
    id: 'group-chat',
    label: '群聊',
    title: '群聊',
    description: '星野群聊入口占位区；OpenHanako Channel 是共享频道/记录空间，不等于即时群聊。',
    items: ['星野群聊入口占位', 'Channel 语义说明', 'Group Chat Orchestrator 路线图'],
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
