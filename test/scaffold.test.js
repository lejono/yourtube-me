import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dataDir = join(root, "data");

const DATA_FILES = {
  "config.json": {},
  "channels.json": [],
  "videos.json": {},
  "history.json": [],
  "blocked.json": { channels: [], videos: [] },
  "ai-cache.json": {},
  "upnext-cache.json": {},
  "profile.json": {},
  "tokens.json": {},
  "sessions.json": {},
};

describe("project scaffold", () => {
  before(async () => {
    // Ensure data dir exists — other test suites may have cleaned it up
    await mkdir(dataDir, { recursive: true });
    for (const [file, expected] of Object.entries(DATA_FILES)) {
      const filePath = join(dataDir, file);
      try { await stat(filePath); } catch {
        await writeFile(filePath, JSON.stringify(expected));
      }
    }
  });

  it("data/ directory exists", async () => {
    const s = await stat(dataDir);
    assert.ok(s.isDirectory());
  });

  for (const [file, expected] of Object.entries(DATA_FILES)) {
    it(`data/${file} exists and parses as valid JSON`, async () => {
      const filePath = join(dataDir, file);
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      assert.deepEqual(parsed, expected);
    });
  }

  it(".gitignore exists and covers node_modules and tokens", async () => {
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.ok(gitignore.includes("node_modules/"));
    assert.ok(gitignore.includes("data/tokens.json"));
  });

  for (const dir of ["lib", "public/css", "public/js", "test"]) {
    it(`${dir}/ directory exists`, async () => {
      const s = await stat(join(root, dir));
      assert.ok(s.isDirectory());
    });
  }

  it("package.json has type: module", async () => {
    const raw = await readFile(join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    assert.equal(pkg.type, "module");
    assert.equal(pkg.name, "yourtube");
    assert.equal(pkg.version, "0.1.0");
  });
});
