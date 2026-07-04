// ---------------------------------------------------------------------------
// Shop identity & preferences.
//
// Stored ONCE in the Realtime Database at shop/shopConfig (a single object, not a keyed
// slice) and cached in localStorage for instant first paint / offline reads. Every screen
// that shows the shop name, address, currency, logo, or receipt footer reads from here —
// there is no hardcoded shop identity anywhere in the UI.
//
// The pure helpers (DEFAULT_SHOP_CONFIG, normalizeConfig, validateConfig) carry no Firebase
// or React dependency so they unit-test cleanly. The subscribe/save helpers and the
// useShopConfig hook wire it to Firebase + React.
// ---------------------------------------------------------------------------
import { createContext, useContext } from "react";
import { ref, onValue, update } from "firebase/database";
import { db } from "./firebase.js";
import { setCurrencySymbol } from "./currency.js";

export const SHOP_CONFIG_PATH = "shop/shopConfig";
export const SHOP_CONFIG_CACHE_KEY = "cfs-shop-config-v1";

// Sensible, brand-neutral defaults. The owner sets the real values in Settings.
export const DEFAULT_SHOP_CONFIG = {
  name: "Clothing & Footwear Shop",
  tagline: "Ladies Fashion & Footwear",
  address: "",
  phone: "",
  email: "",
  gstin: "",
  currency: "₹",
  logoUrl: "", // optional data-URL (uploaded logo) or hosted image URL
  receiptFooter: "Thank you! Please visit again.",
  // Configurable footwear size range (IND/UK). Clothing sizes are a fixed labelled set.
  footwearSizeMin: 3,
  footwearSizeMax: 9,
};

const str = (v, fallback = "") => (v == null ? fallback : String(v));
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// Merge a raw (possibly partial / untrusted) config over the defaults and coerce types, so
// the rest of the app can trust every field exists and is the right shape.
export function normalizeConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const min = clampInt(r.footwearSizeMin, 1, 15, DEFAULT_SHOP_CONFIG.footwearSizeMin);
  const max = clampInt(r.footwearSizeMax, 1, 15, DEFAULT_SHOP_CONFIG.footwearSizeMax);
  return {
    name: str(r.name, DEFAULT_SHOP_CONFIG.name).trim() || DEFAULT_SHOP_CONFIG.name,
    tagline: str(r.tagline, DEFAULT_SHOP_CONFIG.tagline),
    address: str(r.address),
    phone: str(r.phone),
    email: str(r.email),
    gstin: str(r.gstin),
    currency: str(r.currency, DEFAULT_SHOP_CONFIG.currency).trim() || DEFAULT_SHOP_CONFIG.currency,
    logoUrl: str(r.logoUrl),
    receiptFooter: str(r.receiptFooter, DEFAULT_SHOP_CONFIG.receiptFooter),
    footwearSizeMin: Math.min(min, max),
    footwearSizeMax: Math.max(min, max),
  };
}

// Validate a config the owner is about to save. Returns "" when valid, else an error string.
export function validateConfig(cfg) {
  if (!str(cfg.name).trim()) return "Shop name is required.";
  if (cfg.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.email.trim()))
    return "Enter a valid email address (or leave it blank).";
  if (!str(cfg.currency).trim()) return "Currency symbol is required.";
  const min = Number(cfg.footwearSizeMin),
    max = Number(cfg.footwearSizeMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max)
    return "Footwear size range is invalid.";
  return "";
}

// The full inclusive footwear size list from the configured range, as strings.
export function footwearSizes(cfg) {
  const lo = clampInt(cfg?.footwearSizeMin, 1, 15, DEFAULT_SHOP_CONFIG.footwearSizeMin);
  const hi = clampInt(cfg?.footwearSizeMax, 1, 15, DEFAULT_SHOP_CONFIG.footwearSizeMax);
  const out = [];
  for (let s = Math.min(lo, hi); s <= Math.max(lo, hi); s++) out.push(String(s));
  return out;
}

// ---- localStorage cache ----
export function loadCachedConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(SHOP_CONFIG_CACHE_KEY) || "null");
    return c ? normalizeConfig(c) : null;
  } catch {
    return null;
  }
}
export function cacheConfig(cfg) {
  try {
    localStorage.setItem(SHOP_CONFIG_CACHE_KEY, JSON.stringify(cfg));
  } catch (e) {
    console.error("shop-config cache write failed", e);
  }
}

// ---- Firebase wiring ----
export function subscribeShopConfig(onData, onError) {
  return onValue(ref(db, SHOP_CONFIG_PATH), (snap) => onData(normalizeConfig(snap.val())), onError);
}

// Save a partial update (merge). Also refreshes the shared currency symbol immediately.
export function saveShopConfig(patch) {
  const clean = JSON.parse(JSON.stringify(patch ?? {}));
  if (clean.currency) setCurrencySymbol(clean.currency);
  return update(ref(db, SHOP_CONFIG_PATH), clean);
}

// ---- React context ----
export const ShopConfigContext = createContext(DEFAULT_SHOP_CONFIG);
export const useShopConfig = () => useContext(ShopConfigContext);
