const form = document.getElementById("job-form");
const statusEl = document.getElementById("status");
const wordCountEl = document.getElementById("wordCount");
const successCountEl = document.getElementById("successCount");
const failedCountEl = document.getElementById("failedCount");
const totalCountEl = document.getElementById("totalCount");
const progressBarEl = document.getElementById("progressBar");
const logBoxEl = document.getElementById("logBox");
const wordTableEl = document.getElementById("wordTable");
const submitButtonEl = document.getElementById("submitButton");
const jobSelectEl = document.getElementById("jobSelect");

const jobs = new Map();
let activeJobId = "";
let pollTimer = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  submitButtonEl.disabled = true;
  logBoxEl.textContent = "正在创建任务...";

  try {
    const payload = {
      baseUrl: document.getElementById("baseUrl").value.trim(),
      attemptPath: document.getElementById("attemptPath").value.trim(),
      password: document.getElementById("password").value,
      recordPath: document.getElementById("recordPath").value.trim(),
      requestTimeoutMs: Number.parseInt(document.getElementById("requestTimeoutMs").value, 10),
      studyPathPrefix: document.getElementById("studyPathPrefix").value.trim(),
      username: document.getElementById("username").value.trim(),
      wordCount: Number.parseInt(document.getElementById("wordCount").value, 10)
    };

    const response = await fetch("/api/jobs", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST"
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "任务创建失败。");
    }

    activeJobId = data.jobId;
    jobs.set(data.jobId, {
      id: data.jobId,
      progress: {},
      status: "queued",
      words: [],
      logs: [`任务已创建: ${data.jobId}`]
    });
    renderJobOptions();
    renderJob(jobs.get(activeJobId));
    ensurePolling();
  } catch (error) {
    logBoxEl.textContent = error.message;
  } finally {
    submitButtonEl.disabled = false;
  }
});

jobSelectEl.addEventListener("change", () => {
  activeJobId = jobSelectEl.value;
  const job = jobs.get(activeJobId);
  if (job) {
    renderJob(job);
  } else {
    resetView();
  }
});

async function loadJobs() {
  try {
    const response = await fetch("/api/jobs");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "任务列表获取失败。");
    }

    for (const job of data.jobs || []) {
      jobs.set(job.id, job);
    }
    if (!activeJobId && data.jobs && data.jobs.length > 0) {
      activeJobId = data.jobs[0].id;
    }
    renderJobOptions();
    if (activeJobId && jobs.has(activeJobId)) {
      renderJob(jobs.get(activeJobId));
    }
    ensurePolling();
  } catch (error) {
    logBoxEl.textContent = error.message;
  }
}

function ensurePolling() {
  if (!pollTimer) {
    pollTimer = window.setInterval(fetchRunningJobs, 500);
  }
}

function stopPollingIfIdle() {
  const hasRunningJobs = Array.from(jobs.values()).some((job) => isRunning(job.status));
  if (!hasRunningJobs && pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function fetchRunningJobs() {
  const runningIds = Array.from(jobs.values())
    .filter((job) => isRunning(job.status))
    .map((job) => job.id);

  if (runningIds.length === 0) {
    stopPollingIfIdle();
    return;
  }

  await Promise.all(runningIds.map(fetchJobStatus));
  renderJobOptions();
  if (activeJobId && jobs.has(activeJobId)) {
    renderJob(jobs.get(activeJobId));
  }
  stopPollingIfIdle();
}

async function fetchJobStatus(jobId) {
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job = await response.json();

    if (!response.ok) {
      jobs.set(jobId, {
        id: jobId,
        error: job.error || "任务状态获取失败。",
        progress: {},
        status: "missing",
        words: [],
        logs: []
      });
      return;
    }

    jobs.set(job.id, job);
  } catch (error) {
    const current = jobs.get(jobId) || { id: jobId, progress: {}, words: [], logs: [] };
    jobs.set(jobId, {
      ...current,
      error: error.message,
      status: "failed"
    });
  }
}

function renderJobOptions() {
  jobSelectEl.innerHTML = "";

  const allJobs = Array.from(jobs.values()).sort((a, b) => {
    const left = b.createdAt || "";
    const right = a.createdAt || "";
    return left.localeCompare(right);
  });

  if (allJobs.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无任务";
    jobSelectEl.appendChild(option);
    return;
  }

  for (const job of allJobs) {
    const option = document.createElement("option");
    option.value = job.id;
    option.textContent = `${job.status} | ${shortId(job.id)} | ${progressText(job)}`;
    jobSelectEl.appendChild(option);
  }

  if (!activeJobId || !jobs.has(activeJobId)) {
    activeJobId = allJobs[0].id;
  }
  jobSelectEl.value = activeJobId;
}

function renderJob(job) {
  statusEl.textContent = job.status || "idle";
  wordCountEl.textContent = String(job.progress?.fetchedWords || 0);
  successCountEl.textContent = String(job.progress?.succeededRecords || 0);
  failedCountEl.textContent = String(job.progress?.failedRecords || 0);
  totalCountEl.textContent = String(job.progress?.totalRecords || 0);

  const completed = (job.progress?.succeededRecords || 0) + (job.progress?.failedRecords || 0);
  const total = job.progress?.totalRecords || 0;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  progressBarEl.style.width = `${percentage}%`;

  const logs = [...(job.logs || [])];
  if (job.error) {
    logs.push(`ERROR: ${job.error}`);
  }
  logBoxEl.textContent = logs.length > 0 ? logs.join("\n") : "暂无日志。";

  renderWords(job.words || []);
}

function renderWords(words) {
  wordTableEl.innerHTML = "";

  const fragment = document.createDocumentFragment();
  for (const item of words) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(String(item.wordId || ""))}</td>
      <td>${escapeHtml(String(item.word || ""))}</td>
      <td>${escapeHtml(String(item.meaning || ""))}</td>
      <td>${escapeHtml(String(item.phonetic || ""))}</td>
    `;
    fragment.appendChild(row);
  }
  wordTableEl.appendChild(fragment);
}

function resetView() {
  statusEl.textContent = "idle";
  wordCountEl.textContent = "0";
  successCountEl.textContent = "0";
  failedCountEl.textContent = "0";
  totalCountEl.textContent = "0";
  progressBarEl.style.width = "0%";
  logBoxEl.textContent = "等待任务开始...";
  wordTableEl.innerHTML = "";
}

function isRunning(status) {
  return status === "queued" || status === "running";
}

function shortId(id) {
  return id ? id.slice(0, 8) : "";
}

function progressText(job) {
  const progress = job.progress || {};
  const completed = (progress.succeededRecords || 0) + (progress.failedRecords || 0);
  const total = progress.totalRecords || 0;
  return total > 0 ? `${completed}/${total}` : "等待中";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

loadJobs();
