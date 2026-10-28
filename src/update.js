// Updates: on start, Ledger asks GitHub Releases for latest.json. A newer
// version downloads in the background; then "Restart to update" appears in
// the status bar. Releases are signed, so only builds from the Ledger
// workflow are accepted.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

let ready = null; // a downloaded update waiting for a restart

export function initUpdate({ $, toast, settings, beforeInstall, isMain, aborted }) {
  const btn = $("stUpdate");
  btn.onclick = () => restart();

  async function restart() {
    if (!ready) return;
    if (!(await beforeInstall())) return; // unsaved work the user wants to keep
    try {
      await ready.install();
      await relaunch();
    } catch (e) { aborted?.(); toast("The update couldn't be installed: " + e, 6000); }
  }

  // Returns what happened, for `ledger self-update` to print.
  async function run(manual) {
    if (ready) { if (manual) restart(); return `Ledger ${ready.version} is downloaded: restarting to install it.`; }
    try {
      const u = await check();
      if (!u) { const m = `You have the newest Ledger (${await getVersion()}).`; if (manual) toast(m); return m; }
      if (manual) toast(`Downloading Ledger ${u.version}…`);
      await u.download();
      ready = u;
      btn.textContent = `Restart to update (${u.version})`;
      btn.hidden = false;
      if (manual) restart();
      return `Ledger ${u.version} is downloaded. Ledger asks about unsaved work, then restarts to install it.`;
    } catch (e) {
      if (manual) toast("Couldn't check for updates: " + e, 6000);
      throw "Couldn't check for updates: " + e;
    }
  }

  // Only one window checks, and not in development builds.
  if (isMain && settings.autoUpdate && !import.meta.env.DEV) setTimeout(() => run(false), 5000);
  return { check: () => run(true) };
}
