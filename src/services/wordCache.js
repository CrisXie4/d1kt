const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const CACHE_DIR = path.join(__dirname, "..", "..", ".cache");

function cacheKey(baseUrl, userId, count) {
  const raw = `${baseUrl}|${userId}|${count}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
}

async function readCache(baseUrl, userId, count) {
  const file = cachePath(cacheKey(baseUrl, userId, count));
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.words)) {
      return parsed;
    }
    return null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeCache(baseUrl, userId, count, words, rawPayload) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = cachePath(cacheKey(baseUrl, userId, count));
  const payload = {
    baseUrl,
    cachedAt: new Date().toISOString(),
    count,
    rawPayload,
    userId,
    words
  };
  await fs.writeFile(file, JSON.stringify(payload), "utf8");
}

module.exports = {
  readCache,
  writeCache
};
