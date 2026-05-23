const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createJob, getJobView, getJob, listJobViews } = require("./services/jobStore");
const { runVocabularyJob } = require("./services/runVocabularyJob");
const { login } = require("./services/d1ktClient");

const FORCED_USER_ID = "6804bcde1d7614b6b5690a84";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const body = await readJsonBody(req);
        const { loginInput, jobInput } = normalizeJobRequest(body);

        let auth;
        try {
          auth = await login(loginInput);
        } catch (error) {
          return sendJson(res, 401, { error: `Login failed: ${error.message}` });
        }

        const config = { ...jobInput, jwt: auth.token, userId: FORCED_USER_ID };
        const job = createJob(config);

        runVocabularyJob(job.id).catch((error) => {
          const failedJob = getJob(job.id);
          if (failedJob && failedJob.status !== "failed") {
            failedJob.status = "failed";
            failedJob.error = error.message;
            failedJob.finishedAt = new Date().toISOString();
          }
        });

        return sendJson(res, 202, { jobId: job.id });
      }

      if (req.method === "GET" && url.pathname === "/api/jobs") {
        return sendJson(res, 200, { jobs: listJobViews() });
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const jobId = url.pathname.split("/").pop();
        const job = getJobView(jobId);
        if (!job) {
          return sendJson(res, 404, { error: "Job not found." });
        }
        return sendJson(res, 200, job);
      }

      return serveStatic(req, res, url.pathname);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return sendJson(res, statusCode, {
        error: error.expose ? error.message : "Internal server error."
      });
    }
  });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalizedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Forbidden." });
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return sendJson(res, 404, { error: "Not found." });
    }
    throw error;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw createHttpError(400, "Request body is required.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError(400, "Request body must be valid JSON.");
  }
}

function normalizeJobRequest(body) {
  const username = ensureString(body.username, "Username");
  const password = ensureString(body.password, "Password");
  const baseUrl = ensureString(body.baseUrl, "Base URL").replace(/\/+$/, "");
  const loginPath = ensureOptionalPath(body.loginPath, "/api/api/auth/login");
  const studyPathPrefix = ensureOptionalPath(body.studyPathPrefix, "/api/api/vocabulary/study-words/");
  const attemptPath = ensureOptionalPath(body.attemptPath, "/api/api/vocabulary/test-attempt");
  const recordPath = ensureOptionalPath(body.recordPath, "/api/api/vocabulary/test-record");

  const requestTimeoutMs = clampNumber(body.requestTimeoutMs, 1000, 60000, 15000);
  const wordCount = clampNumber(body.wordCount, 1, 500, 100);

  return {
    loginInput: { baseUrl, loginPath, username, password, requestTimeoutMs },
    jobInput: {
      baseUrl,
      attemptPath,
      jwtCookieName: "token",
      recordPath,
      requestTimeoutMs,
      studyPathPrefix,
      wordCount
    }
  };
}

function ensureString(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw createHttpError(400, `${label} is required.`);
  }
  return text;
}

function ensureOptionalPath(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return fallback;
  }

  return text.startsWith("/") ? text : `/${text}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.expose = true;
  error.statusCode = statusCode;
  return error;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

module.exports = {
  createServer
};
