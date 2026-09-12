import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pluginName = "codex-claude-code-bridge";

async function fixture(context, aliasedHome = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-marketplace-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "profile");
  const scripts = path.join(home, "plugins", pluginName, "scripts");
  const marketplacePath = path.join(home, ".agents", "plugins", "marketplace.json");
  await mkdir(scripts, { recursive: true });
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  const effectiveHome = aliasedHome ? path.join(root, "profile-alias") : home;
  if (aliasedHome) await symlink(home, effectiveHome, process.platform === "win32" ? "junction" : "dir");
  for (const name of ["register", "unregister"]) {
    await copyFile(new URL(`../scripts/${name}-personal-marketplace.mjs`, import.meta.url),
      path.join(scripts, `${name}-personal-marketplace.mjs`));
  }
  return {
    marketplacePath,
    run: (name, ...args) => execFileAsync(process.execPath,
      [path.join(scripts, `${name}-personal-marketplace.mjs`), ...args],
      { env: { ...process.env, HOME: effectiveHome, USERPROFILE: effectiveHome }, windowsHide: true }),
  };
}

test("registration and removal preserve other marketplace entries and UTF-8 metadata", async (context) => {
  const { marketplacePath, run } = await fixture(context);
  const other = { name: "other", source: { source: "local", path: "./plugins/other" } };
  const original = { name: "personal_test", interface: { displayName: "我的插件" }, plugins: [other] };
  await writeFile(marketplacePath, JSON.stringify(original), "utf8");
  await run("register");
  await run("register");
  const registered = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(registered.name, original.name);
  assert.deepEqual(registered.interface, original.interface);
  assert.deepEqual(registered.plugins[0], other);
  assert.equal(registered.plugins.length, 2);
  assert.equal(registered.plugins[1].name, pluginName);
  assert.equal(registered.plugins[1].source.path, `./plugins/${pluginName}`);
  await assert.rejects(run("unregister"), (error) => error.code === 2);
  assert.deepEqual(JSON.parse(await readFile(marketplacePath, "utf8")), registered);
  await run("unregister", "--yes");
  assert.deepEqual(JSON.parse(await readFile(marketplacePath, "utf8")), original);
  assert.deepEqual(JSON.parse(await readFile(`${marketplacePath}.codex-claude-code-bridge.bak`, "utf8")), registered);
  await run("unregister", "--yes");
  assert.deepEqual(JSON.parse(await readFile(marketplacePath, "utf8")), original);
});

test("registration creates a personal marketplace when none exists", async (context) => {
  const { marketplacePath, run } = await fixture(context);
  await run("register");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(marketplace.name, "personal");
  assert.deepEqual(marketplace.plugins[0].policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
});

test("registration accepts the expected repository through a home-directory alias", async (context) => {
  const { marketplacePath, run } = await fixture(context, true);
  await run("register");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(marketplace.plugins[0].name, pluginName);
  await run("unregister", "--yes");
  assert.deepEqual(JSON.parse(await readFile(marketplacePath, "utf8")).plugins, []);
});

test("marketplace scripts reject malformed JSON and invalid identifiers without changing the file", async (context) => {
  const { marketplacePath, run } = await fixture(context);
  for (const text of ["{broken", JSON.stringify({ name: "bad@market", plugins: [{ name: pluginName }] })]) {
    await writeFile(marketplacePath, text, "utf8");
    for (const [name, args] of [["register", []], ["unregister", ["--yes"]]]) {
      await assert.rejects(run(name, ...args), (error) => error.code === 1);
      assert.equal(await readFile(marketplacePath, "utf8"), text);
    }
  }
});
