const TEST_TYPES = [
  "chinese-to-english",
  "audio-to-english",
  "multiple-choice"
];

async function fetchStudyWords(config) {
  const base = ensureTrailingSlash(config.baseUrl);
  const prefix = trimSlashes(config.studyPathPrefix);
  const url = new URL(`${prefix}${encodeURIComponent(config.userId)}`, base);
  url.searchParams.set("count", String(config.wordCount || 100));

  return requestJson(url, {
    headers: buildHeaders(config),
    method: "GET",
    timeoutMs: config.requestTimeoutMs
  });
}

async function postWordRecord(config, payload) {
  const url = new URL(trimLeadingSlash(config.recordPath), ensureTrailingSlash(config.baseUrl));
  const body = config.jwtInBody ? { ...payload, jwt: config.jwt } : payload;

  return requestJson(url, {
    body: JSON.stringify(body),
    headers: buildHeaders(config),
    method: "POST",
    timeoutMs: config.requestTimeoutMs
  });
}

function buildHeaders(config) {
  return {
    accept: "application/json",
    authorization: `Bearer ${config.jwt}`,
    connection: "keep-alive",
    "content-type": "application/json",
    cookie: `${config.jwtCookieName}=${encodeURIComponent(config.jwt)}; connect.sid=${encodeURIComponent(config.connectSid)}`,
    "user-agent": "d1kt-node-harness/1.0"
  };
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const target = url.toString();

  try {
    const response = await fetch(url, {
      body: options.body,
      headers: options.headers,
      method: options.method,
      signal: controller.signal
    });

    const text = await response.text();
    const payload = text ? safeParseJson(text) : null;

    if (!response.ok) {
      throw new Error(`${options.method} ${target} -> ${response.status} ${response.statusText}: ${truncate(text, 240)}`);
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${options.method} ${target} timed out after ${options.timeoutMs}ms.`);
    }

    const cause = error.cause && error.cause.message ? ` | cause: ${error.cause.message}` : "";
    throw new Error(`${options.method} ${target} failed: ${error.message}${cause}`);
  } finally {
    clearTimeout(timeout);
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function trimSlashes(value) {
  return value.replace(/^\/+/, "").replace(/\/+$/, "/");
}

function trimLeadingSlash(value) {
  return value.replace(/^\/+/, "");
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

module.exports = {
  TEST_TYPES,
  fetchStudyWords,
  postWordRecord
};
