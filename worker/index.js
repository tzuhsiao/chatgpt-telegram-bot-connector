import {
  callerId,
  observedGroups,
  requireOwner,
  securityConfigured,
  senderAllowed,
} from './access.ts';
import { equalSecret } from './crypto.ts';
import { deliverEvent, retryPending } from './delivery.ts';
import { diagnostic, eventDiagnostic } from './diagnostics.ts';
import { first, requireDatabase, run } from './db.ts';
import { AppError } from './errors.ts';
import { EVENT_DEFINITION, eventOperation } from './events.ts';
import {
  checkGroup,
  groupCurrent,
  membershipUpdate,
  pauseForUpdate,
  pauseGroupAccess,
  syncGroupApprovals,
  verifyGroupAccess,
} from './groups.ts';
import { json, readJson } from './http.ts';
import { normalizedUpdate } from './intake.ts';
import { messageMedia, prefetchMedia } from './media.ts';
import { sendMessage, setMessageReaction } from './outbound.ts';
import { identityFor, landingPage } from './page.ts';
import { connectorStatus, recentMessages } from './status.ts';
import { cleanup } from './retention.ts';
import { botId, webhookSecret } from './telegram.ts';
import { incomingThread } from './threads.ts';
import { toolResult } from './tool-result.ts';
import { TOOLS } from './tools.ts';
import { configureWebhook } from './webhook-setup.ts';
import { groupId, objectArgs } from './validate.ts';

const PROTOCOL = '2026-07-28';
async function telegramWebhook(request, env, runtime, ctx) {
  try {
    const expected = webhookSecret(env);
    if (!(await equalSecret(request.headers.get('x-telegram-bot-api-secret-token'), expected)))
      throw new AppError('Invalid webhook authentication.', 401, -32001);
    if (!securityConfigured(env))
      throw new AppError('Connector security configuration is incomplete.', 503, -32002);
    botId(env);
    const payload = await readJson(request);
    if (!payload || !Number.isSafeInteger(payload.update_id) || payload.update_id < 0)
      throw new AppError('Invalid Telegram update.');
    await cleanup(env, runtime.now());
    await syncGroupApprovals(env);
    if (await membershipUpdate(payload, env, runtime)) return json({ ok: true });
    const groupChat = String(payload.message?.chat?.id);
    const configuredGroups = observedGroups(env).groups;
    if (
      configuredGroups.has(groupChat) &&
      (await first(
        requireDatabase(env),
        'SELECT update_id FROM group_updates WHERE bot_id=? AND update_id=?',
        botId(env),
        payload.update_id,
      ))
    )
      return json({ ok: true, ignored: true });
    if (
      configuredGroups.has(groupChat) &&
      payload.message &&
      (payload.message.sender_chat ||
        payload.message.from?.is_bot !== false ||
        !senderAllowed(groupChat, String(payload.message.from?.id), env))
    ) {
      return json({ ok: true, ignored: true });
    }
    const message = normalizedUpdate(payload, env, runtime.now());
    if (!message) return json({ ok: true, ignored: true });
    let group = null;
    if (groupId(message.chat_id)) {
      try {
        group = await checkGroup(message.chat_id, env, runtime);
      } catch (error) {
        if (error instanceof AppError && error.code === -32016) {
          await run(
            requireDatabase(env),
            'INSERT INTO group_updates(bot_id,update_id,chat_id,received_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
            botId(env),
            payload.update_id,
            groupChat,
            runtime.now(),
          );
          return json({ ok: true, ignored: true, group_paused: true });
        }
        throw error;
      }
    }
    if (
      group &&
      ((group.is_forum === 1 && payload.message.chat?.is_forum !== true) ||
        (!group.is_forum &&
          (payload.message.chat?.is_forum || payload.message.is_topic_message === true)))
    ) {
      await pauseForUpdate(groupChat, payload.update_id, 'group_mode_changed', env, runtime);
      return json({ ok: true, ignored: true });
    }
    const thread = incomingThread(payload.message, group?.is_forum === 1);
    const eventId = `tg_${message.bot_id}_${message.update_id}`;
    if (group) await groupCurrent(group, env);
    await run(
      env.DB,
      `INSERT INTO inbox(event_id,bot_id,update_id,chat_id,sender_id,message_id,text,occurred_at,received_at,group_revision,message_thread_id,media_json,reaction_album)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,update_id) DO NOTHING`,
      eventId,
      message.bot_id,
      message.update_id,
      message.chat_id,
      message.sender_id,
      message.message_id,
      message.text,
      message.occurred_at,
      message.received_at,
      group?.revision ?? null,
      thread,
      message.media_json,
      message.reaction_album,
    );
    const result = await deliverEvent(eventId, env, runtime, false, group);
    // Receipt is already attempted. Never await downloads or let failures affect intake.
    try {
      if (typeof ctx?.waitUntil === 'function')
        ctx.waitUntil(prefetchMedia(eventId, env, runtime, group).catch(() => {}));
    } catch {} // Scheduling is also best effort.
    if (result.state === 'pending' && result.reason !== 'retry_limit')
      return json({ ok: false, retry: true }, 503, { 'retry-after': '5' });
    return json({ ok: true });
  } catch (error) {
    return json(
      { error: error instanceof AppError ? error.message : 'Request could not be processed.' },
      error instanceof AppError ? error.status : 503,
    );
  }
}

