/**
 * Zero dependency PostShiba HTTP client.
 *
 * This module only uses web standard globals (`fetch`, `crypto.subtle`,
 * `TextEncoder`), so it runs unchanged in the Convex V8 runtime, in edge
 * runtimes, and in Node 20 or newer.
 */

/** Default PostShiba API origin. */
export const DEFAULT_BASE_URL = 'https://app.postshiba.com';

/**
 * Slug of the tenant every team starts with. Sent explicitly on every message
 * that names no other tenant. A cluster that also holds credentials for other
 * tenants has been observed to answer a tenant-less send with 201
 * `{queued: false}` and never deliver it, while the same body naming the
 * default tenant queues, so the field is never left to the provider's guess.
 */
export const DEFAULT_TENANT_SLUG = 'default';

/** Default tolerance, in seconds, for webhook signature timestamps. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Scalar values accepted by `unique_args`. */
export type UniqueArgValue = string | number | boolean;

/** Credentials and routing for a single PostShiba cluster. */
export type PostShibaHttpConfig = {
  /** API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Team that owns the cluster. */
  teamId: string;
  /** Cluster the message is sent on. */
  clusterId: string;
  /** API origin. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
};

/** One outgoing message. */
export type SendRequest = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  /** Extra RFC 5322 headers, as a name to value map. */
  headers?: Record<string, string>;
  /**
   * Correlation metadata echoed back on every webhook event. At most 32 keys,
   * scalar values only, 64 byte keys and 256 byte values.
   */
  uniqueArgs?: Record<string, UniqueArgValue>;
  /** Tenant the message is attributed to; `DEFAULT_TENANT_SLUG` when unset. */
  tenant?: string;
  /**
   * Replay key. PostShiba replays the first 201 for 24 hours and answers 409
   * `idempotency_conflict` when the body differs.
   */
  idempotencyKey?: string;
  /** Ask the provider to accept the message without delivering it. */
  sandbox?: boolean;
};

/** Result of a successful send. */
export type SendResult = {
  queued: boolean;
  /** RFC Message-ID header value, without angle brackets. */
  messageId: string;
};

/** Error raised for any non 2xx response or transport failure. */
export class PostShibaHttpError extends Error {
  /** HTTP status, or 0 for a transport failure. */
  readonly status: number;
  /** The provider's `error` field when the body was JSON. */
  readonly code?: string;
  /** Whether retrying the same request could succeed. */
  readonly retryable: boolean;
  /** Raw response body, or the transport error message. */
  readonly body: string;

  constructor(args: {
    message: string;
    status: number;
    code?: string;
    retryable: boolean;
    body: string;
  }) {
    super(args.message);
    this.name = 'PostShibaHttpError';
    this.status = args.status;
    this.code = args.code;
    this.retryable = args.retryable;
    this.body = args.body;
  }
}

/**
 * Statuses PostShiba will never resolve on a retry of the same body.
 * Everything else (429, 5xx, transport failures) is worth retrying.
 */
const PERMANENT_STATUSES = new Set([
  400, 401, 403, 404, 405, 406, 409, 410, 413, 415, 422,
]);

