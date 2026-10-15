// Smooth scrolling for mouse wheels. A wheel moves in big steps (about three lines a notch),
// so each notch is eased over a few frames instead of jumping. Touchpads already send
// small, smooth steps and are left alone, and so is the terminal, which scrolls itself.
// Works on anything that scrolls: the editor, the explorer, Output, Settings…

const EASE = 0.3;         // how much of the remaining distance to cover per 60 Hz frame
const anims = new WeakMap(); // element -> { target, last, raf, t }

// A mouse wheel notch is a whole, largish number of pixels (or lines/pages).
const isWheelNotch = (e) => e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));

function scrollerFor(el, dy) {
  for (; el && el !== document.documentElement; el = el.parentElement) {
    if (el.closest?.(".xterm")) return null;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
      const max = el.scrollHeight - el.clientHeight;
      const a = anims.get(el);
      const at = a ? a.target : el.scrollTop;
      // Already at the end in this direction: let an outer box scroll instead.
      if ((dy < 0 && at > 0) || (dy > 0 && at < max - 1)) return el;
    }
  }
  return null;
}

function step(el, a, now) {
  // Someone else moved it (scrollbar drag, keyboard, Go to definition): stop and follow them.
  if (Math.abs(el.scrollTop - a.last) > 2) { anims.delete(el); return; }
  const dt = Math.min(64, now - a.t);
  a.t = now;
  const k = 1 - Math.pow(1 - EASE, dt / 16.67);
  const left = a.target - el.scrollTop;
  if (Math.abs(left) < 1.5) { el.scrollTop = a.target; anims.delete(el); return; }
  // At least a pixel a frame, since some screens round scroll positions to whole pixels.
  el.scrollTop += Math.sign(left) * Math.max(1, Math.abs(left * k));
  a.last = el.scrollTop;
  a.raf = requestAnimationFrame((t) => step(el, a, t));
}

export function smoothScrolling(enabled) {
  window.addEventListener("wheel", (e) => {
    if (!enabled() || e.ctrlKey || e.defaultPrevented) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey || !isWheelNotch(e)) return;
    const el = scrollerFor(e.target, e.deltaY);
    if (!el) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
    const max = el.scrollHeight - el.clientHeight;
    let a = anims.get(el);
    if (!a) {
      a = { target: el.scrollTop, last: el.scrollTop, t: performance.now(), raf: 0 };
      anims.set(el, a);
      a.raf = requestAnimationFrame((t) => step(el, a, t));
    }
    a.target = Math.max(0, Math.min(max, a.target + px));
  }, { passive: false, capture: true });
}
