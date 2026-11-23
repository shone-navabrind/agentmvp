import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford, sorts lexicographically

let lastMs = -1;
let lastRand: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  for (let i = 9; i >= 0; i--) {
    out = B32[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function bumpRandom(r: number[]): number[] {
  const out = r.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] < 31) {
      out[i]++;
      return out;
    }
    out[i] = 0;
  }
  return out; // wrapped; vanishingly unlikely within one millisecond
}

/**
 * Monotonic ULID. Two ids minted in the same millisecond still sort in creation order,
 * which is what lets the event log use id as a stable global cursor.
 */
export function ulid(now: number = Date.now()): string {
  if (now === lastMs) {
    lastRand = bumpRandom(lastRand);
  } else {
    lastMs = now;
    lastRand = Array.from(randomBytes(16)).map((b) => b % 32);
  }
  return encodeTime(now) + lastRand.map((n) => B32[n]).join("");
}