function sendsUrl(config: PostShibaHttpConfig): string {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/api/v1/teams/${config.teamId}/clusters/${config.clusterId}/sends`;
}

function buildSendBody(req: SendRequest): string {
  const send: Record<string, unknown> = {
    from: req.from,
    to: req.to,
    subject: req.subject,
  };
  if (req.cc !== undefined) send.cc = req.cc;
  if (req.bcc !== undefined) send.bcc = req.bcc;
  if (req.replyTo !== undefined) send.reply_to = req.replyTo;
  if (req.html !== undefined) send.html = req.html;
  if (req.text !== undefined) send.text = req.text;
  if (req.headers !== undefined) send.headers = req.headers;
  if (req.uniqueArgs !== undefined) send.unique_args = req.uniqueArgs;
  send.tenant = req.tenant ?? DEFAULT_TENANT_SLUG;
  if (req.sandbox !== undefined) send.sandbox = req.sandbox;
  return JSON.stringify({ send });
}

function readErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === 'string'
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON. There is no code to report.
  }
  return undefined;
}

/**
 * Sends one message through PostShiba.
 *
 * @throws {PostShibaHttpError} for every non 2xx response and for transport
 * failures. Check `retryable` to decide whether to try again.
 */
export async function sendEmail(
  config: PostShibaHttpConfig,
  req: SendRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (req.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = req.idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetchImpl(sendsUrl(config), {
      method: 'POST',
      headers,
      body: buildSendBody(req),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PostShibaHttpError({
      message: `PostShiba request failed: ${message}`,
      status: 0,
      retryable: true,
      body: message,
    });
  }

  const body = await response.text();

  if (!response.ok) {
    const code = readErrorCode(body);
    throw new PostShibaHttpError({
      message: `PostShiba send failed with ${response.status}${
        code ? ` (${code})` : ''
      }: ${body}`,
      status: response.status,
      code,
      retryable: !PERMANENT_STATUSES.has(response.status),
      body,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const messageId =
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { message_id?: unknown }).message_id === 'string'
      ? (parsed as { message_id: string }).message_id
      : undefined;

  if (messageId === undefined) {
    throw new PostShibaHttpError({
      message: `PostShiba send returned ${response.status} without a message_id: ${body}`,
      status: response.status,
      retryable: true,
      body,
    });
  }

  const queued =
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { queued?: unknown }).queued === 'boolean'
      ? (parsed as { queued: boolean }).queued
      : true;

  return { queued, messageId };
}

function toHex(buffer: ArrayBuffer): string {
  let out = '';
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Length safe, constant time comparison of two hex digests. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies a webhook signature.
 *
 * PostShiba signs `"{timestamp}.{rawBody}"` with HMAC-SHA256 and sends the hex
 * digest as `X-Capsule-Signature: sha256=<hex>` alongside
 * `X-Capsule-Timestamp`. This returns false rather than throwing for every
 * rejection reason, including a missing secret or a malformed header.
 */
export async function verifyWebhookSignature(args: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  toleranceSeconds?: number;
  now?: number;
}): Promise<boolean> {
  if (args.secret === '' || args.signature === '') return false;
  if (!args.signature.startsWith('sha256=')) return false;

  const seconds = Number(args.timestamp);
  if (!Number.isFinite(seconds)) return false;

  const tolerance =
    args.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = (args.now ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - seconds) > tolerance) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(args.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${args.timestamp}.${args.rawBody}`),
  );

  return timingSafeEqual(
    args.signature.slice('sha256='.length).toLowerCase(),
    toHex(mac),
  );
}

/**
 * Parses a webhook body into the array of events PostShiba posts.
 *
 * @throws when the body is not JSON, or is JSON but not an array.
 */
export function parseWebhookEvents(rawBody: string): unknown[] {
  const parsed: unknown = JSON.parse(rawBody);
  if (!Array.isArray(parsed)) {
    throw new Error('PostShiba webhook body must be a JSON array of events');
  }
  return parsed;
}

/**
 * The label that carries the original recipients into a non production sink
 * address. `user@example.com` becomes `user_at_example.com`; several
 * recipients join with `_`.
 */
