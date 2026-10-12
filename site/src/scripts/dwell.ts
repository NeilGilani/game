// "Look and hold", tried with a mouse. Resting the pointer on a phrase fills its ring over 1.2 seconds (AGENCY's
// default dwell time); when the ring is full, the phrase is chosen. Moving away empties the ring and nothing
// happens. Clicking, tapping, or Enter and Space on a focused phrase choose it straight away, so the demo works
// without a mouse too. With reduced motion, the ring fills in four steps instead of a smooth sweep, and the
// pointer dot doesn't glide.

const DWELL_MS = 1200;

export function initDwellDemo(): void {
  const root = document.querySelector<HTMLElement>("[data-dwell-demo]");
  if (!root) return;
  const out = root.querySelector<HTMLElement>("[data-dwell-out]");
  const dot = root.querySelector<HTMLElement>("[data-gaze-dot]");
  const stage = root.querySelector<HTMLElement>("[data-dwell-stage]");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  root.dataset["ready"] = "";

  const choose = (btn: HTMLButtonElement) => {
    const phrase = btn.dataset["say"] ?? btn.textContent ?? "";
    if (out) {
      out.replaceChildren();
      const said = document.createElement("p");
      said.className = "dd-said";
      said.textContent = `“${phrase}”`;
      const how = document.createElement("p");
      how.className = "dd-how";
      how.textContent = "Chosen. In AGENCY, your Mac would now say this out loud.";
      out.append(said, how);
    }
    btn.dataset["chosen"] = "";
    window.setTimeout(() => delete btn.dataset["chosen"], 700);
  };

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-say]")) {
    let start = 0;
    let frame = 0;
    // After a choice, the pointer has to leave and come back before the same phrase can be chosen again.
    let locked = false;
    const set = (p: number) => btn.style.setProperty("--p", String(p));
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      delete btn.dataset["dwelling"];
      set(0);
    };
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / DWELL_MS);
      set(reduce.matches ? Math.floor(raw * 4) / 4 : raw);
      if (raw >= 1) {
        frame = 0;
        delete btn.dataset["dwelling"];
        locked = true;
        set(1);
        choose(btn);
        window.setTimeout(() => set(0), 700);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    btn.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch" || locked || frame) return;
      btn.dataset["dwelling"] = "";
      start = performance.now();
      frame = requestAnimationFrame(tick);
    });
    btn.addEventListener("pointerleave", () => {
      locked = false;
      stop();
    });
    btn.addEventListener("click", () => {
      if (locked && !frame && btn.dataset["chosen"] !== undefined) return;
      stop();
      locked = true;
      choose(btn);
    });
    btn.addEventListener("blur", () => {
      locked = false;
    });
  }

  // The blue dot is AGENCY's eye cursor: it glides after the pointer, as the app's does after your eyes.
  if (!stage || !dot || !window.matchMedia("(pointer: fine)").matches) return;
  let x = 0;
  let y = 0;
  let tx = 0;
  let ty = 0;
  let moving = 0;
  const glide = () => {
    const k = reduce.matches ? 1 : 0.28;
    x += (tx - x) * k;
    y += (ty - y) * k;
    dot.style.transform = `translate(${x}px, ${y}px)`;
    moving = Math.abs(tx - x) + Math.abs(ty - y) > 0.3 ? requestAnimationFrame(glide) : 0;
  };
  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const r = stage.getBoundingClientRect();
    tx = e.clientX - r.left;
    ty = e.clientY - r.top;
    if (!dot.dataset["on"]) {
      x = tx;
      y = ty;
      dot.dataset["on"] = "";
    }
    if (!moving) moving = requestAnimationFrame(glide);
  });
  stage.addEventListener("pointerleave", () => delete dot.dataset["on"]);
}
