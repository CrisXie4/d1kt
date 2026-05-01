async function runPool(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const iterator = items[Symbol.iterator]();
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const next = iterator.next();
      if (next.done) {
        return;
      }
      await worker(next.value);
    }
  });

  await Promise.all(runners);
}

module.exports = {
  runPool
};
