const {
  appendLog,
  getJob,
  markCompleted,
  markFailed,
  setJobStatus,
  setJobWords,
  updateProgress
} = require("./jobStore");
const { TEST_TYPES, fetchStudyWords, postWordRecord } = require("./d1ktClient");
const { runPool } = require("./workerPool");
const { extractWords } = require("../utils/extractWords");
const { readCache, writeCache } = require("./wordCache");

async function runVocabularyJob(jobId) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} does not exist.`);
  }

  try {
    setJobStatus(jobId, "running");

    const { baseUrl, userId, wordCount, useCache } = job.config;
    let words = null;

    if (useCache) {
      const cached = await readCache(baseUrl, userId, wordCount);
      if (cached) {
        words = cached.words;
        appendLog(jobId, `Cache hit: loaded ${words.length} words from ${cached.cachedAt}.`);
      }
    }

    if (!words) {
      appendLog(jobId, `Fetching ${wordCount} study-words for user ${userId}.`);
      const payload = await fetchStudyWords(job.config);
      words = extractWords(payload);
      if (words.length === 0) {
        throw new Error("No words were found in the study-words response.");
      }
      appendLog(jobId, `Fetched ${words.length} words.`);
      if (useCache) {
        try {
          await writeCache(baseUrl, userId, wordCount, words, payload);
          appendLog(jobId, "Words cached to disk.");
        } catch (error) {
          appendLog(jobId, `Cache write failed: ${error.message}`);
        }
      }
    }

    setJobWords(jobId, words);

    const tasks = words.flatMap((word) =>
      TEST_TYPES.map((testType) => ({
        testType,
        word,
        wordId: word.wordId
      }))
    );

    let succeededRecords = 0;
    let failedRecords = 0;
    let completedRecords = 0;

    updateProgress(jobId, { totalRecords: tasks.length });
    appendLog(jobId, `Dispatching ${tasks.length} word-record requests with concurrency ${job.config.concurrency}.`);

    await runPool(tasks, job.config.concurrency, async (task) => {
      try {
        await postWordRecord(job.config, {
          isCorrect: true,
          testType: task.testType,
          wordId: task.wordId
        });
        succeededRecords += 1;
      } catch (error) {
        failedRecords += 1;
        appendLog(jobId, `Failed ${task.word.word} / ${task.testType}: ${error.message}`);
      } finally {
        completedRecords += 1;
        updateProgress(jobId, {
          failedRecords,
          succeededRecords,
          totalRecords: tasks.length
        });

        if (completedRecords % 25 === 0 || completedRecords === tasks.length) {
          appendLog(jobId, `Progress ${completedRecords}/${tasks.length}.`);
        }
      }
    });

    markCompleted(jobId);
    appendLog(jobId, `Completed. Success ${succeededRecords}, failed ${failedRecords}.`);
  } catch (error) {
    markFailed(jobId, error);
    appendLog(jobId, `Job failed: ${error.message}`);
  }
}

module.exports = {
  runVocabularyJob
};
