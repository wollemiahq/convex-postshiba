import { describe, expect, it } from 'vitest';

import {
  PostShibaHttpError,
  createSendingDomain,
  createSmtpCredential,
  createTenant,
  deleteSendingDomain,
  deleteSmtpCredential,
  deleteTenant,
  getInboundMessage,
  getSendingDomain,
  getTenant,
  listInboundMessages,
  nonProductionLabel,
  parseWebhookEvents,
  resumeTenant,
  sendEmail,
  sinkAddressFor,
  suspendTenant,
  verifySendingDomain,
  verifyWebhookSignature,
} from './index.js';

const config = {
  apiKey: 'psk_test_123',
  teamId: 'team_abc',
  clusterId: 'cluster_xyz',
};

type Captured = { url: string; init: RequestInit };

function captureFetch(response: Response) {
  const calls: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function okResponse() {
  return jsonResponse(201, {
    queued: true,
    message_id: 'abc123@mail.example.com',
  });
}

describe('sendEmail', () => {
  it('posts to the cluster sends endpoint with a bearer token', async () => {
    const { calls, impl } = captureFetch(okResponse());

    await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/teams/team_abc/clusters/cluster_xyz/sends',
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer psk_test_123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('honours a custom base url without doubling slashes', async () => {
    const { calls, impl } = captureFetch(okResponse());

    await sendEmail(
      { ...config, baseUrl: 'https://eu.postshiba.test/' },
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    );

    expect(calls[0]!.url).toBe(
      'https://eu.postshiba.test/api/v1/teams/team_abc/clusters/cluster_xyz/sends',
    );
  });

  it('sends an Idempotency-Key header when one is supplied', async () => {
    const { calls, impl } = captureFetch(okResponse());

    await sendEmail(
      config,
      {
        from: 'a@example.com',
        to: ['b@example.com'],
        subject: 'Hi',
        idempotencyKey: 'email_1234',
      },
      impl,
    );

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('email_1234');
  });

  it('wraps the payload in a send envelope with snake_case fields', async () => {
    const { calls, impl } = captureFetch(okResponse());

    await sendEmail(
      config,
      {
        from: 'a@example.com',
        to: ['b@example.com'],
        cc: ['c@example.com'],
        bcc: ['d@example.com'],
        replyTo: ['reply@example.com'],
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        headers: { 'X-Entity': '1' },
        uniqueArgs: { convex_email_id: 'email_1234', attempt: 1, live: true },
        tenant: 'tenant_a',
        sandbox: true,
      },
      impl,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      send: {
        from: 'a@example.com',
        to: ['b@example.com'],
        cc: ['c@example.com'],
        bcc: ['d@example.com'],
        reply_to: ['reply@example.com'],
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
        headers: { 'X-Entity': '1' },
        unique_args: { convex_email_id: 'email_1234', attempt: 1, live: true },
        tenant: 'tenant_a',
        sandbox: true,
      },
    });
  });

  it('omits absent optional fields entirely', async () => {
    const { calls, impl } = captureFetch(okResponse());

    await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(Object.keys(body.send).sort()).toEqual([
      'from',
      'subject',
      'tenant',
      'to',
    ]);
  });

  it('names the default tenant when the caller gives none', async () => {
    // A body with no tenant at all is accepted with `queued: false` and
    // never delivered; the explicit default slug queues.
    const { calls, impl } = captureFetch(okResponse());

    await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.send.tenant).toBe('default');
  });

  it('maps a 201 queued response to a SendResult', async () => {
    const { impl } = captureFetch(okResponse());

    const result = await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    );

    expect(result).toEqual({
      queued: true,
      messageId: 'abc123@mail.example.com',
    });
  });

  it('throws a permanent error for a 403 suppressed response', async () => {
    const { impl } = captureFetch(jsonResponse(403, { error: 'suppressed' }));

    const error = await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PostShibaHttpError);
    const httpError = error as PostShibaHttpError;
    expect(httpError.status).toBe(403);
    expect(httpError.code).toBe('suppressed');
    expect(httpError.retryable).toBe(false);
    expect(httpError.body).toContain('suppressed');
  });

  it('treats 409 and 422 as permanent', async () => {
    for (const status of [409, 422]) {
      const { impl } = captureFetch(
        jsonResponse(status, { error: 'idempotency_conflict' }),
      );
      const error = (await sendEmail(
        config,
        { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
        impl,
      ).catch((e: unknown) => e)) as PostShibaHttpError;
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(false);
    }
  });

  it('treats 429 as retryable', async () => {
    const { impl } = captureFetch(jsonResponse(429, { error: 'throttled' }));

    const error = (await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    ).catch((e: unknown) => e)) as PostShibaHttpError;

    expect(error.status).toBe(429);
    expect(error.code).toBe('throttled');
    expect(error.retryable).toBe(true);
  });

  it('treats 503 as retryable', async () => {
    const { impl } = captureFetch(
      new Response('upstream down', { status: 503 }),
    );

    const error = (await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    ).catch((e: unknown) => e)) as PostShibaHttpError;

    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });

  it('rethrows a network failure as a retryable error', async () => {
    const impl = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    const error = (await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    ).catch((e: unknown) => e)) as PostShibaHttpError;

    expect(error).toBeInstanceOf(PostShibaHttpError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(0);
    expect(error.message).toContain('network down');
  });

  it('throws a retryable error when a 2xx body is not the expected shape', async () => {
    const { impl } = captureFetch(jsonResponse(201, { queued: true }));

    const error = (await sendEmail(
      config,
      { from: 'a@example.com', to: ['b@example.com'], subject: 'Hi' },
      impl,
    ).catch((e: unknown) => e)) as PostShibaHttpError;

    expect(error).toBeInstanceOf(PostShibaHttpError);
    expect(error.retryable).toBe(true);
  });
});

