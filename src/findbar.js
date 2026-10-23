// The find and replace bar (Ctrl F; Ctrl H opens it with the replace row, as does the ▸ button): Ledger's
// own look instead of CodeMirror's plain one, with "3 of 120" so you know where you are.
// Enter / Shift Enter go to the next and previous match, Alt Enter selects every match,
// Esc closes. Aa, ab and .* are match case, whole word and regular expression.
import { SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, selectMatches, replaceNext, replaceAll, closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { runScopeHandlers } from "@codemirror/view";

const MAX_COUNT = 10000;
let wantReplace = false;

class FindBar {
  constructor(view) {
    this.view = view;
    const q = getSearchQuery(view.state);
    this.showReplace = !!q.replace || wantReplace;
    wantReplace = false;
    const dom = (this.dom = document.createElement("div"));
    dom.className = "fb";
    dom.innerHTML = `
      <button class="ibtn fb-exp" data-a="exp" title="Replace" aria-label="Show replace">▸</button>
      <div class="fb-rows">
        <div class="fb-row">
          <div class="fb-in"><input class="fb-q" placeholder="Find" aria-label="Find" spellcheck="false" main-field="true">
            <button class="fb-t" data-t="caseSensitive" title="Match case">Aa</button><button class="fb-t" data-t="wholeWord" title="Whole word"><u>ab</u></button><button class="fb-t" data-t="regexp" title="Regular expression">.*</button></div>
          <span class="fb-count" aria-live="polite"></span>
          <button class="ibtn" data-a="prev" title="Previous match (Shift Enter)" aria-label="Previous match">↑</button>
          <button class="ibtn" data-a="next" title="Next match (Enter)" aria-label="Next match">↓</button>
          <button class="ibtn fb-all" data-a="all" title="Select every match (Alt Enter)">All</button>
          <button class="ibtn" data-a="close" title="Close (Esc)" aria-label="Close">×</button>
        </div>
        <div class="fb-row fb-repl">
          <div class="fb-in"><input class="fb-r" placeholder="Replace" aria-label="Replace with" spellcheck="false"></div>
          <button class="btn" data-a="one" title="Replace this match (Enter in this box)">Replace</button>
          <button class="btn" data-a="every" title="Replace every match">Replace all</button>
        </div>
      </div>`;
    this.q = dom.querySelector(".fb-q");
    this.r = dom.querySelector(".fb-r");
    this.q.value = q.search;
    this.r.value = q.replace;
    dom.addEventListener("input", () => this.commit());
    dom.addEventListener("click", (e) => {
      const t = e.target.closest("[data-t]");
      if (t) { this.flags[t.dataset.t] = !this.flags[t.dataset.t]; this.commit(); return; }
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "exp") { this.showReplace = !this.showReplace; this.paint(); (this.showReplace ? this.r : this.q).focus(); }
      else if (a === "prev") findPrevious(view);
      else if (a === "next") findNext(view);
      else if (a === "all") { selectMatches(view); view.focus(); }
      else if (a === "one") replaceNext(view);
      else if (a === "every") replaceAll(view);
      else if (a === "close") { closeSearchPanel(view); view.focus(); }
    });
    dom.addEventListener("keydown", (e) => {
      if (runScopeHandlers(view, e, "search-panel")) { e.preventDefault(); return; }
      if (e.key === "Escape") { e.preventDefault(); closeSearchPanel(view); view.focus(); }
      else if (e.key === "Enter" && e.target === this.r) { e.preventDefault(); e.ctrlKey || e.metaKey ? replaceAll(view) : replaceNext(view); }
      else if (e.key === "Enter" && e.altKey) { e.preventDefault(); selectMatches(view); view.focus(); }
      else if (e.key === "Enter") { e.preventDefault(); (e.shiftKey ? findPrevious : findNext)(view); }
    });
    this.flags = { caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp };
    this.paint();
  }
  commit() {
    const q = new SearchQuery({ search: this.q.value, replace: this.r.value, ...this.flags });
    if (!q.eq(getSearchQuery(this.view.state))) this.view.dispatch({ effects: setSearchQuery.of(q) });
    this.paint();
  }
  paint() {
    for (const b of this.dom.querySelectorAll("[data-t]")) { const on = !!this.flags[b.dataset.t]; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); }
    this.dom.querySelector(".fb-repl").hidden = !this.showReplace;
    const exp = this.dom.querySelector(".fb-exp");
    exp.textContent = this.showReplace ? "▾" : "▸";
    exp.setAttribute("aria-expanded", this.showReplace);
    this.count();
  }
  count() {
    const st = this.view.state, q = getSearchQuery(st), el = this.dom.querySelector(".fb-count");
    this.q.classList.toggle("bad", !!q.search && !q.valid);
    if (!q.search) { el.textContent = ""; return; }
    if (!q.valid) { el.textContent = "Not a valid pattern"; return; }
    const sel = st.selection.main;
    let n = 0, at = 0;
    const cur = q.getCursor(st);
    for (let r = cur.next(); !r.done; r = cur.next()) {
      n++;
      if (!at && r.value.from === sel.from && r.value.to === sel.to) at = n;
      if (n >= MAX_COUNT) break;
    }
    const more = n >= MAX_COUNT ? "+" : "";
    el.textContent = n ? (at ? `${at} of ${n}${more}` : `${n}${more} match${n === 1 ? "" : "es"}`) : "No results";
    el.classList.toggle("none", !n);
  }
  mount() { this.q.focus(); this.q.select(); }
  update(u) {
    for (const tr of u.transactions) for (const e of tr.effects) if (e.is(setSearchQuery) && !e.value.eq(new SearchQuery({ search: this.q.value, replace: this.r.value, ...this.flags }))) {
      this.q.value = e.value.search; this.r.value = e.value.replace;
      this.flags = { caseSensitive: e.value.caseSensitive, wholeWord: e.value.wholeWord, regexp: e.value.regexp };
    }
    if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.length)) this.paint();
  }
  get top() { return true; }
}

export const findPanel = (view) => new FindBar(view);
// Ctrl H: the bar with its replace row open (and the cursor in Replace when there's already a search).
export function openReplace(view) {
  const open = searchPanelOpen(view.state);
  if (!open) { wantReplace = true; openSearchPanel(view); wantReplace = false; }
  const bar = view.dom.querySelector(".fb");
  if (!bar) return true;
  const exp = bar.querySelector(".fb-exp");
  if (exp.getAttribute("aria-expanded") !== "true") exp.click();
  else (bar.querySelector(".fb-q").value ? bar.querySelector(".fb-r") : bar.querySelector(".fb-q")).focus();
  return true;
}
