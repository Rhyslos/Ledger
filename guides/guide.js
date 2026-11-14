
(function () {
  "use strict";
  var doc = document;
  var root = doc.documentElement;
  var main = doc.getElementById("main");
  var toc = doc.getElementById("toc");
  var input = doc.getElementById("guide-search");
  var results = doc.getElementById("results");
  var progress = doc.getElementById("progress");
  var tocRead = doc.getElementById("toc-read");
  var crumbChapter = doc.getElementById("crumb-chapter");
  var crumbSection = doc.getElementById("crumb-section");
  var crumbSep = doc.querySelector("#crumb .sep");
  var toTop = doc.getElementById("to-top");
  var toast = doc.getElementById("toast");
  var each = function (list, f) { Array.prototype.forEach.call(list, f); };
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* file:// or a private window */ } }
  };
  function here() { return location.pathname + location.search; }
  function setHash(id) {
    try { history.replaceState(null, "", id ? "#" + id : here()); } catch (e) { /* some file:// setups refuse */ }
  }
  var toastTimer = null;
  function say(text) {
    toast.textContent = text;
    toast.classList.add("shown");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { toast.classList.remove("shown"); }, 1600);
  }

  /* Theme: as the system (Auto), light or dark. The <head> script has
     already set the stored one, so this only keeps the button right. */
  var themeButton = doc.getElementById("theme-button");
  var modes = ["system", "light", "dark"];
  var names = { system: "Auto", light: "Light", dark: "Dark" };
  var says = { system: "follows the system", light: "light", dark: "dark" };
  function applyTheme(t) {
    if (t === "light" || t === "dark") { root.setAttribute("data-theme", t); } else { root.removeAttribute("data-theme"); t = "system"; }
    themeButton.dataset.mode = t;
    themeButton.querySelector(".label").textContent = names[t];
    var next = modes[(modes.indexOf(t) + 1) % modes.length];
    themeButton.title = "Theme: " + names[t] + " (" + says[t] + "). Click for " + names[next] + ".";
    themeButton.setAttribute("aria-label", themeButton.title);
    return t;
  }
  var theme = applyTheme(store.get("guide-theme") || "system");
  themeButton.addEventListener("click", function () {
    theme = applyTheme(modes[(modes.indexOf(theme) + 1) % modes.length]);
    store.set("guide-theme", theme);
  });

  /* Tables scroll sideways on their own on a narrow screen. */
  each(main.querySelectorAll("table"), function (t) {
    if (t.parentNode.classList.contains("table-wrap")) { return; }
    var wrap = doc.createElement("div");
    wrap.className = "table-wrap";
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });

  function headingOf(el) {
    if (/^H[1-4]$/.test(el.tagName)) { return el; }
    return el.querySelector("h1, h2, h3, h4");
  }
  function titleOf(h) {
    var c = h.cloneNode(true);
    each(c.querySelectorAll(".anchor"), function (a) { a.remove(); });
    return c.textContent.replace(/\s+/g, " ").trim();
  }

  /* Every heading with a place to link to gets its "#". */
  each(main.querySelectorAll("h2, h3"), function (h) {
    if (h.querySelector(".anchor")) { return; }
    var id = h.id || (h.parentNode.id && h.parentNode.firstElementChild === h ? h.parentNode.id : "");
    if (!id) { return; }
    var a = doc.createElement("a");
    a.className = "anchor";
    a.href = "#" + id;
    a.setAttribute("aria-label", "Link to this section");
    a.textContent = "#";
    h.appendChild(a);
  });

  /* Contents: the chapters, numbered, each with its sections. Only the
     chapter being read is opened out, so the list stays short. */
  var chapters = Array.prototype.slice.call(main.querySelectorAll("section.chapter"));
  var places = [];   /* chapters and sections in page order: {id, el, chapter, link, title} */
  var list = doc.createElement("ol");
  chapters.forEach(function (chapter, i) {
    var head = headingOf(chapter);
    var title = chapter.id === "welcome" ? "Welcome" : titleOf(head);
    chapter.guideTitle = title;
    chapter.guideNum = i;
    if (i > 0) { head.setAttribute("data-num", String(i)); }
    var li = doc.createElement("li");
    var a = doc.createElement("a");
    a.href = "#" + chapter.id;
    a.innerHTML = '<span class="num">' + (i > 0 ? i : "") + "</span>";
    a.appendChild(doc.createTextNode(title));
    li.appendChild(a);
    chapter.tocItem = li;
    places.push({ id: chapter.id, el: chapter, chapter: chapter, link: a, title: title, sub: false });
    var subs = chapter.querySelectorAll(":scope > section[id], :scope > .table-wrap > h3[id]");
    if (subs.length) {
      var inner = doc.createElement("ol");
      each(subs, function (sub) {
        var h = headingOf(sub);
        if (!h) { return; }
        var li2 = doc.createElement("li");
        var a2 = doc.createElement("a");
        a2.href = "#" + sub.id;
        var t = titleOf(h);
        a2.textContent = t;
        li2.appendChild(a2);
        inner.appendChild(li2);
        places.push({ id: sub.id, el: sub, chapter: chapter, link: a2, title: t, sub: true });
      });
      li.appendChild(inner);
    }
    list.appendChild(li);
  });
  toc.appendChild(list);
  var placeById = {};
  places.forEach(function (p) { placeById[p.id] = p; });

  /* At the end of each chapter: the one before and the one after. */
  chapters.forEach(function (chapter, i) {
    var pager = doc.createElement("nav");
    pager.className = "pager";
    pager.setAttribute("aria-label", "Chapters before and after");
    function card(other, dir) {
      var a = doc.createElement("a");
      a.className = dir;
      a.href = "#" + other.id;
      var label = dir === "prev" ? "← Previous" : "Next →";
      if (other.guideNum > 0) { label += " · Chapter " + other.guideNum; }
      a.innerHTML = '<span class="dir"></span><span class="name"></span>';
      a.firstChild.textContent = label;
      a.lastChild.textContent = other.guideTitle;
      pager.appendChild(a);
    }
    if (i > 0) { card(chapters[i - 1], "prev"); }
    if (i < chapters.length - 1) { card(chapters[i + 1], "next"); }
    chapter.appendChild(pager);
  });

  /* Where you are: lit in the contents, named in the top bar, kept in the
     address (replaced, never added, so Back still leaves the page). */
  function topBar() { return doc.querySelector(".top").getBoundingClientRect().height; }
  var current = null;
  var hashTimer = null;
  var userScrolled = false;
  function readingLine() { return topBar() + 64; }
  function findCurrent() {
    var line = readingLine();
    var best = places[0];
    for (var i = 0; i < places.length; i++) {
      if (places[i].el.getBoundingClientRect().top <= line) { best = places[i]; } else { break; }
    }
    /* At the very bottom the last short sections never reach the line. */
    if (window.innerHeight + window.scrollY >= doc.documentElement.scrollHeight - 4) {
      for (var j = places.length - 1; j >= 0; j--) {
        if (places[j].el.getBoundingClientRect().top < window.innerHeight * 0.6) { best = places[j]; break; }
      }
    }
    return best;
  }
  function keepInView(a) {
    /* Closed behind its button on a narrow screen: nothing to keep. */
    if (window.getComputedStyle(toc).visibility === "hidden") { return; }
    var tr = toc.getBoundingClientRect(), ar = a.getBoundingClientRect();
    if (ar.top < tr.top + 60 || ar.bottom > tr.bottom - 60) {
      toc.scrollTop += ar.top - tr.top - tr.height / 3;
    }
  }
  function show(place) {
    if (place === current) { return; }
    var oldChapter = current && current.chapter;
    if (current && current.sub) { current.link.classList.remove("current"); current.link.removeAttribute("aria-current"); }
    if (oldChapter && oldChapter !== place.chapter) { oldChapter.tocItem.classList.remove("open", "active"); }
    current = place;
    var ch = place.chapter;
    ch.tocItem.classList.add("open", "active");
    if (place.sub) { place.link.classList.add("current"); place.link.setAttribute("aria-current", "location"); }
    crumbChapter.textContent = "";
    if (ch.guideNum > 0) {
      var n = doc.createElement("span");
      n.className = "num";
      n.textContent = ch.guideNum + ". ";
      crumbChapter.appendChild(n);
    }
    crumbChapter.appendChild(doc.createTextNode(ch.guideTitle));
    crumbChapter.href = "#" + ch.id;
    crumbSection.textContent = place.sub ? place.title : "";
    crumbSep.classList.toggle("hidden", !place.sub);
    keepInView(place.sub ? place.link : ch.tocItem.firstChild);
    if (userScrolled) {
      window.clearTimeout(hashTimer);
      hashTimer = window.setTimeout(function () {
        setHash(window.scrollY < 40 ? "" : current.id);
      }, 200);
    }
  }
  function onScroll() {
    var max = doc.documentElement.scrollHeight - window.innerHeight;
    var f = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    progress.style.transform = "scaleX(" + f.toFixed(4) + ")";
    tocRead.textContent = Math.round(f * 100) + "% read";
    toTop.classList.toggle("shown", window.scrollY > 900);
    show(findCurrent());
  }
  var ticking = false;
  window.addEventListener("scroll", function () {
    if (!ticking) { ticking = true; window.requestAnimationFrame(function () { ticking = false; onScroll(); }); }
  }, { passive: true });
  ["wheel", "touchmove", "keydown"].forEach(function (t) {
    window.addEventListener(t, function () { userScrolled = true; }, { passive: true });
  });
  window.addEventListener("resize", onScroll);
  window.addEventListener("load", onScroll);
  onScroll();

  /* Landing somewhere lights its heading for a moment, so the eye finds it. */
  function landed(el) {
    var h = el && headingOf(el);
    if (!h) { return; }
    h.classList.remove("landed");
    void h.offsetWidth;
    h.classList.add("landed");
  }
  function goTo(id) {
    var el = doc.getElementById(id);
    if (!el) { return; }
    el.scrollIntoView({ block: "start" });
    landed(el);
  }
  doc.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) { return; }
    var id = decodeURIComponent(a.getAttribute("href").slice(1));
    if (!doc.getElementById(id)) { return; }
    e.preventDefault();
    if (a.classList.contains("anchor")) {
      setHash(id);
      var url = location.href;
      try {
        if (navigator.clipboard) { navigator.clipboard.writeText(url).then(function () { say("Link copied"); }, function () { say("Link in the address bar"); }); }
        else { say("Link in the address bar"); }
      } catch (err) { say("Link in the address bar"); }
      landed(doc.getElementById(id));
      return;
    }
    /* A link inside the page is a step you may want to go back from. */
    try { history.pushState(null, "", "#" + id); } catch (err) { /* refused */ }
    setToc(false);
    goTo(id);
    userScrolled = true;
    onScroll();
  });
  window.addEventListener("hashchange", function () { goTo(decodeURIComponent(location.hash.slice(1))); });
  window.addEventListener("popstate", function () {
    var id = decodeURIComponent(location.hash.slice(1));
    if (id) { goTo(id); } else { window.scrollTo(0, 0); }
  });
  if (location.hash.length > 1) {
    var start = doc.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (start) { window.requestAnimationFrame(function () { start.scrollIntoView({ block: "start" }); landed(start); onScroll(); }); }
  }

  toTop.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setHash("");
    toc.scrollTop = 0;
  });

  /* Contents on a narrow screen: a button (or the line saying where you
     are) opens it; a link, the shade, or Esc closes it. */
  var tocButton = doc.getElementById("toc-button");
  function setToc(open) {
    doc.body.classList.toggle("toc-open", open);
    tocButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && current) { keepInView(current.sub ? current.link : current.chapter.tocItem.firstChild); }
  }
  tocButton.addEventListener("click", function () { setToc(!doc.body.classList.contains("toc-open")); });
  doc.getElementById("scrim").addEventListener("click", function () { setToc(false); });
  doc.getElementById("crumb").addEventListener("click", function (e) {
    if (window.getComputedStyle(tocButton).display === "none") { return; }
    e.preventDefault();
    e.stopPropagation();
    setToc(true);
  }, true);

  /* Search. The guide is cut into places to find: each section, each
     chapter's opening words and each shortcut table. A place matches when
     every word typed is in it; the results list says where each is, with
     the words around the match. The words are marked on the page while the
     search stands, and choosing a result goes to the first mark there and
     makes it flash. */
  var units = [];
  chapters.forEach(function (chapter) {
    var intro = [];
    each(chapter.children, function (n) {
      if (n.tagName === "SECTION" || n.classList.contains("pager")) { return; }
      if (n.classList.contains("table-wrap") && n.querySelector("h3[id]")) {
        /* The shortcut tables: one place per heading. */
        var unit = null;
        each(n.children, function (k) {
          if (k.tagName === "H3" && k.id) {
            unit = { id: k.id, nodes: [k], chapter: chapter, title: titleOf(k) };
            units.push(unit);
          } else if (unit) { unit.nodes.push(k); } else { intro.push(k); }
        });
        return;
      }
      intro.push(n);
    });
    units.push({ id: chapter.id, nodes: intro, chapter: chapter, title: chapter.guideTitle, intro: true });
    each(chapter.querySelectorAll(":scope > section[id]"), function (s) {
      var h = headingOf(s);
      units.push({ id: s.id, nodes: [s], chapter: chapter, title: h ? titleOf(h) : chapter.guideTitle });
    });
  });
  var order = {};
  places.forEach(function (p, i) { order[p.id] = i; });
  units.forEach(function (u) {
    u.text = u.nodes.map(function (n) { return n.textContent; }).join(" ").replace(/\s+/g, " ").replace(/#(?=\s|$)/g, "").trim();
    u.lower = u.text.toLowerCase();
    /* The words after the heading, for the result's preview. */
    u.body = u.text.indexOf(u.title) === 0 ? u.text.slice(u.title.length).trim() : u.text;
    u.bodyLower = u.body.toLowerCase();
    u.order = order[u.id] !== undefined ? order[u.id] : 0;
  });
  units.sort(function (a, b) { return a.order - b.order || (a.intro ? -1 : 1); });

  function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function clearMarks() {
    var parents = [];
    each(main.querySelectorAll("mark.hl"), function (m) {
      var p = m.parentNode;
      p.replaceChild(doc.createTextNode(m.textContent), m);
      if (parents.indexOf(p) < 0) { parents.push(p); }
    });
    parents.forEach(function (p) { p.normalize(); });
  }
  function markWords(el, re) {
    var walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || /^(SCRIPT|STYLE|MARK|BUTTON)$/.test(p.nodeName) || p.classList.contains("anchor")) { return NodeFilter.FILTER_REJECT; }
        re.lastIndex = 0;
        return re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    var nodes = [];
    while (walker.nextNode()) { nodes.push(walker.currentNode); }
    nodes.forEach(function (node) {
      var text = node.nodeValue, frag = doc.createDocumentFragment(), last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
        var mark = doc.createElement("mark");
        mark.className = "hl";
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
      }
      frag.appendChild(doc.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }
  function snippet(u, words) {
    var text = u.body, lower = u.bodyLower, at = -1;
    words.forEach(function (w) { var i = lower.indexOf(w); if (i >= 0 && (at < 0 || i < at)) { at = i; } });
    if (at < 0) { at = 0; }
    var from = Math.max(0, at - 60), to = Math.min(text.length, at + 160);
    if (from > 0) { var sp = text.indexOf(" ", from); if (sp >= 0 && sp < at) { from = sp + 1; } }
    var piece = (from > 0 ? "… " : "") + text.slice(from, to) + (to < text.length ? " …" : "");
    return escapeHtml(piece).replace(new RegExp("(" + words.map(function (w) { return escapeRe(escapeHtml(w)); }).join("|") + ")", "gi"), "<mark>$1</mark>");
  }

  var hits = [];
  var selected = 0;
  function setResults(open) {
    results.classList.toggle("shown", open);
    input.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function select(i) {
    var items = results.querySelectorAll("a.result");
    if (!items.length) { return; }
    selected = (i + items.length) % items.length;
    each(items, function (a, k) { a.classList.toggle("selected", k === selected); a.setAttribute("aria-selected", k === selected ? "true" : "false"); });
    var a = items[selected], rr = results.getBoundingClientRect(), ar = a.getBoundingClientRect();
    if (ar.top < rr.top + 30) { results.scrollTop += ar.top - rr.top - 30; }
    else if (ar.bottom > rr.bottom - 40) { results.scrollTop += ar.bottom - rr.bottom + 40; }
  }
  function search(query) {
    clearMarks();
    each(toc.querySelectorAll("a"), function (a) { a.classList.remove("dim", "hit"); });
    each(toc.querySelectorAll("li.has-hits"), function (li) { li.classList.remove("has-hits"); });
    hits = [];
    var words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) { results.innerHTML = ""; setResults(false); return; }
    var re = new RegExp(words.map(escapeRe).join("|"), "gi");
    var inTitle = [], inText = [];
    units.forEach(function (u) {
      if (!words.every(function (w) { return u.lower.indexOf(w) >= 0; })) { return; }
      var t = u.title.toLowerCase();
      (words.every(function (w) { return t.indexOf(w) >= 0; }) ? inTitle : inText).push(u);
    });
    hits = inTitle.concat(inText);
    var hitIds = {};
    hits.forEach(function (u) {
      u.nodes.forEach(function (n) { markWords(n, re); });
      hitIds[u.id] = true;
      if (u.chapter.tocItem) { u.chapter.tocItem.classList.add("has-hits"); }
    });
    places.forEach(function (p) {
      if (hitIds[p.id]) { p.link.classList.add("hit"); }
      else if (p.sub || !p.chapter.tocItem.classList.contains("has-hits")) { p.link.classList.add("dim"); }
    });
    var html = "";
    if (hits.length) {
      html += '<div class="count">' + hits.length + (hits.length === 1 ? " place matches" : " places match") + "</div>";
      hits.forEach(function (u, i) {
        var num = u.chapter.guideNum > 0 ? "Chapter " + u.chapter.guideNum : "Start";
        var where = u.intro ? num : num + " · " + u.chapter.guideTitle;
        html += '<a class="result" role="option" href="#' + escapeHtml(u.id) + '" data-i="' + i + '">' +
          '<span class="where">' + escapeHtml(where) + "</span>" +
          '<span class="title">' + escapeHtml(u.title) + "</span>" +
          '<span class="snippet">' + snippet(u, words) + "</span></a>";
      });
      html += '<div class="keys-help"><span><kbd>↑</kbd> <kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> go there</span><span><kbd>Esc</kbd> clear</span></div>';
    } else {
      html = '<div class="empty">Nothing in the guide matches that. Try fewer or other words, such as “proxy”, “ripple” or “loudness”.</div>';
    }
    results.innerHTML = html;
    results.scrollTop = 0;
    setResults(true);
    select(0);
  }
  function jump(i) {
    var u = hits[i];
    if (!u) { return; }
    setResults(false);
    input.blur();
    var target = null;
    for (var k = 0; k < u.nodes.length && !target; k++) { target = u.nodes[k].querySelector("mark.hl"); }
    var el = target || u.nodes[0];
    /* The match a third of the way down, but its section's top above the
       reading line, so the contents and the top bar name that section. */
    var at = el.getBoundingClientRect().top + window.scrollY;
    var start = u.nodes[0].getBoundingClientRect().top + window.scrollY;
    var y = Math.max(at - window.innerHeight * 0.3, start - readingLine() + 1);
    window.scrollTo(0, Math.max(0, Math.min(y, at - topBar() - 24)));
    if (target) {
      each(main.querySelectorAll("mark.flash"), function (m) { m.classList.remove("flash"); });
      void target.offsetWidth;
      target.classList.add("flash");
    } else { landed(u.nodes[0]); }
    userScrolled = true;
    setHash(u.id);
    onScroll();
  }

  var timer = null;
  input.addEventListener("input", function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(function () { search(input.value); }, 80);
  });
  function clearSearch() {
    window.clearTimeout(timer);
    input.value = "";
    search("");
  }
  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!results.classList.contains("shown")) { search(input.value); } else { select(selected + 1); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      window.clearTimeout(timer);
      if (!results.classList.contains("shown") || !hits.length) { search(input.value); }
      jump(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (results.classList.contains("shown") && input.value) { setResults(false); }
      else { clearSearch(); input.blur(); }
    }
  });
  input.addEventListener("focus", function () { if (input.value) { search(input.value); } });
  results.addEventListener("mousedown", function (e) { e.preventDefault(); });
  results.addEventListener("click", function (e) {
    var a = e.target.closest("a.result");
    if (!a) { return; }
    e.preventDefault();
    e.stopPropagation();
    jump(Number(a.dataset.i));
  }, true);
  results.addEventListener("mousemove", function (e) {
    var a = e.target.closest("a.result");
    if (a && Number(a.dataset.i) !== selected) { select(Number(a.dataset.i)); }
  });
  input.addEventListener("blur", function () { window.setTimeout(function () { setResults(false); }, 120); });

  doc.addEventListener("keydown", function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement && doc.activeElement.tagName);
    if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); setToc(false); input.focus(); input.select();
    } else if (e.key === "/" && !typing) {
      e.preventDefault(); setToc(false); input.focus(); input.select();
    } else if (e.key === "Escape") {
      if (lightbox.classList.contains("open")) { closeLightbox(); }
      else if (doc.body.classList.contains("toc-open")) { setToc(false); }
      else if (!typing && input.value) { clearSearch(); }
    }
  });

  /* Pictures: click to see them large, with their caption. */
  var lightbox = doc.getElementById("lightbox");
  var big = lightbox.querySelector("img");
  var bigCaption = lightbox.querySelector("p");
  var closeButton = lightbox.querySelector("button");
  var opener = null;
  function closeLightbox() {
    lightbox.classList.remove("open");
    lightbox.setAttribute("aria-hidden", "true");
    big.removeAttribute("src");
    if (opener) { opener.focus({ preventScroll: true }); opener = null; }
  }
  each(main.querySelectorAll("figure img"), function (img) {
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.title = "Click to see it large";
  });
  function openLightbox(img) {
    opener = img;
    big.src = img.currentSrc || img.src;
    big.alt = img.alt;
    var cap = img.closest("figure").querySelector("figcaption");
    bigCaption.textContent = cap ? cap.textContent : img.alt;
    lightbox.classList.add("open");
    lightbox.setAttribute("aria-hidden", "false");
    closeButton.focus({ preventScroll: true });
  }
  main.addEventListener("click", function (e) {
    if (e.target.tagName === "IMG" && e.target.closest("figure")) { openLightbox(e.target); }
  });
  main.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.tagName === "IMG" && e.target.closest("figure")) { e.preventDefault(); openLightbox(e.target); }
  });
  lightbox.addEventListener("click", closeLightbox);
  /* Code blocks get a Copy button. Added last, so search never finds the word "Copy". */
  each(main.querySelectorAll("pre.code"), function (pre) {
    var b = doc.createElement("button");
    b.type = "button";
    b.className = "copy";
    b.textContent = "Copy";
    b.setAttribute("aria-label", "Copy this code");
    b.addEventListener("click", function () {
      var text = pre.querySelector("code").textContent;
      function done() { b.textContent = "Copied"; window.setTimeout(function () { b.textContent = "Copy"; }, 1400); }
      function fallback() {
        var t = doc.createElement("textarea");
        t.value = text;
        t.style.position = "fixed"; t.style.opacity = "0";
        doc.body.appendChild(t);
        t.select();
        try { doc.execCommand("copy"); done(); } catch (e) { say("Select the code and press Ctrl+C"); }
        t.remove();
      }
      try {
        if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, fallback); } else { fallback(); }
      } catch (e) { fallback(); }
    });
    pre.appendChild(b);
  });
}());
