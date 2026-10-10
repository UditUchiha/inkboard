// Each connection may send this many of an event at once and then this many more
// per second, so one person (or a script) can't make the server do work for everyone
// without end. A busy editor sends a change every 40 ms and a cursor a few times
// that, so these leave room for that and no more.
export const LIMITS = {
  op: { burst: 100, perSecond: 40 },
  cursor: { burst: 40, perSecond: 30 },
  viewport: { burst: 20, perSecond: 10 },
  followRequest: { burst: 5, perSecond: 1 },
};

/** A function that says whether one more event is allowed right now (a token bucket). */
export function createLimiter({ burst, perSecond }) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
