import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("npm build produces compiled prompts that load independently of the source tree", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "holly-build-assets-"));
  const root = process.cwd();
  try {
    for (const name of ["package.json", "tsconfig.json", "prompt-text.ts"]) {
      await cp(join(root, name), join(fixture, name));
    }
    await cp(join(root, "scripts"), join(fixture, "scripts"), { recursive: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "junction");
    await mkdir(join(fixture, "prompts"));
    await writeFile(join(fixture, "prompts", "smoke.md"), "Compiled prompt fixture\n");

    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: fixture,
      timeout: 30_000,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    await rm(join(fixture, "prompts"), { recursive: true });
    const compiled = await import(pathToFileURL(join(fixture, "dist", "prompt-text.js")).href);
    assert.equal(compiled.loadPromptText("smoke"), "Compiled prompt fixture");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
