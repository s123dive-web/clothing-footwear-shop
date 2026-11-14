// In-page accessibility audit used by a11y.spec.js. Runs inside the browser (page.evaluate).
// Returns { unlabeled, contrast, small } — each a list of human-readable findings.
export function auditPage({ minTarget = 0 } = {}) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0)
      return false;
    for (let p = el; p; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (c.display === "none" || c.visibility === "hidden") return false;
      if (p.classList && p.classList.contains("sr-only")) return false;
    }
    return true;
  };
  const describe = (el) =>
    `<${el.tagName.toLowerCase()}${el.type ? " type=" + el.type : ""}${el.className && typeof el.className === "string" ? " ." + el.className.split(" ").join(".") : ""}> ` +
    JSON.stringify(
      (el.getAttribute("placeholder") || el.textContent || el.value || "").trim().slice(0, 40)
    );

  // ---- 1. controls without an accessible name
  const unlabeled = [];
  for (const el of document.querySelectorAll("input, select, textarea, button")) {
    if (!visible(el) || el.type === "hidden") continue;
    const name =
      (el.getAttribute("aria-label") || "").trim() ||
      (el.getAttribute("aria-labelledby") &&
        (document.getElementById(el.getAttribute("aria-labelledby")) || {}).textContent) ||
      (el.labels &&
        [...el.labels]
          .map((l) => l.textContent)
          .join(" ")
          .trim()) ||
      (el.getAttribute("title") || "").trim() ||
      (el.tagName === "BUTTON" ? el.textContent.trim() : "");
    if (!name) unlabeled.push(describe(el));
  }

  // ---- 2. text contrast
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // gradient/image: skip
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) base = over(l, base);
    return base;
  };
  const seen = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest("svg, [aria-hidden=true], option") || !visible(el)) continue;
    if (el.closest("button:disabled, input:disabled")) continue;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    const bg = bgOf(el);
    if (!fg0 || !bg) continue;
    const fg = over(fg0, bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio + 0.01 < need) {
      const hex = (c) =>
        "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      const key = hex(fg) + " on " + hex(bg);
      if (!seen.has(key))
        seen.set(
          key,
          `${key} = ${ratio.toFixed(2)} (need ${need}) e.g. ${JSON.stringify(text.slice(0, 30))}`
        );
    }
  }

  // ---- 3. tap targets
  const small = [];
  if (minTarget) {
    for (const el of document.querySelectorAll(
      "button, input, select, textarea, a[href], [role=button]"
    )) {
      if (!visible(el) || el.type === "hidden" || el.type === "file") continue;
      // A checkbox / radio inside its <label> is tapped via the whole label.
      const box = (el.type === "checkbox" || el.type === "radio") && el.closest("label");
      const r = (box || el).getBoundingClientRect();
      const tooShort = r.height < minTarget - 0.5;
      const tooNarrow =
        (el.tagName === "BUTTON" || el.getAttribute("role") === "button") &&
        r.width < minTarget - 0.5;
      if (tooShort || tooNarrow)
        small.push(`${Math.round(r.width)}×${Math.round(r.height)} ${describe(el)}`);
    }
  }
  return { unlabeled, contrast: [...seen.values()], small };
}
