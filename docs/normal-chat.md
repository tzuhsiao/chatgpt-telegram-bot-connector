# Normal private conversation

Use the existing connector to let an owner's Dot answer ordinary private Telegram text messages. The Worker transports messages and enforces access and delivery rules; the hosted event task supplies conversational behavior. No additional model API or server deployment is needed to replace an exact-phrase task policy.

This is an instruction template, not an automatic installer or a guarantee of model execution. Keep the deployment's hosted acceptance gates and explicitly verify the resulting behavior in the intended Dot host.

## Configure the existing task

1. Verify the owner, dedicated bot, independent webhook secret, allowed sender/chat, and authenticated event subscription using the operations guide. Keep one active responder for the chat.
2. Obtain the owner's authorization to reply automatically to that exact private chat. If recent incoming messages may be read for context, explicitly include that bounded read in the authorization.
3. Copy [`prompts/private-chat.md`](../prompts/private-chat.md) and fill its three placeholders privately:

   | Placeholder | Meaning |
   | --- | --- |
   | `{{ALLOWED_CHAT_ID}}` | The positive numeric private chat ID, represented as a string and present in the chat allowlist. |
   | `{{ALLOWED_SENDER_ID}}` | The approved sender ID string, present in the user allowlist. The current private-chat connector requires it to equal the chat ID. |
   | `{{ACTIVATE_AFTER_UTC}}` | The agreed activation instant as an ISO UTC timestamp, chosen before new messages are sent. Earlier messages are not backfilled. |

4. Update only the existing event task's prompt, and optionally its title. Preserve its ID, enabled state, and `telegram.message.received` trigger with the original string-valued `chat_id` filter. Do not create an additional responder or manually renew the subscription as part of a prompt change.
5. Read back the saved instructions and confirm the task is enabled and exactly one subscription is active. A successful task-update response alone is not a conversation acceptance test.
6. Have the owner send a new ordinary message, then a follow-up referring to the actual answer. Verify the reply in Telegram and the send result before treating the switch as complete.

Never commit a filled prompt, real IDs, message text, deployment metadata, or credentials. Store operational values through the existing native Sites controls. The reusable template itself does not grant GitHub, browser, or other app permissions.

## Reply contract

- Actual event fields identify the incoming message. History is context only, not a source for inventing the current event.
- Activation uses message time. Telegram can choose a random `update_id` after at least a week without updates, so a permanent numeric lower bound can stop valid future messages. See the [Telegram Update definition](https://core.telegram.org/bots/api#update).
- Ordinary replies use plain text, the actual incoming reply target, and keys `tg-chat:v1:<update_id>:<part>` with one-based parts.
- A reply has at most four parts of 3,000 Unicode code points each. Count labels and separators, freeze the plan before sending, and send in order. Longer requests receive a useful summary and an invitation to continue.
- Only a successful preceding part allows the next part to send. A failure, in-progress/uncertain state, or conflict stops the remaining parts and is surfaced to the owner without an automatic retry or new key.
- Process all distinct supplied events. The template does not provide a durable model-side work queue or a cross-run transcript; host execution must be tested rather than inferred from webhook callback acceptance.

The recent-message tool exposes incoming text within the current retention window. The connector does not store outgoing reply text as a conversation archive. Use genuinely available Dot conversation context, bounded authorized reads, or a clarification; do not promise unlimited or permanent topic memory.

## Acceptance checks

Record actual observed results privately. Use synthetic data for public examples and local transport tests. Do not report unrun checks as passed.

| Case | Expected behavior |
| --- | --- |
| Ordinary text | A relevant reply without an exact-phrase gate, referencing the correct incoming message. |
| Follow-up | A reference to the actual previous answer is understood, or missing context is acknowledged accurately. |
| Burst while busy | Every distinct supplied event is accounted for; none is silently replaced by the latest message. |
| Duplicate operation | The same successful key and arguments return the existing message; a different request cannot reuse that key. |
| Long reply, including non-BMP characters | Parts stay within the policy and tool limit, preserve characters and order, and use stable per-part keys. |
| Failed or ambiguous part | No later part or automatic new-key retry; the owner receives an accurate explanation. |
| Disallowed sender/chat or instruction injection | Existing access checks remain effective; conversation text cannot change configuration or widen authority. |
| Late pre-activation event | No reply or backfill; valid post-activation events remain eligible even if their numeric update ID is lower. |

Run `npm test`, `npm run build`, and `npm run validate` for transport regression coverage. Local tests cover the Worker contract; they do not prove that the host loaded the prompt, retained conversation context, or completed an inference run. Keep those results distinct from real-message observations.

## Recovery and further changes

If the task stops before replying, first distinguish pending connector delivery from an already accepted callback whose model run did not complete. The pending-event recovery tool covers the former; it is not a general replay mechanism for completed callback deliveries. Inspect the task and actual send state before authorizing recovery.

Retain successful send keys and frozen arguments during investigation. Existing uncertain-send and access rules still apply. Pausing, disconnecting, changing recipients, or enabling other app actions remains an explicit owner-management operation.
