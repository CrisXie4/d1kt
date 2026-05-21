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
        const attempt = await createTestAttempt(job.config, {
          testType: task.testType,
          vocabularyId: task.wordSetId,
          wordSet: task.wordSetId,
          wordSetId: task.wordSetId,
          words: task.words.map(toAttemptWord)
        });
        const questions = Array.isArray(attempt?.questions) ? attempt.questions : [];
        if (!attempt?.attemptId || questions.length === 0) {
          throw new Error(`Invalid test-attempt response for ${task.testType}.`);
        }

        const timing = buildAttemptTiming(attempt, questions.length);
        await saveTestRecord(job.config, {
          answers: questions.map((question, index) =>
            toRecordAnswer(question, task.words, timing.startTime, timing.endTime, index, questions.length)
          ),
          attemptId: attempt.attemptId,
          message: "测试记录已保存",
          stats: {
            accuracy: 0,
            correctWords: questions.length,
            duration: timing.duration,
            endTime: timing.endTime.toISOString(),
            startTime: timing.startTime.toISOString(),
            totalWords: questions.length
          },
          submittedAt: timing.endTime.toISOString()
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

function toAttemptWord(word) {
  return {
    __v: word.version || 0,
    _id: word.wordId,
    createdAt: word.createdAt,
    pronunciation: word.phonetic,
    translation: word.meaning,
    updatedAt: word.updatedAt,
    word: word.word,
    wordSet: word.wordSetId
  };
}

function buildAttemptTiming(attempt, questionCount) {
  const expiresAt = new Date(attempt.expiresAt);
  const startOffsetMs = randomInt(3 * 60 * 1000, 8 * 60 * 1000);
  const startTime = Number.isFinite(expiresAt.getTime())
    ? new Date(expiresAt.getTime() - startOffsetMs)
    : new Date();
  const duration = Math.max(18.1, Math.min(180, questionCount * randomFloat(1.1, 2.4)));
  const endTime = new Date(startTime.getTime() + duration * 1000);

  return {
    duration,
    endTime,
    startTime
  };
}

function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

function randomInt(min, max) {
  return Math.floor(randomFloat(min, max + 1));
}

function toRecordAnswer(question, words, startTime, endTime, index, totalQuestions) {
  const word = words.find((item) => item.wordId === question.wordId) || {};
  const answer = word.word || question.word || question.translation || question.wordId;
  const total = Math.max(1, totalQuestions);
  const answerOffsetMs = Math.round(((index + 1) / total) * (endTime.getTime() - startTime.getTime()));
  const submittedAt = new Date(startTime.getTime() + answerOffsetMs).toISOString();

  return {
    answer,
    duration: Math.max(0.1, (new Date(submittedAt).getTime() - startTime.getTime()) / 1000),
    endTime: submittedAt,
    isCorrect: true,
    questionToken: question.questionToken,
    selectedAnswer: answer,
    startTime: startTime.toISOString(),
    submittedAt,
    userAnswer: answer,
    wordId: question.wordId
  };
}

module.exports = {
  runVocabularyJob
};
