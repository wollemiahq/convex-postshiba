import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostShiba, WEBHOOK_BATCH_SIZE } from './index.js';
import { components, setupTest, type Tester } from './setup.test.js';

const WEBHOOK_SECRET = 'whsec_topsecret';

const ENV_KEYS = [
  'POSTSHIBA_API_KEY',
  'POSTSHIBA_TEAM_ID',
  'POSTSHIBA_CLUSTER_ID',
  'POSTSHIBA_WEBHOOK_SECRET',
  'POSTSHIBA_API_BASE',
] as const;

function clearEnv() {
  const env = (globalThis as { process?: { env: Record<string, string> } })
    .process?.env;
  if (!env) return;
  for (const key of ENV_KEYS) delete env[key];
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const env = (globalThis as { process?: { env: Record<string, string> } })
    .process?.env;
  if (!env) throw new Error('No process.env in this environment');
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) env[key] = value;
  }
}

async function sign(secret: string, timestamp: string, rawBody: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

async function webhookRequest(rawBody: string, secret = WEBHOOK_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request('https://example.convex.site/postshiba/webhook', {
    method: 'POST',
    body: rawBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Capsule-Timestamp': timestamp,
      'X-Capsule-Signature': await sign(secret, timestamp, rawBody),
    },
  });
}

afterEach(clearEnv);

describe('options', () => {
  beforeEach(clearEnv);

  it('reads its defaults from the environment', () => {
    setEnv({
      POSTSHIBA_API_KEY: 'psk_env',
      POSTSHIBA_TEAM_ID: 'team_env',
      POSTSHIBA_CLUSTER_ID: 'cluster_env',
      POSTSHIBA_WEBHOOK_SECRET: 'whsec_env',
      POSTSHIBA_API_BASE: 'https://eu.postshiba.test',
    });

    const client = new PostShiba(components.postshiba);

    expect(client.config.apiKey).toBe('psk_env');
    expect(client.config.teamId).toBe('team_env');
    expect(client.config.clusterId).toBe('cluster_env');
    expect(client.config.webhookSecret).toBe('whsec_env');
    expect(client.config.baseUrl).toBe('https://eu.postshiba.test');
  });

  it('prefers explicit options over the environment', () => {
    setEnv({ POSTSHIBA_API_KEY: 'psk_env' });

    const client = new PostShiba(components.postshiba, {
      apiKey: 'psk_explicit',
    });

    expect(client.config.apiKey).toBe('psk_explicit');
  });

  it('falls back to documented defaults', () => {
    const client = new PostShiba(components.postshiba);

    expect(client.config.apiKey).toBe('');
    expect(client.config.baseUrl).toBe('https://app.postshiba.com');
    expect(client.config.initialBackoffMs).toBe(30000);
    expect(client.config.retryAttempts).toBe(5);
    expect(client.config.hourlyLimit).toBe(25);
    expect(client.config.bulkShare).toBe(0.7);
    expect(client.config.testMode).toBe(true);
    expect(client.config.testDomains).toEqual(['inbound.postshiba.com']);
    expect(client.config.signatureToleranceSeconds).toBe(300);
  });
});

describe('sendEmail', () => {
  let t: Tester;
  let client: PostShiba;

  beforeEach(() => {
    clearEnv();
    t = setupTest();
    client = new PostShiba(components.postshiba, {
      apiKey: 'psk_test',
      teamId: 'team_abc',
      clusterId: 'cluster_xyz',
      webhookSecret: WEBHOOK_SECRET,
      testMode: false,
    });
  });

  it('refuses to send without an api key', async () => {
    const unconfigured = new PostShiba(components.postshiba, {
      teamId: 'team_abc',
      clusterId: 'cluster_xyz',
    });

    await expect(
      t.run((ctx) =>
        unconfigured.sendEmail(ctx, {
          from: 'a@example.com',
          to: 'b@example.com',
          subject: 'Hi',
          text: 'Hi',
        }),
      ),
    ).rejects.toThrow(/api key/i);
  });

  it('refuses to send without a team or cluster', async () => {
    const unconfigured = new PostShiba(components.postshiba, {
      apiKey: 'psk_test',
    });

    await expect(
      t.run((ctx) =>
        unconfigured.sendEmail(ctx, {
          from: 'a@example.com',
          to: 'b@example.com',
          subject: 'Hi',
          text: 'Hi',
        }),
      ),
    ).rejects.toThrow(/team|cluster/i);
  });

  it('normalizes a single recipient into an array and returns the id', async () => {
    const emailId = await t.run((ctx) =>
      client.sendEmail(ctx, {
        from: 'a@example.com',
        to: 'b@example.com',
        cc: 'c@example.com',
        replyTo: 'reply@example.com',
        subject: 'Hi',
        text: 'Hi',
      }),
    );

    const email = await t.run((ctx) => client.get(ctx, emailId));
    expect(email?.to).toEqual(['b@example.com']);
    expect(email?.cc).toEqual(['c@example.com']);
    expect(email?.replyTo).toEqual(['reply@example.com']);
    expect(email?.priority).toBe('transactional');
    expect(email?.text).toBe('Hi');
  });

  it('passes the bulk priority through', async () => {
    const emailId = await t.run((ctx) =>
      client.sendEmail(ctx, {
        from: 'a@example.com',
        to: 'b@example.com',
        subject: 'Hi',
        text: 'Hi',
        priority: 'bulk',
      }),
    );

    const status = await t.run((ctx) => client.status(ctx, emailId));
    expect(status?.status).toBe('queued');
    const email = await t.run((ctx) => client.get(ctx, emailId));
    expect(email?.priority).toBe('bulk');
  });

  it('cancels a queued email', async () => {
    const emailId = await t.run((ctx) =>
      client.sendEmail(ctx, {
        from: 'a@example.com',
        to: 'b@example.com',
        subject: 'Hi',
        text: 'Hi',
      }),
    );

    await t.run((ctx) => client.cancelEmail(ctx, emailId));
    const status = await t.run((ctx) => client.status(ctx, emailId));
    expect(status?.status).toBe('cancelled');
  });
});

