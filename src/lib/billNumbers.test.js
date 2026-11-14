import { describe, it, expect } from "vitest";
import {
  fyLabel,
  formatBillNo,
  provisionalNo,
  allocateInCounter,
  unnumbered,
  billNoText,
  RECENT_KEEP,
} from "./billNumbers.js";

describe("financial year", () => {
  it("runs 1 April – 31 March", () => {
    expect(fyLabel("2026-04-01")).toBe("2026-27");
    expect(fyLabel("2026-11-14")).toBe("2026-27");
    expect(fyLabel("2027-03-31")).toBe("2026-27");
    expect(fyLabel("2027-04-01")).toBe("2027-28");
    expect(fyLabel("2026-01-15")).toBe("2025-26");
  });
  it("handles the century wrap in the short year", () => {
    expect(fyLabel("2099-06-01")).toBe("2099-00");
  });
  it("formats as FY/0001", () => {
    expect(formatBillNo("2026-27", 1)).toBe("2026-27/0001");
    expect(formatBillNo("2026-27", 12345)).toBe("2026-27/12345");
  });
});

describe("allocateInCounter (transaction body)", () => {
  it("starts at 1 on an empty counter and counts up", () => {
    const a = allocateInCounter(null, "s1");
    expect(a.n).toBe(1);
    const b = allocateInCounter(a.node, "s2");
    expect(b.n).toBe(2);
    expect(b.node.next).toBe(3);
  });
  it("is idempotent: the same bill always gets the same number, with no gap", () => {
    const a = allocateInCounter(null, "s1");
    const again = allocateInCounter(a.node, "s1");
    expect(again).toMatchObject({ n: 1, reused: true });
    expect(again.node).toBe(a.node); // nothing to write
    expect(allocateInCounter(again.node, "s2").n).toBe(2);
  });
  it("two devices racing for different bills never share a number", () => {
    // Device B's transaction is re-run by the server on top of device A's committed node.
    const a = allocateInCounter({ next: 7, recent: {} }, "A");
    const b = allocateInCounter(a.node, "B");
    expect([a.n, b.n]).toEqual([7, 8]);
  });
  it("keeps the idempotency window bounded", () => {
    let node = null;
    for (let i = 0; i < RECENT_KEEP + 25; i++) node = allocateInCounter(node, "s" + i).node;
    expect(Object.keys(node.recent)).toHaveLength(RECENT_KEEP);
    expect(node.next).toBe(RECENT_KEEP + 26);
    expect(node.recent["s0"]).toBeUndefined();
  });
});

describe("helpers", () => {
  it("provisional numbers are short and marked", () => {
    expect(provisionalNo(1794641038904)).toMatch(/^P-[0-9A-Z]{6}$/);
  });
  it("unnumbered: only bills holding a provisional number, oldest first", () => {
    const list = unnumbered([
      { id: "c", billNoProv: "P-3", createdAt: 30 },
      { id: "old", date: "2026-05-01" }, // made before the feature — never numbered retroactively
      { id: "a", billNoProv: "P-1", createdAt: 10 },
      { id: "done", billNoProv: "P-0", billNo: "2026-27/0001", createdAt: 1 },
      { id: "b", billNoProv: "P-2", createdAt: 20 },
    ]);
    expect(list.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
  it("billNoText", () => {
    expect(billNoText({ billNo: "2026-27/0007", billNoProv: "P-X" })).toBe("2026-27/0007");
    expect(billNoText({ billNoProv: "P-ABC123" })).toBe("P-ABC123 (provisional)");
    expect(billNoText({})).toBe("");
  });
});
