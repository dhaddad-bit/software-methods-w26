function getEmailProvider() {
  return (process.env.EMAIL_PROVIDER || 'noop').trim().toLowerCase();
}

function isEmailEnabled() {
  return String(process.env.NOTIFICATIONS_EMAIL_ENABLED || '').toLowerCase() === 'true';
}

function buildEmailPayload({ notification }) {
  const payload = notification.payload_json || {};
  return {
    toUserId: notification.recipient_user_id,
    type: notification.type,
    subject: `[Social Scheduler] ${notification.type}`,
    text: JSON.stringify(payload)
  };
}

async function sendEmailViaProvider({ provider, message }) {
  if (provider === 'noop') return { ok: true, provider: 'noop' };

  if (provider === 'sendgrid') {
    if (!process.env.SENDGRID_API_KEY) {
      throw new Error('SENDGRID_API_KEY is required');
    }
    return { ok: true, provider: 'sendgrid', skippedNetwork: true, message };
  }

  if (provider === 'resend') {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required');
    }
    return { ok: true, provider: 'resend', skippedNetwork: true, message };
  }

  throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
}

async function dispatchOutboxMessage({ channel, notification }) {
  if (channel !== 'EMAIL') return { ok: true, skipped: true };
  if (!isEmailEnabled()) return { ok: true, skipped: true, reason: 'email_disabled' };

  const provider = getEmailProvider();
  const message = buildEmailPayload({ notification });
  return sendEmailViaProvider({ provider, message });
}

module.exports = {
  getEmailProvider,
  isEmailEnabled,
  buildEmailPayload,
  sendEmailViaProvider,
  dispatchOutboxMessage
};
