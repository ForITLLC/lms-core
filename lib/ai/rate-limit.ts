// Questions a learner may ask the tutor in one window. Each question is an Opus
// call billed to the tenant's operator, so one signed-in learner (or a stolen
// cookie) can't run up the bill. Counts are per app instance, so with N
// instances the real ceiling is N times this; that bounds cost, which is the
// point, without a table write on every question.
export const TUTOR_QUESTIONS_PER_WINDOW = 30;
export const TUTOR_WINDOW_MS = 10 * 60_000;

export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    // Records the attempt and answers how long to wait, or 0 when it may go ahead.
    take(key: string): number {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => at > t - windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return recent[0]! + windowMs - t;
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 10_000) {
        for (const [k, times] of hits) if (times.every((at) => at <= t - windowMs)) hits.delete(k);
      }
      return 0;
    },
  };
}

export const tutorLimiter = createRateLimiter(TUTOR_QUESTIONS_PER_WINDOW, TUTOR_WINDOW_MS);
