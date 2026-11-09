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
