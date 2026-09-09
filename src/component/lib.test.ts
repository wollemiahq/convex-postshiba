import { Workpool, type WorkId } from '@convex-dev/workpool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, components, internal } from './_generated/api.js';
import {
  FINALIZED_EPOCH,
  insertTestEmail,
  rawEvent,
  setLastOptions,
  setupTest,
  testRuntimeConfig,
  type Tester,
} from './setup.test.js';

import type { Doc, Id } from './_generated/dataModel.js';

type FetchCall = { url: string; init: RequestInit };

function stubFetch(responder: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return responder(call);
  });
  return calls;
}

const okBody = JSON.stringify({
  queued: true,
  message_id: 'abc123@mail.example.com',
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendEmail', () => {
  let t: Tester;

  beforeEach(() => {
    t = setupTest();
  });

  const send = (args: Record<string, unknown> = {}) =>
    t.mutation(api.lib.sendEmail, {
      options: testRuntimeConfig(),
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Welcome',
      html: '<p>Welcome</p>',
      ...args,
    } as never);

  const getEmail = (emailId: string) =>
    t.run(async (ctx) => {
      const email = await ctx.db.get('emails', emailId as Id<'emails'>);
      if (!email) throw new Error('Email not found');
      return email;
    });

  it('stores the bodies and inserts a queued email', async () => {
    const emailId = await send({ text: 'Welcome' });
    const email = await getEmail(emailId);

    expect(email.status).toBe('queued');
    expect(email.priority).toBe('transactional');
    expect(email.subject).toBe('Welcome');
    expect(email.to).toEqual(['recipient@example.com']);
    expect(email.finalizedAt).toBe(FINALIZED_EPOCH);
    expect(email.workId).toBeTypeOf('string');

    const bodies = await t.run(async (ctx) => {
      const html = email.html
        ? await ctx.db.get('content', email.html)
        : undefined;
      const text = email.text
        ? await ctx.db.get('content', email.text)
        : undefined;
      return {
        html: html ? new TextDecoder().decode(html.content) : undefined,
        htmlMime: html?.mimeType,
        text: text ? new TextDecoder().decode(text.content) : undefined,
        textMime: text?.mimeType,
      };
    });
    expect(bodies.html).toBe('<p>Welcome</p>');
    expect(bodies.htmlMime).toBe('text/html');
    expect(bodies.text).toBe('Welcome');
    expect(bodies.textMime).toBe('text/plain');
  });

  it('persists the options so background work can read them', async () => {
    await send();
    const stored = await t.run((ctx) => ctx.db.query('lastOptions').unique());
    expect(stored?.options.clusterId).toBe('cluster_xyz');
  });

  it('replaces the stored options when they change', async () => {
    await send();
    await t.mutation(api.lib.sendEmail, {
      options: testRuntimeConfig({ hourlyLimit: 100 }),
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Welcome',
      html: '<p>Welcome</p>',
    } as never);

    const rows = await t.run((ctx) => ctx.db.query('lastOptions').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.options.hourlyLimit).toBe(100);
  });

  it('rejects an email with neither html nor text', async () => {
    await expect(send({ html: undefined })).rejects.toThrow(/html or text/i);
  });

  it('rejects a blank subject', async () => {
    await expect(send({ subject: '   ' })).rejects.toThrow(/subject/i);
  });

  it('rejects a non test recipient in test mode', async () => {
    await expect(
      t.mutation(api.lib.sendEmail, {
        options: testRuntimeConfig({ testMode: true }),
        from: 'sender@example.com',
        to: ['someone@example.com'],
        subject: 'Welcome',
        html: '<p>Welcome</p>',
      } as never),
    ).rejects.toThrow(/test mode/i);
  });

  it('checks cc and bcc in test mode too', async () => {
    await expect(
      t.mutation(api.lib.sendEmail, {
        options: testRuntimeConfig({ testMode: true }),
        from: 'sender@example.com',
        to: ['someone@inbound.postshiba.com'],
        bcc: ['leak@example.com'],
        subject: 'Welcome',
        html: '<p>Welcome</p>',
      } as never),
    ).rejects.toThrow(/test mode/i);
  });

  it('allows a subdomain of a configured test domain', async () => {
    const emailId = await t.mutation(api.lib.sendEmail, {
      options: testRuntimeConfig({
        testMode: true,
        testDomains: ['mail.example.com'],
      }),
      from: 'sender@example.com',
      to: ['someone@inbound.mail.example.com'],
      subject: 'Welcome',
      html: '<p>Welcome</p>',
    } as never);

    const email = await getEmail(emailId);
    expect(email.status).toBe('queued');
  });

  it('enqueues a transactional email on the transactional pool only', async () => {
    const emailId = await send({ priority: 'transactional' });
    const email = await getEmail(emailId);

    const statuses = await t.run(async (ctx) => ({
      onTransactional: await new Workpool(
        components.transactionalPool,
        {},
      ).status(ctx, email.workId as WorkId),
      onBulk: await new Workpool(components.bulkPool, {}).status(
        ctx,
        email.workId as WorkId,
      ),
    }));

    expect(statuses.onTransactional.state).toBe('pending');
    // The bulk pool never saw this work, so it reads as finished.
    expect(statuses.onBulk.state).toBe('finished');
  });

  it('enqueues a bulk email on the bulk pool only', async () => {
    const emailId = await send({ priority: 'bulk' });
    const email = await getEmail(emailId);
    expect(email.priority).toBe('bulk');

    const statuses = await t.run(async (ctx) => ({
      onBulk: await new Workpool(components.bulkPool, {}).status(
        ctx,
        email.workId as WorkId,
      ),
      onTransactional: await new Workpool(
        components.transactionalPool,
        {},
      ).status(ctx, email.workId as WorkId),
    }));

    expect(statuses.onBulk.state).toBe('pending');
    expect(statuses.onTransactional.state).toBe('finished');
  });
});