const SECRET = 'whsec_topsecret';

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

describe('verifyWebhookSignature', () => {
  const now = 1_700_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const rawBody = '[{"event":"delivered"}]';

  it('accepts a valid signature', async () => {
    const signature = await sign(SECRET, timestamp, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody,
        now,
      }),
    ).resolves.toBe(true);
  });

  it('rejects a signature made with a different secret', async () => {
    const signature = await sign('whsec_other', timestamp, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a tampered body', async () => {
    const signature = await sign(SECRET, timestamp, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody: '[{"event":"bounce"}]',
        now,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a stale timestamp outside the tolerance', async () => {
    const stale = String(Math.floor(now / 1000) - 400);
    const signature = await sign(SECRET, stale, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: stale,
        signature,
        rawBody,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('accepts a stale timestamp when the tolerance is widened', async () => {
    const stale = String(Math.floor(now / 1000) - 400);
    const signature = await sign(SECRET, stale, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: stale,
        signature,
        rawBody,
        toleranceSeconds: 600,
        now,
      }),
    ).resolves.toBe(true);
  });

  it('rejects a future timestamp outside the tolerance', async () => {
    const future = String(Math.floor(now / 1000) + 400);
    const signature = await sign(SECRET, future, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: future,
        signature,
        rawBody,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('requires the sha256= prefix', async () => {
    const signature = await sign(SECRET, timestamp, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature: signature.replace('sha256=', ''),
        rawBody,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a non numeric timestamp', async () => {
    const signature = await sign(SECRET, 'not-a-number', rawBody);
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp: 'not-a-number',
        signature,
        rawBody,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('rejects a signature of a different length without throwing', async () => {
    await expect(
      verifyWebhookSignature({
        secret: SECRET,
        timestamp,
        signature: 'sha256=abcd',
        rawBody,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('rejects an empty secret', async () => {
    const signature = await sign(SECRET, timestamp, rawBody);
    await expect(
      verifyWebhookSignature({
        secret: '',
        timestamp,
        signature,
        rawBody,
        now,
      }),
    ).resolves.toBe(false);
  });
});

describe('parseWebhookEvents', () => {
  it('returns the array of events', () => {
    expect(
      parseWebhookEvents('[{"event":"delivered"},{"event":"bounce"}]'),
    ).toEqual([{ event: 'delivered' }, { event: 'bounce' }]);
  });

  it('throws when the body is a bare object', () => {
    expect(() => parseWebhookEvents('{"event":"delivered"}')).toThrow(/array/i);
  });

  it('throws when the body is not valid JSON', () => {
    expect(() => parseWebhookEvents('not json')).toThrow();
  });
});

describe('nonProductionLabel', () => {
  it('turns the first at sign into _at_', () => {
    expect(nonProductionLabel(['user@example.com'])).toBe(
      'user_at_example.com',
    );
  });

  it('joins several recipients with an underscore', () => {
    expect(nonProductionLabel(['a@example.com', 'b@example.com'])).toBe(
      'a_at_example.com_bexample.com',
    );
  });

  it('strips characters outside the safe local part set', () => {
    expect(nonProductionLabel(['us er+tag@example.com'])).toBe(
      'usertag_at_example.com',
    );
  });
});

describe('sinkAddressFor', () => {
  it('plus addresses the sink local part with the label', () => {
    expect(
      sinkAddressFor('dev@inbound.mail.example.com', ['user@example.com']),
    ).toBe('dev+user_at_example.com@inbound.mail.example.com');
  });

  it('uses the sink domain, not the recipient domain', () => {
    expect(sinkAddressFor('sink@sink.test', ['a@b.co'])).toBe(
      'sink+a_at_b.co@sink.test',
    );
  });
});

const inboxConfig = {
  apiKey: 'psk_test_123',
  baseUrl: 'https://app.postshiba.com',
};

const rawInboundMessage = {
  id: 'OvzDJa',
  inbox_id: 'RvgeJQ',
  to: 'reply+test@inbound.mail.example.com',
  from: 'hi@example.com',
  subject: 'test',
  text: 'test\n',
  html: '<div dir="ltr">test</div>\n',
  thread_id: 'test',
  headers: {
    to: 'reply+test@inbound.mail.example.com',
    date: '2026-09-05T10:07:28+10:00',
    from: 'Example Team <hi@example.com>',
    subject: 'test',
    'message-id': 'CALmvwtRFQ@mail.gmail.com',
  },
  envelope: {
    rcpt_to: 'reply+test@inbound.mail.example.com',
    plus_tag: 'test',
    mail_from: 'hi@example.com',
  },
  authentication: {
    arc: { result: 'none' },
    spf: { result: 'pass', domain: 'example.com' },
    dkim: [{ result: 'pass', domain: 'example.com', selector: '20230601' }],
    dmarc: { result: 'pass', policy: 'reject', aligned: true },
  },
  attachments: [],
  expires_at: '2026-09-12T00:07:43Z',
  drain_status: 'stored',
};

describe('listInboundMessages', () => {
  it('gets the inbox inbound messages endpoint with a bearer token', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(200, [rawInboundMessage]),
    );

    await listInboundMessages(inboxConfig, 'RvgeJQ', impl);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/inboxes/RvgeJQ/inbound_messages',
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer psk_test_123');
  });

  it('maps snake_case fields to camelCase and keeps unknown fields out', async () => {
    const { impl } = captureFetch(jsonResponse(200, [rawInboundMessage]));

    const messages = await listInboundMessages(inboxConfig, 'RvgeJQ', impl);

    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.id).toBe('OvzDJa');
    expect(message.inboxId).toBe('RvgeJQ');
    expect(message.threadId).toBe('test');
    expect(message.expiresAt).toBe('2026-09-12T00:07:43Z');
    expect(message.envelope).toEqual({
      rcptTo: 'reply+test@inbound.mail.example.com',
      plusTag: 'test',
      mailFrom: 'hi@example.com',
    });
    expect(message.authentication).toEqual({
      arc: { result: 'none' },
      spf: { result: 'pass', domain: 'example.com' },
      dkim: [{ result: 'pass', domain: 'example.com', selector: '20230601' }],
      dmarc: { result: 'pass', policy: 'reject', aligned: true },
    });
    expect(message.headers['message-id']).toBe('CALmvwtRFQ@mail.gmail.com');
    expect('drain_status' in message).toBe(false);
    expect('inbox_id' in message).toBe(false);
  });

  it('tolerates a message with no authentication object', async () => {
    const { authentication: _drop, ...withoutAuth } = rawInboundMessage;
    const { impl } = captureFetch(jsonResponse(200, [withoutAuth]));

    const messages = await listInboundMessages(inboxConfig, 'RvgeJQ', impl);

    expect(messages[0]!.authentication).toBeUndefined();
    expect(messages[0]!.attachments).toEqual([]);
  });

  it('accepts a data wrapped list body', async () => {
    const { impl } = captureFetch(
      jsonResponse(200, { data: [rawInboundMessage] }),
    );

    const messages = await listInboundMessages(inboxConfig, 'RvgeJQ', impl);

    expect(messages).toHaveLength(1);
  });

  it('throws a PostShibaHttpError on a non 2xx response', async () => {
    const { impl } = captureFetch(jsonResponse(404, { error: 'not_found' }));

    await expect(
      listInboundMessages(inboxConfig, 'RvgeJQ', impl),
    ).rejects.toBeInstanceOf(PostShibaHttpError);
  });
});

describe('getInboundMessage', () => {
  it('gets one message by id and returns the raw MIME', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(200, { ...rawInboundMessage, raw: 'From: hi@example.com' }),
    );

    const message = await getInboundMessage(
      inboxConfig,
      'RvgeJQ',
      'OvzDJa',
      impl,
    );

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/inboxes/RvgeJQ/inbound_messages/OvzDJa',
    );
    expect(message.raw).toBe('From: hi@example.com');
    expect(message.id).toBe('OvzDJa');
  });

  it('accepts a data wrapped single body', async () => {
    const { impl } = captureFetch(
      jsonResponse(200, { data: rawInboundMessage }),
    );

    const message = await getInboundMessage(
      inboxConfig,
      'RvgeJQ',
      'OvzDJa',
      impl,
    );

    expect(message.id).toBe('OvzDJa');
  });
});

const SENDING_DOMAIN_PAYLOAD = {
  id: 'sd_123',
  name: 'notifications.example.com',
  dkim_status: 'pending',
  return_path_status: 'pending',
  dmarc_status: 'pending',
  dkim_cname_host: 'psd1._domainkey.notifications.example.com',
  dkim_cname_target: 'psd1.dkim.postshiba.com',
  return_path_host: 'psrp.notifications.example.com',
  return_path_target: 'rp.postshiba.com',
  dmarc_host: '_dmarc.notifications.example.com',
  dmarc_record: 'v=DMARC1; p=none;',
  suspended: false,
  primary: false,
};

describe('createSendingDomain', () => {
  it('posts the sending_domain envelope to the team endpoint', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(201, SENDING_DOMAIN_PAYLOAD),
    );

    const domain = await createSendingDomain(
      config,
      'notifications.example.com',
      undefined,
      impl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/teams/team_abc/sending_domains',
    );
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer psk_test_123');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      sending_domain: { name: 'notifications.example.com' },
    });

    expect(domain).toEqual({
      id: 'sd_123',
      name: 'notifications.example.com',
      dkimStatus: 'pending',
      returnPathStatus: 'pending',
      dmarcStatus: 'pending',
      dkimCnameHost: 'psd1._domainkey.notifications.example.com',
      dkimCnameTarget: 'psd1.dkim.postshiba.com',
      returnPathHost: 'psrp.notifications.example.com',
      returnPathTarget: 'rp.postshiba.com',
      dmarcHost: '_dmarc.notifications.example.com',
      dmarcRecord: 'v=DMARC1; p=none;',
      suspended: false,
      primary: false,
    });
  });

  it('unwraps a data envelope and tolerates missing optional fields', async () => {
    const { impl } = captureFetch(
      jsonResponse(201, {
        data: { id: 'sd_min', name: 'a.example.com', dkim_status: 'pending' },
      }),
    );

    const domain = await createSendingDomain(
      config,
      'a.example.com',
      undefined,
      impl,
    );

    expect(domain.id).toBe('sd_min');
    expect(domain.dkimStatus).toBe('pending');
    expect(domain.returnPathStatus).toBeUndefined();
    expect(domain.dkimCnameHost).toBeUndefined();
  });

  it('throws a permanent PostShibaHttpError on 422', async () => {
    const { impl } = captureFetch(jsonResponse(422, { error: 'domain_taken' }));

    await expect(
      createSendingDomain(config, 'taken.example.com', undefined, impl),
    ).rejects.toMatchObject({
      name: 'PostShibaHttpError',
      status: 422,
      code: 'domain_taken',
      retryable: false,
    });
  });
});

describe('getSendingDomain', () => {
  it('reads one domain by id and maps the verification error', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(200, {
        ...SENDING_DOMAIN_PAYLOAD,
        dkim_status: 'verified',
        return_path_status: 'verified',
        last_verification_error: 'CNAME not found',
      }),
    );

    const domain = await getSendingDomain(config, 'sd_123', impl);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/sending_domains/sd_123',
    );
    expect(calls[0]!.init.method).toBe('GET');
    expect(domain.dkimStatus).toBe('verified');
    expect(domain.returnPathStatus).toBe('verified');
    expect(domain.lastVerificationError).toBe('CNAME not found');
  });

  it('throws on a 404', async () => {
    const { impl } = captureFetch(jsonResponse(404, { error: 'not_found' }));

    await expect(getSendingDomain(config, 'gone', impl)).rejects.toMatchObject({
      status: 404,
      retryable: false,
    });
  });
});

