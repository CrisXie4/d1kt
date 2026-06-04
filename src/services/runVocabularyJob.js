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
    const attempt = await createTestAttempt(job.config, {
      wordSetId,
      testType,
      wordIds: words.map((word) => word.wordId)
    });
    const questions = Array.isArray(attempt?.questions) ? attempt.questions : [];
    if (!attempt?.attemptId || questions.length === 0) {
      throw new Error(`Invalid test-attempt response for ${testType}.`);
    }

    // Load the test page and read the instructions before the first question.
    await sleep(randomInt(2500, 5000));

    const startedAt = Date.now();
    for (const question of questions) {
      // Transition to this question (advance the card / brief glance).
      await sleep(randomInt(300, 1000));

      const userAnswer = pickUserAnswer(question, wordsById, testType);
      const shownAt = Date.now();
      const { interactions, submittedAt } = buildAnswerTimeline(userAnswer, shownAt);

      // Live through the typing window so submittedAt lands at the real send
      // time — keeping the request's arrival close to its claimed timestamp.
      const waitMs = submittedAt - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const answerProof = computeAnswerProof(
        attempt.attemptId,
        question.questionToken,
        submittedAt,
        userAnswer
      );

      await submitTestAnswer(job.config, {
        attemptId: attempt.attemptId,
        questionToken: question.questionToken,
        userAnswer,
        submittedAt,
        answerProof,
        interactions
      });
    }

    appendLog(
      jobId,
      `[${testType}] answered ${questions.length} questions over ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );

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

// Build a realistic interaction timeline for one answer, mirroring the events a
// real browser session emits: a question-shown marker, an optional look-away
// (blur) / return (focus) while the user thinks, then a keydown + input pair per
// character. Returns the interactions together with the submittedAt they lead up
// to, so the answerProof can be derived from a timestamp that is consistent with
// the events. Gaps are tuned to a captured sample (keystrokes ~110-360ms apart,
// input firing 0-3ms after keydown, submit ~150-500ms after the last keystroke).
function buildAnswerTimeline(userAnswer, shownAt) {
  const interactions = [];
  const chars = userAnswer.split("");
  let cursor = shownAt;

  interactions.push({ type: "question-shown", ts: Math.round(cursor) });

  // Not every answer looks away — only some sessions blur/focus before typing.
  if (Math.random() < 0.35) {
    cursor += randomInt(400, 1200);
    interactions.push({ type: "blur", valueLength: 0, ts: Math.round(cursor) });
    cursor += randomInt(1500, 6000);
    interactions.push({ type: "focus", valueLength: 0, ts: Math.round(cursor) });
    cursor += randomInt(400, 1200);
  } else {
    // Read the prompt and recall the word.
    cursor += randomInt(700, 2600);
  }

  for (let i = 0; i < chars.length; i++) {
    if (i > 0) {
      // Inter-keystroke gap, with the occasional longer hesitation.
      cursor += Math.random() < 0.12 ? randomInt(450, 1100) : randomInt(110, 360);
    }

    // keydown reflects the field value *before* this character is inserted.
    interactions.push({
      type: "keydown",
      key: chars[i],
      value: userAnswer.slice(0, i),
      valueLength: i,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ts: Math.round(cursor)
    });

    // input fires a hair after the keydown, with the value *after* insertion.
    cursor += randomInt(0, 3);
    interactions.push({
      type: "input",
      inputType: "insertText",
      value: userAnswer.slice(0, i + 1),
      valueLength: i + 1,
      ts: Math.round(cursor)
    });
  }

  // Pause between the last keystroke and pressing submit.
  cursor += randomInt(150, 500);

  return { interactions, submittedAt: Math.round(cursor) };
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
