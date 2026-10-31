import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.ts";
import { DeferredResultStore } from "../lib/deferred-result-store.ts";

const target = { sessionId: "session-a", sessionPath: "/synthetic/a.jsonl" };
const mediaMeta = {
  type: "image-generation",
  deliveryIntent: "ui_only",
  triggerParentTurn: false,
  notifyAgentOnFailure: true,
};
const disposables: { dispose(): void }[] = [];

afterEach(() => {
  for (const item of disposables.splice(0).reverse()) item.dispose();
  vi.restoreAllMocks();
});

function gate() {
  let resolve: (value: { ok: true }) => void;
  let reject: (error: Error) => void;
  const promise = new Promise<{ ok: true }>((res, rej) => { resolve = res; reject = rej; });
  return { promise, succeed: () => resolve({ ok: true }), fail: () => reject(new Error("late receipt failed")) };
}

function harness() {
  const store = new DeferredResultStore(null, null);
  type Payload = { result?: unknown; content?: string };
  type Options = { shouldDeliver: () => boolean };
  const deliveries: { payload: Payload; options?: Options; receipt: ReturnType<typeof gate> }[] = [];
  const sessionCoordinator = {
    isRunnableSessionPath: () => true,
    deliverCustomMessage: vi.fn((_path: string, message: Payload, options: Options) => {
      const receipt = gate();
      deliveries.push({ payload: message, options, receipt });
      return receipt.promise;
    }),
    recordCustomEntry: vi.fn((_path: string, _type: string, record: Payload) => {
      const receipt = gate();
      deliveries.push({ payload: record, receipt });
      return receipt.promise;
    }),
  };
  const coordinator = new DeferredResultCoordinator({
    store, sessionCoordinator, retryIntervalMs: 0, log: { ...console, warn: vi.fn() },
  });
  disposables.push(store, coordinator);
  coordinator.start();
  return { store, coordinator, sessionCoordinator, deliveries };
}