describe('verifySendingDomain', () => {
  it('posts to the verify endpoint and returns the current statuses', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(200, { ...SENDING_DOMAIN_PAYLOAD, dkim_status: 'failed' }),
    );

    const domain = await verifySendingDomain(config, 'sd_123', impl);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/sending_domains/sd_123/verify',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(domain.dkimStatus).toBe('failed');
  });
});

describe('deleteSendingDomain', () => {
  it('deletes by id and reports the deletion', async () => {
    const { calls, impl } = captureFetch(new Response(null, { status: 204 }));

    await expect(deleteSendingDomain(config, 'sd_123', impl)).resolves.toBe(
      true,
    );

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/sending_domains/sd_123',
    );
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('treats a 404 as already gone', async () => {
    const { impl } = captureFetch(jsonResponse(404, { error: 'not_found' }));

    await expect(deleteSendingDomain(config, 'gone', impl)).resolves.toBe(
      false,
    );
  });

  it('throws for any other failure', async () => {
    const { impl } = captureFetch(jsonResponse(500, { error: 'boom' }));

    await expect(
      deleteSendingDomain(config, 'sd_123', impl),
    ).rejects.toMatchObject({ status: 500, retryable: true });
  });
});

const TENANT_PAYLOAD = {
  id: 'tn_123',
  name: 'acme-jobs',
  slug: 'acme-jobs',
  suspended: false,
};

describe('createTenant', () => {
  it('posts the tenant envelope to the team endpoint', async () => {
    const { calls, impl } = captureFetch(jsonResponse(201, TENANT_PAYLOAD));

    const tenant = await createTenant(config, 'acme-jobs', impl);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/teams/team_abc/tenants',
    );
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer psk_test_123');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      tenant: { name: 'acme-jobs' },
    });
    expect(tenant).toEqual({
      id: 'tn_123',
      name: 'acme-jobs',
      slug: 'acme-jobs',
      suspended: false,
    });
  });

  it('sends an explicit slug alongside the display name', async () => {
    const { calls, impl } = captureFetch(jsonResponse(201, TENANT_PAYLOAD));

    await createTenant(
      config,
      { name: 'Acme Jobs', slug: 'account-abc123' },
      impl,
    );

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      tenant: { name: 'Acme Jobs', slug: 'account-abc123' },
    });
  });

  it('unwraps a data envelope and tolerates a missing suspended flag', async () => {
    const { impl } = captureFetch(
      jsonResponse(201, {
        data: { id: 'tn_min', name: 'Board', slug: 'board' },
      }),
    );

    const tenant = await createTenant(config, 'Board', impl);

    expect(tenant).toEqual({ id: 'tn_min', name: 'Board', slug: 'board' });
  });

  it('throws a permanent error when billing refuses the tenant', async () => {
    const { impl } = captureFetch(
      jsonResponse(403, { error: 'payment_required' }),
    );

    await expect(createTenant(config, 'acme', impl)).rejects.toMatchObject({
      name: 'PostShibaHttpError',
      status: 403,
      code: 'payment_required',
      retryable: false,
    });
  });
});

