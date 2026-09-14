// Telegram Bot API client: long polling, no dependencies.
//
// Written directly against the HTTP API rather than a framework, for the same
// reason there is no colour library: this process holds private keys, and every
// dependency is a supply-chain path into it. The surface actually needed is five
// methods.
//
// Two decisions here are safety-critical rather than stylistic:
//
//   The update offset is committed *before* an update is handled, not after. That
//   makes delivery at-most-once. The usual default — acknowledge after successful
//   processing — would redeliver an update if the bot crashed mid-handling, and for
//   a bot that sends transactions, redelivering "fire" means minting twice with the
//   same intent. A dropped command is recoverable by retyping it; a duplicated
//   mint is not.
//
//   HTTP 409 means another process is polling the same token. That is treated as
//   fatal rather than retried, because two live instances would both act on every
//   command — the same double-mint, arrived at a different way.

import { redactKeys } from "../core/wallets";

const API_ROOT = "https://api.telegram.org";

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export class TelegramError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

/** Another process is polling this token — both would act on every command. */
export class ConflictError extends TelegramError {
  constructor() {
    super(
      409,
      "Another instance is already polling this bot token. Two instances would both act on every command, so this one is stopping.",
    );
    this.name = "ConflictError";
  }
}

export class TelegramClient {
  private readonly base: string;
  private offset = 0;

  constructor(token: string) {
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      throw new Error(
        "TELEGRAM_BOT_TOKEN does not look like a bot token (expected `123456789:ABC…` from @BotFather).",
      );
    }
    this.base = `${API_ROOT}/bot${token}`;
  }

  private async call<T>(method: string, payload?: object, timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // The token is in the URL, so a fetch error can quote it.
      throw new TelegramError(0, `Telegram unreachable: ${redactKeys(message)}`);
    }

    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };

    if (res.status === 409) throw new ConflictError();
    if (res.status === 401) {
      throw new TelegramError(401, "Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.");
    }
    if (!res.ok || json.ok !== true) {
      const retryAfter = json.parameters?.retry_after;
      throw new TelegramError(
        res.status,
        `Telegram ${method} failed: ${json.description ?? `HTTP ${res.status}`}`,
        retryAfter,
      );
    }
    return json.result as T;
  }

  async getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe");
  }

  /**
   * Long-poll for updates.
   *
   * A 50s server-side wait rather than a short poll loop: the connection is held
   * open and Telegram replies the instant something arrives, so a command reaches
   * the bot in one round trip instead of waiting out a polling interval. The client
   * timeout is deliberately longer than the server's so the server closes first.
   */
  async getUpdates(timeoutSec = 50): Promise<TgUpdate[]> {
    const updates = await this.call<TgUpdate[]>(
      "getUpdates",
      {
        offset: this.offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      },
      (timeoutSec + 15) * 1000,
    );
    // Commit before the caller handles anything. See the header note.
    for (const update of updates) {
      if (update.update_id >= this.offset) this.offset = update.update_id + 1;
    }
    return updates;
  }

  /** Discard anything queued while the bot was down. */
  async dropPendingUpdates(): Promise<number> {
    const stale = await this.call<TgUpdate[]>("getUpdates", { offset: -1, timeout: 0 });
    const last = stale[stale.length - 1];
    if (last) this.offset = last.update_id + 1;
    return stale.length;
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: { buttons?: InlineButton[][]; replyTo?: number; silent?: boolean } = {},
  ): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: truncate(text),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(opts.silent ? { disable_notification: true } : {}),
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo } } : {}),
      ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    });
  }

  /**
   * Edit a message in place.
   *
   * Used for the countdown and the live run status, so a mint produces one message
   * that updates rather than fifty that scroll. "message is not modified" is
   * returned as an error by Telegram and is meaningless here, so it is swallowed.
   */
  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    opts: { buttons?: InlineButton[][] } = {},
  ): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: truncate(text),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof TelegramError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  /**
   * Acknowledge a button press. Without this the client spins for ~30s.
   *
   * `alert` raises a modal instead of a toast, for the cases the user must
   * actually read — a rejected callback, or a button that is no longer valid.
   */
  async answerCallback(id: string, text?: string, alert = false): Promise<void> {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: id,
        ...(text ? { text } : {}),
        ...(alert ? { show_alert: true } : {}),
      });
    } catch {
      // A stale callback id is not worth failing a run over.
    }
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    try {
      await this.call("setMyCommands", { commands });
    } catch {
      // Cosmetic: the menu hint in Telegram's UI. Never fail startup for it.
    }
  }
}

/** Telegram rejects messages over 4096 characters outright. */
function truncate(text: string, limit = 4096): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}\n… (truncated)`;
}

/** Escape for parse_mode HTML. Only these three characters are special. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function code(text: string): string {
  return `<code>${esc(text)}</code>`;
}

export function bold(text: string): string {
  return `<b>${esc(text)}</b>`;
}

export function link(label: string, url: string): string {
  return `<a href="${esc(url)}">${esc(label)}</a>`;
}
