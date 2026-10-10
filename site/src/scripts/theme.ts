// Light or dark: follows the Mac's setting until the visitor chooses, then remembers the choice in this browser
// only (localStorage; no cookie, never sent anywhere).
const KEY = "agency-site.theme";

type Theme = "light" | "dark";

function current(): Theme {
  const set = document.documentElement.dataset["theme"];
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function initTheme(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  const label = button?.querySelector<HTMLElement>("[data-theme-label]");
  if (!button || !label) return;
  const render = () => {
    const next = current() === "dark" ? "Light" : "Dark";
    label.textContent = next;
    button.setAttribute("aria-label", `Switch to ${next.toLowerCase()} colours`);
  };
  button.hidden = false;
  render();
  button.addEventListener("click", () => {
    const next: Theme = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset["theme"] = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private browsing: the choice lasts for this page only */
    }
    render();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}
