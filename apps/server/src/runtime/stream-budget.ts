/** Shared observation admission; reserve before any asynchronous setup. No execution ownership. */
export function streamBudget(limit = 64): {acquire(): () => void} {
  let active = 0;
  return {acquire() {
    if (active >= limit) throw new Error('TOO_MANY_STREAMS');
    active += 1;
    let released = false;
    return () => { if (!released) { released = true; active -= 1; } };
  }};
}
export type StreamBudget = ReturnType<typeof streamBudget>;
