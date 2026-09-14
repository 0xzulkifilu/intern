// Access control, on both input paths.
//
// The bot token is a bearer credential: anyone holding it can message the bot, and
// tokens leak — into .env files, screenshots, shell history. The id allowlist is
// what stands between a leaked token and a process that signs transactions, so it
// is enforced on every message AND every button press, and this file holds it to
// that on both paths.
//
// The trap these tests exist for: it is easy to check the allowlist on
// `message.from.id` and forget that a callback_query carries its own `from`. A
// panel sitting in a group is visible to every member of it, so "who pressed the
// button" is exactly as open a question as "who typed the command" — and a panel
// left open in a group would otherwise be a mint button for the whole room.
//
// The manager is driven through its real `handleUpdate` with a stub client. Only
// /start and menu navigation are exercised, which reach nothing but the stub.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager } from "../src/bot/session";
import { InlineButton, TelegramClient, TgMessage, TgUpdate } from "../src/bot/api";
import { Defaults } from "../src/util/env";
import { LoadedWallet } from "../src/core/wallets";

interface Call {
  method: string;
  chatId?: number;
  text?: string;
  alert?: boolean;
}

/**
 * A TelegramClient that records instead of sending.
 *
 * Cast through `unknown` because only the handful of methods these paths touch are
 * implemented; a full fake of the transport would test the fake, not the bot.
 */
function stubClient(): { client: TelegramClient; calls: Call[] } {
  const calls: Call[] = [];
  let nextId = 100;

  const client = {
    async sendMessage(
      chatId: number,
      text: string,
      _opts: { buttons?: InlineButton[][] } = {},
    ): Promise<TgMessage> {
      calls.push({ method: "sendMessage", chatId, text });
      nextId += 1;
      return { message_id: nextId, chat: { id: chatId, type: "private" }, date: 0, text };
    },
    async editMessage(chatId: number, _messageId: number, text: string): Promise<void> {
      calls.push({ method: "editMessage", chatId, text });
    },
    async answerCallback(_id: string, text?: string, alert = false): Promise<void> {
      calls.push({ method: "answerCallback", text, alert });
    },
  } as unknown as TelegramClient;

  return { client, calls };
}

const ALLOWED = 111;
const STRANGER = 222;
const ALLOWED_GROUP = -1000;

function defaults(): Defaults {
  return {
    chain: "ethereum",
    quantity: 1,
    gasLimit: 300_000n,
    maxFeeGwei: null,
    priorityGwei: null,
    leadMs: 0,
    openseaApiKey: null,
    telegramToken: "test-token",
    telegramAllowedIds: [ALLOWED, ALLOWED_GROUP],
    receiptTimeoutMs: 60_000,
  };
}

function wallets(): LoadedWallet[] {
  // Never touched: no test here reaches signing. Present only so the manager sees
  // a non-empty wallet list when it renders the menu.
  return [{ index: 0, address: "0x1111111111111111111111111111111111111111" } as LoadedWallet];
}

function manager(allowedIds = [ALLOWED, ALLOWED_GROUP]) {
  const { client, calls } = stubClient();
  const mgr = new SessionManager({ client, defaults: defaults(), wallets: wallets(), allowedIds });
  return { mgr, calls };
}

function message(userId: number, chatId: number, text: string, chatType = "private"): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: userId, is_bot: false, first_name: "T" },
      chat: { id: chatId, type: chatType },
      date: 0,
      text,
    },
  } as TgUpdate;
}

function press(userId: number, chatId: number, data: string, chatType = "private"): TgUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cb-1",
      from: { id: userId, is_bot: false, first_name: "T" },
      message: {
        message_id: 10,
        chat: { id: chatId, type: chatType },
        date: 0,
      },
      data,
    },
  } as TgUpdate;
}

describe("allowlist — messages", () => {
  it("serves an allowed user", async () => {
    const { mgr, calls } = manager();
    await mgr.handleUpdate(message(ALLOWED, ALLOWED, "/start"));
    assert.ok(calls.some((c) => c.method === "sendMessage"));
  });

  it("ignores a stranger entirely", async () => {
    // Silence, not a refusal: an unsolicited message is from someone who found the
    // bot, and replying confirms the token is live and the bot is worth probing.
    const { mgr, calls } = manager();
    await mgr.handleUpdate(message(STRANGER, STRANGER, "/start"));
    assert.deepEqual(calls, []);
  });

  it("ignores a message with no sender", async () => {
    const { mgr, calls } = manager();
    const update = message(ALLOWED, ALLOWED, "/start");
    delete update.message!.from;
    await mgr.handleUpdate(update);
    assert.deepEqual(calls, []);
  });
});