describe('deliver', () => {
  let t: Tester;
  let email: Doc<'emails'>;

  beforeEach(async () => {
    t = setupTest();
    await setLastOptions(t);
    email = await insertTestEmail(t, {
      status: 'queued',
      providerMessageId: undefined,
    });
  });

  const getEmail = () =>
    t.run(async (ctx) => {
      const found = await ctx.db.get('emails', email._id);
      if (!found) throw new Error('Email not found');
      return found;
    });

  it('posts the message and returns the provider message id', async () => {
    const calls = stubFetch(() => new Response(okBody, { status: 201 }));

    const result = await t.action(internal.lib.deliver, {
      emailId: email._id,
    });

    expect(result).toEqual({
      emailId: email._id,
      providerMessageId: 'abc123@mail.example.com',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://app.postshiba.test/api/v1/teams/team_abc/clusters/cluster_xyz/sends',
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(email._id);
  });

  it('stamps the correlation id into unique_args', async () => {
    const calls = stubFetch(() => new Response(okBody, { status: 201 }));

    await t.action(internal.lib.deliver, { emailId: email._id });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.send.unique_args.convex_email_id).toBe(email._id);
  });

  it('keeps caller supplied unique_args but never lets them win the correlation key', async () => {
    const withArgs = await insertTestEmail(t, {
      status: 'queued',
      uniqueArgs: { campaign: 'welcome', convex_email_id: 'spoofed' },
    });
    const calls = stubFetch(() => new Response(okBody, { status: 201 }));

    await t.action(internal.lib.deliver, { emailId: withArgs._id });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.send.unique_args).toEqual({
      campaign: 'welcome',
      convex_email_id: withArgs._id,
    });
  });

  it('drops provider reserved unique_args keys', async () => {
    const withArgs = await insertTestEmail(t, {
      status: 'queued',
      uniqueArgs: { event: 'nope', tenant_id: 'nope', ok: 'yes' },
    });
    const calls = stubFetch(() => new Response(okBody, { status: 201 }));

    await t.action(internal.lib.deliver, { emailId: withArgs._id });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.send.unique_args).toEqual({
      ok: 'yes',
      convex_email_id: withArgs._id,
    });
  });

  it('sends the stored bodies, headers, reply-to and tenant', async () => {
    const rich = await t.run(async (ctx) => {
      const html = await ctx.db.insert('content', {
        content: new TextEncoder().encode('<p>Body</p>').buffer,
        mimeType: 'text/html',
      });
      const text = await ctx.db.insert('content', {
        content: new TextEncoder().encode('Body').buffer,
        mimeType: 'text/plain',
      });
      const id = await ctx.db.insert('emails', {
        from: 'sender@example.com',
        to: ['a@example.com'],
        cc: ['c@example.com'],
        bcc: ['b@example.com'],
        subject: 'Rich',
        replyTo: ['reply@example.com'],
        headers: [{ name: 'X-Entity', value: '42' }],
        tenant: 'tenant_a',
        priority: 'transactional',
        html,
        text,
        status: 'queued',
        bounced: false,
        complained: false,
        failed: false,
        deliveryDelayed: false,
        dropped: false,
        unsubscribed: false,
        opened: false,
        clicked: false,
        finalizedAt: FINALIZED_EPOCH,
      });
      return id;
    });
    const calls = stubFetch(() => new Response(okBody, { status: 201 }));

    await t.action(internal.lib.deliver, { emailId: rich });

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.send.html).toBe('<p>Body</p>');
    expect(body.send.text).toBe('Body');
    expect(body.send.cc).toEqual(['c@example.com']);
    expect(body.send.bcc).toEqual(['b@example.com']);
    expect(body.send.reply_to).toEqual(['reply@example.com']);
    expect(body.send.headers).toEqual({ 'X-Entity': '42' });
    expect(body.send.tenant).toBe('tenant_a');
  });

  it('marks the email failed with the error code on a permanent 403', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'suppressed' }), { status: 403 }),
    );

    const result = await t.action(internal.lib.deliver, {
      emailId: email._id,
    });

    expect(result).toBeNull();
    const updated = await getEmail();
    expect(updated.status).toBe('failed');
    expect(updated.failed).toBe(true);
    expect(updated.errorCode).toBe('suppressed');
    expect(updated.errorMessage).toContain('suppressed');
    expect(updated.finalizedAt).toBeLessThan(FINALIZED_EPOCH);
  });

  it('throws on a 429 so the pool retries', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'throttled' }), { status: 429 }),
    );

    await expect(
      t.action(internal.lib.deliver, { emailId: email._id }),
    ).rejects.toThrow(/429|throttled/i);

    const updated = await getEmail();
    expect(updated.status).toBe('queued');
  });

  it('throws on a 500 so the pool retries', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));

    await expect(
      t.action(internal.lib.deliver, { emailId: email._id }),
    ).rejects.toThrow();
  });

  it('marks the email failed when the provider answers 2xx but did not queue it', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            queued: false,
            message_id: 'abc123@mail.example.com',
          }),
          { status: 200 },
        ),
    );

    const result = await t.action(internal.lib.deliver, {
      emailId: email._id,
    });

    expect(result).toBeNull();
    const updated = await getEmail();
    expect(updated.status).toBe('failed');
    expect(updated.errorCode).toBe('not_queued');
  });

  it('skips an email that is no longer queued', async () => {
    const cancelled = await insertTestEmail(t, { status: 'cancelled' });
    const calls = stubFetch(() => new Response(okBody, { status: 201 }));

    const result = await t.action(internal.lib.deliver, {
      emailId: cancelled._id,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('onDeliverComplete', () => {
  let t: Tester;
  let email: Doc<'emails'>;

  beforeEach(async () => {
    t = setupTest();
    await setLastOptions(t);
    email = await insertTestEmail(t, {
      status: 'queued',
      providerMessageId: undefined,
    });
  });

  const getEmail = () =>
    t.run(async (ctx) => {
      const found = await ctx.db.get('emails', email._id);
      if (!found) throw new Error('Email not found');
      return found;
    });

  it('marks the email sent on success', async () => {
    await t.mutation(internal.lib.onDeliverComplete, {
      workId: 'work_1',
      context: { emailId: email._id },
      result: {
        kind: 'success',
        returnValue: {
          emailId: email._id,
          providerMessageId: 'abc123@mail.example.com',
        },
      },
    });

    const updated = await getEmail();
    expect(updated.status).toBe('sent');
    expect(updated.providerMessageId).toBe('abc123@mail.example.com');
  });

  it('still records the provider message id when a webhook already moved the status past queued', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('emails', email._id, { status: 'sent' });
    });

    await t.mutation(internal.lib.onDeliverComplete, {
      workId: 'work_1',
      context: { emailId: email._id },
      result: {
        kind: 'success',
        returnValue: {
          emailId: email._id,
          providerMessageId: 'abc123@mail.example.com',
        },
      },
    });

    const updated = await getEmail();
    expect(updated.status).toBe('sent');
    expect(updated.providerMessageId).toBe('abc123@mail.example.com');
  });

  it('leaves the email alone when the action returned null', async () => {
    await t.mutation(internal.lib.onDeliverComplete, {
      workId: 'work_1',
      context: { emailId: email._id },
      result: { kind: 'success', returnValue: null },
    });

    expect((await getEmail()).status).toBe('queued');
  });

  it('marks the email failed when every retry is exhausted', async () => {
    await t.mutation(internal.lib.onDeliverComplete, {
      workId: 'work_1',
      context: { emailId: email._id },
      result: { kind: 'failed', error: 'PostShiba send failed with 503' },
    });

    const updated = await getEmail();
    expect(updated.status).toBe('failed');
    expect(updated.failed).toBe(true);
    expect(updated.errorMessage).toContain('503');
  });

  it('marks the email cancelled when the work is canceled', async () => {
    await t.mutation(internal.lib.onDeliverComplete, {
      workId: 'work_1',
      context: { emailId: email._id },
      result: { kind: 'canceled' },
    });

    expect((await getEmail()).status).toBe('cancelled');
  });
});

describe('handleEvents', () => {
  let t: Tester;
  let email: Doc<'emails'>;

  beforeEach(async () => {
    t = setupTest();
    await setLastOptions(t);
    email = await insertTestEmail(t, { status: 'sent' });
  });

  const getEmail = () =>
    t.run(async (ctx) => {
      const found = await ctx.db.get('emails', email._id);
      if (!found) throw new Error('Email not found');
      return found;
    });

  const correlated = (event: string, overrides: Record<string, unknown> = {}) =>
    rawEvent(event, {
      unique_args: { convex_email_id: email._id },
      ...overrides,
    });

  it('correlates by unique_args and records the event', async () => {
    const result = await t.mutation(api.lib.handleEvents, {
      events: [correlated('delivered')],
    });

    expect(result).toEqual({
      applied: 1,
      ignored: 0,
      invalid: 0,
      duplicates: 0,
      callbacks: 0,
    });
    expect((await getEmail()).status).toBe('delivered');

    const events = await t.run((ctx) =>
      ctx.db
        .query('deliveryEvents')
        .withIndex('by_emailId_eventType', (q) => q.eq('emailId', email._id))
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('delivered');
    expect(events[0]!.occurredAt).toBe(1_700_000_000_000);
    expect(events[0]!.raw).toMatchObject({
      sg_event_id: expect.stringMatching(/^evt_/),
    });
  });

  it('applies a redelivered event only once, keyed on sg_event_id', async () => {
    await setLastOptions(t, {
      onEmailEvent: { fnHandle: 'function://callback' },
    });
    const first = await t.mutation(api.lib.handleEvents, {
      events: [correlated('delivered', { sg_event_id: 'evt_dup' })],
    });
    const second = await t.mutation(api.lib.handleEvents, {
      events: [correlated('delivered', { sg_event_id: 'evt_dup' })],
    });

    expect(first).toMatchObject({ applied: 1, duplicates: 0, callbacks: 1 });
    expect(second).toMatchObject({ applied: 0, duplicates: 1, callbacks: 0 });

    const events = await t.run((ctx) =>
      ctx.db
        .query('deliveryEvents')
        .withIndex('by_emailId_eventType', (q) => q.eq('emailId', email._id))
        .collect(),
    );
    expect(events).toHaveLength(1);
  });

  it('still records two distinct events that lack an sg_event_id', async () => {
    const result = await t.mutation(api.lib.handleEvents, {
      events: [
        correlated('processed', { sg_event_id: undefined }),
        correlated('delivered', { sg_event_id: undefined }),
      ],
    });

    expect(result).toMatchObject({ applied: 2, duplicates: 0 });
  });

  it('correlates by a flattened convex_email_id', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [rawEvent('delivered', { convex_email_id: email._id })],
    });

    expect((await getEmail()).status).toBe('delivered');
  });

  it('falls back to the smtp-id when there is no correlation id', async () => {
    const result = await t.mutation(api.lib.handleEvents, {
      events: [rawEvent('delivered')],
    });

    expect(result.applied).toBe(1);
    expect((await getEmail()).status).toBe('delivered');
  });

  it('ignores an event for an unknown email', async () => {
    const result = await t.mutation(api.lib.handleEvents, {
      events: [rawEvent('delivered', { 'smtp-id': '<nobody@example.com>' })],
    });

    expect(result).toEqual({
      applied: 0,
      ignored: 1,
      invalid: 0,
      duplicates: 0,
      callbacks: 0,
    });
    expect((await getEmail()).status).toBe('sent');
  });

  it('skips a malformed element and still applies the rest', async () => {
    const result = await t.mutation(api.lib.handleEvents, {
      events: [
        'not an object',
        { event: 'not_a_known_event' },
        correlated('delivered'),
      ],
    });

    expect(result).toEqual({
      applied: 1,
      ignored: 0,
      invalid: 2,
      duplicates: 0,
      callbacks: 0,
    });
    expect((await getEmail()).status).toBe('delivered');
  });

  it('throws when the payload is not an array', async () => {
    await expect(
      t.mutation(api.lib.handleEvents, { events: { event: 'delivered' } }),
    ).rejects.toThrow(/array/i);
  });

  it('upgrades queued through processed and delivered', async () => {
    const queued = await insertTestEmail(t, { status: 'queued' });
    await t.mutation(api.lib.handleEvents, {
      events: [
        rawEvent('processed', { unique_args: { convex_email_id: queued._id } }),
      ],
    });
    const afterProcessed = await t.run((ctx) =>
      ctx.db.get('emails', queued._id),
    );
    expect(afterProcessed?.status).toBe('sent');

    await t.mutation(api.lib.handleEvents, {
      events: [
        rawEvent('delivered', { unique_args: { convex_email_id: queued._id } }),
      ],
    });
    const afterDelivered = await t.run((ctx) =>
      ctx.db.get('emails', queued._id),
    );
    expect(afterDelivered?.status).toBe('delivered');
    expect(afterDelivered?.finalizedAt).toBeLessThan(FINALIZED_EPOCH);
  });

  it('does not downgrade a bounced email when a delivered event arrives late', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [correlated('bounce', { reason: '550 mailbox unavailable' })],
    });
    expect((await getEmail()).status).toBe('bounced');

    await t.mutation(api.lib.handleEvents, {
      events: [correlated('delivered')],
    });

    const updated = await getEmail();
    expect(updated.status).toBe('bounced');
    expect(updated.bounced).toBe(true);
    expect(updated.errorMessage).toBe('550 mailbox unavailable');
  });

  it('never moves a cancelled email', async () => {
    const cancelled = await insertTestEmail(t, { status: 'cancelled' });
    await t.mutation(api.lib.handleEvents, {
      events: [
        rawEvent('delivered', {
          unique_args: { convex_email_id: cancelled._id },
        }),
      ],
    });

    const updated = await t.run((ctx) => ctx.db.get('emails', cancelled._id));
    expect(updated?.status).toBe('cancelled');
  });

  it('sets deliveryDelayed on a deferred event', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [correlated('deferred', { response: '451 try later' })],
    });

    const updated = await getEmail();
    expect(updated.deliveryDelayed).toBe(true);
    expect(updated.status).toBe('delivery_delayed');
  });

  it('uses the response when a bounce carries no reason', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [correlated('bounce', { response: '554 rejected' })],
    });

    expect((await getEmail()).errorMessage).toBe('554 rejected');
  });

  it('fails the email on a dropped event', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [correlated('dropped', { reason: 'Bounced Address' })],
    });

    const updated = await getEmail();
    expect(updated.dropped).toBe(true);
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('Bounced Address');
  });

  it('sets complained on a spamreport event', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [correlated('spamreport')],
    });

    const updated = await getEmail();
    expect(updated.complained).toBe(true);
    expect(updated.status).toBe('sent');
  });

  it('sets unsubscribed on unsubscribe and group_unsubscribe', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [correlated('unsubscribe')],
    });
    expect((await getEmail()).unsubscribed).toBe(true);

    const other = await insertTestEmail(t, {
      providerMessageId: 'other@mail.example.com',
    });
    await t.mutation(api.lib.handleEvents, {
      events: [
        rawEvent('group_unsubscribe', {
          unique_args: { convex_email_id: other._id },
        }),
      ],
    });
    const updated = await t.run((ctx) => ctx.db.get('emails', other._id));
    expect(updated?.unsubscribed).toBe(true);
  });

  it('sets opened and clicked', async () => {
    await t.mutation(api.lib.handleEvents, {
      events: [correlated('open'), correlated('click')],
    });

    const updated = await getEmail();
    expect(updated.opened).toBe(true);
    expect(updated.clicked).toBe(true);
  });

  it('enqueues the callback when one is configured', async () => {
    await setLastOptions(t, { onEmailEvent: { fnHandle: 'function://noop' } });

    const result = await t.mutation(api.lib.handleEvents, {
      events: [correlated('delivered'), correlated('open')],
    });

    expect(result.callbacks).toBe(2);
  });

  it('does not enqueue a callback when none is configured', async () => {
    const result = await t.mutation(api.lib.handleEvents, {
      events: [correlated('delivered')],
    });

    expect(result.callbacks).toBe(0);
    expect((await getEmail()).status).toBe('delivered');
  });
});

