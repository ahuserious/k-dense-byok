/**
 * Bounded fan-out for kinds that split work (today: best-of-n).
 *
 * Slot ids stay caller-owned and stable (`candidate-${index}`). This helper
 * only decides how many of those slots are in flight at once.
 */
export async function mapWithBoundedConcurrency<T>(
  count: number,
  limit: number,
  worker: (index: number) => Promise<T>,
): Promise<T[]> {
  const size = Math.max(0, count);
  const concurrency = Math.max(1, Math.min(limit, size || 1));
  const results: T[] = new Array(size);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= size) return;
      results[index] = await worker(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, size) }, () => runWorker()));
  return results;
}
