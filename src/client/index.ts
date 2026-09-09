import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
  internalMutationGeneric,
} from 'convex/server';
import { type VString, v } from 'convex/values';

import {
  type ActionCtx,
  type EmailEvent,
  type MutationCtx,
  type Priority,
  type QueryCtx,
  type RuntimeConfig,
  type Status,
  type UniqueArgs,
  vEmailEvent,
} from '../component/shared.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  parseWebhookEvents,
  verifyWebhookSignature,
} from '../http/index.js';

import type { ComponentApi } from '../component/_generated/component.js';

export type PostShibaComponent = ComponentApi;

/** Opaque id of an email inside the component. */
export type EmailId = string & { __isEmailId: true };
export const vEmailId = v.string() as VString<EmailId>;

export {
  vEmailEvent,
  vEventType,
  vOptions,
  vPriority,
  vStatus,
  vUniqueArgs,
} from '../component/shared.js';
export type {
  EmailEvent,
  EventType,
  Priority,
  Status,
  UniqueArgs,
} from '../component/shared.js';

/** Args of the mutation the component calls for each webhook event. */
export const vOnEmailEventArgs = v.object({
  id: vEmailId,
  event: vEmailEvent,
});

/** Header carrying the unix second timestamp a webhook was signed at. */
export const SIGNATURE_TIMESTAMP_HEADER = 'X-Capsule-Timestamp';
/** Header carrying `sha256=<hex>` of the webhook signature. */
export const SIGNATURE_HEADER = 'X-Capsule-Signature';

type Config = RuntimeConfig & {
  webhookSecret: string;
  signatureToleranceSeconds: number;
};

type OnEmailEventReference = FunctionReference<
  'mutation',
  FunctionVisibility,
  { id: EmailId; event: EmailEvent }
>;

function env(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, unknown> } })
    .process?.env?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Construction options. Anything omitted falls back to env, then to a default. */
export type PostShibaOptions = {
  /** API key. Defaults to `POSTSHIBA_API_KEY`. */
  apiKey?: string;
  /** Team that owns the cluster. Defaults to `POSTSHIBA_TEAM_ID`. */
  teamId?: string;
  /** Cluster to send on. Defaults to `POSTSHIBA_CLUSTER_ID`. */
  clusterId?: string;
  /** Webhook signing secret. Defaults to `POSTSHIBA_WEBHOOK_SECRET`. */
  webhookSecret?: string;
  /** API origin. Defaults to `POSTSHIBA_API_BASE`, then app.postshiba.com. */
  baseUrl?: string;
  /** First retry delay, doubling each attempt. Defaults to 30 seconds. */
  initialBackoffMs?: number;
  /** Attempts before a send is marked failed. Defaults to 5. */
  retryAttempts?: number;
  /** Messages per hour the transactional bucket refills at. Defaults to 25. */
  hourlyLimit?: number;
  /** Fraction of `hourlyLimit` for the bulk bucket. Defaults to 0.7. */
  bulkShare?: number;
  /**
   * When on, every recipient must be inside `testDomains`. Defaults to true,
   * so sending to real recipients is something you opt into.
   */
  testMode?: boolean;
  /** Domains allowed in test mode. Defaults to `["inbound.postshiba.com"]`. */
  testDomains?: string[];
  /** How far a webhook timestamp may drift, in seconds. Defaults to 300. */
  signatureToleranceSeconds?: number;
  /** A mutation to run for every webhook event. */
  onEmailEvent?: OnEmailEventReference | null;
};

/** How many webhook events one `handleEvents` mutation applies at a time. */
export const WEBHOOK_BATCH_SIZE = 100;

/** The status of an email, as tracked from the provider's webhook events. */
export type EmailStatus = {
  /**
   * - `queued`: accepted by the component, not yet handed to the provider.
   * - `cancelled`: cancelled before it was handed over.
   * - `sent`: the provider accepted it; its fate is not known yet.
   * - `delivery_delayed`: the provider is retrying delivery.
   * - `delivered`: it reached the recipient's server.
   * - `bounced`: the recipient's server rejected it.
   * - `failed`: it was dropped, or every send attempt failed.
   */
  status: Status;
  /** Bounce reason, drop reason, or the last send error. */
  errorMessage: string | null;
  /** The provider's error code for a permanent send failure. */
  errorCode: string | null;
  bounced: boolean;
  /** The recipient marked it as spam. */
  complained: boolean;
  failed: boolean;
  deliveryDelayed: boolean;
  /** The provider refused to attempt delivery at all. */
  dropped: boolean;
  unsubscribed: boolean;
  opened: boolean;
  clicked: boolean;
};