describe('cancelEmail', () => {
  let t: Tester;

  beforeEach(() => {
    t = setupTest();
  });

  it('cancels a queued email', async () => {
    const email = await insertTestEmail(t, { status: 'queued' });
    await t.mutation(api.lib.cancelEmail, { emailId: email._id });

    const updated = await t.run((ctx) => ctx.db.get('emails', email._id));
    expect(updated?.status).toBe('cancelled');
    expect(updated?.finalizedAt).toBeLessThan(FINALIZED_EPOCH);
  });

  it('refuses to cancel an email that already went out', async () => {
    const email = await insertTestEmail(t, { status: 'sent' });
    await expect(
      t.mutation(api.lib.cancelEmail, { emailId: email._id }),
    ).rejects.toThrow(/already/i);
  });

  it('throws for an unknown email', async () => {
    const email = await insertTestEmail(t, { status: 'queued' });
    await t.run((ctx) => ctx.db.delete('emails', email._id));
    await expect(
      t.mutation(api.lib.cancelEmail, { emailId: email._id }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('getStatus and get', () => {
  let t: Tester;

  beforeEach(() => {
    t = setupTest();
  });

  it('returns null for an unknown email', async () => {
    const email = await insertTestEmail(t);
    await t.run((ctx) => ctx.db.delete('emails', email._id));

    expect(await t.query(api.lib.getStatus, { emailId: email._id })).toBeNull();
    expect(await t.query(api.lib.get, { emailId: email._id })).toBeNull();
  });

  it('reports the flags', async () => {
    const email = await insertTestEmail(t, {
      status: 'bounced',
      bounced: true,
      errorMessage: '550',
    });

    expect(await t.query(api.lib.getStatus, { emailId: email._id })).toEqual({
      status: 'bounced',
      errorMessage: '550',
      errorCode: null,
      bounced: true,
      complained: false,
      failed: false,
      deliveryDelayed: false,
      dropped: false,
      unsubscribed: false,
      opened: false,
      clicked: false,
    });
  });

  it('decodes the bodies', async () => {
    const emailId = await t.mutation(api.lib.sendEmail, {
      options: testRuntimeConfig(),
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Welcome',
      html: '<p>Welcome</p>',
      text: 'Welcome',
    } as never);

    const email = await t.query(api.lib.get, { emailId });
    expect(email?.html).toBe('<p>Welcome</p>');
    expect(email?.text).toBe('Welcome');
    expect(email?.createdAt).toBeTypeOf('number');
  });
});

describe('cleanup', () => {
  let t: Tester;

  beforeEach(() => {
    t = setupTest();
  });

  it('removes finalized emails with their bodies and events', async () => {
    const { emailId } = await t.run(async (ctx) => {
      const html = await ctx.db.insert('content', {
        content: new TextEncoder().encode('<p>Old</p>').buffer,
        mimeType: 'text/html',
      });
      const id = await ctx.db.insert('emails', {
        from: 'sender@example.com',
        to: ['recipient@example.com'],
        subject: 'Old',
        replyTo: [],
        priority: 'transactional',
        html,
        status: 'delivered',
        bounced: false,
        complained: false,
        failed: false,
        deliveryDelayed: false,
        dropped: false,
        unsubscribed: false,
        opened: false,
        clicked: false,
        finalizedAt: Date.now() - 1000 * 60 * 60 * 24 * 30,
      });
      await ctx.db.insert('deliveryEvents', {
        emailId: id,
        eventType: 'delivered',
        occurredAt: Date.now(),
        raw: {},
      });
      return { emailId: id };
    });

    await t.mutation(api.lib.cleanupOldEmails, {});

    const remaining = await t.run(async (ctx) => ({
      emails: await ctx.db.query('emails').collect(),
      content: await ctx.db.query('content').collect(),
      events: await ctx.db.query('deliveryEvents').collect(),
    }));
    expect(remaining.emails).toHaveLength(0);
    expect(remaining.content).toHaveLength(0);
    expect(remaining.events).toHaveLength(0);
    expect(emailId).toBeTypeOf('string');
  });

  it('keeps emails that are still live', async () => {
    await insertTestEmail(t, { status: 'queued' });
    await t.mutation(api.lib.cleanupOldEmails, {});

    const remaining = await t.run((ctx) => ctx.db.query('emails').collect());
    expect(remaining).toHaveLength(1);
  });

  it('removes abandoned emails regardless of status', async () => {
    await insertTestEmail(t, { status: 'queued' });
    await t.mutation(api.lib.cleanupAbandonedEmails, { olderThan: -1 });

    const remaining = await t.run((ctx) => ctx.db.query('emails').collect());
    expect(remaining).toHaveLength(0);
  });

  /**
   * Batches are sized in rows but paid for in bytes: every deleted email
   * also drops up to two content docs of up to 1 MB each plus its delivery
   * events. A batch large enough to blow the transaction read budget fails
   * on the same oldest rows every night, so retention stalls for good
   * rather than falling behind. Both sweeps therefore cap at 50 rows and
   * reschedule themselves while more remain.
   */
  const CLEANUP_BATCH_SIZE = 50;

  async function scheduledCleanupCount(t: Tester, name: string) {
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query('_scheduled_functions').collect(),
    );
    return scheduled.filter((s) => String(s.name).includes(name)).length;
  }

  it('deletes finalized emails one bounded batch at a time', async () => {
    const finalizedAt = Date.now() - 1000 * 60 * 60 * 24 * 30;
    for (let i = 0; i < CLEANUP_BATCH_SIZE + 1; i += 1) {
      await insertTestEmail(t, { status: 'delivered', finalizedAt });
    }

    await t.mutation(api.lib.cleanupOldEmails, {});

    const remaining = await t.run((ctx) => ctx.db.query('emails').collect());
    expect(remaining).toHaveLength(1);
    expect(await scheduledCleanupCount(t, 'cleanupOldEmails')).toBe(1);
  });

  it('deletes abandoned emails one bounded batch at a time', async () => {
    for (let i = 0; i < CLEANUP_BATCH_SIZE + 1; i += 1) {
      await insertTestEmail(t, { status: 'queued' });
    }

    await t.mutation(api.lib.cleanupAbandonedEmails, { olderThan: -1 });

    const remaining = await t.run((ctx) => ctx.db.query('emails').collect());
    expect(remaining).toHaveLength(1);
    expect(await scheduledCleanupCount(t, 'cleanupAbandonedEmails')).toBe(1);
  });
});
