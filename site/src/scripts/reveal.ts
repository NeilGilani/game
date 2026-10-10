// Sections ease in once as they scroll into view. Skipped entirely when the visitor prefers reduced motion,
// and content is visible without JavaScript (the hiding class is only added by script).
export function initReveal(): void {
  const items = document.querySelectorAll<HTMLElement>(".reveal");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  items.forEach((el) => observer.observe(el));
  // A focused element must never be invisible: reveal anything that receives keyboard focus.
  document.addEventListener("focusin", (e) => {
    const host = (e.target as HTMLElement | null)?.closest<HTMLElement>(".reveal");
    host?.classList.add("is-visible");
  });
}
