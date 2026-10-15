// Keeps a scrolling box (the Output panel, the debug console) pinned to its last line,
// like a terminal. It stays pinned while new lines come in and while the box changes size
// (the Input box appearing, the panel being dragged taller or shorter). Scrolling up to read
// lets go; scrolling back to the bottom pins it again.
export function followBottom(el) {
  let pinned = true;
  const toEnd = () => { el.scrollTop = el.scrollHeight; };
  el.addEventListener("scroll", () => {
    if (!el.clientHeight) return; // hidden: nothing to decide
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, { passive: true });
  new ResizeObserver(() => { if (pinned) toEnd(); }).observe(el);
  return {
    // Call after adding or changing what's in the box.
    changed() { if (pinned) toEnd(); },
    // Pin again and jump to the end: a new run, or the box was cleared.
    reset() { pinned = true; toEnd(); },
  };
}
