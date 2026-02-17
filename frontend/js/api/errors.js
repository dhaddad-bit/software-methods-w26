export function toUiError(payload, status) {
  const error = payload && typeof payload === "object" ? payload : {};

  return {
    error: error.error || error.message || "Request failed",
    code: typeof error.code === "string" && error.code ? error.code : "API_ERROR",
    retryable: typeof error.retryable === "boolean" ? error.retryable : status >= 500,
    details: error.details ?? null,
    requestId: error.requestId || null,
    status
  };
}
