process.env.NODE_ENV = 'test';

const provider = require('../outbox/provider');

describe('outbox/provider', () => {
  beforeEach(() => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.NOTIFICATIONS_EMAIL_ENABLED;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.RESEND_API_KEY;
  });

  test('provider helpers and noop dispatch behavior', async () => {
    expect(provider.getEmailProvider()).toBe('noop');
    expect(provider.isEmailEnabled()).toBe(false);

    const skipped = await provider.dispatchOutboxMessage({
      channel: 'EMAIL',
      notification: {
        recipient_user_id: 1,
        type: 'PETITION_CREATED',
        payload_json: {}
      }
    });
    expect(skipped).toMatchObject({ ok: true, skipped: true, reason: 'email_disabled' });

    process.env.NOTIFICATIONS_EMAIL_ENABLED = 'true';
    const sent = await provider.dispatchOutboxMessage({
      channel: 'EMAIL',
      notification: {
        recipient_user_id: 1,
        type: 'PETITION_CREATED',
        payload_json: { petitionId: 10 }
      }
    });
    expect(sent).toMatchObject({ ok: true, provider: 'noop' });
  });

  test('provider-specific branches validate required credentials', async () => {
    const message = {
      toUserId: 7,
      type: 'PETITION_STATUS',
      subject: 'subject',
      text: '{}'
    };

    await expect(
      provider.sendEmailViaProvider({
        provider: 'sendgrid',
        message
      })
    ).rejects.toThrow('SENDGRID_API_KEY is required');

    process.env.SENDGRID_API_KEY = 'x';
    await expect(
      provider.sendEmailViaProvider({
        provider: 'sendgrid',
        message
      })
    ).resolves.toMatchObject({
      ok: true,
      provider: 'sendgrid',
      skippedNetwork: true
    });

    await expect(
      provider.sendEmailViaProvider({
        provider: 'resend',
        message
      })
    ).rejects.toThrow('RESEND_API_KEY is required');

    process.env.RESEND_API_KEY = 'y';
    await expect(
      provider.sendEmailViaProvider({
        provider: 'resend',
        message
      })
    ).resolves.toMatchObject({
      ok: true,
      provider: 'resend',
      skippedNetwork: true
    });

    await expect(
      provider.sendEmailViaProvider({
        provider: 'unknown',
        message
      })
    ).rejects.toThrow('Unsupported EMAIL_PROVIDER');
  });
});

describe('outbox/run_worker', () => {
  test('parseArgs parses limit and main writes result', async () => {
    jest.resetModules();
    jest.doMock('../outbox/worker', () => ({
      processOutboxBatch: jest.fn(async () => ({
        claimed: 3,
        sent: 2,
        failed: 1,
        dead: 0
      }))
    }));
    jest.doMock('../outbox/provider', () => ({
      dispatchOutboxMessage: jest.fn(async () => ({ ok: true }))
    }));

    const runWorker = require('../outbox/run_worker');
    expect(runWorker.parseArgs(['--limit', '13'])).toMatchObject({ limit: 13 });
    expect(runWorker.parseArgs(['--limit', 'bad'])).toMatchObject({ limit: 25 });

    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runWorker.main();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('"claimed":3'));
    writeSpy.mockRestore();

    jest.dontMock('../outbox/worker');
    jest.dontMock('../outbox/provider');
  });
});
