import { describe, expect, it, afterEach } from "vitest";
import {
  resolveSubagentToolAccess,
  resolveSubagentToolStrategy,
  SubagentAccessDeniedError,
} from "../lib/tools/subagent-tool-policy.ts";

describe("subagent 工具访问策略收口（Codex 式：显式 access + 继承父会话档）", () => {
  afterEach(() => { delete process.env.HANA_SUBAGENT_TOOL_STRATEGY; });

  it("默认 intercept（甲）：不剥离工具（filter=null）", () => {
    const a = resolveSubagentToolAccess({ access: "write" });
    expect(a).toMatchObject({
      strategy: "intercept",
      customToolFilter: null,
      builtinToolFilter: null,
      subagentContext: true,
    });
  });

  // ── 显式 access 参数决定权限档（优先级最高） ──
  it("access:read → READ_ONLY", () => {
    expect(resolveSubagentToolAccess({ access: "read" }).permissionMode).toBe("read_only");
    // 即便父会话可操作，显式 read 仍压成只读
    expect(resolveSubagentToolAccess({ access: "read", parentPermissionMode: "operate" }).permissionMode).toBe("read_only");
  });

  it("access:write → OPERATE（父会话非只读时）", () => {
    expect(resolveSubagentToolAccess({ access: "write" }).permissionMode).toBe("operate");
    expect(resolveSubagentToolAccess({ access: "write", parentPermissionMode: "operate" }).permissionMode).toBe("operate");
    expect(resolveSubagentToolAccess({ access: "write", parentPermissionMode: "ask" }).permissionMode).toBe("operate");
  });

  // ── attenuation 校验：子权限不得超过父会话（#1614 越权缺口修复） ──
  it("父只读 + 显式 access:write → 抛 SubagentAccessDeniedError（不静默降级）", () => {
    expect(() => resolveSubagentToolAccess({ access: "write", parentPermissionMode: "read_only" }))
      .toThrow(SubagentAccessDeniedError);
    try {
      resolveSubagentToolAccess({ access: "write", parentPermissionMode: "read_only" });
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("SUBAGENT_WRITE_DENIED_BY_PARENT_READ_ONLY");
      expect(err.message).toMatch(/read-only/i);
    }
  });

  it("父只读 + access:write 在 strip 策略下同样拒绝（attenuation 与策略正交）", () => {
    expect(() => resolveSubagentToolAccess({ access: "write", parentPermissionMode: "read_only", strategy: "strip" }))
      .toThrow(SubagentAccessDeniedError);
  });

  it("父只读 + access:read / 省略 access 不受影响（仍是只读，不抛错）", () => {
    expect(resolveSubagentToolAccess({ access: "read", parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
    expect(resolveSubagentToolAccess({ parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
  });

  // ── 省略 access → 继承父会话档，但 subagent 只有两态（后台不能交互确认，ASK 不可用） ──
  it("省略 access：父只读 → 只读", () => {
    expect(resolveSubagentToolAccess({ parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
  });

  it("省略 access：父可操作 → 可操作", () => {
    expect(resolveSubagentToolAccess({ parentPermissionMode: "operate" }).permissionMode).toBe("operate");
  });

  it("省略 access：父先问(ask) → 可操作（后台无法交互确认，ASK 坍缩为 operate，绝不让 subagent 挂在确认上）", () => {
    expect(resolveSubagentToolAccess({ parentPermissionMode: "ask" }).permissionMode).toBe("operate");
  });

  it("省略 access + 无父档 → 可操作（= 历史默认行为，subagent 一向全权）", () => {
    expect(resolveSubagentToolAccess({}).permissionMode).toBe("operate");
    expect(resolveSubagentToolAccess().permissionMode).toBe("operate");
  });

  it("非法 access 值按省略处理（继承父档）", () => {
    expect(resolveSubagentToolAccess({ access: "garbage", parentPermissionMode: "read_only" }).permissionMode).toBe("read_only");
    expect(resolveSubagentToolAccess({ access: "garbage", parentPermissionMode: "operate" }).permissionMode).toBe("operate");
  });

  // ── 乙策略（strip）：按权限档剥离工具清单 ──
  it("strip（乙）：write 档剥离全集清单", () => {
    const a = resolveSubagentToolAccess({ access: "write", strategy: "strip" });
    expect(a.strategy).toBe("strip");
    expect(a.builtinToolFilter).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
    expect(a.customToolFilter).toEqual(["web_search", "web_fetch", "todo_write", "browser"]);
    expect(a.permissionMode).toBe("operate");
  });

  it("strip（乙）：read 档剥离到 builtin 只读子集", () => {
    const a = resolveSubagentToolAccess({ access: "read", strategy: "strip" });
    expect(a.builtinToolFilter).toEqual(["read", "grep", "find", "ls"]);
    expect(a.permissionMode).toBe("read_only");
  });

  it("strip（乙）：继承父只读档也走只读子集", () => {
    const a = resolveSubagentToolAccess({ parentPermissionMode: "read_only", strategy: "strip" });
    expect(a.builtinToolFilter).toEqual(["read", "grep", "find", "ls"]);
    expect(a.permissionMode).toBe("read_only");
  });

  it("env HANA_SUBAGENT_TOOL_STRATEGY=strip 切到乙（性能 A/B 开关）", () => {
    process.env.HANA_SUBAGENT_TOOL_STRATEGY = "strip";
    expect(resolveSubagentToolStrategy()).toBe("strip");
    expect(resolveSubagentToolAccess({ access: "write" }).strategy).toBe("strip");
  });

  it("默认策略 intercept", () => {
    expect(resolveSubagentToolStrategy()).toBe("intercept");
  });

  // ── 角色私有草稿：subagent 无论甲乙策略都拿不到 xingye_propose_draft ──
  // 甲（intercept）给全集但靠拦截层（SUBAGENT_BLOCKED_TOOLS）拦死；乙（strip）的白名单本就不含它。
  // 这里只断言「策略侧不会把它派给 subagent」：strip 的 customToolFilter 不含；intercept 不剥离（filter=null）。
  // 运行时拦截见 session-permission-mode.test.js。
  it("strip（乙）：白名单不含 xingye_propose_draft（subagent 拿不到草稿工具）", () => {
    const w = resolveSubagentToolAccess({ access: "write", strategy: "strip" });
    expect(w.customToolFilter).not.toContain("xingye_propose_draft");
    const r = resolveSubagentToolAccess({ access: "read", strategy: "strip" });
    expect(r.customToolFilter).not.toContain("xingye_propose_draft");
  });

  it("intercept（甲）：不剥离工具（草稿工具靠拦截层拦，不靠剥离）", () => {
    // intercept 给全集（filter=null），xingye_propose_draft 在拦截层被 SUBAGENT_BLOCKED_TOOLS 拦死。
    const a = resolveSubagentToolAccess({ access: "write", strategy: "intercept" });
    expect(a.customToolFilter).toBeNull();
    expect(a.subagentContext).toBe(true);
  });
});
