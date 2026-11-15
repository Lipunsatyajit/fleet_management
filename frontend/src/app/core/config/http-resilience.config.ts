export const httpResilienceConfig = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  retryDelayMs: 300,
} as const;
