import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = parseInt(process.env.YOURTUBE_PORT || "3457");
export const HOST = process.env.YOURTUBE_HOST || "0.0.0.0";
export const DATA_DIR = join(__dirname, process.env.YOURTUBE_DATA_DIR || "data");

// Session secret — generate a random one if not provided, but warn
const envSecret = process.env.YOURTUBE_SESSION_SECRET;
if (!envSecret) {
  console.warn("WARNING: YOURTUBE_SESSION_SECRET not set — using random secret (sessions won't survive restarts)");
}
export const SESSION_SECRET = envSecret || randomBytes(32).toString("hex");

// Parent password — warn loudly if using default
const envPassword = process.env.YOURTUBE_PARENT_PASSWORD;
if (!envPassword) {
  console.warn("");
  console.warn("  ╔══════════════════════════════════════════════════════════════╗");
  console.warn("  ║  WARNING: YOURTUBE_PARENT_PASSWORD is not set.              ║");
  console.warn("  ║  Using the default password 'changeme'.                     ║");
  console.warn("  ║  Set YOURTUBE_PARENT_PASSWORD in your .env file before use. ║");
  console.warn("  ╚══════════════════════════════════════════════════════════════╝");
  console.warn("");
}
export const PARENT_PASSWORD = envPassword || "changeme";
// Alias used by auth module
export const ADMIN_PASSWORD = PARENT_PASSWORD;

// Kid password — defaults to parent password if not set
export const KID_PASSWORD = process.env.YOURTUBE_KID_PASSWORD || PARENT_PASSWORD;

// YouTube API credentials (optional — only needed for OAuth import)
export const YOUTUBE_CLIENT_ID = process.env.YOURTUBE_YOUTUBE_CLIENT_ID || "";
export const YOUTUBE_CLIENT_SECRET = process.env.YOURTUBE_YOUTUBE_CLIENT_SECRET || "";

// Optional features
export const SCRAPER_ENABLED = process.env.YOURTUBE_SCRAPER_ENABLED === "true";
export const SCRAPER_TIMEOUT_MS = parseInt(process.env.YOURTUBE_SCRAPER_TIMEOUT_MS || "15000");
export const SEARCH_BUDGET_PER_DAY = parseInt(process.env.YOURTUBE_SEARCH_BUDGET_PER_DAY || "10");

// AI content filter (requires the `claude` CLI to be installed and on PATH)
// When disabled, videos are passed through without AI classification.
export const AI_FILTER_ENABLED = process.env.YOURTUBE_AI_FILTER_ENABLED === "true";

// Valid kid usernames — comma-separated. Default is a single user "kid".
// Each username gets its own data/<username>/ directory.
export const VALID_USERS = (process.env.YOURTUBE_USERS || "kid")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Cross-app auth with KidCode (optional sibling app at https://github.com/...).
// When enabled, kids can click through from KidCode to YourTube without
// re-entering a password. Requires KIDCODE_CROSS_AUTH_SECRET to be set — we
// refuse to start with an insecure default.
export const KIDCODE_ENABLED = process.env.YOURTUBE_KIDCODE_ENABLED === "true";
export const KIDCODE_URL = process.env.YOURTUBE_KIDCODE_URL || "";
const kidcodeSecret = process.env.KIDCODE_CROSS_AUTH_SECRET;
if (KIDCODE_ENABLED && !kidcodeSecret) {
  throw new Error(
    "YOURTUBE_KIDCODE_ENABLED=true but KIDCODE_CROSS_AUTH_SECRET is not set. " +
    "Refusing to start with an insecure shared secret. " +
    "Set KIDCODE_CROSS_AUTH_SECRET in your .env, or disable KidCode integration.",
  );
}
export const CROSS_AUTH_SECRET = kidcodeSecret || "";
