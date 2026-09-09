# @cavuno/convex-postshiba

A [Convex](https://convex.dev) component for durable transactional email
through [PostShiba](https://postshiba.com).

Enqueue an email from a mutation and it commits with the rest of your
transaction. The component owns everything after that: a durable background
send, retries with exponential backoff, two rate limited pools so a bulk
campaign cannot starve a password reset, and a webhook that keeps each
email's status current.

- Send from a mutation, so no email escapes a transaction that rolled back
- Retries with configurable attempts and backoff
- Separate `transactional` and `bulk` pools, each with its own hourly budget
- Idempotency keys, so a retried attempt does not send twice
- Webhook signature verification with a replay window
- Per-email status, flags, and a full event history
- Test mode on by default, so real recipients are something you opt into
- A zero dependency HTTP client you can use outside Convex

## Install

```sh
npm install @cavuno/convex-postshiba
```

The component uses `convex` and `convex-helpers` as peer dependencies.

## Configure

Register the component in `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import postshiba from "@cavuno/convex-postshiba/convex.config";

const app = defineApp();
app.use(postshiba);

export default app;
```

Then construct a client. Every option falls back to an environment variable,
so the common case needs no arguments:

```ts
// convex/email.ts
import { PostShiba } from "@cavuno/convex-postshiba";
import { components } from "./_generated/api";

export const postshiba = new PostShiba(components.postshiba);
```

| Option | Environment variable | Default |
| --- | --- | --- |
| `apiKey` | `POSTSHIBA_API_KEY` | none, required |
| `teamId` | `POSTSHIBA_TEAM_ID` | none, required |
| `clusterId` | `POSTSHIBA_CLUSTER_ID` | none, required |
| `webhookSecret` | `POSTSHIBA_WEBHOOK_SECRET` | none, required for webhooks |
| `baseUrl` | `POSTSHIBA_API_BASE` | `https://app.postshiba.com` |
| `initialBackoffMs` | | `30000` |
| `retryAttempts` | | `5` |
| `hourlyLimit` | | `25` |
| `bulkShare` | | `0.7` |
| `testMode` | | `true` |
| `testDomains` | | `["inbound.postshiba.com"]` |
| `signatureToleranceSeconds` | | `300` |

Set the secrets on your deployment with `npx convex env set`. The component
copies `apiKey` into its `lastOptions` table on the first send so the delivery
action can retry without the caller resupplying it; anyone who can read that
table in the dashboard can read the key.

## Send an email

`sendEmail` is callable from a mutation or an action and returns the id of
the email inside the component:

```ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { postshiba } from "./email";

export const sendWelcome = mutation({
  args: { to: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await postshiba.sendEmail(ctx, {
      from: "Acme <hello@mail.example.com>",
      to: args.to,
      subject: "Welcome to Acme",
      html: "<p>Glad you are here.</p>",
      text: "Glad you are here.",
    });
  },
});
```

`to`, `cc`, `bcc`, and `replyTo` each accept a single address or an array.
You may also pass `headers`, `tenant`, and `uniqueArgs`.

`uniqueArgs` is correlation metadata the provider echoes on every webhook
event for that message. At most 32 keys, scalar values only. The component
reserves one key, `convex_email_id`, which is how webhook events find their
email; anything you set under that name is replaced.

## Priority and rate limits

Every send goes on one of two pools:

```ts
await postshiba.sendEmail(ctx, { ...options, priority: "bulk" });
```

`transactional` is the default and should stay reserved for email a person is
waiting on: sign-in links, password resets, receipts. `bulk` is for
newsletters and digests.

Each pool draws on its own hourly token bucket. The transactional bucket
refills at `hourlyLimit` messages per hour; the bulk bucket refills at
`hourlyLimit * bulkShare`. Each holds a quarter of its hourly rate as burst
capacity, so a handful of messages go out immediately rather than being
spread across the hour.

The two buckets together can exceed the provider's own hourly cap. That is
deliberate. When the provider answers 429 the pool retries with backoff, and
the transactional pool keeps its own budget in the meantime.

## Handle the webhook

Point a PostShiba webhook endpoint at your deployment and route it:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { postshiba } from "./email";

const http = httpRouter();

http.route({
  path: "/postshiba/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    return await postshiba.handleEventWebhook(ctx, req);
  }),
});

