import rateLimiter from '@convex-dev/rate-limiter/test';
import workpool from '@convex-dev/workpool/test';
import { convexTest } from 'convex-test';
import { test } from 'vitest';

import schema from './schema.js';

import type { Doc } from './_generated/dataModel.js';
import type { RuntimeConfig } from './shared.js';

export const modules = import.meta.glob('./**/*.*s');

/**
 * A component under test is its own root, so the components it uses register
 * at their bare names rather than under a parent path.
 */
export const setupTest = () => {
  const t = convexTest(schema, modules);
  rateLimiter.register(t, 'rateLimiter');
  workpool.register(t, 'transactionalPool');
  workpool.register(t, 'bulkPool');
  workpool.register(t, 'callbackPool');
  return t;
};

export type Tester = ReturnType<typeof setupTest>;

test('setup', () => {});

export const testRuntimeConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => ({
  apiKey: 'psk_test_123',
  teamId: 'team_abc',
  clusterId: 'cluster_xyz',
  baseUrl: 'https://app.postshiba.test',
  initialBackoffMs: 1000,
  retryAttempts: 3,
  hourlyLimit: 25,
  bulkShare: 0.7,
  testMode: false,
  testDomains: ['inbound.postshiba.com'],
  ...overrides,
});

export const FINALIZED_EPOCH = Number.MAX_SAFE_INTEGER;

export const insertTestEmail = (
  t: Tester,
  overrides: Partial<Doc<'emails'>> = {},
) =>
  t.run(async (ctx) => {
    const id = await ctx.db.insert('emails', {
      from: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Test email',
      replyTo: [],
      priority: 'transactional',
      status: 'sent',
      bounced: false,
      complained: false,
      failed: false,
      deliveryDelayed: false,
      dropped: false,
      unsubscribed: false,
      opened: false,
      clicked: false,
      providerMessageId: 'abc123@mail.example.com',
      finalizedAt: FINALIZED_EPOCH,
      ...overrides,
    });
    const email = await ctx.db.get('emails', id);
    if (!email) throw new Error('Email not found');
    return email;
  });

export const setLastOptions = (
  t: Tester,
  overrides: Partial<RuntimeConfig> = {},
) =>
  t.run(async (ctx) => {
    const existing = await ctx.db.query('lastOptions').unique();
    const options = testRuntimeConfig(overrides);
    if (existing) {
      await ctx.db.replace('lastOptions', existing._id, { options });
    } else {
      await ctx.db.insert('lastOptions', { options });
    }
  });

let eventCounter = 0;

/**
 * Build one raw webhook array element the way the provider posts it. Every
 * call gets a fresh `sg_event_id`, as every real event does; pass
 * `sg_event_id` in `overrides` to model a redelivery.
 */
export const rawEvent = (
  event: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  event,
  email: 'recipient@example.com',
  timestamp: 1_700_000_000,
  sg_event_id: `evt_${++eventCounter}`,
  sg_message_id: 'provider_internal_1',
  'smtp-id': '<abc123@mail.example.com>',
  ...overrides,
});
