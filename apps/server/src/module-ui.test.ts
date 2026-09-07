import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SentrelloEnv,
  type SentrelloModule,
  defineModule,
} from "@sentrello/module-sdk";
import { Hono } from "hono";
import { serveModuleUi } from "./module-ui";

const dir = await mkdtemp(join(tmpdir(), "sentrello-ui-"));
const script = join(dir, "index.js");
await writeFile(script, "window.__sentrello.screens.demo = () => null;\n");

const withUi = (id: string, ui?: string): SentrelloModule =>
  defineModule({ id, tier: "module", ui, register: () => {} });

function mount(modules: SentrelloModule[], loaded: string[]) {
  const app = new Hono<SentrelloEnv>();
  const ids = serveModuleUi(app, modules, loaded);
  return { app, ids };
}

test("a loaded module's script is served as JavaScript", async () => {
  const { app, ids } = mount([withUi("demo", script)], ["demo"]);
  expect(ids).toEqual(["demo"]);

  const res = await app.request("http://localhost/modules/demo/ui.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/javascript");
  expect(await res.text()).toContain("screens.demo");
});

test("a module that did not load is not served", async () => {
  // The licence decides. Withholding the file matters more than hiding the
  // nav entry: the nav is only a suggestion the browser can ignore.
  const { app, ids } = mount([withUi("demo", script)], []);
  expect(ids).toEqual([]);
  expect(
    (await app.request("http://localhost/modules/demo/ui.js")).status,
  ).toBe(404);
});

test("a module with no screens is not advertised", async () => {
  const { app, ids } = mount([withUi("headless")], ["headless"]);
  expect(ids).toEqual([]);
  expect(
    (await app.request("http://localhost/modules/headless/ui.js")).status,
  ).toBe(404);
});

test("a declared file that is missing is a 404, not a crash", async () => {
  // A bundle can be unpacked without its script — an older release, or a
  // partial download. The instance must stay up.
  const { app } = mount(
    [withUi("demo", join(dir, "does-not-exist.js"))],
    ["demo"],
  );
  expect(
    (await app.request("http://localhost/modules/demo/ui.js")).status,
  ).toBe(404);
});

test("the id cannot be used to reach another file", async () => {
  const { app } = mount([withUi("demo", script)], ["demo"]);
  for (const id of [
    "../../../etc/passwd",
    "..%2f..%2fpackage.json",
    "demo/../../secrets",
  ]) {
    const res = await app.request(
      `http://localhost/modules/${encodeURIComponent(id)}/ui.js`,
    );
    expect(res.status).toBe(404);
  }
});
