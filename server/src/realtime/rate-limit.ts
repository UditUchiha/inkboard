// Per connection: this many of an event at once, then this many more per second, so one person (or a script) can't make
// the server do unbounded work. A busy editor sends a change every 40 ms and a cursor a few times that.
export const LIMITS = {
  op: { burst: 100, perSecond: 40 },
  cursor: { burst: 40, perSecond: 30 },
  viewport: { burst: 20, perSecond: 10 },
  followRequest: { burst: 5, perSecond: 1 },
  present: { burst: 5, perSecond: 1 },
  countdown: { burst: 5, perSecond: 1 },
  privateMode: { burst: 5, perSecond: 1 },
  classroom: { burst: 10, perSecond: 2 },
  replay: { burst: 3, perSecond: 0.1 },
  vote: { burst: 20, perSecond: 5 },
};

export interface Limit {
  burst: number;
  perSecond: number;
}

export type Limiter = () => boolean;

export function createLimiter({ burst, perSecond }: Limit): Limiter {
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
