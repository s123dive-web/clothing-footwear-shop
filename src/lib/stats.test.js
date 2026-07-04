import { describe, it, expect } from "vitest";
import {
  round2,
  formatINR,
  inrCompact,
  parseDate,
  weekdayIndex,
  daysBetween,
  dayLabel,
  monthLabel,
  eachDate,
  eachMonth,
  parseHour,
  parseMinutes,
  hourLabel,
  normalizeName,
  isConsolidatedLine,
  filterByDateRange,
  summarize,
  withMovingAverage,
  dailyRevenueSeries,
  monthlyRevenueProfit,
  salesHeatmap,
  aggregateItems,
  topItems,
  paymentBreakdown,
  udhariEvents,
  udhariOutstandingSeries,
  inventoryValue,
  inventoryByCategory,
  deadStock,
  breakEvenSeries,
  breakEvenEstimate,
  expenseTotal,
  expenseByMonth,
  expenseBreakdown,
} from "./stats.js";

const RUPEE = String.fromCharCode(0x20b9);

// A small, realistic fixture reused across a few suites.
const SALES = [
  // Mon 2025-06-02, 10:30 am, UPI
  {
    date: "2025-06-02",
    time: "10:30 am",
    payment: "UPI",
    total: 100,
    profit: 30,
    lines: [{ name: "Tea", qty: 2, amount: 100, price: 50, buyPrice: 35 }],
  },
  // Mon 2025-06-02, 06:15 pm, Cash
  {
    date: "2025-06-02",
    time: "06:15 pm",
    payment: "Cash",
    total: 200,
    profit: 50,
    lines: [{ name: "Sugar", qty: 1, amount: 200, price: 200, buyPrice: 150 }],
  },
  // Tue 2025-06-03, Udhari, back-dated consolidated row
  {
    date: "2025-06-03",
    time: "12:00 pm (back-dated)",
    payment: "Udhari",
    total: 500,
    profit: 120,
    paid: 100,
    lines: [
      { name: "Misc SwadSutra Sold", qty: 1, amount: 500, price: 500, buyPrice: 380, misc: true },
    ],
  },
];

describe("round2", () => {
  it("kills float drift", () => expect(round2(0.1 + 0.2)).toBe(0.3));
  it("coerces junk to 0", () => {
    expect(round2("abc")).toBe(0);
    expect(round2(undefined)).toBe(0);
    expect(round2(NaN)).toBe(0);
  });
  it("rounds to paise", () => expect(round2(12.345)).toBe(12.35));
});

describe("formatINR — Indian grouping", () => {
  it("groups lakhs the Indian way", () => expect(formatINR(125503)).toBe(RUPEE + "1,25,503"));
  it("handles crores", () => expect(formatINR(12500000)).toBe(RUPEE + "1,25,00,000"));
  it("small numbers unchanged", () => expect(formatINR(999)).toBe(RUPEE + "999"));
  it("can drop the symbol", () => expect(formatINR(1000, { symbol: false })).toBe("1,000"));
  it("null/NaN -> zero", () => expect(formatINR(undefined)).toBe(RUPEE + "0"));
});

describe("inrCompact", () => {
  it("thousands", () => expect(inrCompact(1250)).toBe(RUPEE + "1.3k"));
  it("exact thousands have no decimal", () => expect(inrCompact(2000)).toBe(RUPEE + "2k"));
  it("lakhs", () => expect(inrCompact(250000)).toBe(RUPEE + "2.5L"));
  it("crores", () => expect(inrCompact(12000000)).toBe(RUPEE + "1.2Cr"));
  it("below 1k left as-is", () => expect(inrCompact(750)).toBe(RUPEE + "750"));
  it("negatives keep sign", () => expect(inrCompact(-1500)).toBe("-" + RUPEE + "1.5k"));
});

describe("date helpers", () => {
  it("parseDate is local midnight", () => {
    const d = parseDate("2025-06-02");
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(2);
  });
  it("weekdayIndex: 2025-06-02 is Monday", () => expect(weekdayIndex("2025-06-02")).toBe(1));
  it("daysBetween counts inclusive gap", () =>
    expect(daysBetween("2025-06-01", "2025-06-08")).toBe(7));
  it("daysBetween negative when reversed", () =>
    expect(daysBetween("2025-06-08", "2025-06-01")).toBe(-7));
  it("dayLabel is locale-independent", () => expect(dayLabel("2025-07-03")).toBe("3 Jul"));
  it("monthLabel is locale-independent", () => expect(monthLabel("2025-07")).toBe("Jul '25"));
});