describe("allowlist — callback queries", () => {
  it("enforces the allowlist on button presses, not just on text", async () => {
    // The trap this whole file exists for.
    const { mgr, calls } = manager();
    await mgr.handleUpdate(press(STRANGER, ALLOWED, "mint"));

    const answered = calls.filter((c) => c.method === "answerCallback");
    assert.equal(answered.length, 1);
    assert.match(answered[0]!.text!, /Not authorized/);
    assert.equal(answered[0]!.alert, true);
    // Nothing was drawn: the press must not advance the panel one step.
    assert.ok(!calls.some((c) => c.method === "editMessage" || c.method === "sendMessage"));
  });

  it("rejects a stranger's press out loud, since they can see the panel", async () => {
    // Unlike an unsolicited message, the presser is already looking at the bot —
    // there is nothing to conceal, and silence reads as a broken button.
    const { mgr, calls } = manager();
    await mgr.handleUpdate(press(STRANGER, ALLOWED, "menu"));
    assert.equal(calls.filter((c) => c.method === "answerCallback")[0]!.alert, true);
  });

  it("accepts an allowed user's press", async () => {
    const { mgr, calls } = manager();
    await mgr.handleUpdate(press(ALLOWED, ALLOWED, "menu"));
    assert.ok(calls.some((c) => c.method === "answerCallback"));
    assert.ok(calls.some((c) => c.method === "editMessage" || c.method === "sendMessage"));
  });

  it("rejects a press carrying an unknown action", async () => {
    // A stale keyboard from an older deployment, or a modified client sending
    // whatever it likes. Either way it is named, not silently dropped.
    const { mgr, calls } = manager();
    await mgr.handleUpdate(press(ALLOWED, ALLOWED, "drain_wallets"));

    const answered = calls.filter((c) => c.method === "answerCallback");
    assert.equal(answered.length, 1);
    assert.match(answered[0]!.text!, /no longer valid/);
    assert.equal(answered[0]!.alert, true);
    assert.ok(!calls.some((c) => c.method === "editMessage" || c.method === "sendMessage"));
  });

  it("rejects a press with no data at all", async () => {
    const { mgr, calls } = manager();
    const update = press(ALLOWED, ALLOWED, "menu");
    delete update.callback_query!.data;
    await mgr.handleUpdate(update);
    assert.match(calls.filter((c) => c.method === "answerCallback")[0]!.text!, /no longer valid/);
  });

  it("rejects a press with no message to act on", async () => {
    // No chat means no panel to edit and no way to check the group rule.
    const { mgr, calls } = manager();
    const update = press(ALLOWED, ALLOWED, "menu");
    delete update.callback_query!.message;
    await mgr.handleUpdate(update);
    assert.match(calls.filter((c) => c.method === "answerCallback")[0]!.text!, /Not authorized/);
  });
});

describe("allowlist — groups", () => {
  it("requires both the sender and the group to be listed", async () => {
    const { mgr, calls } = manager();
    await mgr.handleUpdate(message(ALLOWED, ALLOWED_GROUP, "/start", "group"));
    assert.ok(calls.some((c) => c.method === "sendMessage"));
  });

  it("refuses an allowed user in an unlisted group", async () => {
    // Otherwise anyone could add the bot to a group and have a listed user's
    // presence there authorize the whole room.
    const { mgr, calls } = manager();
    await mgr.handleUpdate(message(ALLOWED, -9999, "/start", "group"));
    assert.deepEqual(calls, []);
  });

  it("refuses a stranger in a listed group", async () => {
    // A panel open in a group is visible to every member of it.
    const { mgr, calls } = manager();
    await mgr.handleUpdate(press(STRANGER, ALLOWED_GROUP, "mint", "group"));
    assert.match(calls.filter((c) => c.method === "answerCallback")[0]!.text!, /Not authorized/);
  });

  it("applies the group rule to button presses too", async () => {
    const { mgr, calls } = manager();
    await mgr.handleUpdate(press(ALLOWED, -9999, "mint", "supergroup"));
    assert.match(calls.filter((c) => c.method === "answerCallback")[0]!.text!, /Not authorized/);
  });
});

describe("allowlist — empty", () => {
  it("authorizes nobody when the list is empty", async () => {
    // The bot refuses to start in this state; if that check is ever bypassed, the
    // failure mode must stay "nobody" and never "everybody".
    const { mgr, calls } = manager([]);
    await mgr.handleUpdate(message(ALLOWED, ALLOWED, "/start"));
    await mgr.handleUpdate(press(ALLOWED, ALLOWED, "mint"));
    assert.ok(!calls.some((c) => c.method === "sendMessage" || c.method === "editMessage"));
  });
});
