import "server-only";

export const REQUEST_TIMEOUT_MS = 10_000;
export const OPERATION_TIMEOUT_MS = 45_000;

/** Keep both individual requests and multi-request operations within a bounded budget. */
export function deadlineSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
