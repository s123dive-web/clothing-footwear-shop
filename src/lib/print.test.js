import { describe, it, expect, vi } from "vitest";

vi.mock("../config/shopConfig.js", () => ({ DEFAULT_SHOP_CONFIG: { name: "Shop" } }));
vi.mock("../config/currency.js", () => ({ CURRENCY: { symbol: "₹" } }));
const { whenImagesReady } = await import("./print.js");

// A minimal stand-in for an <img>: fire("load"|"error") settles it.
const fakeImg = ({ complete = false, naturalWidth = 0, decode } = {}) => {
  const handlers = {};
  return {
    complete,
    naturalWidth,
    decode,
    addEventListener: (ev, fn) => (handlers[ev] = fn),
    fire: (ev) => handlers[ev] && handlers[ev](),
  };
};

describe("whenImagesReady (print waits for logo / QR, not a guessed delay)", () => {
  it("resolves immediately when there are no images", async () => {
    await expect(whenImagesReady([], 5000)).resolves.toEqual([]);
  });

  it("waits for a pending image to load and decode", async () => {
    const decode = vi.fn(() => Promise.resolve());
    const img = fakeImg({ decode });
    let done = false;
    whenImagesReady([img], 5000).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    img.fire("load");
    await new Promise((r) => setTimeout(r, 0));
    expect(decode).toHaveBeenCalled();
    expect(done).toBe(true);
  });

  it("does not hang on a broken image (error, failed decode, or already failed)", async () => {
    const a = fakeImg({ decode: () => Promise.reject(new Error("bad")) });
    const b = fakeImg({ complete: true, naturalWidth: 0 });
    const p = whenImagesReady([a, b], 5000);
    a.fire("error");
    await expect(p).resolves.toBeDefined();
  });

  it("gives up after the cap so a dead image URL cannot block the receipt", async () => {
    vi.useFakeTimers();
    let done = false;
    whenImagesReady([fakeImg()], 2500).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});
