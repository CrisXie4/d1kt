function extractWords(payload) {
  const source = findArrayCandidate(payload);
  if (!Array.isArray(source)) {
    return [];
  }

  const words = source
    .map(normalizeWord)
    .filter((item) => item.wordId && item.word);

  const seen = new Set();
  return words.filter((item) => {
    if (seen.has(item.wordId)) {
      return false;
    }
    seen.add(item.wordId);
    return true;
  });
}

function findArrayCandidate(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const preferredKeys = ["data", "items", "list", "rows", "records", "words"];
  for (const key of preferredKeys) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
    if (value[key] && typeof value[key] === "object") {
      const nested = findArrayCandidate(value[key]);
      if (nested) {
        return nested;
      }
    }
  }

  for (const nestedValue of Object.values(value)) {
    const nested = findArrayCandidate(nestedValue);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function normalizeWord(item) {
  const wordId =
    firstString(item.wordId, item._id, item.id, item.word?._id, item.word?.id) || "";

  const wordSetId =
    firstString(
      item.wordSetId,
      item.wordSet,
      item.vocabularyId,
      item.vocabulary,
      item.word?.wordSetId,
      item.word?.wordSet
    ) || "";

  const word =
    firstString(item.word, item.spelling, item.content, item.name, item.term, item.word?.word) || "";

  const meaning =
    firstString(
      item.meaning,
      item.translation,
      item.definition,
      item.chineseMeaning,
      item.cnMeaning,
      item.word?.meaning
    ) || joinStrings(item.meanings || item.translations);

  const phonetic =
    firstString(
      item.phonetic,
      item.pronunciation,
      item.ukphone,
      item.usphone,
      item.phonogram,
      item.word?.phonetic
    ) || "";

  return {
    createdAt: firstString(item.createdAt, item.word?.createdAt),
    meaning,
    phonetic,
    updatedAt: firstString(item.updatedAt, item.word?.updatedAt),
    version: typeof item.__v === "number" ? item.__v : item.word?.__v,
    word,
    wordId,
    wordSetId
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function joinStrings(values) {
  if (!Array.isArray(values)) {
    return "";
  }

  return values
    .map((value) => {
      if (typeof value === "string") {
        return value.trim();
      }
      if (value && typeof value === "object") {
        return firstString(value.meaning, value.translation, value.text);
      }
      return "";
    })
    .filter(Boolean)
    .join(" / ");
}

module.exports = {
  extractWords
};