export function nonProductionLabel(recipients: string[]): string {
  return recipients
    .join('_')
    .replace('@', '_at_')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

/**
 * Rewrites recipients into a plus addressed sink, for example
 * `dev+user_at_example.com@inbound.mail.example.com`. The sink keeps the
 * original recipients readable in its local part, which the inbox also
 * exposes as the message thread id.
 */
export function sinkAddressFor(sink: string, recipients: string[]): string {
  const [local, domain] = sink.split('@');
  return `${local}+${nonProductionLabel(recipients)}@${domain}`;
}

/** One SPF, DKIM, DMARC and ARC verdict set as the inbox records it. */
export type InboundAuthentication = {
  spf?: { result: string; domain?: string };
  dkim?: Array<{ result: string; domain?: string; selector?: string }>;
  dmarc?: { result: string; policy?: string; aligned?: boolean };
  arc?: { result: string };
};

/** One file carried by an inbound message. */
export type InboundAttachment = {
  filename?: string;
  contentType?: string;
  size?: number;
  contentBase64?: string;
};

/** One message an inbox received. */
export type InboundMessage = {
  id: string;
  inboxId: string;
  to: string;
  from: string;
  subject?: string;
  text?: string;
  html?: string;
  threadId?: string;
  /** Curated header subset the provider stores, lowercase names. */
  headers: Record<string, string>;
  envelope?: { rcptTo?: string; plusTag?: string; mailFrom?: string };
  authentication?: InboundAuthentication;
  attachments: InboundAttachment[];
  /** Full MIME source. Only present on a single message read. */
  raw?: string;
  expiresAt?: string;
};

function inboxesUrl(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  path: string,
): string {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/api/v1/inboxes/${path}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key.toLowerCase()] = entry;
  }
  return out;
}

function mapAuthentication(value: unknown): InboundAuthentication | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const out: InboundAuthentication = {};

  const spf = asRecord(record.spf);
  if (spf && typeof spf.result === 'string') {
    out.spf = {
      result: spf.result,
      ...(asString(spf.domain) !== undefined
        ? { domain: spf.domain as string }
        : {}),
    };
  }

  if (Array.isArray(record.dkim)) {
    const entries = record.dkim.flatMap((entry) => {
      const dkim = asRecord(entry);
      if (!dkim || typeof dkim.result !== 'string') return [];
      return [
        {
          result: dkim.result,
          ...(asString(dkim.domain) !== undefined
            ? { domain: dkim.domain as string }
            : {}),
          ...(asString(dkim.selector) !== undefined
            ? { selector: dkim.selector as string }
            : {}),
        },
      ];
    });
    if (entries.length > 0) out.dkim = entries;
  }

  const dmarc = asRecord(record.dmarc);
  if (dmarc && typeof dmarc.result === 'string') {
    out.dmarc = {
      result: dmarc.result,
      ...(asString(dmarc.policy) !== undefined
        ? { policy: dmarc.policy as string }
        : {}),
      ...(typeof dmarc.aligned === 'boolean' ? { aligned: dmarc.aligned } : {}),
    };
  }

  const arc = asRecord(record.arc);
  if (arc && typeof arc.result === 'string') out.arc = { result: arc.result };

  return out;
}

function mapAttachments(value: unknown): InboundAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const attachment = asRecord(entry);
    if (!attachment) return [];
    const size = attachment.size;
    return [
      {
        ...(asString(attachment.filename) !== undefined
          ? { filename: attachment.filename as string }
          : {}),
        ...(asString(attachment.content_type) !== undefined
          ? { contentType: attachment.content_type as string }
          : {}),
        ...(typeof size === 'number' ? { size } : {}),
        ...(asString(attachment.content_base64) !== undefined
          ? { contentBase64: attachment.content_base64 as string }
          : {}),
      },
    ];
  });
}