describe('getTenant', () => {
  it('reads one tenant by id', async () => {
    const { calls, impl } = captureFetch(jsonResponse(200, TENANT_PAYLOAD));

    const tenant = await getTenant(config, 'tn_123', impl);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/tenants/tn_123',
    );
    expect(calls[0]!.init.method).toBe('GET');
    expect(tenant.slug).toBe('acme-jobs');
  });

  it('throws on a 404', async () => {
    const { impl } = captureFetch(jsonResponse(404, { error: 'not_found' }));

    await expect(getTenant(config, 'gone', impl)).rejects.toMatchObject({
      status: 404,
      retryable: false,
    });
  });
});

describe('suspendTenant and resumeTenant', () => {
  it('posts to the suspend endpoint', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(200, { ...TENANT_PAYLOAD, suspended: true }),
    );

    const tenant = await suspendTenant(config, 'tn_123', impl);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/tenants/tn_123/suspend',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(tenant.suspended).toBe(true);
  });

  it('posts to the resume endpoint', async () => {
    const { calls, impl } = captureFetch(jsonResponse(200, TENANT_PAYLOAD));

    const tenant = await resumeTenant(config, 'tn_123', impl);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/tenants/tn_123/resume',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(tenant.suspended).toBe(false);
  });
});

describe('deleteTenant', () => {
  it('deletes by id and reports the deletion', async () => {
    const { calls, impl } = captureFetch(new Response(null, { status: 204 }));

    await expect(deleteTenant(config, 'tn_123', impl)).resolves.toBe(true);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/tenants/tn_123',
    );
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('treats a 404 as already gone', async () => {
    const { impl } = captureFetch(jsonResponse(404, { error: 'not_found' }));

    await expect(deleteTenant(config, 'gone', impl)).resolves.toBe(false);
  });

  it('throws when the tenant still owns a resource', async () => {
    const { impl } = captureFetch(
      jsonResponse(422, { error: 'tenant_not_empty' }),
    );

    await expect(deleteTenant(config, 'tn_123', impl)).rejects.toMatchObject({
      status: 422,
      code: 'tenant_not_empty',
      retryable: false,
    });
  });
});

describe('createSmtpCredential', () => {
  it('posts the credential envelope to the cluster endpoint', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(201, {
        id: 'sc_123',
        username: 'acme-jobs-1',
        password: 'shown-once-never-stored',
      }),
    );

    const credential = await createSmtpCredential(config, 'tn_123', impl);

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/teams/team_abc/clusters/cluster_xyz/smtp_credentials',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      smtp_credential: { tenant_id: 'tn_123' },
    });
    // The once-only password is dropped rather than returned to a caller
    // that would be tempted to persist it.
    expect(credential).toEqual({ id: 'sc_123', username: 'acme-jobs-1' });
    expect(Object.keys(credential)).not.toContain('password');
  });

  it('throws a permanent error on 422', async () => {
    const { impl } = captureFetch(
      jsonResponse(422, { error: 'tenant_not_found' }),
    );

    await expect(
      createSmtpCredential(config, 'nope', impl),
    ).rejects.toMatchObject({ status: 422, retryable: false });
  });
});

