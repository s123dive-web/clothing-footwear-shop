// Language toggle (English / Hindi / Marathi). Device-local preference, default English.
//   const { t, lang, setLang } = useLang();     t("Complete sale · {amount}", { amount })
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { STRINGS, LANGS } from "./strings.js";

export { LANGS };
export const LANG_KEY = "cfs-lang-v1";

// Pure: translate `key` into `lang`, falling back to English (the key itself), then fill {vars}.
export function translate(lang, key, vars) {
  const table = STRINGS[lang] || STRINGS.en;
  let s = table[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  return s;
}

const readLang = () => {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return STRINGS[v] ? v : "en";
  } catch {
    return "en";
  }
};

const LangContext = createContext({
  lang: "en",
  setLang: () => {},
  t: (k, v) => translate("en", k, v),
});

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(readLang);
  const setLang = useCallback((v) => {
    const next = STRINGS[v] ? v : "en";
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* private mode — the choice just won't persist */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(
    () => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang, setLang]
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export const useLang = () => useContext(LangContext);

// The language picker (sidebar + Settings).
export function LangSelect({ style, id }) {
  const { lang, setLang, t } = useLang();
  return (
    <select
      id={id}
      className="input"
      aria-label={t("Language")}
      value={lang}
      onChange={(e) => setLang(e.target.value)}
      style={style}
    >
      {LANGS.map(([code, name]) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </select>
  );
}
