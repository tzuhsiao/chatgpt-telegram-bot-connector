import { callerId, requireOwner } from './access.ts';
import { cleanup } from './retention.ts';
import { configureWebhook } from './webhook-setup.ts';
import { connectorStatus, recentMessages } from './status.ts';
import { diagnostic, eventDiagnostic } from './diagnostics.ts';
import type { BackgroundContext, Env, Runtime } from './env.ts';
import { AppError } from './errors.ts';
import { EVENT_DEFINITION, eventOperation } from './events.ts';
import { retryPending } from './delivery.ts';
import { pauseGroupAccess, syncGroupApprovals, verifyGroupAccess } from './groups.ts';
import { json, readJson } from './http.ts';
import { messageMedia } from './media.ts';
import { sendMessage, setMessageReaction } from './outbound.ts';
import { toolResult } from './tool-result.ts';
import { TOOLS } from './tools.ts';
import type { UntypedJson } from './untyped.ts';
import { objectArgs } from './validate.ts';

// MCP JSON-RPC endpoint. Discovery and identity are public; every other method
// requires the platform-verified owner identity before dispatch.

export const PROTOCOL = '2026-07-28';

export async function ownerTool(name: UntypedJson, args: UntypedJson, env: Env, runtime: Runtime) {
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
  let result: UntypedJson;
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

export async function mcp(
  request: Request,
  env: Env,
  runtime: Runtime,
  ctx?: BackgroundContext,
): Promise<Response> {
  const correlationId = 'diag_' + crypto.randomUUID();
  let id = null;
  let dispatched = false;
  let diagnosticMethod = 'unparsed';
  let diagnosticParams: UntypedJson = {};
  try {
    const body: UntypedJson = await readJson(request);
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
    let result: UntypedJson;
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
        result = await eventOperation(method, params, owner, env, runtime, ctx);
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
        content: result.content.map((block: UntypedJson, index: number) =>
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