describe("eachDate / eachMonth", () => {
  it("inclusive daily walk", () => {
    expect(eachDate("2025-06-01", "2025-06-03")).toEqual([
      "2025-06-01",
      "2025-06-02",
      "2025-06-03",
    ]);
  });
  it("single day", () => expect(eachDate("2025-06-01", "2025-06-01")).toEqual(["2025-06-01"]));
  it("reversed range -> empty", () => expect(eachDate("2025-06-03", "2025-06-01")).toEqual([]));
  it("crosses a month boundary", () => {
    expect(eachDate("2025-01-31", "2025-02-01")).toEqual(["2025-01-31", "2025-02-01"]);
  });
  it("monthly walk spans year boundary", () => {
    expect(eachMonth("2024-11-15", "2025-02-10")).toEqual([
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
    ]);
  });
});

describe("time parsing", () => {
  it("parseHour 12h am/pm", () => {
    expect(parseHour("10:30 am")).toBe(10);
    expect(parseHour("06:15 pm")).toBe(18);
  });
  it("parseHour handles 12", () => {
    expect(parseHour("12:00 pm")).toBe(12);
    expect(parseHour("12:45 am")).toBe(0);
  });
  it("parseHour ignores trailing text", () => expect(parseHour("02:15 pm (back-dated)")).toBe(14));
  it("parseHour null when unparseable", () => {
    expect(parseHour("")).toBeNull();
    expect(parseHour(undefined)).toBeNull();
  });
  it("parseMinutes 12h", () => expect(parseMinutes("06:15 pm")).toBe(18 * 60 + 15));
  it("parseMinutes 24h fallback", () => expect(parseMinutes("14:15")).toBe(14 * 60 + 15));
  it("parseMinutes -1 unknown", () => expect(parseMinutes("nope")).toBe(-1));
  it("hourLabel", () => {
    expect(hourLabel(9)).toBe("9a");
    expect(hourLabel(14)).toBe("2p");
    expect(hourLabel(0)).toBe("12a");
  });
});

describe("normalizeName / isConsolidatedLine", () => {
  it("normalizes case & whitespace", () => expect(normalizeName("  Parle   G ")).toBe("parle g"));
  it("flags misc-flag lines", () =>
    expect(isConsolidatedLine({ name: "Real item", misc: true })).toBe(true));
  it("flags Misc/SwadSutra/Sold names", () => {
    expect(isConsolidatedLine({ name: "Misc groceries" })).toBe(true);
    expect(isConsolidatedLine({ name: "SwadSutra bulk" })).toBe(true);
    expect(isConsolidatedLine({ name: "Items Sold (May)" })).toBe(true);
  });
  it("passes normal items", () => expect(isConsolidatedLine({ name: "Tea" })).toBe(false));
});

describe("filterByDateRange", () => {
  it("keeps rows within the inclusive window", () => {
    const rows = [{ date: "2025-06-01" }, { date: "2025-06-05" }, { date: "2025-06-10" }];
    expect(filterByDateRange(rows, "2025-06-02", "2025-06-08")).toEqual([{ date: "2025-06-05" }]);
  });
});

describe("summarize", () => {
  it("totals, margin and avg ticket", () => {
    const s = summarize(SALES);
    expect(s.revenue).toBe(800);
    expect(s.profit).toBe(200);
    expect(s.bills).toBe(3);
    expect(s.margin).toBe(25); // 200/800
    expect(s.avgTicket).toBe(round2(800 / 3));
  });
  it("empty is all zero, no divide-by-zero", () => {
    expect(summarize([])).toEqual({ revenue: 0, profit: 0, bills: 0, margin: 0, avgTicket: 0 });
  });
});

describe("withMovingAverage", () => {
  it("trailing average, leading rows partial", () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = withMovingAverage(rows, "v", 2, "ma");
    expect(out.map((r) => r.ma)).toEqual([10, 15, 25]); // [10], [10,20], [20,30]
  });
});

describe("dailyRevenueSeries", () => {
  it("fills empty days with zero and adds ma7", () => {
    const out = dailyRevenueSeries(SALES, "2025-06-01", "2025-06-03");
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.revenue)).toEqual([0, 300, 500]);
    expect(out[0]).toHaveProperty("ma7");
    expect(out[2].ma7).toBe(round2((0 + 300 + 500) / 3));
  });
});

