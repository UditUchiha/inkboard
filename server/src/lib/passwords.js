import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";

// Passwords are hashed with scrypt, which runs on libuv's thread pool so a login
// doesn't stall the event loop (bcryptjs is plain JavaScript and does). Hashes made
// with bcrypt before that are still accepted, and are replaced at the next login
// (see waitOutSlowestCheck for what the slower check means for failed logins).
// Stored as `scrypt$N$r$p$salt$hash` (salt and hash in base64).
const scryptAsync = promisify(scrypt);
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

const derive = (password, salt, { N, r, p }) =>
  scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY });

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Whether `password` matches `stored`, and whether `stored` should be re-made with the current algorithm. */
export async function verifyPasswordHash(password, stored) {
  if (stored.startsWith("scrypt$")) {
    const [, N, r, p, salt, hash] = stored.split("$");
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), { N: Number(N), r: Number(r), p: Number(p) });
    const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
    return { ok, needsRehash: ok && (Number(N) !== COST.N || Number(r) !== COST.r || Number(p) !== COST.p) };
  }
  const ok = await bcrypt.compare(password, stored);
  return { ok, needsRehash: ok };
}

// Compared against when no account matches, so that answering takes as long as it
// does for a real one and the response time doesn't reveal who has an account.
const decoy = hashPassword(randomBytes(16).toString("base64"));
export async function spendPasswordTime(password) {
  await verifyPasswordHash(password, await decoy);
}

// A bcrypt check takes about twice as long as an scrypt one, so a wrong guess at an account still on an
// old bcrypt hash would answer later than one at no account, and give away that a dormant account uses
// the address. Failed logins therefore wait until a bcrypt check would have finished. Matching it with a
// timer rather than with more hashing keeps the event loop and the CPU free while the answer waits. (The
// bcrypt checks themselves run on the event loop, but bcryptjs gives it back every 100 ms or so.)
// The decoy is a hash of a random string at cost 12, the cost the old hashes were made with.
const LEGACY_DECOY = "$2b$12$2VHidUVRV7tXCUQS/wirVOg1H6mWk2ZJZhAQhYyKHvOl3XtkLOvWy";

// How long that takes is measured, not guessed, and a single measurement can be wrong either way: one
// taken while the server is busy (someone can arrange that right after a restart) would make every
// failed login wait that long, and one taken too fast would let dormant bcrypt accounts show. So the
// shortest of the last few measurements is used (a busy moment can't stay in it for long, and a lucky
// one is held to the floor below), new ones are taken now and then, and the result is kept within what a
// bcrypt check at this cost can reasonably take.
const SAMPLE_WINDOW = 9;
const FIRST_SAMPLES = 3;
const REFRESH_EVERY_MS = 5 * 60 * 1000;
const FLOOR_MS = 100;
const CEILING_MS = 1500;

async function timeLegacyCheck() {
  const started = performance.now();
  await bcrypt.compare("decoy", LEGACY_DECOY);
  return performance.now() - started;
}

/**
 * Keeps the timing described above. `measure`, `now` and `sleep` can be swapped, which tests do.
 * Only the very first failed login waits for a measurement (one); the others that make the minimum
 * steadier are taken in the background, so no later request pays for them.
 */
export function createCheckTimer({
  measure = timeLegacyCheck,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const samples = [];
  let lastSampledAt = -Infinity;
  let first = null;
  let background = null;

  async function sample() {
    const ms = await measure();
    samples.push(ms);
    if (samples.length > SAMPLE_WINDOW) samples.shift();
    lastSampledAt = now();
  }

  // Further samples, when there are few so far or the last one is old. Never more than one run at a time.
  function topUp() {
    const due = samples.length < FIRST_SAMPLES || now() - lastSampledAt >= REFRESH_EVERY_MS;
    if (!due || background) return;
    const wanted = samples.length < FIRST_SAMPLES ? FIRST_SAMPLES - samples.length : 1;
    background = (async () => {
      for (let taken = 0; taken < wanted; taken += 1) await sample();
    })()
      .catch((error) => console.error("Couldn't time a bcrypt check:", error.message))
      .finally(() => {
        background = null;
      });
  }

  const slowestMs = () => Math.min(CEILING_MS, Math.max(FLOOR_MS, Math.min(...samples)));

  return {
    slowestMs,
    /** Waits, without working, until a failed login that began at `startedAt` takes as long as the slowest check. */
    async waitOut(startedAt) {
      if (samples.length === 0) await (first ??= sample().finally(() => (first = null)));
      topUp();
      const remaining = startedAt + slowestMs() - now();
      if (remaining > 0) await sleep(remaining);
    },
  };
}

const checkTimer = createCheckTimer();

/** Waits, without working, until a failed login that began at `startedAt` (performance.now()) takes as long as the slowest check. */
export const waitOutSlowestCheck = (startedAt) => checkTimer.waitOut(startedAt);
