
/**
 * Generates a purely numeric verification code.
 * Formula: (Prefix * 1,000,000) + (ScoreBucket * 1,000) + SessionSuffix
 * Prefix: 200 - 998 (agent-specific)
 * ScoreBucket: floor(Score / 100), 0 - 999
 * SessionSuffix: 000 - 999
 */
const PREFIX_MIN = 200;
const PREFIX_MAX = 998;
const SCORE_BUCKET_DIVISOR = 100;
const SCORE_BUCKET_MULTIPLIER = 1000;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const hashSeed = (seed: string) => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 2147483647;
  }
  return hash;
};

export const normalizeVerificationPrefix = (prefix?: number): number | null => {
  if (typeof prefix !== 'number' || Number.isNaN(prefix)) return null;
  const rounded = Math.round(prefix);
  if (rounded < PREFIX_MIN || rounded > PREFIX_MAX) return null;
  return rounded;
};

export const generateVerificationPrefix = (seed: string): number => {
  const range = PREFIX_MAX - PREFIX_MIN + 1;
  return PREFIX_MIN + (hashSeed(seed) % range);
};

export const getVerificationMinimum = (prefix: number): number => {
  const cleanPrefix = normalizeVerificationPrefix(prefix) ?? PREFIX_MIN;
  return cleanPrefix * 1_000_000;
};

export const getVerificationMaximum = (): number => 999_999_999;

export async function generateVerificationCode(score: number, sessionSuffix: number, prefix: number): Promise<string> {
  const cleanScore = clampNumber(score, 0, 100000);
  const bucket = Math.min(999, Math.floor(cleanScore / SCORE_BUCKET_DIVISOR));
  const cleanSuffix = clampNumber(sessionSuffix, 0, 999);
  const cleanPrefix = normalizeVerificationPrefix(prefix) ?? PREFIX_MIN;
  const numericCode = (cleanPrefix * 1_000_000) + (bucket * SCORE_BUCKET_MULTIPLIER) + cleanSuffix;
  return numericCode.toString();
}

export function validateWordCount(text: string, min: number, max: number): { ok: boolean; count: number } {
  const trimmed = text.trim();
  const count = trimmed ? trimmed.split(/\s+/).length : 0;
  return {
    ok: count >= min && count <= max,
    count
  };
}
