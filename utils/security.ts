
/**
 * Generates a purely numeric verification code.
 * Formula: (Score * 10000) + SessionSuffix
 * Score: 0 - 100,000
 * SessionSuffix: 0000 - 9999
 * Resulting code is a number up to 1,000,099,999.
 */
export async function generateVerificationCode(score: number, sessionSuffix: number): Promise<string> {
  // Ensure score is within bounds and rounded
  const cleanScore = Math.min(100000, Math.max(0, Math.round(score)));
  // Ensure suffix is exactly 4 digits
  const cleanSuffix = Math.min(9999, Math.max(0, Math.round(sessionSuffix)));
  
  // Calculate the numeric code
  const numericCode = (cleanScore * 10000) + cleanSuffix;
  
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
