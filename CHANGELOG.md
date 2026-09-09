# Changelog

## Unreleased

- Every send names a tenant. A request with no `tenant` field falls back to
  the team's `default` tenant instead of leaving the choice to the provider,
  which could answer `queued: false` and never deliver.

## 0.1.0

Initial release.

- Durable email delivery through PostShiba, backed by a workpool with
  configurable retries and exponential backoff.
- Two sending pools, transactional and bulk, each with its own hourly token
  bucket, so a bulk campaign cannot starve a password reset.
- `sendEmail` callable from a mutation, so an email commits with the rest of
  your transaction.
- `status`, `get`, and `cancelEmail`.
- Webhook handler with HMAC-SHA256 signature verification and a replay
  window, plus per-event status tracking and an optional `onEmailEvent`
  callback.
- Test mode, on by default, restricting recipients to configured test domains.
- A zero dependency HTTP client exported at `/http` for use outside Convex.
- A `/test` helper that registers the component, and everything it uses, with
  `convex-test`.
