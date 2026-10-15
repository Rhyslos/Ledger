// Tells you when a newer Ledger is out. Every build on GitHub is published as a
// release tagged v<version>; on start Ledger asks the repo for its tags with
// your own git sign-in (the repo is private), and if one is newer than this
// copy, an "Update" button appears in the status bar that opens the download
// page. Installing the new setup over this one keeps your settings.
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { winLabel } from "./win.js";
import { REPO_URL } from "./app.js";

const parse = (v) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

export function initUpdate(app) {
  const btn = app.$("stUpdate");
  const page = () => openUrl(`${REPO_URL}/releases/latest`).catch(() => app.toast("Couldn't open the browser."));
  btn.onclick = page;

  // { latest, current } or throws with a message you can act on.
  async function check() {
    const current = await getVersion();
    const exe = await app.invoke("exe_path");
    const cwd = exe.replace(/[\\/][^\\/]*$/, "") || ".";
    // credential.interactive=false: never pop a sign-in window; fail quietly instead.
    const r = await app.invoke("git", { cwd, args: ["-c", "credential.interactive=false", "ls-remote", "--tags", "--refs", REPO_URL] });
    if (r.code !== 0) throw new Error("Couldn't reach the Ledger repo on GitHub. Git needs to be signed in to GitHub on this PC (cloning or pushing any of your private repos once does that).");
    const tags = [...r.out.matchAll(/refs\/tags\/(v\d+(?:\.\d+)*)$/gm)].map((m) => m[1]);
    const latest = tags.reduce((best, t) => (!best || newer(t, best) ? t : best), null);
    return { current, latest: latest?.replace(/^v/, "") ?? null };
  }

  function show(latest) {
    btn.hidden = false;
    btn.textContent = `Update ${latest}`;
    btn.title = `Ledger ${latest} is out. Click to open the download page, then run the setup over this one.`;
  }

  app.command("app.update", "Check for updates", [], async () => {
    app.toast("Checking for updates…");
    try {
      const { current, latest } = await check();
      if (latest && newer(latest, current)) { show(latest); app.toast(`Ledger ${latest} is out. Opening the download page.`, 4000); page(); }
      else app.toast(`Ledger ${current} is the newest version.`);
    } catch (e) { app.toast(String(e.message || e), 7000); }
  });

  // One quiet check per start, from the first window only, once things have settled.
  if (winLabel === "main") setTimeout(() => {
    check().then(({ current, latest }) => { if (latest && newer(latest, current)) { show(latest); app.toast(`Ledger ${latest} is out. Click Update in the status bar.`, 5000); } }).catch(() => {});
  }, 4000);
}