describe('deleteSmtpCredential', () => {
  it('deletes by id under the cluster', async () => {
    const { calls, impl } = captureFetch(new Response(null, { status: 204 }));

    await expect(deleteSmtpCredential(config, 'sc_123', impl)).resolves.toBe(
      true,
    );

    expect(calls[0]!.url).toBe(
      'https://app.postshiba.com/api/v1/teams/team_abc/clusters/cluster_xyz/smtp_credentials/sc_123',
    );
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('treats a 404 as already gone', async () => {
    const { impl } = captureFetch(jsonResponse(404, { error: 'not_found' }));

    await expect(deleteSmtpCredential(config, 'gone', impl)).resolves.toBe(
      false,
    );
  });
});

describe('createSendingDomain under a tenant', () => {
  it('sends tenant_id in the envelope when one is given', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(201, SENDING_DOMAIN_PAYLOAD),
    );

    await createSendingDomain(
      config,
      'notifications.example.com',
      { tenantId: 'tn_123' },
      impl,
    );

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      sending_domain: {
        name: 'notifications.example.com',
        tenant_id: 'tn_123',
      },
    });
  });

  it('omits tenant_id entirely when no tenant is given', async () => {
    const { calls, impl } = captureFetch(
      jsonResponse(201, SENDING_DOMAIN_PAYLOAD),
    );

    await createSendingDomain(
      config,
      'notifications.example.com',
      undefined,
      impl,
    );

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      sending_domain: { name: 'notifications.example.com' },
    });
  });
});