describe("monthlyRevenueProfit", () => {
  it("buckets by month with revenue and profit", () => {
    const out = monthlyRevenueProfit(SALES, "2025-06-01", "2025-06-30");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ month: "2025-06", revenue: 800, profit: 200 });
  });
});

describe("salesHeatmap", () => {
  it("places whole-bill revenue at weekday × hour and skips untimed bills", () => {
    const h = salesHeatmap(SALES);
    // Mon (getDay=1) 10am = 100, Mon 6pm = 200. Tue Udhari HAS a parseable time so it is placed too.
    expect(h.grid[1][10]).toBe(100);
    expect(h.grid[1][18]).toBe(200);
    expect(h.grid[2][12]).toBe(500);
    expect(h.max).toBe(500);
    expect(h.minHour).toBe(10);
    expect(h.maxHour).toBe(18);
    expect(h.placed).toBe(3);
  });
  it("truly untimed bills are dropped", () => {
    const h = salesHeatmap([{ date: "2025-06-02", time: "", total: 100 }]);
    expect(h.placed).toBe(0);
    expect(h.minHour).toBeNull();
  });
});

describe("aggregateItems / topItems", () => {
  it("excludes consolidated rows by default", () => {
    const agg = aggregateItems(SALES);
    expect(agg.map((a) => a.name).sort()).toEqual(["Sugar", "Tea"]);
  });
  it("can include consolidated rows", () => {
    const agg = aggregateItems(SALES, { includeConsolidated: true });
    expect(agg.some((a) => /SwadSutra/.test(a.name))).toBe(true);
  });
  it("computes revenue/qty/profit and merges same-name lines", () => {
    const agg = aggregateItems([
      { lines: [{ name: "Tea", qty: 2, amount: 100, price: 50, buyPrice: 35 }] },
      { lines: [{ name: "tea", qty: 1, amount: 50, price: 50, buyPrice: 35 }] },
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ qty: 3, revenue: 150, profit: round2((50 - 35) * 3) });
  });
  it("topItems sorts by chosen metric and limits", () => {
    const top = topItems(SALES, { metric: "revenue", limit: 1 });
    expect(top).toHaveLength(1);
    expect(top[0].name).toBe("Sugar"); // 200 > 100
  });
});

describe("paymentBreakdown", () => {
  it("splits by method with amounts and %", () => {
    const { rows, total } = paymentBreakdown(SALES);
    expect(total).toBe(800);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.UPI.value).toBe(100);
    expect(byName.Cash.value).toBe(200);
    expect(byName.Udhari.value).toBe(500);
    expect(byName.Udhari.pct).toBe(63); // round(500/800*100)=62.5 -> 63
  });
  it("unknown methods fall into Other", () => {
    const { rows } = paymentBreakdown([{ payment: "Card", total: 100 }]);
    expect(rows).toEqual([{ name: "Other", value: 100, pct: 100 }]);
  });
});

describe("udhari outstanding", () => {
  it("builds credit and repayment events", () => {
    const ev = udhariEvents([
      {
        date: "2025-06-03",
        payment: "Udhari",
        total: 500,
        payments: [{ date: "2025-06-05", amount: 200 }],
      },
    ]);
    expect(ev).toEqual([
      { date: "2025-06-03", delta: 500 },
      { date: "2025-06-05", delta: -200 },
    ]);
  });
  it("falls back to legacy paid on the bill date", () => {
    const ev = udhariEvents([{ date: "2025-06-03", payment: "Udhari", total: 500, paid: 100 }]);
    expect(ev).toEqual([
      { date: "2025-06-03", delta: 500 },
      { date: "2025-06-03", delta: -100 },
    ]);
  });
  it("runs a cumulative balance across the window", () => {
    const sales = [
      {
        date: "2025-06-01",
        payment: "Udhari",
        total: 300,
        payments: [{ date: "2025-06-04", amount: 100 }],
      },
      { date: "2025-06-03", payment: "Udhari", total: 200 },
    ];
    const s = udhariOutstandingSeries(sales, "2025-06-01", "2025-06-05");
    expect(s.map((r) => r.outstanding)).toEqual([300, 300, 500, 400, 400]);
  });
  it("carries the balance in from before the window", () => {
    const sales = [{ date: "2025-05-20", payment: "Udhari", total: 300 }];
    const s = udhariOutstandingSeries(sales, "2025-06-01", "2025-06-02");
    expect(s.map((r) => r.outstanding)).toEqual([300, 300]);
  });
});

