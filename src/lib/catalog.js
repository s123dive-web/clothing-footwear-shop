// ---------------------------------------------------------------------------
// Apparel taxonomy, sizes, colours, category auto-guess, and the one-time seed catalogue.
//
// Pure module (no React / Firebase / Date.now) so it unit-tests cleanly. The product/variant
// object helpers live in products.js; this file is the domain vocabulary.
//
// Two-level category model:
//   group       — "Clothing" | "Footwear" | "Accessories"  (the clothing-vs-footwear filter)
//   subcategory — "Kurtis", "Sarees", "Sandals", …          (the granular retail category)
// A product stores both: `category` holds the group, `subcategory` the fine-grained one.
// ---------------------------------------------------------------------------

export const GROUPS = ["Clothing", "Footwear", "Accessories"];

export const SUBCATEGORIES_BY_GROUP = {
  Clothing: [
    "Kurtis",
    "Sarees",
    "Salwar Suits",
    "Leggings",
    "Tops",
    "Dresses",
    "Nightwear",
    "Dupattas",
    "Blouses",
    "Innerwear",
  ],
  Footwear: [
    "Sandals",
    "Flats",
    "Heels",
    "Slippers/Chappals",
    "Sports Shoes",
    "Bellies/Ballerinas",
  ],
  Accessories: ["Handbags", "Belts", "Scarves"],
};

export const ALL_SUBCATEGORIES = GROUPS.flatMap((g) => SUBCATEGORIES_BY_GROUP[g]);

const SUBCAT_TO_GROUP = {};
for (const g of GROUPS) for (const s of SUBCATEGORIES_BY_GROUP[g]) SUBCAT_TO_GROUP[s] = g;

// The group a subcategory belongs to (defaults to Clothing for anything unrecognised).
export const groupForSubcategory = (sub) => SUBCAT_TO_GROUP[sub] || "Clothing";

// Clothing size set (fixed, labelled). Footwear sizes come from the shop config's numeric range.
export const CLOTHING_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "Free Size"];

const clampInt = (v, lo, hi, fb) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
};

// Numeric footwear (IND/UK) size list from a config's range, as strings.
export function footwearSizeRange(cfg) {
  const lo = clampInt(cfg?.footwearSizeMin, 1, 15, 3);
  const hi = clampInt(cfg?.footwearSizeMax, 1, 15, 9);
  const out = [];
  for (let s = Math.min(lo, hi); s <= Math.max(lo, hi); s++) out.push(String(s));
  return out;
}

// The relevant size options for a product, given the shop config (for the footwear range).
export function sizesForProduct(product, cfg) {
  const group = product?.category || groupForSubcategory(product?.subcategory);
  if (group === "Footwear") return footwearSizeRange(cfg);
  if (group === "Accessories") return ["Free Size"];
  return CLOTHING_SIZES;
}

// Common colours for the variant colour picker (colour is still free text — this is a shortcut).
export const COLOR_SWATCHES = [
  { name: "Black", hex: "#222222" },
  { name: "White", hex: "#F5F5F5" },
  { name: "Red", hex: "#C0392B" },
  { name: "Maroon", hex: "#7B241C" },
  { name: "Pink", hex: "#E48AA6" },
  { name: "Rani Pink", hex: "#D6246E" },
  { name: "Navy", hex: "#22314F" },
  { name: "Blue", hex: "#2E6BB8" },
  { name: "Sky Blue", hex: "#7EC0E6" },
  { name: "Green", hex: "#2E7D5B" },
  { name: "Yellow", hex: "#E8C34A" },
  { name: "Orange", hex: "#E08A3C" },
  { name: "Purple", hex: "#7A4C9E" },
  { name: "Grey", hex: "#8A8F98" },
  { name: "Beige", hex: "#D8C7A8" },
  { name: "Brown", hex: "#6E4B33" },
  { name: "Gold", hex: "#C9A24B" },
  { name: "Cream", hex: "#EFE6D2" },
  { name: "Multicolour", hex: "linear-gradient(90deg,#C0392B,#E8C34A,#2E7D5B,#2E6BB8)" },
];

// Emoji icon per subcategory (used in place of a product photo).
export const SUBCAT_ICONS = {
  Kurtis: "👚",
  Sarees: "🥻",
  "Salwar Suits": "🥻",
  Leggings: "🩳",
  Tops: "👕",
  Dresses: "👗",
  Nightwear: "🌙",
  Dupattas: "🧣",
  Blouses: "👚",
  Innerwear: "🩲",
  Sandals: "👡",
  Flats: "🥿",
  Heels: "👠",
  "Slippers/Chappals": "🩴",
  "Sports Shoes": "👟",
  "Bellies/Ballerinas": "🥿",
  Handbags: "👜",
  Belts: "🎗️",
  Scarves: "🧣",
};
const GROUP_ICONS = { Clothing: "👗", Footwear: "👠", Accessories: "👜" };
export const subcatIcon = (subcategory, group) =>
  SUBCAT_ICONS[subcategory] || GROUP_ICONS[group] || "🛍️";

