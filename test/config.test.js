import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("config.js", () => {
  it("imports without error and exports expected keys", async () => {
    const config = await import("../config.js");

    assert.equal(typeof config.PORT, "number");
    assert.equal(typeof config.HOST, "string");
    assert.equal(typeof config.DATA_DIR, "string");
    assert.equal(typeof config.SESSION_SECRET, "string");
    assert.equal(typeof config.PARENT_PASSWORD, "string");
    assert.equal(typeof config.YOUTUBE_CLIENT_ID, "string");
    assert.equal(typeof config.YOUTUBE_CLIENT_SECRET, "string");
    assert.equal(typeof config.SCRAPER_ENABLED, "boolean");
    assert.equal(typeof config.SEARCH_BUDGET_PER_DAY, "number");
  });

  it("has correct defaults", async () => {
    const config = await import("../config.js");

    assert.equal(config.PORT, 3457);
    assert.equal(config.HOST, "0.0.0.0");
    assert.ok(config.DATA_DIR.endsWith("data"));
    assert.equal(config.PARENT_PASSWORD, "changeme");
    assert.equal(config.SCRAPER_ENABLED, false);
    assert.equal(config.SEARCH_BUDGET_PER_DAY, 10);
    assert.ok(config.SESSION_SECRET.length > 0);
  });
});
