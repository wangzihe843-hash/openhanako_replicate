# 星野重要记忆：分层与网关

## 四层记忆语义

1. **identity / ishiki**：短核心人格摘要，驱动「像谁在说」。
2. **pinned**：经 **MemoryCandidate** 人工确认后写入 `pinned.md`，稳定进入对话侧栏式记忆。
3. **facts.db**：可检索事实存储；**不保证**立刻进入 prompt，与 `memory.md` 解耦。
4. **workspace**：秘密空间 / 手机 / 朋友圈等业务源数据，**不等于** OpenHanako 记忆本体。

## 模块规则

- **SecretSpace / Phone / Moments / Relationship** 等将来只能 **创建 `MemoryCandidate`**（带 `target` 策略），**不得**直接写 `memory.md`、`facts.md`、`longterm.md` 或绕过 **`confirmXingyeMemoryCandidate`** 网关。
- 重要记忆写入意图统一经 **target policy**（`xingye-memory-target-policy.ts`）判定可写性；当前轮仅 **pinned** 可走成功确认路径。
- 服务端 facts 管线（`fact-store`、`compile`、`memory-ticker` 等）由 OpenHanako 既有机制维护；星野侧本轮 **不调用** fact import HTTP。
