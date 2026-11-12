// Keeps a scrolling box (the Output panel, the debug console) pinned to its last line,
// like a terminal. It stays pinned while new lines come in and while the box changes size
// (the Input box appearing, the panel being dragged taller or shorter). Scrolling up to read
// lets go; scrolling back to the bottom pins it again.
//
// Only scrolling you do counts (the wheel, keys, the scrollbar, touch). The box also scrolls on
// its own (hidden and shown again, the panel switching tabs, lines dropped off the top), and
// those scrolls used to look like you scrolling up, so it stopped following mid-run.
export function followBottom(el) {
  let pinned = true;
  let touched = 0; // when you last scrolled it yourself
  const toEnd = () => { el.scrollTop = el.scrollHeight; };
  const you = () => { touched = performance.now(); };
  el.addEventListener("wheel", you, { passive: true });
  el.addEventListener("touchmove", you, { passive: true });
  el.addEventListener("keydown", (e) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(e.key)) you(); });
  // The scrollbar: a press on the box itself, not on its lines.
  el.addEventListener("pointerdown", (e) => { if (e.target === el) you(); });
  el.addEventListener("scroll", () => {
    if (!el.clientHeight) return; // hidden: nothing to decide
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (performance.now() - touched < 1500) pinned = atEnd;
    else if (pinned && !atEnd) toEnd(); // moved without you: back to the end
  }, { passive: true });
  new ResizeObserver(() => { if (pinned) toEnd(); }).observe(el);
  return {
    // Call after adding or changing what's in the box.
    changed() { if (pinned) toEnd(); },
    // Pin again and jump to the end: a new run, or the box was cleared.
    reset() { pinned = true; toEnd(); },
    get pinned() { return pinned; },
  };
}
