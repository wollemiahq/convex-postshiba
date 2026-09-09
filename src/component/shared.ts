import { literals } from 'convex-helpers/validators';
import { type Infer, v } from 'convex/values';

import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from 'convex/server';

/** Validator for the `onEmailEvent` option. */
export const vOnEmailEvent = v.object({
  fnHandle: v.string(),
});

/** Lifecycle of an email inside the component. */
export const vStatus = v.union(
  v.literal('queued'),
  v.literal('cancelled'),
  v.literal('sent'),
  v.literal('delivered'),
  v.literal('delivery_delayed'),
  v.literal('bounced'),
  v.literal('failed'),
);
export type Status = Infer<typeof vStatus>;

/** Which of the two sending pools an email is enqueued on. */
export const vPriority = v.union(v.literal('transactional'), v.literal('bulk'));
export type Priority = Infer<typeof vPriority>;

/**
 * Event names accepted on the webhook. The first seven are what PostShiba
 * emits today; the remaining four are accepted so an endpoint shared with an
 * engagement tracking provider does not fail.
 */
export const ACCEPTED_EVENT_TYPES = [
  'processed',
  'delivered',
  'deferred',
  'bounce',
  'dropped',
  'spamreport',
  'unsubscribe',
  'open',
  'click',
  'group_unsubscribe',
  'group_resubscribe',
] as const;

export const vEventType = v.union(literals(...ACCEPTED_EVENT_TYPES));
export type EventType = Infer<typeof vEventType>;

/** Scalar values accepted in `unique_args`. */
export const vUniqueArgValue = v.union(v.string(), v.number(), v.boolean());
export const vUniqueArgs = v.record(v.string(), vUniqueArgValue);
export type UniqueArgs = Infer<typeof vUniqueArgs>;

/**
 * A webhook event, normalized to camelCase. Every provider field is optional
 * because the payload is not a stable contract; the untouched element is kept
 * on `raw` so nothing is lost.
 */
export const vEmailEvent = v.object({
  event: vEventType,
  email: v.optional(v.string()),
  /** Unix seconds, as sent by the provider. */
  timestamp: v.optional(v.number()),
  sgEventId: v.optional(v.string()),
  /** The provider's internal id, not the RFC Message-ID. */
  sgMessageId: v.optional(v.string()),
  /** The RFC Message-ID, angle brackets stripped. */
  smtpId: v.optional(v.string()),
  reason: v.optional(v.string()),
  response: v.optional(v.string()),
  status: v.optional(v.string()),
  attempt: v.optional(v.union(v.string(), v.number())),
  /** Bounce type, for `bounce` events. */
  type: v.optional(v.string()),
  bounceClassification: v.optional(v.string()),
  tenantId: v.optional(v.string()),
  from: v.optional(v.string()),
  subject: v.optional(v.string()),
  category: v.optional(v.union(v.string(), v.array(v.string()))),
  uniqueArgs: v.optional(vUniqueArgs),
  /** The raw element exactly as the provider posted it. */
  raw: v.any(),
});
export type EmailEvent = Infer<typeof vEmailEvent>;

/** Runtime configuration, persisted so background work can read it. */
export const vOptions = v.object({
  apiKey: v.string(),
  teamId: v.string(),
  clusterId: v.string(),
  baseUrl: v.string(),
  initialBackoffMs: v.number(),
  retryAttempts: v.number(),
  /** Messages per hour the transactional bucket refills at. */
  hourlyLimit: v.number(),
  /** Fraction of `hourlyLimit` the bulk bucket refills at. */
  bulkShare: v.number(),
  testMode: v.boolean(),
  testDomains: v.array(v.string()),
  onEmailEvent: v.optional(vOnEmailEvent),
});
export type RuntimeConfig = Infer<typeof vOptions>;

/** The `unique_args` key the component reserves for correlation. */
export const CORRELATION_KEY = 'convex_email_id';

/** Provider reserved `unique_args` names that cannot be overridden. */
export const RESERVED_UNIQUE_ARG_KEYS = [
  'event',
  'email',
  'timestamp',
  'sg_event_id',
  'sg_message_id',
  'smtp-id',
  'tenant_id',
] as const;

/* Context type utilities. */

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, 'runQuery'>;
export type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  'runQuery' | 'runMutation'
>;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  'runQuery' | 'runMutation' | 'runAction'
>;
