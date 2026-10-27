// Protocol-visible error. `status` is the HTTP status and `code` the JSON-RPC
// error code; `reason` is an optional fixed-vocabulary machine detail.
export class AppError extends Error {
  // `declare` keeps these type-only: the constructor's Object.assign defines them,
  // and no class-field initializers are emitted.
  declare status: number;
  declare code: number;
  declare reason: string | undefined;
  // Set by the Telegram API wrapper on a definite client-error rejection.
  declare telegramCode?: number;

  constructor(message: string, status = 400, code = -32602, reason?: string) {
    super(message);
    Object.assign(this, { status, code, reason });
  }
}