async function ownerTool(name, args, env, runtime) {
  if (name !== 'get_connector_status') await syncGroupApprovals(env);
  if (
    [
      'send_message',
      'set_message_reaction',
      'configure_telegram_webhook',
      'retry_pending_events',
      'get_message_media',
    ].includes(name)
  )
    await cleanup(env, runtime.now());
  let result;
  if (name === 'get_connector_status') {
    objectArgs(args, []);
    result = await connectorStatus(env, runtime);
  } else if (name === 'get_message_media') return messageMedia(args, env, runtime);
  else if (name === 'get_recent_messages') result = await recentMessages(args, env, runtime);
  else if (name === 'set_message_reaction') result = await setMessageReaction(args, env, runtime);
  else if (name === 'send_message') result = await sendMessage(args, env, runtime);
  else if (name === 'configure_telegram_webhook')
    result = await configureWebhook(args, env, runtime);
  else if (name === 'verify_group_access') result = await verifyGroupAccess(args, env, runtime);
  else if (name === 'pause_group_access') result = await pauseGroupAccess(args, env);
  else if (name === 'retry_pending_events') result = await retryPending(args, env, runtime);
  else throw new AppError('Unknown tool.', 200, -32602);
  return {
    ...toolResult(result),
    isError:
      (name === 'send_message' && result.state !== 'sent') ||
      (name === 'set_message_reaction' && result.state !== 'applied'),
  };
}

async function mcp(request, env, runtime) {
  const correlationId = 'diag_' + crypto.randomUUID();
  let id = null;
  let dispatched = false;
  let diagnosticMethod = 'unparsed';
  let diagnosticParams = {};
  try {
    const body = await readJson(request);
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      throw new AppError('Invalid JSON-RPC request.', 400, -32600);
    if (
      body.id !== undefined &&
      body.id !== null &&
      typeof body.id !== 'string' &&
      !(typeof body.id === 'number' && Number.isFinite(body.id))
    )
      throw new AppError('Invalid request ID.', 400, -32600);
    id = body.id ?? null;
    const { method, params = {} } = body;
    diagnosticMethod = method;
    diagnosticParams = params;
    eventDiagnostic(env, method, 'received', request, params, undefined, correlationId);
    let result;
    if (method === 'server/discover')
      result = {
        resultType: 'complete',
        supportedVersions: [PROTOCOL],
        capabilities: { tools: {}, events: {} },
      };
    else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'events/list') result = { events: [EVENT_DEFINITION] };
    else if (method === 'tools/call' && params?.name === 'get_connector_identity') {
      const caller = callerId(request);
      result = toolResult({
        authenticated: !!caller,
        caller_user_id: caller,
        owner_configured: !!env.OWNER_USER_ID,
        is_owner: !!caller && caller === env.OWNER_USER_ID,
      });
    } else {
      const owner = requireOwner(request, env);
      if (method === 'events/subscribe' || method === 'events/unsubscribe') {
        dispatched = true;
        result = await eventOperation(method, params, owner, env, runtime);
      } else if (method === 'tools/call') {
        dispatched = true;
        result = await ownerTool(params?.name, params?.arguments ?? {}, env, runtime);
      } else throw new AppError('Method not found.', 200, -32601);
    }
    if (method === 'tools/call' && result?.isError) {
      const data = {
        ...result.structuredContent,
        diagnostics: diagnostic(null, method, params.name, correlationId, result.structuredContent),
      };
      // Keep non-text content blocks (including image transport) byte-for-byte.
      result = {
        ...result,
        structuredContent: data,
        content: result.content.map((block, index) =>
          index === 0 && block.type === 'text' ? { ...block, text: JSON.stringify(data) } : block,
        ),
      };
    }
    return json({ jsonrpc: '2.0', id, result });
  } catch (error) {
    const known = error instanceof AppError;
    eventDiagnostic(
      env,
      diagnosticMethod,
      'rejected',
      request,
      diagnosticParams,
      error,
      correlationId,
      dispatched,
    );
    return json(
      {
        jsonrpc: '2.0',
        id,
        error: {
          code: known ? error.code : -32603,
          message: known ? error.message : 'Internal error.',
          data: {
            ...(known && error.reason ? { reason: error.reason } : {}),
            diagnostics: diagnostic(
              error,
              diagnosticMethod,
              diagnosticParams?.name,
              correlationId,
              undefined,
              dispatched,
            ),
          },
        },
      },
      known ? error.status : 500,
    );
  }
}

// workerd's native fetch requires its global receiver even when stored on runtime.
export function createWorker({
  fetch: networkFetch = globalThis.fetch.bind(globalThis),
  now = Date.now,
} = {}) {
  return {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (path === '/' && request.method === 'GET') return landingPage();
      if (path === '/favicon.ico' && request.method === 'GET')
        return new Response(null, { status: 204 });
      if (path === '/api/identity' && request.method === 'GET')
        return json(identityFor(request, env));
      if (path === '/api/status' && request.method === 'GET') {
        try {
          requireOwner(request, env);
          return json(await connectorStatus(env, { fetch: networkFetch, now }));
        } catch (error) {
          return json(
            { error: error instanceof AppError ? error.message : 'Status unavailable.' },
            error instanceof AppError ? error.status : 503,
          );
        }
      }
      if (path === '/mcp') {
        if (request.method !== 'POST')
          return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
        return mcp(request, env, { fetch: networkFetch, now });
      }
      if (path === '/telegram/webhook') {
        if (request.method !== 'POST')
          return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
        return telegramWebhook(request, env, { fetch: networkFetch, now }, ctx);
      }
      return json({ error: 'Not found.' }, 404);
    },
  };
}

export default createWorker();
