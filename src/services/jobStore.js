const { randomUUID } = require("node:crypto");

const CLEANUP_INTERVAL_MS = 60 * 1000;
const CLEANUP_AFTER_FINISHED_MS = 30 * 60 * 1000;

const jobs = new Map();

function createJob(config, owner) {
  const job = {
    id: randomUUID(),
    owner: owner || null,
    config,
    createdAt: new Date().toISOString(),
    error: null,
    finishedAt: null,
    logs: [],
    progress: {
      failedRecords: 0,
      fetchedWords: 0,
      succeededRecords: 0,
      totalRecords: 0
    },
    status: "queued",
    words: []
  };

  jobs.set(job.id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function getJobView(id, owner) {
  const job = jobs.get(id);
  if (!job) {
    return null;
  }
  if (owner && job.owner && job.owner !== owner) {
    return null;
  }

  return {
    createdAt: job.createdAt,
    error: job.error,
    finishedAt: job.finishedAt,
    id: job.id,
    logs: job.logs.slice(-50),
    progress: job.progress,
    status: job.status,
    words: job.words
  };
}

function listJobViews(owner) {
  return Array.from(jobs.values())
    .filter((job) => !owner || !job.owner || job.owner === owner)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => getJobView(job.id, owner));
}

function setJobStatus(id, status) {
  const job = getRequiredJob(id);
  job.status = status;
}

function setJobWords(id, words) {
  const job = getRequiredJob(id);
  job.words = words;
  job.progress.fetchedWords = words.length;
}

function updateProgress(id, patch) {
  const job = getRequiredJob(id);
  job.progress = {
    ...job.progress,
    ...patch
  };
}

function appendLog(id, message) {
  const job = getRequiredJob(id);
  const line = `[${new Date().toISOString()}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 200) {
    job.logs = job.logs.slice(-200);
  }
  console.log(`[job ${id.slice(0, 8)}] ${line}`);
}

function markCompleted(id) {
  const job = getRequiredJob(id);
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
}

function markFailed(id, error) {
  const job = getRequiredJob(id);
  job.status = "failed";
  job.error = error instanceof Error ? error.message : String(error);
  job.finishedAt = new Date().toISOString();
}

function getRequiredJob(id) {
  const job = jobs.get(id);
  if (!job) {
    throw new Error(`Job ${id} not found.`);
  }
  return job;
}

function sweepFinishedJobs(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (!job.finishedAt) continue;
    const finishedMs = Date.parse(job.finishedAt);
    if (Number.isFinite(finishedMs) && now - finishedMs >= CLEANUP_AFTER_FINISHED_MS) {
      jobs.delete(id);
    }
  }
}

const cleanupTimer = setInterval(sweepFinishedJobs, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

module.exports = {
  appendLog,
  createJob,
  getJob,
  getJobView,
  listJobViews,
  markCompleted,
  markFailed,
  setJobStatus,
  setJobWords,
  sweepFinishedJobs,
  updateProgress
};
