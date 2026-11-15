import { useEffect, useState } from "react";

/**
 * Ember / purple skin. The colours are CSS variables on <html>, so switching
 * is one attribute and nothing re-renders. The choice is a per-browser
 * convenience; the page works the same if storage is unavailable.
 */
type Theme = "ember" | "purple";
const KEY = "xtomb-theme";

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === "purple" ? "purple" : "ember";
  } catch {
    return "ember";
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    if (theme === "purple") document.documentElement.dataset.theme = "purple";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* private window: the choice just lasts for this visit */
    }
  }, [theme]);

  const next: Theme = theme === "purple" ? "ember" : "purple";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] transition-colors hover:border-white/25"
    >
      <span className="h-3.5 w-3.5 rounded-full" style={{ background: next === "purple" ? "#a78bfa" : "#ff6a2b" }} />
    </button>
  );
}
