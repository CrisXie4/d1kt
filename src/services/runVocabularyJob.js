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

        await sleep(randomInt(400, 1200));
        const startTime = new Date();
        const targetDurationSec = computeAttemptDuration(questions.length);
        await sleep(targetDurationSec * 1000);
        const endTime = new Date();
        const durationSec = (endTime.getTime() - startTime.getTime()) / 1000;

        appendLog(
          jobId,
          `[${task.testType}] start=${startTime.toISOString()} end=${endTime.toISOString()} duration=${durationSec.toFixed(2)}s`
        );

        await saveTestRecord(job.config, {
          answers: questions.map((question, index) =>
            toRecordAnswer(question, task.words, startTime, endTime, index, questions.length)
          ),
          attemptId: attempt.attemptId,
          message: "测试记录已保存",
          stats: {
            accuracy: 1,
            correctWords: questions.length,
            duration: durationSec,
            endTime: endTime.toISOString(),
            startTime: startTime.toISOString(),
            totalWords: questions.length
          },
          submittedAt: endTime.toISOString()
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

function computeAttemptDuration(questionCount) {
  const perQuestion = randomFloat(0.7, 1.3);
  return Math.max(20, Math.min(150, questionCount * perQuestion));
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

function toRecordAnswer(question, words, startTime, endTime, index, totalQuestions) {
  const word = words.find((item) => item.wordId === question.wordId) || {};
  const answer = word.word || question.word || question.translation || question.wordId;
  const total = Math.max(1, totalQuestions);
  const totalMs = Math.max(0, endTime.getTime() - startTime.getTime());
  const questionStartMs = Math.round((index / total) * totalMs);
  const questionEndMs = Math.round(((index + 1) / total) * totalMs);
  const questionStart = new Date(startTime.getTime() + questionStartMs);
  const questionEnd = new Date(startTime.getTime() + questionEndMs);
  const questionDurationSec = Math.max(0.1, (questionEnd.getTime() - questionStart.getTime()) / 1000);

  return {
    answer,
    duration: questionDurationSec,
    endTime: questionEnd.toISOString(),
    isCorrect: true,
    questionToken: question.questionToken,
    selectedAnswer: answer,
    startTime: questionStart.toISOString(),
    submittedAt: questionEnd.toISOString(),
    userAnswer: answer,
    wordId: question.wordId
  };
}

module.exports = {
  runVocabularyJob
};
