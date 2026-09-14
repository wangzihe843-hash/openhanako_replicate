export interface AutomationSlice {
  /** Automation job count for badge */
  automationCount: number;
}

export const createAutomationSlice = (): AutomationSlice => ({
  automationCount: 0,
});

// ── Selectors ──
export const selectAutomationCount = (s: AutomationSlice) => s.automationCount;
