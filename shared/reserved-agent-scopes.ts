/**
 * agents/ 下的保留存储作用域目录 id（双下划线包裹），不是真实 agent、没有 config.yaml：
 *   __user__   用户本人（朋友圈用户发帖等，见 server/routes/xingye-storage.js）
 *   __shared__ 全体共享礼物库存（见 lib/xingye/gift-inventory.ts）
 *
 * 凡枚举 agents/ 子目录、或用外部输入当 agentId 建目录的地方，都必须用这里判断并跳过/拒绝，
 * 否则真实 agent 会与保留作用域撞盘混居。按模式匹配而非存清单，新增保留作用域时无需改这里。
 */
export function isReservedAgentScopeId(id: string): boolean {
  return /^__.+__$/.test(id);
}
