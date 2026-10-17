import { useSyncExternalStore } from "react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";

export type Theme = "light" | "dark";
const THEME_KEY = "gitflare-theme";
const THEME_EVENT = "gitflare:theme";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.gfTheme = theme;
  root.dataset.mode = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function initializeTheme() {
  let theme: Theme = "light";
  try {
    if (localStorage.getItem(THEME_KEY) === "dark") theme = "dark";
  } catch {}
  applyTheme(theme);
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  window.dispatchEvent(new Event(THEME_EVENT));
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY) {
      applyTheme(event.newValue === "dark" ? "dark" : "light");
      listener();
    }
  };
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme() {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.gfTheme === "dark" ? "dark" as const : "light" as const, () => "light" as const);
}

export function ThemeToggle({ className = "", compact = true }: { className?: string; compact?: boolean }) {
  const theme = useTheme();
  const dark = theme === "dark";
  const label = `Switch to ${dark ? "light" : "dark"} theme`;
  return <button type="button" className={`theme-toggle ${compact ? "theme-toggle-compact" : ""} ${className}`} aria-label={label} title={label} aria-pressed={dark} onClick={() => setTheme(dark ? "light" : "dark")}>
    {dark ? <SunIcon size={17} aria-hidden="true" /> : <MoonIcon size={17} aria-hidden="true" />}
    {!compact && <span>{dark ? "Light" : "Dark"} theme</span>}
  </button>;
}

export default ThemeToggle;
