const crypto = require("node:crypto");
const {
  appendLog,
  getJob,
  markCompleted,
  markFailed,
  setJobStatus,
  setJobWords,
  updateProgress
} = require("./jobStore");
const { TEST_TYPES, createTestAttempt, fetchStudyWords, saveTestRecord } = require("./d1ktClient");
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
        words = normalizeCachedWords(cached);
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

    const wordSetIds = Array.from(new Set(words.map((word) => word.wordSetId || userId).filter(Boolean)));
    const wordSetId = wordSetIds[0];
    if (!wordSetId) {
      throw new Error("No wordSetId was found. Fetch study-words again or check the word set ID.");
    }
    if (wordSetIds.length > 1) {
      appendLog(jobId, `Multiple word sets found; using ${wordSetId}.`);
    }

    const tasks = TEST_TYPES.map((testType) => ({
      testType,
      wordSetId,
      words
    }));

    let succeededRecords = 0;
    let failedRecords = 0;
    let completedRecords = 0;

    updateProgress(jobId, { totalRecords: tasks.length });
    appendLog(jobId, `Dispatching ${tasks.length} test-attempt/test-record flows with concurrency ${job.config.concurrency}.`);

    await runPool(tasks, job.config.concurrency, async (task) => {
      try {
        const wordsById = new Map(task.words.map((word) => [word.wordId, word]));
        const attemptStartedAt = Date.now();
        const attempt = await createTestAttempt(job.config, {
          wordSetId: task.wordSetId,
          testType: task.testType,
          wordIds: task.words.map((word) => word.wordId)
        });
        const questions = Array.isArray(attempt?.questions) ? attempt.questions : [];
        if (!attempt?.attemptId || questions.length === 0) {
          throw new Error(`Invalid test-attempt response for ${task.testType}.`);
        }

        const initialDelayMs = randomInt(3000, 6000);
        let cursorMs = attemptStartedAt + initialDelayMs;
        const answers = questions.map((question) => {
          cursorMs += randomInt(700, 1500);
          const submittedAt = cursorMs;
          const userAnswer = pickUserAnswer(question, wordsById, task.testType);
          const answerProof = computeAnswerProof(
            attempt.attemptId,
            question.questionToken,
            submittedAt,
            userAnswer
          );
          return {
            questionToken: question.questionToken,
            userAnswer,
            submittedAt,
            answerProof
          };
        });

        const lastSubmittedAt = answers[answers.length - 1].submittedAt;
        const waitMs = lastSubmittedAt - Date.now() + 500;
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        appendLog(
          jobId,
          `[${task.testType}] answered ${answers.length} questions over ${((lastSubmittedAt - attemptStartedAt) / 1000).toFixed(1)}s`
        );

        await saveTestRecord(job.config, {
          attemptId: attempt.attemptId,
          answers
        });
        succeededRecords += 1;
      } catch (error) {
        failedRecords += 1;
        appendLog(jobId, `Failed ${task.testType}: ${error.message}`);
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

function normalizeCachedWords(cached) {
  const words = Array.isArray(cached.words) ? cached.words : [];
  const needsRawFields = words.some((word) => !word.wordSetId || !word.createdAt || !word.updatedAt);
  if (!needsRawFields) {
    return words;
  }

  const extracted = extractWords(cached.rawPayload);
  return extracted.length > 0 ? extracted : words;
}

function pickUserAnswer(question, wordsById, testType) {
  const word = wordsById.get(question.wordId);
  if (testType === "multiple-choice") {
    return String(word?.meaning ?? question.translation ?? "").trim();
  }
  return String(word?.word ?? question.word ?? "").trim();
}

function computeAnswerProof(attemptId, questionToken, submittedAt, userAnswer) {
  return crypto
    .createHash("sha256")
    .update(`${attemptId}:${questionToken}:${submittedAt}:${userAnswer}`)
    .digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

function randomInt(min, max) {
  return Math.floor(randomFloat(min, max + 1));
}

module.exports = {
  runVocabularyJob
};
