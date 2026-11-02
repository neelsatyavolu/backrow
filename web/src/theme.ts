// Theme: follows the system unless the visitor picks light or dark with the
// nav button (cycles system -> light -> dark). Loaded as a classic script in
// <head> so a saved choice applies before first paint.

type Mode = "system" | "light" | "dark";
const ORDER: Mode[] = ["system", "light", "dark"];
const KEY = "backrow:theme";
const ICONS: Record<Mode, string> = {
  system: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M6 14h4"/></svg>',
  light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3"/></svg>',
  dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg>',
};

function saved(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(mode: Mode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

let mode = saved();
apply(mode);

function wire(): void {
  const btn = document.getElementById("theme");
  if (!btn) return;
  const render = () => {
    btn.innerHTML = ICONS[mode];
    btn.title = `Theme: ${mode}`;
    btn.setAttribute("aria-label", `Theme: ${mode}. Change theme`);
  };
  render();
  btn.addEventListener("click", () => {
    mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? "system";
    apply(mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // Not persisted; the choice lasts for this page.
    }
    render();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
else wire();