function mapInboundMessage(value: unknown): InboundMessage {
  const record = asRecord(value);
  if (!record) {
    throw new PostShibaHttpError({
      message: 'PostShiba inbound message was not a JSON object',
      status: 0,
      retryable: false,
      body: JSON.stringify(value ?? null),
    });
  }

  const envelope = asRecord(record.envelope);
  const authentication = mapAuthentication(record.authentication);

  return {
    id: asString(record.id) ?? '',
    inboxId: asString(record.inbox_id) ?? '',
    to: asString(record.to) ?? '',
    from: asString(record.from) ?? '',
    ...(asString(record.subject) !== undefined
      ? { subject: record.subject as string }
      : {}),
    ...(asString(record.text) !== undefined
      ? { text: record.text as string }
      : {}),
    ...(asString(record.html) !== undefined
      ? { html: record.html as string }
      : {}),
    ...(asString(record.thread_id) !== undefined
      ? { threadId: record.thread_id as string }
      : {}),
    headers: asStringMap(record.headers),
    ...(envelope
      ? {
          envelope: {
            ...(asString(envelope.rcpt_to) !== undefined
              ? { rcptTo: envelope.rcpt_to as string }
              : {}),
            ...(asString(envelope.plus_tag) !== undefined
              ? { plusTag: envelope.plus_tag as string }
              : {}),
            ...(asString(envelope.mail_from) !== undefined
              ? { mailFrom: envelope.mail_from as string }
              : {}),
          },
        }
      : {}),
    ...(authentication ? { authentication } : {}),
    attachments: mapAttachments(record.attachments),
    ...(asString(record.raw) !== undefined
      ? { raw: record.raw as string }
      : {}),
    ...(asString(record.expires_at) !== undefined
      ? { expiresAt: record.expires_at as string }
      : {}),
  };
}

async function getJson(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PostShibaHttpError({
      message: `PostShiba request failed: ${message}`,
      status: 0,
      retryable: true,
      body: message,
    });
  }

  const body = await response.text();

  if (!response.ok) {
    const code = readErrorCode(body);
    throw new PostShibaHttpError({
      message: `PostShiba read failed with ${response.status}${
        code ? ` (${code})` : ''
      }: ${body}`,
      status: response.status,
      code,
      retryable: !PERMANENT_STATUSES.has(response.status),
      body,
    });
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new PostShibaHttpError({
      message: `PostShiba returned ${response.status} with a non JSON body: ${body}`,
      status: response.status,
      retryable: true,
      body,
    });
  }
}

/** Unwraps the optional `{ data: ... }` envelope some endpoints use. */
function unwrapData(parsed: unknown): unknown {
  const record = asRecord(parsed);
  return record && 'data' in record ? record.data : parsed;
}

/**
 * Lists the messages an inbox currently holds, newest first. Bodies are
 * included; the full MIME source is not, use {@link getInboundMessage} for
 * that.
 *
 * @throws {PostShibaHttpError} for every non 2xx response and for transport
 * failures.
 */
