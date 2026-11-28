import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_FILES } from "../scripts/install.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("agy-dart ships zero custom agents/*.md files to prevent #1890 4x quota billing", () => {
  assert.equal(
    RUNTIME_FILES.some((rel) => rel.startsWith("agents/")),
    false,
    "RUNTIME_FILES must not include any agents/* entries"
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "package-manifest.json"), "utf8"));
  assert.equal(
    manifest.runtimeFiles.some((rel) => rel.startsWith("agents/")),
    false,
    "package-manifest.json runtimeFiles must not include agents/*"
  );
  assert.equal(
    manifest.runtimeAssets.some((rel) => rel.startsWith("agents/")),
    false,
    "package-manifest.json runtimeAssets must not include agents/*"
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    (pkg.files || []).some((entry) => entry === "agents/" || entry === "agents" || entry.startsWith("agents/")),
    false,
    "package.json files must not package agents/"
  );

  assert.equal(fs.existsSync(path.join(ROOT, "agents")), false, "agents/ directory must be removed from repo");
});
