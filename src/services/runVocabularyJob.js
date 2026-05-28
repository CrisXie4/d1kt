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
const { TEST_TYPES, createTestAttempt, fetchStudyWords, saveTestRecord, submitTestAnswer } = require("./d1ktClient");
const { extractWords } = require("../utils/extractWords");

async function runVocabularyJob(jobId) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} does not exist.`);
  }

  try {
    setJobStatus(jobId, "running");

    const { userId, wordCount } = job.config;

    appendLog(jobId, `Fetching ${wordCount} study-words for user ${userId}.`);
    const payload = await fetchStudyWords(job.config);
    const words = extractWords(payload);
    if (words.length === 0) {
      throw new Error("No words were found in the study-words response.");
    }
    appendLog(jobId, `Fetched ${words.length} words.`);

    setJobWords(jobId, words);

    const wordSetIds = Array.from(new Set(words.map((word) => word.wordSetId || userId).filter(Boolean)));
    const wordSetId = wordSetIds[0];
    if (!wordSetId) {
      throw new Error("No wordSetId was found. Fetch study-words again or check the word set ID.");
    }
    if (wordSetIds.length > 1) {
      appendLog(jobId, `Multiple word sets found; using ${wordSetId}.`);
    }

    updateProgress(jobId, { totalRecords: TEST_TYPES.length });
    appendLog(jobId, `Dispatching ${TEST_TYPES.length} independent test-attempt/test-record flows.`);

    const progress = {
      completed: 0,
      failed: 0,
      succeeded: 0
    };

    await Promise.all(
      TEST_TYPES.map((testType) =>
        runTestType({ job, jobId, progress, testType, words, wordSetId })
      )
    );

    markCompleted(jobId);
    appendLog(jobId, `Completed. Success ${progress.succeeded}, failed ${progress.failed}.`);
  } catch (error) {
    markFailed(jobId, error);
    appendLog(jobId, `Job failed: ${error.message}`);
  }
}

async function runTestType({ job, jobId, progress, testType, words, wordSetId }) {
  const wordsById = new Map(words.map((word) => [word.wordId, word]));

  try {
    const attemptStartedAt = Date.now();
    const attempt = await createTestAttempt(job.config, {
      wordSetId,
      testType,
      wordIds: words.map((word) => word.wordId)
    });
    const questions = Array.isArray(attempt?.questions) ? attempt.questions : [];
    if (!attempt?.attemptId || questions.length === 0) {
      throw new Error(`Invalid test-attempt response for ${testType}.`);
    }

    const initialDelayMs = randomInt(3000, 6000);
    let cursorMs = attemptStartedAt + initialDelayMs;
    const answers = questions.map((question) => {
      cursorMs += randomInt(700, 1500);
      const submittedAt = cursorMs;
      const userAnswer = pickUserAnswer(question, wordsById, testType);
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
      `[${testType}] answered ${answers.length} questions over ${((lastSubmittedAt - attemptStartedAt) / 1000).toFixed(1)}s`
    );

    for (const answer of answers) {
      const interactions = generateInteractions(answer.userAnswer, answer.submittedAt);
      await submitTestAnswer(job.config, {
        attemptId: attempt.attemptId,
        questionToken: answer.questionToken,
        userAnswer: answer.userAnswer,
        submittedAt: answer.submittedAt,
        answerProof: answer.answerProof,
        interactions
      });
    }

    await saveTestRecord(job.config, {
      attemptId: attempt.attemptId
    });
    progress.succeeded += 1;
  } catch (error) {
    progress.failed += 1;
    appendLog(jobId, `Failed ${testType}: ${error.message}`);
  } finally {
    progress.completed += 1;
    updateProgress(jobId, {
      failedRecords: progress.failed,
      succeededRecords: progress.succeeded,
      totalRecords: TEST_TYPES.length
    });
    appendLog(jobId, `Progress ${progress.completed}/${TEST_TYPES.length}.`);
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

const ANSWER_PROOF_SALT = "d1ktsalt";

function computeAnswerProof(attemptId, questionToken, submittedAt, userAnswer) {
  return crypto
    .createHash("md5")
    .update(
      `${ANSWER_PROOF_SALT}:${attemptId}:${questionToken}:${submittedAt}:${userAnswer}:${ANSWER_PROOF_SALT}`
    )
    .digest("hex");
}

function generateInteractions(userAnswer, submittedAt) {
  const interactions = [];
  const chars = userAnswer.split("");
  let ts = submittedAt - (chars.length * 100 + randomInt(100, 300)); // Start typing slightly before submission

  // Question shown event
  interactions.push({
    type: "question-shown",
    ts: ts - randomInt(100, 500)
  });

  // Generate keydown and input events for each character
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const keydownTs = ts + i * randomInt(50, 150);
    const inputTs = keydownTs + randomInt(1, 5);

    interactions.push({
      type: "keydown",
      key: char,
      value: userAnswer.slice(0, i),
      valueLength: i,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ts: keydownTs
    });

    interactions.push({
      type: "input",
      inputType: "insertText",
      value: userAnswer.slice(0, i + 1),
      valueLength: i + 1,
      ts: inputTs
    });
  }

  return interactions;
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
