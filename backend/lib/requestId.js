const crypto = require('crypto');

function generateRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function attachRequestId(req, res, next) {
  const incoming = typeof req.get === 'function' ? req.get('x-request-id') : null;
  const requestId = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : generateRequestId();

  req.requestId = requestId;
  res.set('x-request-id', requestId);
  next();
}

function logRequestCompletion({ logger = console.log } = {}) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const isApiRoute = req.path.startsWith('/api') || req.path.startsWith('/test');
      if (!isApiRoute) return;

      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      logger(
        `[${req.requestId || 'no-request-id'}] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`
      );
    });

    next();
  };
}

module.exports = {
  attachRequestId,
  generateRequestId,
  logRequestCompletion
};
