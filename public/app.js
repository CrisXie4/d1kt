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

let currentJobId = null;
let pollTimer = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopPolling();
  resetView();

  submitButtonEl.disabled = true;
  logBoxEl.textContent = "正在创建任务...";

  try {
    const payload = {
      baseUrl: document.getElementById("baseUrl").value.trim(),
      concurrency: Number.parseInt(document.getElementById("concurrency").value, 10),
      connectSid: document.getElementById("connectSid").value.trim(),
      jwt: document.getElementById("jwt").value.trim(),
      jwtInBody: document.getElementById("jwtInBody").checked,
      recordPath: document.getElementById("recordPath").value.trim(),
      requestTimeoutMs: Number.parseInt(document.getElementById("requestTimeoutMs").value, 10),
      studyPathPrefix: document.getElementById("studyPathPrefix").value.trim(),
      useCache: document.getElementById("useCache").checked,
      userId: document.getElementById("userId").value.trim(),
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

    currentJobId = data.jobId;
    statusEl.textContent = "queued";
    logBoxEl.textContent = `任务已创建: ${currentJobId}`;
    startPolling();
  } catch (error) {
    logBoxEl.textContent = error.message;
    submitButtonEl.disabled = false;
  }
});

function startPolling() {
  pollTimer = window.setInterval(fetchJobStatus, 500);
  fetchJobStatus();
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function fetchJobStatus() {
  if (!currentJobId) {
    return;
  }

  try {
    const response = await fetch(`/api/jobs/${currentJobId}`);
    const job = await response.json();

    if (!response.ok) {
      throw new Error(job.error || "任务状态获取失败。");
    }

    renderJob(job);

    if (job.status === "completed" || job.status === "failed") {
      stopPolling();
      submitButtonEl.disabled = false;
    }
  } catch (error) {
    stopPolling();
    submitButtonEl.disabled = false;
    logBoxEl.textContent = error.message;
  }
}

function renderJob(job) {
  statusEl.textContent = job.status;
  wordCountEl.textContent = String(job.progress.fetchedWords || 0);
  successCountEl.textContent = String(job.progress.succeededRecords || 0);
  failedCountEl.textContent = String(job.progress.failedRecords || 0);
  totalCountEl.textContent = String(job.progress.totalRecords || 0);

  const completed = (job.progress.succeededRecords || 0) + (job.progress.failedRecords || 0);
  const total = job.progress.totalRecords || 0;
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
      <td>${escapeHtml(item.wordId || "")}</td>
      <td>${escapeHtml(item.word || "")}</td>
      <td>${escapeHtml(item.meaning || "")}</td>
      <td>${escapeHtml(item.phonetic || "")}</td>
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
  wordTableEl.innerHTML = "";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
