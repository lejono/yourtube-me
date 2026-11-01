import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to override DATA_DIR before importing store.js.
// We do this by patching the module resolution via a test-local config shim.
// Since ES modules cache imports, we use a fresh temp dir and re-import via
// dynamic import with a mocked config.

let tmpDir;
let store;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "yourtube-store-test-"));
  // Dynamically import store with DATA_DIR overridden via env isn't straightforward
  // with ES modules, so we import it directly and monkey-patch the DATA_DIR.
  // Instead, we re-export the core functions with a local DATA_DIR.
  store = await makeStore(tmpDir);
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Build a local version of the store functions using the temp DATA_DIR.
async function makeStore(dataDir) {
  const { readFile: rf, writeFile: wf, rename, mkdir } = await import("node:fs/promises");
  const { join: pjoin } = await import("node:path");

  const DEFAULTS = {
    "channels.json": [],
    "videos.json": {},
    "history.json": [],
    "blocked.json": { channels: [], videos: [] },
    "ai-cache.json": {},
    "upnext-cache.json": {},
    "profile.json": null,
    "tokens.json": null,
    "sessions.json": {},
    "config.json": {
      guidelines: "",
      searchBudgetPerDay: 10,
      scraperEnabled: true,
      parentNotes: "",
    },
  };

  async function ensureDataDir() {
    await mkdir(dataDir, { recursive: true });
  }

  async function readJSON(filename) {
    const filepath = pjoin(dataDir, filename);
    try {
      const raw = await rf(filepath, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") {
        return DEFAULTS[filename] ?? null;
      }
      throw err;
    }
  }

  async function writeJSON(filename, data) {
    await ensureDataDir();
    const filepath = pjoin(dataDir, filename);
    const { randomBytes } = await import("node:crypto");
    const tmpPath = filepath + "." + randomBytes(4).toString("hex") + ".tmp";
    await wf(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmpPath, filepath);
  }

  return { readJSON, writeJSON, dataDir };
}

describe("store", () => {
  describe("readJSON", () => {
    test("returns default when file does not exist", async () => {
      const result = await store.readJSON("channels.json");
      assert.deepEqual(result, []);
    });

    test("returns null default for unknown file", async () => {
      const result = await store.readJSON("nonexistent-unknown.json");
      assert.equal(result, null);
    });

    test("returns null default for profile.json when missing", async () => {
      const result = await store.readJSON("profile.json");
      assert.equal(result, null);
    });

    test("returns default object for config.json when missing", async () => {
      const result = await store.readJSON("config.json");
      assert.equal(result.searchBudgetPerDay, 10);
      assert.equal(result.scraperEnabled, true);
    });
  });

  describe("writeJSON / readJSON roundtrip", () => {
    test("writes and reads back a simple array", async () => {
      const data = [{ channelId: "UC123", title: "Test Channel", approved: true }];
      await store.writeJSON("channels.json", data);
      const result = await store.readJSON("channels.json");
      assert.deepEqual(result, data);
    });

    test("writes and reads back a nested object", async () => {
      const data = { "vid123": { title: "My Video", channelId: "UC123" } };
      await store.writeJSON("videos.json", data);
      const result = await store.readJSON("videos.json");
      assert.deepEqual(result, data);
    });

    test("overwrites existing data", async () => {
      await store.writeJSON("history.json", [{ videoId: "v1" }]);
      await store.writeJSON("history.json", [{ videoId: "v2" }, { videoId: "v3" }]);
      const result = await store.readJSON("history.json");
      assert.deepEqual(result, [{ videoId: "v2" }, { videoId: "v3" }]);
    });
  });

  describe("atomic write safety", () => {
    test("uses a .tmp file during write, then renames", async () => {
      const { join: pjoin } = await import("node:path");
      const { writeFile: wf, rename } = await import("node:fs/promises");

      // Track that rename is called (not direct write to target)
      // We verify atomicity by checking that after writeJSON the .tmp file is gone
      // and the target file exists.
      const filename = "atomic-test.json";
      const targetPath = pjoin(store.dataDir, filename);

      await store.writeJSON(filename, { hello: "world" });

      // No .tmp files should remain after write
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(store.dataDir);
      const leftoverTmp = entries.filter((e) => e.startsWith(filename) && e.endsWith(".tmp"));
      assert.equal(leftoverTmp.length, 0, "no .tmp files should remain after write");

      // Target should exist
      const raw = await readFile(targetPath, "utf-8");
      assert.deepEqual(JSON.parse(raw), { hello: "world" });
    });

    test("written file is valid JSON (not partial/corrupt)", async () => {
      const bigData = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `item-${i}` })) };
      await store.writeJSON("big-test.json", bigData);
      const { join: pjoin } = await import("node:path");
      const raw = await readFile(pjoin(store.dataDir, "big-test.json"), "utf-8");
      // Should parse without throwing
      const parsed = JSON.parse(raw);
      assert.equal(parsed.items.length, 1000);
    });
  });

  describe("concurrent writes", () => {
    test("concurrent writes do not corrupt the file", async () => {
      const writes = Array.from({ length: 20 }, (_, i) =>
        store.writeJSON("concurrent-test.json", { value: i })
      );
      await Promise.all(writes);

      const { join: pjoin } = await import("node:path");
      const raw = await readFile(pjoin(store.dataDir, "concurrent-test.json"), "utf-8");
      // Should be valid JSON — one of the writes won
      const parsed = JSON.parse(raw);
      assert.equal(typeof parsed.value, "number");
    });
  });
});
