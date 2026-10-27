// .NET SDKs, runtimes, workloads and global.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSdks, parseRuntimes, parseWorkloads, sdkMeets, globalJsonProblem } from "../src/dotnetsdk.js";

test("SDK and runtime lists", () => {
  assert.deepEqual(parseSdks("8.0.404 [C:\\Program Files\\dotnet\\sdk]\r\n10.0.100-rc.2.25502.107 [C:\\Program Files\\dotnet\\sdk]\r\n"), ["8.0.404", "10.0.100-rc.2.25502.107"]);
  assert.deepEqual(parseRuntimes("Microsoft.AspNetCore.App 8.0.32 [/usr/lib/dotnet/shared/Microsoft.AspNetCore.App]\nMicrosoft.NETCore.App 8.0.32 [/x]\nMicrosoft.NETCore.App 10.0.0 [/x]\n"),
    [{ name: "Microsoft.AspNetCore.App", versions: ["8.0.32"] }, { name: "Microsoft.NETCore.App", versions: ["8.0.32", "10.0.0"] }]);
});

test("workloads", () => {
  const out = "\nInstalled Workload Id      Manifest Version      Installation Source\n--------------------------------------------------------------------\nmaui-windows               9.0.14/9.0.100        SDK 9.0.100\nwasm-tools                 9.0.3/9.0.100         SDK 9.0.100\n\nUse `dotnet workload search` to find additional workloads to install.\n";
  assert.deepEqual(parseWorkloads(out), ["maui-windows", "wasm-tools"]);
  assert.deepEqual(parseWorkloads("Installed Workload Id      Manifest Version      Installation Source\n--------------------------------------------------------------------\n\nUse `dotnet workload search`"), []);
});

test("global.json roll-forward rules", () => {
  const have = ["8.0.404", "9.0.100"];
  assert.equal(sdkMeets("8.0.400", undefined, have), true); // latestPatch: same 8.0.4xx band
  assert.equal(sdkMeets("8.0.405", undefined, have), false);
  assert.equal(sdkMeets("8.0.300", "latestPatch", have), false); // a different feature band
  assert.equal(sdkMeets("8.0.300", "latestFeature", have), true);
  assert.equal(sdkMeets("8.0.100", "latestMinor", ["8.1.100"]), true);
  assert.equal(sdkMeets("8.0.100", "latestMinor", ["9.0.100"]), false);
  assert.equal(sdkMeets("8.0.100", "latestMajor", ["9.0.100"]), true);
  assert.equal(sdkMeets("8.0.404", "disable", have), true);
  assert.equal(sdkMeets("8.0.403", "disable", have), false);
  assert.equal(sdkMeets("10.0.100", "latestFeature", ["10.0.100-rc.1"]), false); // previews only when allowed
});

test("global.json problems", () => {
  assert.equal(globalJsonProblem('{ "sdk": { "version": "8.0.400" } }', ["8.0.404"]), null);
  assert.equal(globalJsonProblem('{ "msbuild-sdks": {} }', []), null);
  const p = globalJsonProblem('{\n  // pinned\n  "sdk": { "version": "9.0.200", "rollForward": "latestPatch", },\n}', ["8.0.404"]);
  assert.equal(p.major, 9);
  assert.match(p.message, /9\.0\.200.*8\.0\.404/);
});
