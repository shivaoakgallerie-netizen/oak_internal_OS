// Provider exceptions can contain request headers or response bodies. Persist only
// a status code or a generic failure, never the raw exception text.
export function safeProviderError(error) {
  if (error?.message === 'Email fallback unavailable: no notification address is configured. Enable device push and monitor the in-app inbox.' ||
      error?.message === 'Email delivery provider is not configured.') return error.message;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'Provider timed out';
  const status = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? `Provider returned HTTP ${status}` : 'Provider request failed';
}
