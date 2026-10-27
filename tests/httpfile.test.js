// .http request files and coverage reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHttpFile, expand, readEnvFile } from "../src/httpfile.js";
import { parseCobertura, coveredPercent } from "../src/coverage.js";

const FILE = `@host = https://localhost:5001
@api = {{host}}/api

# @name list
GET {{api}}/todos
Accept: application/json

###
// a comment
POST {{api}}/todos HTTP/1.1
Content-Type: application/json

{
  "title": "Write it"
}

###
https://example.com/plain
  ?page=2
`;

test(".http files: variables, requests, headers and bodies", () => {
  const { vars, requests } = parseHttpFile(FILE);
  assert.deepEqual(vars, { host: "https://localhost:5001", api: "{{host}}/api" });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((r) => [r.line, r.method, r.name]), [[4, "GET", "list"], [9, "POST", null], [17, "GET", null]]);
  assert.deepEqual(requests[0].headers, [["Accept", "application/json"]]);
  assert.equal(requests[0].body, "");
  assert.equal(requests[1].body, '{\n  "title": "Write it"\n}');
  assert.equal(requests[2].url, "https://example.com/plain?page=2");
  assert.equal(expand(requests[1].url, vars), "https://localhost:5001/api/todos");
});

test(".http: ### names a request, and URLs can hold {{$randomInt 1 2}}", () => {
  const { requests } = parseHttpFile("### list todos\nGET {{host}}/todos?x={{$randomInt 1 2}} HTTP/1.1\n\n###\nnot a request line\n");
  assert.deepEqual(requests.map((r) => [r.name, r.method, r.url]), [["list todos", "GET", "{{host}}/todos?x={{$randomInt 1 2}}"]]);
});

test(".http variables: environments, nesting and dynamic values", () => {
  const env = readEnvFile('{ "$shared": { "ver": "v1" }, "dev": { "host": "https://localhost:7001" }, "prod": { "host": "https://api.example.com", "ver": "v2" } }');
  assert.deepEqual(env.names, ["dev", "prod"]);
  assert.equal(expand("{{host}}/{{ver}}", {}, env.vars("dev")), "https://localhost:7001/v1");
  assert.equal(expand("{{host}}/{{ver}}", {}, env.vars("prod")), "https://api.example.com/v2");
  assert.equal(expand("{{missing}}", {}, {}), "{{missing}}");
  assert.match(expand("{{$guid}}", {}), /^[0-9a-f-]{36}$/);
  assert.match(expand("{{$randomInt 5 6}}", {}), /^5$/);
  assert.equal(expand("{{a}}", { a: "{{a}}" }), "{{a}}"); // no endless loop
});

test("Cobertura coverage: lines that ran and lines that didn't", () => {
  const xml = `<?xml version="1.0"?><coverage line-rate="0.5"><sources><source>C:\\src\\App\\</source></sources><packages><package name="App"><classes>
    <class name="App.Calc" filename="Calc.cs"><methods><method name="Add"><lines><line number="5" hits="3" /></lines></method></methods>
      <lines><line number="5" hits="3" branch="False" /><line number="6" hits="0" /><line number="9" hits="0" /></lines></class>
    <class name="App.Calc+Inner" filename="Calc.cs"><lines><line number="9" hits="1" /></lines></class>
    <class name="App.Other" filename="C:\\elsewhere\\Other.cs"><lines><line number="1" hits="0" /></lines></class>
  </classes></package></packages></coverage>`;
  const cov = parseCobertura(xml);
  assert.deepEqual([...cov.keys()], ["C:/src/App/Calc.cs", "C:/elsewhere/Other.cs"]);
  const c = cov.get("C:/src/App/Calc.cs");
  assert.deepEqual([...c.hit].sort(), [5, 9]);
  assert.deepEqual([...c.miss], [6]);
  assert.equal(coveredPercent(cov), 50);
});
