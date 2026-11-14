import { subcatIcon } from "./catalog.js";

// ---------- apparel domain glue ----------
// Activity-log categories (generic; unchanged across domains).
export const LOG_TYPES = ["sale", "inventory", "expense", "import", "backup", "bill"];

// A product's display icon: its own stored icon, else derived from its subcategory / group.
export const iconFor = (p) => (p && p.icon) || subcatIcon(p && p.subcategory, p && p.category);
