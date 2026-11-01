import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "../config.js";

// Default values for each data file
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
  "likes.json": [],
  "search-log.json": [],
};

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function readJSON(filename) {
  const filepath = join(DATA_DIR, filename);
  try {
    const raw = await readFile(filepath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return DEFAULTS[filename] ?? null;
    }
    throw err;
  }
}

export async function writeJSON(filename, data) {
  const filepath = join(DATA_DIR, filename);
  await mkdir(dirname(filepath), { recursive: true });
  const tmpPath = filepath + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filepath);
}

// Generic aliases used by auth module
export async function read(filename, fallback = null) {
  const filepath = join(DATA_DIR, filename);
  try {
    const raw = await readFile(filepath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export const write = writeJSON;

// Getter/setter pairs for each data file

export const getChannels = () => readJSON("channels.json");
export const setChannels = (data) => writeJSON("channels.json", data);

export const getVideos = () => readJSON("videos.json");
export const setVideos = (data) => writeJSON("videos.json", data);

export const getHistory = () => readJSON("history.json");
export const setHistory = (data) => writeJSON("history.json", data);

export const getBlocked = () => readJSON("blocked.json");
export const setBlocked = (data) => writeJSON("blocked.json", data);

export const getAICache = () => readJSON("ai-cache.json");
export const setAICache = (data) => writeJSON("ai-cache.json", data);

export const getUpNextCache = () => readJSON("upnext-cache.json");
export const setUpNextCache = (data) => writeJSON("upnext-cache.json", data);

export const getProfile = () => readJSON("profile.json");
export const setProfile = (data) => writeJSON("profile.json", data);

export const getTokens = () => readJSON("tokens.json");
export const setTokens = (data) => writeJSON("tokens.json", data);

export const getSessions = () => readJSON("sessions.json");
export const setSessions = (data) => writeJSON("sessions.json", data);

export const getConfig = () => readJSON("config.json");
export const setConfig = (data) => writeJSON("config.json", data);

export const getLikes = () => readJSON("likes.json");
export const setLikes = (data) => writeJSON("likes.json", data);

export const getSearchLog = () => readJSON("search-log.json");
export const setSearchLog = (data) => writeJSON("search-log.json", data);

// --- User-scoped getters/setters ---

export const getUserProfile = (user) => readJSON(`${user}/profile.json`);
export const setUserProfile = (user, data) => writeJSON(`${user}/profile.json`, data);

export const getUserChannels = (user) => readJSON(`${user}/channels.json`);
export const setUserChannels = (user, data) => writeJSON(`${user}/channels.json`, data);

export const getUserLikes = (user) => readJSON(`${user}/likes.json`);
export const setUserLikes = (user, data) => writeJSON(`${user}/likes.json`, data);

export const getUserHistory = (user) => readJSON(`${user}/history.json`);
export const setUserHistory = (user, data) => writeJSON(`${user}/history.json`, data);

export const getUserBlocked = (user) => readJSON(`${user}/blocked.json`);
export const setUserBlocked = (user, data) => writeJSON(`${user}/blocked.json`, data);

export const getUserAICache = (user) => readJSON(`${user}/ai-cache.json`);
export const setUserAICache = (user, data) => writeJSON(`${user}/ai-cache.json`, data);

export const getUserSearchLog = (user) => readJSON(`${user}/search-log.json`);
export const setUserSearchLog = (user, data) => writeJSON(`${user}/search-log.json`, data);