export default http;
```

The handler verifies the `X-Capsule-Signature` HMAC against
`X-Capsule-Timestamp` and rejects anything signed more than
`signatureToleranceSeconds` from now. It answers 401 for a signature that
does not verify, 400 for a body that is not a JSON array, and 200 with a
summary otherwise.

A single unrecognized element never fails the batch. It is counted and
skipped so the rest still apply and the provider does not redeliver events
that were already handled. A redelivered event is recognized by its
`sg_event_id` and skipped, so a retried batch never double counts.

Events are matched to an email by `unique_args.convex_email_id` first, then
by the RFC Message-ID. An event that matches nothing is logged and ignored.

## React to events

Pass a mutation as `onEmailEvent` and the component runs it for every event,
on its own pool:

```ts
// convex/email.ts
import { PostShiba, vOnEmailEventArgs } from "@cavuno/convex-postshiba";
import { internalMutation } from "./_generated/server";
import { components, internal } from "./_generated/api";

export const postshiba = new PostShiba(components.postshiba, {
  onEmailEvent: internal.email.handleEmailEvent,
});

export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  returns: null,
  handler: async (ctx, { id, event }) => {
    if (event.event === "bounce") {
      // Suppress the address, alert someone, whatever the product needs.
    }
  },
});
```

## Read status

```ts
const status = await postshiba.status(ctx, emailId);
// { status: "delivered", bounced: false, complained: false, ... }

const email = await postshiba.get(ctx, emailId);
// The whole record, with html and text decoded.

await postshiba.cancelEmail(ctx, emailId);
// Throws if the message already went to the provider.
```

`status` moves forward only: `queued`, `sent`, `delivery_delayed`,
`delivered`, then `bounced` or `failed`. A late `delivered` event never
downgrades a bounce, and `cancelled` is terminal.

## Test mode

`testMode` is on by default. Every recipient, including cc and bcc, must sit
inside one of `testDomains`; a subdomain of a listed domain counts. Anything
else throws with the address that was refused. Turn it off deliberately:

```ts
export const postshiba = new PostShiba(components.postshiba, {
  testMode: false,
});
```

## Testing

The `/test` helper registers the component with
[`convex-test`](https://docs.convex.dev/testing/convex-test), including the
rate limiter and the three workpools it uses:

```ts
import { convexTest } from "convex-test";
import postshiba from "@cavuno/convex-postshiba/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

test("sends a welcome email", async () => {
  const t = convexTest(schema, modules);
  postshiba.register(t);
  // ...
});
```

Pass a second argument if you mounted the component under another name.

## Use the HTTP client on its own

`@cavuno/convex-postshiba/http` is a zero dependency client built on `fetch`
and Web Crypto. It runs in the Convex V8 runtime, in edge runtimes, and in
Node 20 or newer, so a web app can send through the same code path the
component uses:

```ts
import {
  sendEmail,
  verifyWebhookSignature,
  parseWebhookEvents,
  PostShibaHttpError,
} from "@cavuno/convex-postshiba/http";

try {
  const { messageId } = await sendEmail(
    { apiKey, teamId, clusterId },
    { from, to: [to], subject, html },
  );
} catch (error) {
  if (error instanceof PostShibaHttpError && error.retryable) {
    // 429, 5xx, or a transport failure. Try again later.
  }
}
```

## Retention

Two mutations trim old rows. Schedule them from a cron:

- `cleanupOldEmails` deletes emails that reached a terminal state more than
  seven days ago, along with their bodies and events.
- `cleanupAbandonedEmails` deletes emails older than thirty days that never
  finalized, which happens when no webhook ever arrived.

Both accept `olderThan` in milliseconds to override the window.

## Limits

- A request body may not exceed 5 MB, bodies and headers included.
- `unique_args` allows at most 32 keys, with scalar values only, 64 byte keys
  and 256 byte values. The provider reserves `event`, `email`, `timestamp`,
  `sg_event_id`, `sg_message_id`, `smtp-id`, and `tenant_id`; the component
  drops those keys rather than sending a request the provider will reject.
- Idempotency keys replay the first accepted response for 24 hours. Sending
  a different body under the same key answers 409, which the component
  records as a permanent failure.
- The component does not track opens or clicks itself. It records those
  events if your endpoint receives them.

## License

MIT
