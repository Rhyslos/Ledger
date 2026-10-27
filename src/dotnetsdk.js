// The .NET SDKs, runtimes and workloads on this computer, and whether a project's global.json can
// be met by them.

/** `dotnet --list-sdks` → ["8.0.404", "10.0.100", …]. */
export function parseSdks(out) {
  return String(out || "").split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter((v) => /^\d+\.\d+\.\d+/.test(v));
}

/** `dotnet --list-runtimes` → [{ name: "Microsoft.NETCore.App", versions: ["8.0.11", …] }, …]. */
export function parseRuntimes(out) {
  const by = new Map();
  for (const l of String(out || "").split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(\d+\.\d+\.\d+\S*)/.exec(l);
    if (!m) continue;
    if (!by.has(m[1])) by.set(m[1], []);
    by.get(m[1]).push(m[2]);
  }
  return [...by].map(([name, versions]) => ({ name, versions }));
}

/** `dotnet workload list` → installed workload ids. */
export function parseWorkloads(out) {
  const lines = String(out || "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^-{5,}/.test(l.trim()));
  if (start < 0) return [];
  const ids = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || /^-{5,}/.test(l.trim()) || /^Use `dotnet workload/i.test(l.trim())) break;
    ids.push(l.trim().split(/\s+/)[0]);
  }
  return ids;
}

// 8.0.204 → [8, 0, 2 (the feature band, 2xx), 4 (the patch)]
const parts = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  if (!m) return null;
  return [+m[1], +m[2], Math.floor(+m[3] / 100), +m[3] % 100];
};
const cmp = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const pre = (v) => /-/.test(v);

/**
 * Whether an installed SDK meets global.json's sdk.version with its rollForward rule (the SDK's
 * own rules: latestPatch by default when a version is given).
 */
export function sdkMeets(pinned, rollForward, installed, allowPrerelease = false) {
  const want = parts(pinned);
  if (!want) return true;
  const rule = (rollForward || "latestPatch").replace(/^latest/, "").toLowerCase();
  return installed.some((v) => {
    const have = parts(v);
    if (!have || (pre(v) && !allowPrerelease && !pre(pinned))) return false;
    if (rule === "disable") return String(v) === String(pinned);
    if (cmp(have, want) < 0) return false;
    if (rule === "patch") return have[0] === want[0] && have[1] === want[1] && have[2] === want[2];
    if (rule === "feature") return have[0] === want[0] && have[1] === want[1];
    if (rule === "minor") return have[0] === want[0];
    return true; // major
  });
}

/**
 * global.json's text and the installed SDKs → null when fine, or { version, major, message }
 * when no installed SDK will do.
 */
export function globalJsonProblem(text, installed) {
  let j;
  try { j = JSON.parse(String(text).replace(/^﻿/, "").replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || "").replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
  const sdk = j?.sdk;
  if (!sdk?.version) return null;
  if (sdkMeets(sdk.version, sdk.rollForward, installed, !!sdk.allowPrerelease)) return null;
  const major = parseInt(sdk.version, 10);
  return {
    version: sdk.version, major,
    message: `global.json asks for the .NET SDK ${sdk.version}${sdk.rollForward ? ` (rollForward: ${sdk.rollForward})` : ""}, and ${installed.length ? `the SDKs installed (${installed.join(", ")}) don't match` : "no .NET SDK is installed"}. dotnet commands will fail until it's installed.`,
  };
}