describe("deferred delivery attempt ownership", () => {
  for (const order of ["new-result-before-old-ack", "new-result-after-old-ack", "new-ack-before-old-ack"]) {
    for (const outcome of ["resolved", "failed"]) {
      it.each(["success", "failure"])(`${order}: new ${outcome} survives old receipt %s`, async (oldReceipt) => {
        const { store, coordinator, sessionCoordinator, deliveries } = harness();
        store.defer("task", target, mediaMeta);
        store.fail("task", "OLD_FAILURE");
        const oldDelivery = coordinator.deliverTask("task");
        expect(deliveries).toHaveLength(1);
        const oldShouldDeliver = deliveries[0].options.shouldDeliver;
        expect(oldShouldDeliver()).toBe(true);

        store.retry("task", target, mediaMeta);
        expect(oldShouldDeliver()).toBe(false);
        const completeNew = () => outcome === "resolved"
          ? store.resolve("task", { replyText: "NEW_RESULT" })
          : store.fail("task", "NEW_FAILURE");
        if (order !== "new-result-after-old-ack") completeNew();
        let newDelivery = order !== "new-result-after-old-ack" ? coordinator.deliverTask("task") : null;
        if (order === "new-ack-before-old-ack") {
          expect(deliveries).toHaveLength(2);
          deliveries[1].receipt.succeed();
          expect(await newDelivery).toBe(true);
        }
        if (oldReceipt === "success") deliveries[0].receipt.succeed();
        else deliveries[0].receipt.fail();
        expect(await oldDelivery).toBe(false);
        expect(store.query("task").delivered).toBe(order === "new-ack-before-old-ack");

        if (order === "new-result-after-old-ack") {
          expect(store.query("task").status).toBe("pending");
          completeNew();
          newDelivery = coordinator.deliverTask("task");
        }
        expect(deliveries).toHaveLength(2);
        const duplicate = coordinator.deliverTask("task");
        expect(deliveries).toHaveLength(2); // Old finally cannot remove the new in-flight delivery.
        if (order !== "new-ack-before-old-ack") {
          deliveries[1].receipt.succeed();
          expect(await newDelivery).toBe(true);
          expect(await duplicate).toBe(true);
        } else {
          expect(await duplicate).toBe(false);
        }
        expect(store.query("task")).toMatchObject({ status: outcome, delivered: true });
        expect(oldShouldDeliver()).toBe(false);
        if (outcome === "resolved") {
          expect(sessionCoordinator.recordCustomEntry).toHaveBeenCalledOnce();
          expect(deliveries[1].payload.result).toEqual({ replyText: "NEW_RESULT" });
        } else {
          expect(sessionCoordinator.deliverCustomMessage).toHaveBeenCalledTimes(2);
          expect(deliveries[1].payload.content).toContain("NEW_FAILURE");
        }
        await coordinator.flushUndelivered();
        expect(deliveries).toHaveLength(2);
      });
    }
  }

  it.each(["success", "failure"])("late UI record %s cannot acknowledge or clear the next UI attempt", async (oldReceipt) => {
    const { store, coordinator, deliveries } = harness();
    store.defer("task", target, mediaMeta);
    store.resolve("task", "OLD_RESULT");
    const oldDelivery = coordinator.deliverTask("task");
    store.retry("task", target, mediaMeta);
    store.resolve("task", "NEW_RESULT");
    const newDelivery = coordinator.deliverTask("task");
    if (oldReceipt === "success") deliveries[0].receipt.succeed();
    else deliveries[0].receipt.fail();
    expect(await oldDelivery).toBe(false);
    expect(store.query("task").delivered).toBe(false);
    const duplicate = coordinator.deliverTask("task");
    expect(deliveries.map((entry) => entry.payload.result)).toEqual(["OLD_RESULT", "NEW_RESULT"]);
    deliveries[1].receipt.succeed();
    expect(await newDelivery).toBe(true);
    expect(await duplicate).toBe(true);
  });

  it("keeps the newest of three same-clock attempts in flight while other tasks complete", async () => {
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const { store, coordinator, deliveries } = harness();
    const pending = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      store.retry("task", target, mediaMeta);
      store.resolve("task", `RESULT_${attempt}`);
      pending.push(coordinator.deliverTask("task"));
    }
    store.defer("other", target, mediaMeta);
    store.resolve("other", "INDEPENDENT");
    const other = coordinator.deliverTask("other");
    expect(deliveries).toHaveLength(4);
    deliveries[1].receipt.succeed();
    expect(await pending[1]).toBe(false);
    deliveries[3].receipt.succeed();
    expect(await other).toBe(true);
    deliveries[0].receipt.fail();
    expect(await pending[0]).toBe(false);
    const duplicate = coordinator.deliverTask("task");
    expect(deliveries).toHaveLength(4);
    deliveries[2].receipt.succeed();
    expect(await pending[2]).toBe(true);
    expect(await duplicate).toBe(true);
    expect(store.query("task")).toMatchObject({ result: "RESULT_2", delivered: true });
    expect(coordinator._inFlight.size).toBe(0);
  });

  it.each(["message", "ui-record"])("preserves a discarded branch fence after a late %s receipt", async (kind) => {
    const { store, coordinator, deliveries } = harness();
    store.defer("task", target, mediaMeta);
    if (kind === "message") store.fail("task", "OLD_FAILURE");
    else store.resolve("task", "OLD_RESULT");
    const delivery = coordinator.deliverTask("task");
    store.suppressTaskIdsForSession(target, ["task"], "discarded branch");
    deliveries[0].receipt.succeed();
    expect(await delivery).toBe(false);
    expect(store.query("task")).toMatchObject({ delivered: true, deliverySuppressed: true });
    await coordinator.flushUndelivered();
    expect(deliveries).toHaveLength(1);
  });

  it("can retry a failed delivery within the current attempt without reviving the old attempt", async () => {
    const { store, coordinator, deliveries } = harness();
    store.defer("task", target, mediaMeta);
    store.fail("task", "OLD_FAILURE");
    const oldDelivery = coordinator.deliverTask("task");
    store.retry("task", target, mediaMeta);
    store.resolve("task", "NEW_RESULT");
    const firstNewDelivery = coordinator.deliverTask("task");
    expect(deliveries).toHaveLength(2);
    deliveries[1].receipt.fail();
    expect(await firstNewDelivery).toBe(false);
    expect(store.listUndelivered()).toHaveLength(1);
    const secondNewDelivery = coordinator.deliverTask("task");
    expect(deliveries).toHaveLength(3);
    deliveries[0].receipt.succeed();
    expect(await oldDelivery).toBe(false);
    const duplicate = coordinator.deliverTask("task");
    expect(deliveries).toHaveLength(3);
    deliveries[2].receipt.succeed();
    expect(await secondNewDelivery).toBe(true);
    expect(await duplicate).toBe(true);
    expect(store.query("task").delivered).toBe(true);
  });
});
