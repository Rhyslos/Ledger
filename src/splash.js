// The update check before Ledger opens (splash.rs makes this window). The main window loads
// hidden meanwhile; splash_done shows it. An update is only installed when you say so.
import "./splash.css";
import icon from "../src-tauri/icons/128x128.png";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const $ = (id) => document.getElementById(id);
const CHECK_MS = 8000; // offline or slow: open Ledger rather than keep you waiting

// Ledger's theme from settings.json, so the splash matches the window that follows.
async function theme() {
  try {
    const s = JSON.parse((await invoke("settings_read")) || "{}");
    if (s.theme === "light" || s.theme === "dark") document.documentElement.dataset.theme = s.theme;
  } catch {}
}

const status = (t) => { $("status").textContent = t; };
let leaving = false;
const done = () => { if (!leaving) { leaving = true; invoke("splash_done"); } };

/** "1.2 MB" */
const mb = (n) => (n / 1e6).toFixed(1) + " MB";

async function install(u) {
  $("actions").hidden = true;
  $("notes").hidden = true;
  $("bar").hidden = false;
  let total = 0, got = 0;
  status(`Downloading Ledger ${u.version}…`);
  try {
    await u.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength || 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        if (total) { $("fill").style.width = Math.min(100, (got / total) * 100) + "%"; status(`Downloading Ledger ${u.version}… ${mb(got)} of ${mb(total)}`); }
      } else if (e.event === "Finished") { $("fill").style.width = "100%"; status(`Installing Ledger ${u.version}…`); }
    });
    // On Windows the installer closes Ledger and starts the new one itself; elsewhere, restart.
    status("Starting the new Ledger…");
    await relaunch();
  } catch (e) {
    $("bar").hidden = true;
    status("The update didn't install, so nothing has changed. " + String(e).replace(/^\w/, (c) => c.toUpperCase()) + ".");
    $("update").textContent = "Try again";
    $("later").textContent = "Open Ledger";
    $("actions").hidden = false;
    $("later").focus();
  }
}

async function main() {
  $("icon").src = icon;
  await theme();
  invoke("splash_ready");
  try { $("ver").textContent = "Version " + (await getVersion()); } catch {}
  let u = null;
  try {
    u = await Promise.race([check({ timeout: CHECK_MS }), new Promise((r) => setTimeout(() => r(null), CHECK_MS + 500))]);
  } catch { u = null; } // offline, or GitHub didn't answer: no reason to hold Ledger back
  if (!u) { done(); return; }
  status(`Ledger ${u.version} is ready to install.`);
  const notes = (u.body || "").split("\n").map((l) => l.trim()).find(Boolean);
  if (notes) { $("notes").textContent = notes; $("notes").hidden = false; }
  $("actions").hidden = false;
  $("update").onclick = () => install(u);
  $("later").onclick = done;
  $("update").focus();
  document.addEventListener("keydown", (e) => {
    if ($("actions").hidden) return;
    if (e.key === "Escape") { e.preventDefault(); done(); }
  });
}

main().catch(done);
