import { subcatIcon } from "./catalog.js";

// ---------- apparel domain glue ----------
// Activity-log categories (generic; unchanged across domains).
export const LOG_TYPES = ["sale", "inventory", "expense", "import", "backup", "bill"];

// A product's display icon: its own stored icon, else derived from its subcategory / group.
export const iconFor = (p) => (p && p.icon) || subcatIcon(p && p.subcategory, p && p.category);

// ---------- Inventory ----------
// Normalised product name for duplicate detection (trim, lowercase, collapse inner spaces).
export const normName = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

// ---------- Sales history ----------
export const PAY_COLORS = { UPI: "#2A6FB0", Cash: "#1B5E43", Udhari: "#C44536" };