// Keyword → subcategory guesses for the Add-product form. More specific entries first.
const SUBCAT_KEYWORDS = [
  ["kurti", "Kurtis"],
  ["kurta", "Kurtis"],
  ["anarkali", "Kurtis"],
  ["saree", "Sarees"],
  ["sari", "Sarees"],
  ["salwar", "Salwar Suits"],
  ["suit", "Salwar Suits"],
  ["churidar", "Salwar Suits"],
  ["patiala", "Salwar Suits"],
  ["legging", "Leggings"],
  ["jegging", "Leggings"],
  ["palazzo", "Leggings"],
  ["top", "Tops"],
  ["t-shirt", "Tops"],
  ["tshirt", "Tops"],
  ["tee", "Tops"],
  ["crop", "Tops"],
  ["dress", "Dresses"],
  ["gown", "Dresses"],
  ["frock", "Dresses"],
  ["maxi", "Dresses"],
  ["nighty", "Nightwear"],
  ["nightwear", "Nightwear"],
  ["nightdress", "Nightwear"],
  ["pyjama", "Nightwear"],
  ["pajama", "Nightwear"],
  ["nightsuit", "Nightwear"],
  ["dupatta", "Dupattas"],
  ["chunni", "Dupattas"],
  ["stole", "Dupattas"],
  ["blouse", "Blouses"],
  ["innerwear", "Innerwear"],
  ["bra", "Innerwear"],
  ["panty", "Innerwear"],
  ["camisole", "Innerwear"],
  ["slip", "Innerwear"],
  ["lingerie", "Innerwear"],
  ["sandal", "Sandals"],
  ["heel", "Heels"],
  ["stiletto", "Heels"],
  ["wedge", "Heels"],
  ["chappal", "Slippers/Chappals"],
  ["slipper", "Slippers/Chappals"],
  ["flip flop", "Slippers/Chappals"],
  ["flip-flop", "Slippers/Chappals"],
  ["sports shoe", "Sports Shoes"],
  ["sneaker", "Sports Shoes"],
  ["running shoe", "Sports Shoes"],
  ["walking shoe", "Sports Shoes"],
  ["bellie", "Bellies/Ballerinas"],
  ["belly", "Bellies/Ballerinas"],
  ["ballerina", "Bellies/Ballerinas"],
  ["ballet", "Bellies/Ballerinas"],
  ["flat", "Flats"],
  ["mojari", "Flats"],
  ["juti", "Flats"],
  ["jutti", "Flats"],
  ["kolhapuri", "Flats"],
  ["handbag", "Handbags"],
  ["hand bag", "Handbags"],
  ["clutch", "Handbags"],
  ["sling", "Handbags"],
  ["purse", "Handbags"],
  ["tote", "Handbags"],
  ["belt", "Belts"],
  ["scarf", "Scarves"],
  ["scarves", "Scarves"],
  ["muffler", "Scarves"],
];

// Guess a subcategory from a typed product name. Returns null when nothing is confident.
export function guessSubcategory(name) {
  const n = (name || "").toLowerCase().trim();
  if (n.length < 2) return null;
  for (const [kw, sub] of SUBCAT_KEYWORDS) {
    const hit = /[^a-z0-9]/.test(kw) ? n.includes(kw) : new RegExp(`\\b${kw}\\b`).test(n);
    if (hit) return sub;
  }
  return null;
}

