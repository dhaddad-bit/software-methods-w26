class ApiError extends Error {
  constructor({
    message,
    status = 500,
    code = 'INTERNAL_ERROR',
    retryable = false,
    details = null
  } = {}) {
    super(message || 'Unexpected server error');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = Boolean(retryable);
    this.details = details;
  }
}

function inferCodeFromStatus(status) {
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'UNPROCESSABLE_ENTITY';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'API_ERROR';
}

function defaultRetryableForStatus(status) {
  return status >= 500;
}

function normalizeErrorPayload(payload, status, requestId) {
  const code =
    typeof payload?.code === 'string' && payload.code.trim()
      ? payload.code.trim().toUpperCase()
      : inferCodeFromStatus(status);

  const retryable =
    typeof payload?.retryable === 'boolean'
      ? payload.retryable
      : defaultRetryableForStatus(status);

  return {
    ...payload,
    error: payload?.error || payload?.message || 'Unexpected server error',
    code,
    retryable,
    details: payload?.details ?? null,
    requestId: payload?.requestId || requestId || null
  };
}

function sendError(res, error, fallback = {}) {
  const status = Number.isInteger(error?.status) ? error.status : (fallback.status || 500);
  const payload = normalizeErrorPayload(
    {
      error: error?.message || fallback.message || 'Unexpected server error',
      code: error?.code || fallback.code,
      retryable: typeof error?.retryable === 'boolean' ? error.retryable : fallback.retryable,
      details: error?.details ?? fallback.details ?? null
    },
    status,
    res?.req?.requestId || null
  );

  return res.status(status).json(payload);
}

function withRouteGuard(handler, fallback = {}) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (typeof next === 'function') {
        return next(error);
      }
      return sendError(res, error, fallback);
    }
  };
}

module.exports = {
  ApiError,
  inferCodeFromStatus,
  normalizeErrorPayload,
  sendError,
  withRouteGuard
};
