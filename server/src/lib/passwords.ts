import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { BinaryLike, ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";

// scrypt runs on libuv's thread pool, so a login doesn't stall the event loop (bcryptjs is plain JavaScript and does).
// Older bcrypt hashes are accepted and replaced at the next login. Stored as `scrypt$N$r$p$salt$hash` (base64). The
// type
// arguments pick promisify's overload for scrypt's options form.
const scryptAsync = promisify<BinaryLike, BinaryLike, number, ScryptOptions, Buffer>(scrypt);

type ScryptCost = { N: number; r: number; p: number };
const COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

const derive = (password: string, salt: Buffer, { N, r, p }: ScryptCost) =>
  scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY });

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPasswordHash(password: string, stored: string) {
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

// compared against when no account matches, so answering takes as long and the response time doesn't reveal who has an
// account
const decoy = hashPassword(randomBytes(16).toString("base64"));
export async function spendPasswordTime(password: string) {
  await verifyPasswordHash(password, await decoy);
}

// A bcrypt check takes about twice as long as scrypt, so a wrong guess at an account still on bcrypt would answer later
// than one at no account and give away that it exists. Failed logins therefore wait until a bcrypt check would have
// finished, by timer rather than more hashing, which keeps the event loop and CPU free. The decoy is a cost-12 hash,
// the
// cost the old hashes used.
const LEGACY_DECOY = "$2b$12$2VHidUVRV7tXCUQS/wirVOg1H6mWk2ZJZhAQhYyKHvOl3XtkLOvWy";

// The wait is measured, and one measurement can be wrong either way: taken while the server is busy (arrangeable right
// after a restart) it would stall every failed login, and taken too fast it would let bcrypt accounts show. So the
// shortest of the last few is used, new ones are taken now and then, and the result is clamped to what a bcrypt check
// can reasonably take.
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

export interface CheckTimerOptions {
  measure?: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

// `measure`, `now` and `sleep` can be swapped (tests do). Only the first failed login waits for a measurement; the rest
// are taken in the background.
export function createCheckTimer({
  measure = timeLegacyCheck,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: CheckTimerOptions = {}) {
  const samples: number[] = [];
  let lastSampledAt = -Infinity;
  let first: Promise<void> | null = null;
  let background: Promise<void> | null = null;

  async function sample() {
    const ms = await measure();
    samples.push(ms);
    if (samples.length > SAMPLE_WINDOW) samples.shift();
    lastSampledAt = now();
  }

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
    async waitOut(startedAt: number) {
      if (samples.length === 0) await (first ??= sample().finally(() => (first = null)));
      topUp();
      const remaining = startedAt + slowestMs() - now();
      if (remaining > 0) await sleep(remaining);
    },
  };
}

const checkTimer = createCheckTimer();

export const waitOutSlowestCheck = (startedAt: number) => checkTimer.waitOut(startedAt);
