import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

import {
  vEventType,
  vOptions,
  vPriority,
  vStatus,
  vUniqueArgs,
} from './shared.js';

export default defineSchema({
  /** Email bodies, kept out of the email row so batches stay small. */
  content: defineTable({
    content: v.bytes(),
    mimeType: v.string(),
  }),

  /** The most recent runtime configuration, for background work to read. */
  lastOptions: defineTable({
    options: vOptions,
  }),

  /** Every webhook event, for auditing. */
  deliveryEvents: defineTable({
    emailId: v.id('emails'),
    eventType: vEventType,
    occurredAt: v.number(),
    message: v.optional(v.string()),
    /** The provider's event id, used to drop redelivered events. */
    sgEventId: v.optional(v.string()),
    raw: v.any(),
  })
    .index('by_emailId_eventType', ['emailId', 'eventType'])
    .index('by_sgEventId', ['sgEventId']),

  emails: defineTable({
    from: v.string(),
    to: v.array(v.string()),
    cc: v.optional(v.array(v.string())),
    bcc: v.optional(v.array(v.string())),
    subject: v.string(),
    replyTo: v.array(v.string()),
    headers: v.optional(
      v.array(v.object({ name: v.string(), value: v.string() })),
    ),
    uniqueArgs: v.optional(vUniqueArgs),
    tenant: v.optional(v.string()),
    priority: vPriority,
    html: v.optional(v.id('content')),
    text: v.optional(v.id('content')),
    status: vStatus,
    errorMessage: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    bounced: v.boolean(),
    complained: v.boolean(),
    failed: v.boolean(),
    deliveryDelayed: v.boolean(),
    dropped: v.boolean(),
    unsubscribed: v.boolean(),
    opened: v.boolean(),
    clicked: v.boolean(),
    /** The RFC Message-ID the provider assigned, without angle brackets. */
    providerMessageId: v.optional(v.string()),
    workId: v.optional(v.string()),
    finalizedAt: v.number(),
  })
    .index('by_providerMessageId', ['providerMessageId'])
    .index('by_finalizedAt', ['finalizedAt']),
});
