/** 32-bit FNV-1a over the text's UTF-8 bytes. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

/**
 * Which of 100 buckets a unit falls in for an experiment; the variant gets the buckets below its
 * weight. Part of the wire contract: every PromptHelm SDK must pick the same bucket, so a user
 * sees one version whichever language serves them. Without a unit, every call is picked at random.
 */
export function bucket(experimentId: string, unit?: string | number): number {
  return unit === undefined
    ? Math.floor(Math.random() * 100)
    : fnv1a32(`${experimentId}:${unit}`) % 100;
}

export const LATENCY_BUCKETS = 24;

/**
 * Which of 24 latency buckets a model call's duration falls in, for its percentiles: bucket i
 * holds calls up to 50·2^(i/2) ms (bucket 0 under 50 ms), and the last one everything slower.
 */
export function latencyBucket(ms: number): number {
  return ms < 50 ? 0 : Math.min(LATENCY_BUCKETS - 1, 1 + Math.floor(2 * Math.log2(ms / 50)));
}