/** The whole email, with its bodies decoded. */
export type Email = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  replyTo: string[];
  headers?: { name: string; value: string }[];
  uniqueArgs?: UniqueArgs;
  tenant?: string;
  priority: Priority;
  status: Status;
  errorMessage?: string;
  errorCode?: string;
  bounced: boolean;
  complained: boolean;
  failed: boolean;
  deliveryDelayed: boolean;
  dropped: boolean;
  unsubscribed: boolean;
  opened: boolean;
  clicked: boolean;
  providerMessageId?: string;
  workId?: string;
  finalizedAt: number;
  createdAt: number;
  html?: string;
  text?: string;
};

export type SendEmailOptions = {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string | string[];
  headers?: { name: string; value: string }[];
  /** Correlation metadata echoed on every webhook event for this message. */
  uniqueArgs?: UniqueArgs;
  tenant?: string;
  /** Which sending pool to use. Defaults to `transactional`. */
  priority?: Priority;
};

/** `Response.json` is not available in every runtime the component targets. */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Durable, rate limited email delivery through PostShiba.
 *
 * Enqueue from a mutation and the component owns the rest: retries with
 * backoff, two rate limited pools so bulk cannot starve transactional, and a
 * webhook that keeps each email's status current.
 */
export class PostShiba {
  public config: Config;
  onEmailEvent?: OnEmailEventReference | null;

  /**
   * @param component The component, e.g. `components.postshiba` from
   * `./_generated/api.ts`.
   * @param options See {@link PostShibaOptions}.
   */
  constructor(
    public component: PostShibaComponent,
    options?: PostShibaOptions,
  ) {
    this.config = {
      apiKey: options?.apiKey ?? env('POSTSHIBA_API_KEY') ?? '',
      teamId: options?.teamId ?? env('POSTSHIBA_TEAM_ID') ?? '',
      clusterId: options?.clusterId ?? env('POSTSHIBA_CLUSTER_ID') ?? '',
      webhookSecret:
        options?.webhookSecret ?? env('POSTSHIBA_WEBHOOK_SECRET') ?? '',
      baseUrl:
        options?.baseUrl ?? env('POSTSHIBA_API_BASE') ?? DEFAULT_BASE_URL,
      initialBackoffMs: options?.initialBackoffMs ?? 30000,
      retryAttempts: options?.retryAttempts ?? 5,
      hourlyLimit: options?.hourlyLimit ?? 25,
      bulkShare: options?.bulkShare ?? 0.7,
      testMode: options?.testMode ?? true,
      testDomains: options?.testDomains ?? ['inbound.postshiba.com'],
      signatureToleranceSeconds:
        options?.signatureToleranceSeconds ??
        DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
    };
    if (options?.onEmailEvent) {
      this.onEmailEvent = options.onEmailEvent;
    }
  }

  private async runtimeConfig(): Promise<RuntimeConfig> {
    if (this.config.apiKey === '') {
      throw new Error(
        'PostShiba API key is not set. Pass apiKey or set POSTSHIBA_API_KEY.',
      );
    }
    if (this.config.teamId === '' || this.config.clusterId === '') {
      throw new Error(
        'PostShiba team and cluster are not set. Pass teamId and clusterId, or set POSTSHIBA_TEAM_ID and POSTSHIBA_CLUSTER_ID.',
      );
    }
    return {
      apiKey: this.config.apiKey,
      teamId: this.config.teamId,
      clusterId: this.config.clusterId,
      baseUrl: this.config.baseUrl,
      initialBackoffMs: this.config.initialBackoffMs,
      retryAttempts: this.config.retryAttempts,
      hourlyLimit: this.config.hourlyLimit,
      bulkShare: this.config.bulkShare,
      testMode: this.config.testMode,
      testDomains: this.config.testDomains,
      onEmailEvent: this.onEmailEvent
        ? { fnHandle: await createFunctionHandle(this.onEmailEvent) }
        : undefined,
    };
  }

