/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from 'convex/server';

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      cancelEmail: FunctionReference<
        'mutation',
        'internal',
        { emailId: string },
        null,
        Name
      >;
      cleanupAbandonedEmails: FunctionReference<
        'mutation',
        'internal',
        { olderThan?: number },
        null,
        Name
      >;
      cleanupOldEmails: FunctionReference<
        'mutation',
        'internal',
        { olderThan?: number },
        null,
        Name
      >;
      get: FunctionReference<
        'query',
        'internal',
        { emailId: string },
        {
          bcc?: Array<string>;
          bounced: boolean;
          cc?: Array<string>;
          clicked: boolean;
          complained: boolean;
          createdAt: number;
          deliveryDelayed: boolean;
          dropped: boolean;
          errorCode?: string;
          errorMessage?: string;
          failed: boolean;
          finalizedAt: number;
          from: string;
          headers?: Array<{ name: string; value: string }>;
          html?: string;
          opened: boolean;
          priority: 'transactional' | 'bulk';
          providerMessageId?: string;
          replyTo: Array<string>;
          status:
            | 'queued'
            | 'cancelled'
            | 'sent'
            | 'delivered'
            | 'delivery_delayed'
            | 'bounced'
            | 'failed';
          subject: string;
          tenant?: string;
          text?: string;
          to: Array<string>;
          uniqueArgs?: Record<string, string | number | boolean>;
          unsubscribed: boolean;
          workId?: string;
        } | null,
        Name
      >;
      getStatus: FunctionReference<
        'query',
        'internal',
        { emailId: string },
        {
          bounced: boolean;
          clicked: boolean;
          complained: boolean;
          deliveryDelayed: boolean;
          dropped: boolean;
          errorCode: string | null;
          errorMessage: string | null;
          failed: boolean;
          opened: boolean;
          status:
            | 'queued'
            | 'cancelled'
            | 'sent'
            | 'delivered'
            | 'delivery_delayed'
            | 'bounced'
            | 'failed';
          unsubscribed: boolean;
        } | null,
        Name
      >;
      handleEvents: FunctionReference<
        'mutation',
        'internal',
        { events: any },
        {
          applied: number;
          callbacks: number;
          duplicates: number;
          ignored: number;
          invalid: number;
        },
        Name
      >;
      sendEmail: FunctionReference<
        'mutation',
        'internal',
        {
          bcc?: Array<string>;
          cc?: Array<string>;
          from: string;
          headers?: Array<{ name: string; value: string }>;
          html?: string;
          options: {
            apiKey: string;
            baseUrl: string;
            bulkShare: number;
            clusterId: string;
            hourlyLimit: number;
            initialBackoffMs: number;
            onEmailEvent?: { fnHandle: string };
            retryAttempts: number;
            teamId: string;
            testDomains: Array<string>;
            testMode: boolean;
          };
          priority?: 'transactional' | 'bulk';
          replyTo?: Array<string>;
          subject: string;
          tenant?: string;
          text?: string;
          to: Array<string>;
          uniqueArgs?: Record<string, string | number | boolean>;
        },
        string,
        Name
      >;
    };
  };