describe("inventory", () => {
  const items = [
    { name: "Tea", category: "Beverages", buyPrice: 35, sellPrice: 50, stock: 10 },
    { name: "Sugar", category: "Staples", buyPrice: 40, sellPrice: 45, stock: 0 },
    { name: "Salt", category: "Staples", buyPrice: 10, sellPrice: 20, stock: 5 },
  ];
  it("inventoryValue sums cost/retail and counts out-of-stock", () => {
    const v = inventoryValue(items);
    expect(v.cost).toBe(35 * 10 + 10 * 5); // 400
    expect(v.retail).toBe(50 * 10 + 20 * 5); // 600
    expect(v.outOfStock).toBe(1);
    expect(v.count).toBe(3);
  });
  it("inventoryByCategory groups and drops zero-value categories", () => {
    const cats = inventoryByCategory(items);
    // Staples has only Salt with value (Sugar stock 0); Beverages has Tea.
    const byName = Object.fromEntries(cats.map((c) => [c.name, c]));
    expect(byName.Beverages).toMatchObject({ cost: 350, retail: 500 });
    expect(byName.Staples).toMatchObject({ cost: 50, retail: 100 });
    expect(cats[0].name).toBe("Beverages"); // sorted by cost desc
  });
  it("deadStock lists in-stock items with no sales, by value", () => {
    const dead = deadStock(items, [{ lines: [{ name: "Tea" }] }]);
    expect(dead.map((d) => d.name)).toEqual(["Salt"]); // Sugar out of stock, Tea sold
    expect(dead[0].value).toBe(50);
  });
});

describe("expenses", () => {
  const expenses = [
    { date: "2026-01-15", desc: "Racks", amount: 5000 },
    { date: "2026-01-20", desc: "Racks", amount: 2000 },
    { date: "2026-03-02", desc: "Signboard", amount: 3000 },
    { date: "2026-05-10", desc: "Deposit", amount: 10000 },
  ];
  it("expenseTotal sums everything", () => expect(expenseTotal(expenses)).toBe(20000));
  it("expenseTotal empty is 0", () => expect(expenseTotal([])).toBe(0));
  it("expenseByMonth buckets per month across the range, zero-filled", () => {
    const rows = expenseByMonth(expenses, "2026-01-01", "2026-05-31");
    expect(rows.map((r) => r.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ]);
    expect(rows.map((r) => r.amount)).toEqual([7000, 0, 3000, 0, 10000]);
  });
  it("expenseBreakdown groups by desc, biggest first, with %", () => {
    const { rows, total } = expenseBreakdown(expenses);
    expect(total).toBe(20000);
    expect(rows[0]).toMatchObject({ name: "Deposit", value: 10000, pct: 50 });
    expect(rows.find((r) => r.name === "Racks")).toMatchObject({ value: 7000, pct: 35 });
  });
  it("expenseBreakdown labels blank desc as Uncategorised and honours limit", () => {
    const { rows } = expenseBreakdown([{ desc: "", amount: 100 }, { amount: 50 }], { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Uncategorised");
    expect(rows[0].value).toBe(150);
  });
});

describe("break-even", () => {
  const sales = [
    { date: "2025-06-01", profit: 400 },
    { date: "2025-06-02", profit: 300 },
    { date: "2025-06-03", profit: 500 },
  ];
  const expenses = [{ date: "2025-05-01", desc: "Racks", amount: 1000 }];

  it("cumulates profit and finds the break-even date", () => {
    const be = breakEvenSeries(sales, expenses);
    expect(be.capex).toBe(1000);
    expect(be.series.map((r) => r.cumProfit)).toEqual([400, 700, 1200]);
    expect(be.breakEvenDate).toBe("2025-06-03"); // first day cum (1200) >= 1000
    expect(be.recovered).toBe(120);
  });
  it("estimate: reached reports days taken", () => {
    const est = breakEvenEstimate(breakEvenSeries(sales, expenses));
    expect(est.status).toBe("reached");
    expect(est.breakEvenDate).toBe("2025-06-03");
    expect(est.days).toBe(2);
  });
  it("estimate: projects an ETA when not yet recovered", () => {
    const est = breakEvenEstimate(breakEvenSeries(sales, [{ date: "2025-05-01", amount: 5000 }]));
    expect(est.status).toBe("projected");
    // cum=1200 over a 2-day span -> 600/day; remaining 3800 -> ceil(3800/600)=7
    expect(est.perDay).toBe(600);
    expect(est.daysLeft).toBe(7);
  });
  it("estimate: no capex", () => {
    expect(breakEvenEstimate(breakEvenSeries(sales, [])).status).toBe("no-capex");
  });
});