export async function listInboundMessages(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  inboxId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InboundMessage[]> {
  const parsed = unwrapData(
    await getJson(
      config,
      inboxesUrl(config, `${inboxId}/inbound_messages`),
      fetchImpl,
    ),
  );

  if (!Array.isArray(parsed)) {
    throw new PostShibaHttpError({
      message: 'PostShiba inbound message list was not a JSON array',
      status: 0,
      retryable: false,
      body: JSON.stringify(parsed ?? null),
    });
  }

  return parsed.map(mapInboundMessage);
}

/**
 * Reads one inbound message, including its raw MIME source and any attachment
 * content.
 *
 * @throws {PostShibaHttpError} for every non 2xx response and for transport
 * failures.
 */
export async function getInboundMessage(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  inboxId: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InboundMessage> {
  return mapInboundMessage(
    unwrapData(
      await getJson(
        config,
        inboxesUrl(config, `${inboxId}/inbound_messages/${id}`),
        fetchImpl,
      ),
    ),
  );
}

/** DNS verification state of one authentication record on a sending domain. */
export type SendingDomainStatus = 'pending' | 'verified' | 'failed';

/**
 * One customer sending domain, as the sending domains API reports it.
 *
 * Sending on a domain is allowed once DKIM and the return path are both
 * `verified`. DMARC is optional.
 */
export type SendingDomain = {
  id: string;
  name: string;
  dkimStatus?: SendingDomainStatus;
  returnPathStatus?: SendingDomainStatus;
  dmarcStatus?: SendingDomainStatus;
  dkimCnameHost?: string;
  dkimCnameTarget?: string;
  returnPathHost?: string;
  returnPathTarget?: string;
  dmarcHost?: string;
  dmarcRecord?: string;
  /** Why the last DNS check failed, when it did. */
  lastVerificationError?: string;
  suspended?: boolean;
  primary?: boolean;
};

function sendingDomainStatus(value: unknown): SendingDomainStatus | undefined {
  return value === 'pending' || value === 'verified' || value === 'failed'
    ? value
    : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  target: string,
): Record<string, string> {
  const value = asString(record[key]);
  return value === undefined ? {} : { [target]: value };
}

function optionalStatus(
  record: Record<string, unknown>,
  key: string,
  target: string,
): Record<string, SendingDomainStatus> {
  const value = sendingDomainStatus(record[key]);
  return value === undefined ? {} : { [target]: value };
}

function mapSendingDomain(value: unknown): SendingDomain {
  const record = asRecord(unwrapData(value));
  if (!record) {
    throw new PostShibaHttpError({
      message: 'PostShiba sending domain was not a JSON object',
      status: 0,
      retryable: false,
      body: JSON.stringify(value ?? null),
    });
  }

  return {
    id: asString(record.id) ?? '',
    name: asString(record.name) ?? '',
    ...optionalStatus(record, 'dkim_status', 'dkimStatus'),
    ...optionalStatus(record, 'return_path_status', 'returnPathStatus'),
    ...optionalStatus(record, 'dmarc_status', 'dmarcStatus'),
    ...optionalString(record, 'dkim_cname_host', 'dkimCnameHost'),
    ...optionalString(record, 'dkim_cname_target', 'dkimCnameTarget'),
    ...optionalString(record, 'return_path_host', 'returnPathHost'),
    ...optionalString(record, 'return_path_target', 'returnPathTarget'),
    ...optionalString(record, 'dmarc_host', 'dmarcHost'),
    ...optionalString(record, 'dmarc_record', 'dmarcRecord'),
    ...optionalString(
      record,
      'last_verification_error',
      'lastVerificationError',
    ),
    ...(typeof record.suspended === 'boolean'
      ? { suspended: record.suspended }
      : {}),
    ...(typeof record.primary === 'boolean' ? { primary: record.primary } : {}),
  };
}

/**
 * One request against the sending domains API. Returns the raw body so a
 * 204 with no content is representable.
 */
async function sendingDomainRequest(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body: string | undefined,
  fetchImpl: typeof fetch,
  allowNotFound = false,
  label = 'sending domain',
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PostShibaHttpError({
      message: `PostShiba request failed: ${message}`,
      status: 0,
      retryable: true,
      body: message,
    });
  }

  const text = await response.text();

  if (!response.ok) {
    if (allowNotFound && response.status === 404) {
      return { status: 404, body: text };
    }
    const code = readErrorCode(text);
    throw new PostShibaHttpError({
      message: `PostShiba ${label} ${method} failed with ${response.status}${
        code ? ` (${code})` : ''
      }: ${text}`,
      status: response.status,
      code,
      retryable: !PERMANENT_STATUSES.has(response.status),
      body: text,
    });
  }

  return { status: response.status, body: text };
}

function parseSendingDomain(result: { status: number; body: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new PostShibaHttpError({
      message: `PostShiba returned ${result.status} with a non JSON body: ${result.body}`,
      status: result.status,
      retryable: true,
      body: result.body,
    });
  }
  return mapSendingDomain(parsed);
}

function sendingDomainUrl(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  path: string,
): string {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/api/v1/sending_domains/${path}`;
}

/**
 * Registers a customer sending domain on the team. The returned record
 * carries the DNS records the customer has to publish.
 *
 * @throws {PostShibaHttpError} for every non 2xx response and for transport
 * failures.
 */
export async function createSendingDomain(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'teamId' | 'baseUrl'>,
  name: string,
  options: { tenantId?: string } | undefined = undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SendingDomain> {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const sendingDomain: Record<string, string> = { name };
  if (options?.tenantId !== undefined) {
    sendingDomain.tenant_id = options.tenantId;
  }
  return parseSendingDomain(
    await sendingDomainRequest(
      config,
      'POST',
      `${base}/api/v1/teams/${config.teamId}/sending_domains`,
      JSON.stringify({ sending_domain: sendingDomain }),
      fetchImpl,
    ),
  );
}

/**
 * Reads one sending domain, including its current DNS verification state.
 *
 * @throws {PostShibaHttpError} for every non 2xx response, 404 included.
 */
export async function getSendingDomain(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendingDomain> {
  return parseSendingDomain(
    await sendingDomainRequest(
      config,
      'GET',
      sendingDomainUrl(config, id),
      undefined,
      fetchImpl,
    ),
  );
}

/**
 * Queues a DNS check and returns the statuses as they stand right now. The
 * check itself is asynchronous, so a follow up {@link getSendingDomain} is
 * what observes the result.
 *
 * @throws {PostShibaHttpError} for every non 2xx response.
 */
export async function verifySendingDomain(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendingDomain> {
  return parseSendingDomain(
    await sendingDomainRequest(
      config,
      'POST',
      sendingDomainUrl(config, `${id}/verify`),
      undefined,
      fetchImpl,
    ),
  );
}

/**
 * Removes a sending domain. Answers `false` when the provider no longer has
 * it, so a retry after a partially applied delete still completes.
 *
 * @throws {PostShibaHttpError} for every non 2xx response other than 404.
 */
export async function deleteSendingDomain(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = await sendingDomainRequest(
    config,
    'DELETE',
    sendingDomainUrl(config, id),
    undefined,
    fetchImpl,
    true,
  );
  return result.status !== 404;
}

/**
 * One tenant. PostShiba's ESP guide models a customer of ours as a tenant:
 * it owns that customer's sending domain and SMTP credential, and its
 * suppression list is its own.
 */
export type Tenant = {
  id: string;
  name: string;
  /** Generated from the name on create. This is what a send carries. */
  slug: string;
  suspended?: boolean;
};

function tenantsUrl(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  path: string,
): string {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/api/v1/tenants/${path}`;
}

function mapTenant(value: unknown): Tenant {
  const record = asRecord(unwrapData(value));
  if (!record) {
    throw new PostShibaHttpError({
      message: 'PostShiba tenant was not a JSON object',
      status: 0,
      retryable: false,
      body: JSON.stringify(value ?? null),
    });
  }

  return {
    id: asString(record.id) ?? '',
    name: asString(record.name) ?? '',
    slug: asString(record.slug) ?? '',
    ...(typeof record.suspended === 'boolean'
      ? { suspended: record.suspended }
      : {}),
  };
}

function parseTenant(result: { status: number; body: string }): Tenant {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new PostShibaHttpError({
      message: `PostShiba returned ${result.status} with a non JSON body: ${result.body}`,
      status: result.status,
      retryable: true,
      body: result.body,
    });
  }
  return mapTenant(parsed);
}

