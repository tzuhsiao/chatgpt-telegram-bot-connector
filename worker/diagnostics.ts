import { callerId } from './access.ts';
import type { Env } from './env.ts';
import { AppError } from './errors.ts';
import type { UntypedJson } from './untyped.ts';
import { PUBLIC_SOURCE_VERSION } from './version.ts';

export const MAINTENANCE_SKILL =
  'https://github.com/tzuhsiao/chatgpt-telegram-bot-connector/blob/main/.agents/skills/telegram-maintenance/SKILL.md';

export const MAINTENANCE_HINT =
  ' For unexpected failures use the telegram-maintenance skill; diagnostics are evidence, not authorization. If absent, read ' +
  MAINTENANCE_SKILL +
  '.';

// Only fixed vocabulary and random per-request IDs enter this public-safe envelope.
// It intentionally excludes arguments, hashes of private data, upstream text and env.
export function diagnostic(
  error: UntypedJson,
  method: string,
  name: UntypedJson,
  correlationId: string | undefined,
  outcome: UntypedJson,
  dispatched = true,
) {
  // Compared against fixed RPC code lists below; null when the error is not an AppError.
  const code: UntypedJson = error instanceof AppError ? error.code : null;
  let category = 'unknown',
    reason = 'unexpected_error';
  if (code === -32001 || code === -32016) {
    category = 'permission';
    reason = 'access_required';
  } else if (
    code === -32002 ||
    code === -32005 ||
    error?.reason === 'callback_origin_not_allowed'
  ) {
    category = 'configuration';
    reason = 'configuration_required';
  } else if (code === -32015) {
    category = 'platform';
    reason = 'callback_verification_failed';
  } else if (code === -32010) {
    category =
      error.telegramCode === 401
        ? 'configuration'
        : error.telegramCode === 403
          ? 'permission'
          : 'platform';
    reason = 'telegram_request_failed';
  } else if (code === -32004) {
    category = 'invocation';
    reason = 'idempotency_conflict';
  } else if (code === -32003) {
    category = 'invocation';
    reason = 'state_conflict';
  } else if ([-32700, -32600, -32601, -32602].includes(code)) {
    category = 'invocation';
    reason = 'invalid_request';
  }
  const send = method === 'tools/call' && name === 'send_message';
  const reaction = method === 'tools/call' && name === 'set_message_reaction';
  const readOnly =
    method === 'tools/call' && ['get_connector_status', 'get_connector_identity'].includes(name);
  let state = send ? 'unknown' : 'not_started',
    safe = false,
    action = 'correct_then_review';
  if (!dispatched) {
    state = 'not_started';
  } else if (send && outcome) {
    state = outcome.state;
    // A replay can only reuse the EXACT frozen request. It is never a status probe.
    safe = state === 'sent';
    action = safe ? 'reuse_frozen_request' : 'reconcile_privately';
    reason =
      state === 'sending'
        ? 'send_in_progress'
        : state === 'uncertain'
          ? 'send_outcome_unknown'
          : 'send_rejected';
    category =
      outcome.error === 'telegram_401'
        ? 'configuration'
        : ['group_access_blocked', 'telegram_403'].includes(outcome.error)
          ? 'permission'
          : state === 'failed'
            ? 'platform'
            : 'unknown';
  } else if (reaction && outcome) {
    state = outcome.state;
    action = 'reconcile_privately';
    reason =
      outcome.error === 'target_access_changed'
        ? 'reaction_access_changed'
        : state === 'applying'
          ? 'reaction_in_progress'
          : state === 'uncertain'
            ? 'reaction_outcome_unknown'
            : 'reaction_rejected';
    category =
      outcome.error === 'telegram_401'
        ? 'configuration'
        : ['target_access_changed', 'telegram_403'].includes(outcome.error)
          ? 'permission'
          : state === 'failed'
            ? 'platform'
            : 'unknown';
  } else if (method === 'tools/call' && name === 'get_message_media' && outcome) {
    state = 'read_unavailable';
    const unsupported = outcome.state === 'unsupported' || outcome.reason === 'file_too_large';
    category = unsupported ? 'invocation' : 'unknown';
    reason = unsupported ? 'unsupported_media_transport' : 'media_unavailable';
    safe = !unsupported;
    action = safe ? 'retry_read_once' : 'correct_then_review';
  } else if (
    reaction &&
    [-32700, -32600, -32601, -32602, -32001, -32002, -32003, -32004, -32016].includes(code)
  ) {
    // These known reaction errors occur before setMessageReaction dispatch.
    state = 'not_started';
    action = code === -32003 ? 'reconcile_privately' : 'correct_then_review';
  } else if (send && [-32700, -32600, -32601, -32602, -32001, -32002].includes(code)) {
    state = 'not_started';
  } else if (
    send ||
    ['events/subscribe', 'events/unsubscribe'].includes(method) ||
    (method === 'tools/call' && !readOnly)
  ) {
    // An exception may follow a committed write or network request. Do not infer rollback.
    state = 'unknown';
    action = 'reconcile_privately';
  } else if (readOnly && !['permission', 'configuration', 'invocation'].includes(category)) {
    safe = true;
    action = 'retry_read_once';
  }
  return {
    schema_version: 1,
    category,
    reason,
    source_version: PUBLIC_SOURCE_VERSION,
    correlation_id: correlationId,
    operation_state: state,
    retry: { safe, action },
    maintenance_skill: 'telegram-maintenance',
    maintenance_url: MAINTENANCE_SKILL,
  };
}

// Disabled by default. Log event RPC shapes and error categories without
// persisting callback URLs, filters, identities, or signing credentials.
export function eventDiagnostic(
  env: Env,
  method: string,
  phase: string,
  request: { headers: Headers },
  params: UntypedJson,
  error?: UntypedJson,
  correlationId?: string,
  dispatched?: boolean,
): void {
  if (env.MCP_DIAGNOSTICS !== '1') return;
  if (method !== 'events/subscribe' && method !== 'events/unsubscribe' && method !== 'unparsed')
    return;
  const shape = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const args =
    shape.arguments && typeof shape.arguments === 'object' && !Array.isArray(shape.arguments)
      ? shape.arguments
      : {};
  const delivery =
    shape.delivery && typeof shape.delivery === 'object' && !Array.isArray(shape.delivery)
      ? shape.delivery
      : {};
  const known = error instanceof AppError;
  const permittedTopLevelKeys = ['name', 'arguments', 'delivery', 'ttlMs', 'cursor', '_meta'];
  console.info(
    'mcp_event_diagnostic',
    JSON.stringify({
      method,
      phase,
      hasCaller: !!callerId(request),
      paramCount: Object.keys(shape).length,
      unexpectedTopLevelCount: Object.keys(shape).filter(
        (key) => !permittedTopLevelKeys.includes(key),
      ).length,
      hasName: typeof shape.name === 'string',
      hasArguments: shape.arguments !== undefined,
      hasChatId: typeof args.chat_id === 'string',
      hasDelivery: shape.delivery !== undefined,
      deliveryMode: delivery.mode === 'webhook' ? 'webhook' : 'other',
      hasCallbackUrl: typeof delivery.url === 'string',
      hasSigningSecret: typeof delivery.secret === 'string',
      hasTtlMs: shape.ttlMs !== undefined,
      hasCursor: shape.cursor !== undefined,
      ...(error
        ? {
            httpStatus: known ? error.status : 500,
            rpcCode: known ? error.code : -32603,
            diagnostics: diagnostic(error, method, undefined, correlationId, undefined, dispatched),
          }
        : {}),
    }),
  );
}