// ---------------------------------------------------------------------------
// One-time seed catalogue — ~15 realistic ladies clothing & footwear products.
// Specs only (no ids / no stock): products.js turns these into full records at 0 stock the
// first time the cloud is empty, guarded by a DB flag so deleted items never resurrect.
// Each spec lists the size/colour variants to create.
// ---------------------------------------------------------------------------
export const SEED_PRODUCTS = [
  {
    name: "Cotton Printed Kurti",
    brand: "Biba",
    subcategory: "Kurtis",
    purchasePrice: 380,
    sellingPrice: 649,
    mrp: 899,
    sizes: ["S", "M", "L", "XL"],
    colors: ["Maroon", "Navy", "Yellow"],
  },
  {
    name: "Rayon Straight Kurti",
    brand: "W",
    subcategory: "Kurtis",
    purchasePrice: 320,
    sellingPrice: 549,
    mrp: 799,
    sizes: ["M", "L", "XL", "XXL"],
    colors: ["Black", "Pink"],
  },
  {
    name: "Anarkali Long Kurta",
    brand: "Aurelia",
    subcategory: "Kurtis",
    purchasePrice: 560,
    sellingPrice: 999,
    mrp: 1499,
    sizes: ["M", "L", "XL"],
    colors: ["Rani Pink", "Green"],
  },
  {
    name: "Georgette Designer Saree",
    brand: "Mysore Silk",
    subcategory: "Sarees",
    purchasePrice: 850,
    sellingPrice: 1499,
    mrp: 2200,
    sizes: ["Free Size"],
    colors: ["Red", "Maroon", "Navy"],
  },
  {
    name: "Cotton Handloom Saree",
    brand: "Fabindia",
    subcategory: "Sarees",
    purchasePrice: 620,
    sellingPrice: 1099,
    mrp: 1599,
    sizes: ["Free Size"],
    colors: ["Beige", "Green"],
  },
  {
    name: "Cotton Salwar Suit Set",
    brand: "Libas",
    subcategory: "Salwar Suits",
    purchasePrice: 720,
    sellingPrice: 1299,
    mrp: 1899,
    sizes: ["M", "L", "XL", "XXL"],
    colors: ["Sky Blue", "Cream"],
  },
  {
    name: "Ankle-Length Leggings",
    brand: "Go Colors",
    subcategory: "Leggings",
    purchasePrice: 180,
    sellingPrice: 349,
    mrp: 499,
    sizes: ["S", "M", "L", "XL", "XXL"],
    colors: ["Black", "Navy", "Maroon", "White"],
  },
  {
    name: "Rayon Printed Top",
    brand: "Max",
    subcategory: "Tops",
    purchasePrice: 210,
    sellingPrice: 399,
    mrp: 599,
    sizes: ["S", "M", "L", "XL"],
    colors: ["White", "Pink", "Yellow"],
  },
  {
    name: "A-Line Midi Dress",
    brand: "Zara",
    subcategory: "Dresses",
    purchasePrice: 640,
    sellingPrice: 1199,
    mrp: 1799,
    sizes: ["S", "M", "L"],
    colors: ["Black", "Red"],
  },
  {
    name: "Cotton Printed Nighty",
    brand: "Comfort Lady",
    subcategory: "Nightwear",
    purchasePrice: 190,
    sellingPrice: 349,
    mrp: 499,
    sizes: ["L", "XL", "XXL", "Free Size"],
    colors: ["Pink", "Sky Blue"],
  },
  {
    name: "Chiffon Dupatta",
    brand: "Soch",
    subcategory: "Dupattas",
    purchasePrice: 120,
    sellingPrice: 249,
    mrp: 399,
    sizes: ["Free Size"],
    colors: ["Gold", "Rani Pink", "Maroon"],
  },
  {
    name: "Embroidered Blouse",
    brand: "House of Blouse",
    subcategory: "Blouses",
    purchasePrice: 160,
    sellingPrice: 329,
    mrp: 499,
    sizes: ["32", "34", "36", "38"],
    colors: ["Red", "Gold", "Black"],
  },
  {
    name: "Fashion Flat Sandals",
    brand: "Bata",
    subcategory: "Sandals",
    purchasePrice: 260,
    sellingPrice: 499,
    mrp: 699,
    sizes: ["4", "5", "6", "7", "8"],
    colors: ["Black", "Brown", "Gold"],
  },
  {
    name: "Block Heel Sandals",
    brand: "Metro",
    subcategory: "Heels",
    purchasePrice: 420,
    sellingPrice: 799,
    mrp: 1199,
    sizes: ["4", "5", "6", "7"],
    colors: ["Black", "Maroon", "Beige"],
  },
  {
    name: "Daily Wear Chappals",
    brand: "Relaxo",
    subcategory: "Slippers/Chappals",
    purchasePrice: 110,
    sellingPrice: 249,
    mrp: 349,
    sizes: ["4", "5", "6", "7", "8"],
    colors: ["Pink", "Blue", "Black"],
  },
  {
    name: "Ballerina Bellies",
    brand: "Inc.5",
    subcategory: "Bellies/Ballerinas",
    purchasePrice: 300,
    sellingPrice: 599,
    mrp: 899,
    sizes: ["4", "5", "6", "7"],
    colors: ["Beige", "Black", "Rani Pink"],
  },
  {
    name: "Quilted Sling Handbag",
    brand: "Caprese",
    subcategory: "Handbags",
    purchasePrice: 480,
    sellingPrice: 899,
    mrp: 1499,
    sizes: ["Free Size"],
    colors: ["Black", "Brown", "Maroon"],
  },
];