  /**
   * Enqueue an email.
   *
   * The mutation returns as soon as the email is stored, so it commits with
   * the rest of your transaction. Delivery happens in a durable background
   * action, retried with backoff.
   *
   * @returns The id of the email inside the component.
   */
  async sendEmail(
    ctx: MutationCtx | ActionCtx,
    options: SendEmailOptions,
  ): Promise<EmailId> {
    const id = await ctx.runMutation(this.component.lib.sendEmail, {
      options: await this.runtimeConfig(),
      from: options.from,
      to: toArray(options.to) ?? [],
      cc: toArray(options.cc),
      bcc: toArray(options.bcc),
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: toArray(options.replyTo),
      headers: options.headers,
      uniqueArgs: options.uniqueArgs,
      tenant: options.tenant,
      priority: options.priority,
    });
    return id as EmailId;
  }

  /** Cancel an email that has not been handed to the provider yet. */
  async cancelEmail(
    ctx: MutationCtx | ActionCtx,
    emailId: EmailId,
  ): Promise<void> {
    await ctx.runMutation(this.component.lib.cancelEmail, { emailId });
  }

  /** The delivery status of an email, or null if it is gone. */
  async status(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    emailId: EmailId,
  ): Promise<EmailStatus | null> {
    return (await ctx.runQuery(this.component.lib.getStatus, {
      emailId,
    })) as EmailStatus | null;
  }

  /** The whole email with its bodies decoded, or null if it is gone. */
  async get(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    emailId: EmailId,
  ): Promise<Email | null> {
    return (await ctx.runQuery(this.component.lib.get, {
      emailId,
    })) as Email | null;
  }

  /**
   * Handle a webhook delivery.
   *
   * Verifies the signature, then applies every event in the array. Answers
   * 401 for a signature that does not verify, 400 for a body that is not a
   * JSON array, and 200 with a summary otherwise. A single unrecognized
   * element never fails the batch, so the provider does not redeliver events
   * that were already applied.
   *
   * @example
   * ```ts
   * http.route({
   *   path: "/postshiba/webhook",
   *   method: "POST",
   *   handler: httpAction(async (ctx, req) => postshiba.handleEventWebhook(ctx, req)),
   * });
   * ```
   */
  async handleEventWebhook(
    ctx: MutationCtx | ActionCtx,
    req: Request,
  ): Promise<Response> {
    if (this.config.webhookSecret === '') {
      throw new Error(
        'PostShiba webhook secret is not set. Pass webhookSecret or set POSTSHIBA_WEBHOOK_SECRET.',
      );
    }

    const rawBody = await req.text();
    const verified = await verifyWebhookSignature({
      secret: this.config.webhookSecret,
      timestamp: req.headers.get(SIGNATURE_TIMESTAMP_HEADER) ?? '',
      signature: req.headers.get(SIGNATURE_HEADER) ?? '',
      rawBody,
      toleranceSeconds: this.config.signatureToleranceSeconds,
    });
    if (!verified) {
      return jsonResponse({ error: 'invalid_signature' }, 401);
    }

    let events: unknown[];
    try {
      events = parseWebhookEvents(rawBody);
    } catch {
      return jsonResponse({ error: 'invalid_body' }, 400);
    }

    // A batch is applied in bounded slices so one oversized delivery cannot
    // push a single mutation past the transaction limits and fail the whole
    // array after part of it was applied. If a later slice fails, the
    // provider redelivers the batch and the applied events dedupe on their
    // `sg_event_id`.
    const summary = {
      applied: 0,
      ignored: 0,
      invalid: 0,
      duplicates: 0,
      callbacks: 0,
    };
    for (let start = 0; start < events.length; start += WEBHOOK_BATCH_SIZE) {
      const slice = await ctx.runMutation(this.component.lib.handleEvents, {
        events: events.slice(start, start + WEBHOOK_BATCH_SIZE),
      });
      summary.applied += slice.applied;
      summary.ignored += slice.ignored;
      summary.invalid += slice.invalid;
      summary.duplicates += slice.duplicates;
      summary.callbacks += slice.callbacks;
    }
    return jsonResponse(summary, 200);
  }

  /**
   * Define the mutation to run for each webhook event.
   *
   * Declaring your own `internalMutation` with `vOnEmailEventArgs` as its
   * args does the same thing.
   */
  defineOnEmailEvent<DataModel extends GenericDataModel>(
    handler: (
      ctx: GenericMutationCtx<DataModel>,
      args: { id: EmailId; event: EmailEvent },
    ) => Promise<void>,
  ) {
    return internalMutationGeneric({
      args: { id: vEmailId, event: vEmailEvent },
      handler,
    });
  }
}