describe('handleEventWebhook', () => {
  let t: Tester;
  let client: PostShiba;

  beforeEach(() => {
    clearEnv();
    t = setupTest();
    client = new PostShiba(components.postshiba, {
      apiKey: 'psk_test',
      teamId: 'team_abc',
      clusterId: 'cluster_xyz',
      webhookSecret: WEBHOOK_SECRET,
      testMode: false,
    });
  });

  /**
   * `t.run` serializes what the callback returns as a Convex value, and a
   * `Response` is not one, so unwrap it inside the transaction.
   */
  const post = (request: Request, using: PostShiba = client) =>
    t.run(async (ctx) => {
      const response = await using.handleEventWebhook(ctx, request);
      return { status: response.status, body: await response.text() };
    });

  it('throws when no webhook secret is configured', async () => {
    const unsigned = new PostShiba(components.postshiba, {
      apiKey: 'psk_test',
      teamId: 'team_abc',
      clusterId: 'cluster_xyz',
    });

    await expect(post(await webhookRequest('[]'), unsigned)).rejects.toThrow(
      /webhook secret/i,
    );
  });

  it('answers 401 when the signature does not verify', async () => {
    const response = await post(await webhookRequest('[]', 'whsec_wrong'));
    expect(response.status).toBe(401);
  });

  it('answers 401 when the signature header is missing', async () => {
    const response = await post(
      new Request('https://example.convex.site/webhook', {
        method: 'POST',
        body: '[]',
      }),
    );
    expect(response.status).toBe(401);
  });

  it('answers 400 when the body is not an array', async () => {
    const response = await post(await webhookRequest('{"event":"delivered"}'));
    expect(response.status).toBe(400);
  });

  it('answers 200 and applies a well formed array', async () => {
    const emailId = await t.run((ctx) =>
      client.sendEmail(ctx, {
        from: 'a@example.com',
        to: 'b@example.com',
        subject: 'Hi',
        text: 'Hi',
      }),
    );

    const body = JSON.stringify([
      {
        event: 'delivered',
        email: 'b@example.com',
        timestamp: 1_700_000_000,
        unique_args: { convex_email_id: emailId },
      },
    ]);

    const response = await post(await webhookRequest(body));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).applied).toBe(1);

    const status = await t.run((ctx) => client.status(ctx, emailId));
    expect(status?.status).toBe('delivered');
  });

  it('applies a large batch in bounded chunks', async () => {
    const emailId = await t.run((ctx) =>
      client.sendEmail(ctx, {
        from: 'a@example.com',
        to: 'b@example.com',
        subject: 'Hi',
        text: 'Hi',
      }),
    );

    const count = WEBHOOK_BATCH_SIZE * 2 + 1;
    const body = JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        event: 'deferred',
        email: 'b@example.com',
        timestamp: 1_700_000_000 + index,
        sg_event_id: `evt_${index}`,
        unique_args: { convex_email_id: emailId },
      })),
    );

    const request = await webhookRequest(body);
    const result = await t.run(async (ctx) => {
      const runMutation = vi.fn(ctx.runMutation.bind(ctx));
      const response = await client.handleEventWebhook(
        { ...ctx, runMutation } as typeof ctx,
        request,
      );
      return {
        status: response.status,
        body: await response.text(),
        calls: runMutation.mock.calls.length,
      };
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).applied).toBe(count);
    expect(result.calls).toBe(3);
  });

  it('answers 200 for an empty array', async () => {
    const response = await post(await webhookRequest('[]'));
    expect(response.status).toBe(200);
  });
});