/**
 * Creates a tenant on the team. The slug is generated from the name, and
 * the slug is what a send passes as `tenant`.
 *
 * @throws {PostShibaHttpError} for every non 2xx response and for transport
 * failures.
 */
export async function createTenant(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'teamId' | 'baseUrl'>,
  /** A display name, or a name with an explicit slug. The provider derives
   *  the slug from the name when none is given. */
  tenant: string | { name: string; slug?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Tenant> {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const body =
    typeof tenant === 'string'
      ? { name: tenant }
      : { name: tenant.name, ...(tenant.slug ? { slug: tenant.slug } : {}) };
  return parseTenant(
    await sendingDomainRequest(
      config,
      'POST',
      `${base}/api/v1/teams/${config.teamId}/tenants`,
      JSON.stringify({ tenant: body }),
      fetchImpl,
      false,
      'tenant',
    ),
  );
}

/**
 * Reads one tenant by id.
 *
 * @throws {PostShibaHttpError} for every non 2xx response, 404 included.
 */
export async function getTenant(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Tenant> {
  return parseTenant(
    await sendingDomainRequest(
      config,
      'GET',
      tenantsUrl(config, id),
      undefined,
      fetchImpl,
      false,
      'tenant',
    ),
  );
}

/**
 * Stops the tenant from sending. Its domain and credential stay in place, so
 * {@link resumeTenant} puts it back exactly as it was.
 *
 * @throws {PostShibaHttpError} for every non 2xx response.
 */
export async function suspendTenant(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Tenant> {
  return parseTenant(
    await sendingDomainRequest(
      config,
      'POST',
      tenantsUrl(config, `${id}/suspend`),
      undefined,
      fetchImpl,
      false,
      'tenant',
    ),
  );
}

/**
 * Lets a suspended tenant send again.
 *
 * @throws {PostShibaHttpError} for every non 2xx response.
 */
export async function resumeTenant(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Tenant> {
  return parseTenant(
    await sendingDomainRequest(
      config,
      'POST',
      tenantsUrl(config, `${id}/resume`),
      undefined,
      fetchImpl,
      false,
      'tenant',
    ),
  );
}

/**
 * Removes a tenant. Answers `false` when the provider no longer has it, so a
 * retry after a partially applied delete still completes. The provider
 * refuses while the tenant still owns a domain, a credential or an inbox, so
 * delete those first.
 *
 * @throws {PostShibaHttpError} for every non 2xx response other than 404.
 */
export async function deleteTenant(
  config: Pick<PostShibaHttpConfig, 'apiKey' | 'baseUrl'>,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = await sendingDomainRequest(
    config,
    'DELETE',
    tenantsUrl(config, id),
    undefined,
    fetchImpl,
    true,
    'tenant',
  );
  return result.status !== 404;
}

/**
 * One SMTP credential, without its password. A tenant needs a credential on
 * the sending cluster before any send that names it is accepted, HTTP sends
 * included.
 */
export type SmtpCredential = {
  id: string;
  username: string;
};

function smtpCredentialsUrl(
  config: Pick<
    PostShibaHttpConfig,
    'apiKey' | 'teamId' | 'clusterId' | 'baseUrl'
  >,
  path: string,
): string {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}/api/v1/teams/${config.teamId}/clusters/${config.clusterId}/smtp_credentials${path}`;
}

/**
 * Creates an SMTP credential for a tenant on the sending cluster.
 *
 * The provider returns a password exactly once. We never send SMTP, so it is
 * dropped here rather than handed to a caller that might store it.
 *
 * @throws {PostShibaHttpError} for every non 2xx response and for transport
 * failures.
 */
export async function createSmtpCredential(
  config: Pick<
    PostShibaHttpConfig,
    'apiKey' | 'teamId' | 'clusterId' | 'baseUrl'
  >,
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SmtpCredential> {
  const result = await sendingDomainRequest(
    config,
    'POST',
    smtpCredentialsUrl(config, ''),
    JSON.stringify({ smtp_credential: { tenant_id: tenantId } }),
    fetchImpl,
    false,
    'SMTP credential',
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new PostShibaHttpError({
      message: `PostShiba returned ${result.status} with a non JSON body: ${result.body}`,
      status: result.status,
      retryable: true,
      body: result.body,
    });
  }

  const record = asRecord(unwrapData(parsed));
  if (!record) {
    throw new PostShibaHttpError({
      message: 'PostShiba SMTP credential was not a JSON object',
      status: result.status,
      retryable: false,
      body: result.body,
    });
  }

  return {
    id: asString(record.id) ?? '',
    username: asString(record.username) ?? '',
  };
}

/**
 * Removes an SMTP credential. Answers `false` when the provider no longer
 * has it, so a retry after a partially applied delete still completes.
 *
 * @throws {PostShibaHttpError} for every non 2xx response other than 404.
 */
export async function deleteSmtpCredential(
  config: Pick<
    PostShibaHttpConfig,
    'apiKey' | 'teamId' | 'clusterId' | 'baseUrl'
  >,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const result = await sendingDomainRequest(
    config,
    'DELETE',
    smtpCredentialsUrl(config, `/${id}`),
    undefined,
    fetchImpl,
    true,
    'SMTP credential',
  );
  return result.status !== 404;
}
