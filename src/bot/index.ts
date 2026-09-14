#!/usr/bin/env node
// The bot process: startup checks, the long-poll loop, shutdown.
//
// Startup refuses to continue on two conditions, both deliberately fatal rather
// than warned:
//
//   No TELEGRAM_ALLOWED_IDS. A bot token is a bearer credential — anyone who has it
//   can message the bot, and a token in a .env file, a screenshot or a shell history
//   has a way of getting out. Without an id allowlist, this process will sign
//   transactions for whoever finds it. Starting "open for now" is how that happens,
//   so it does not start.
//
//   No wallets. A bot that cannot sign is a bot that discovers this at T-0, on the
//   mint the user was waiting for. Better to fail at boot with the reason.
//
// Pending updates are dropped at startup. A "fire" command that was sent while the
// process was down should not execute on restart, minutes late, against a stage
// whose price has moved.

import { ConflictError, TelegramClient, TelegramError, bold, esc } from "./api";
import { BOT_COMMANDS, SessionManager } from "./session";
import { loadEnv, readDefaults } from "../util/env";
import { redactKeys, walletsFromEnv } from "../core/wallets";
import { shortAddress } from "../core/target";
import { CorrectedClock, syncClock } from "../core/clock";
import { resolveChain } from "../core/chains";
import { resolveRpcsForChain } from "../core/rpc";

/** Backoff between reconnects, in ms. Grows on repeated failure, resets on success. */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export async function runBot(): Promise<void> {
  loadEnv();
  const defaults = readDefaults();

  if (!defaults.telegramToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put the token in .env.",
    );
  }

  if (defaults.telegramAllowedIds.length === 0) {
    throw new Error(
      [
        "TELEGRAM_ALLOWED_IDS is empty, so this bot will not start.",
        "",
        "The bot token is the only thing standing between a stranger and your wallets,",
        "and a token is easy to leak. Set TELEGRAM_ALLOWED_IDS to the numeric Telegram",
        "user ids allowed to command this bot:",
        "",
        "    TELEGRAM_ALLOWED_IDS=123456789,987654321",
        "",
        "Message @userinfobot on Telegram to find your id. Ids, not usernames — a",
        "username can be changed by whoever holds it.",
      ].join("\n"),
    );
  }

  const wallets = walletsFromEnv();
  if (wallets.length === 0) {
    throw new Error(
      "No wallets loaded. Set PRIVATE_KEYS in .env — the bot signs locally and never accepts keys over Telegram.",
    );
  }

  const client = new TelegramClient(defaults.telegramToken);
  const me = await client.getMe();

  // Measure the local clock against the network once at startup, so every panel
  // countdown and "updated at" footer reads corrected time. This is only for
  // display: an actual mint re-syncs inside the engine against the chain it fires
  // on. Best-effort — a bot that cannot reach an RPC at boot must still start,
  // because the wallets and the allowlist are what make it useful, not the clock.
  const clock = new CorrectedClock(0);
  try {
    const chain = resolveChain(defaults.chain);
    if (chain) {
      const resolved = resolveRpcsForChain(chain.key, [], process.env);
      const sync = await syncClock(resolved.urls, chain.blockTimeSec, { rounds: 2 });
      clock.applySync(sync);
    }
  } catch {
    // Fall through with a zero offset — the local clock, used as-is.
  }

  const manager = new SessionManager({
    client,
    defaults,
    wallets,
    allowedIds: defaults.telegramAllowedIds,
    clock,
  });

  const dropped = await client.dropPendingUpdates();
  await client.setCommands(BOT_COMMANDS);

  process.stdout.write(
    [
      `intern bot online as @${me.username ?? me.id}`,
      `  wallets: ${wallets.length} — ${wallets.map((w) => shortAddress(w.address)).join(", ")}`,
      `  allowed: ${defaults.telegramAllowedIds.length} id(s)`,
      `  chain:   ${defaults.chain}`,
      `  clock:   ${clock.offset >= 0 ? "+" : ""}${clock.offset}ms correction`,
      dropped > 0 ? `  dropped: ${dropped} update(s) queued while offline` : "",
      "",
      "bot is running — leave this process alive (systemd recommended).",
      "See deploy/intern-bot.service. Ctrl+C to stop.",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n",
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    process.stdout.write("\nStopping — in-flight runs are being aborted.\n");
    manager.shutdown();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let backoff = BACKOFF_MIN_MS;

  while (!stopping) {
    try {
      const updates = await client.getUpdates();
      backoff = BACKOFF_MIN_MS;

      // Sequential, not concurrent. Two commands from the same chat arriving in one
      // batch must be applied in the order they were sent, or "/mint x" followed by
      // a confirmation tap can be processed the wrong way round.
      for (const update of updates) {
        if (stopping) break;
        try {
          await manager.handleUpdate(update);
        } catch (err: unknown) {
          // One bad update must never end the loop: the bot would go silent
          // precisely when someone is relying on it.
          const message = redactKeys(err instanceof Error ? err.message : String(err));
          process.stderr.write(`update ${update.update_id} failed: ${message}\n`);
          const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
          if (chatId !== undefined) {
            await client
              .sendMessage(chatId, `${bold("Something went wrong")}\n${esc(message)}`)
              .catch(() => {});
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        process.stderr.write(`\n${err.message}\n`);
        manager.shutdown();
        process.exitCode = 1;
        return;
      }
      if (err instanceof TelegramError && err.status === 401) {
        process.stderr.write(`\n${err.message}\n`);
        manager.shutdown();
        process.exitCode = 1;
        return;
      }

      // Everything else — a dropped connection, a 502, a rate limit — is transient.
      // Telegram's own retry_after is honoured when given, because ignoring it is
      // what turns a brief limit into a long one.
      const wait =
        err instanceof TelegramError && err.retryAfterSec
          ? err.retryAfterSec * 1000
          : backoff;
      const message = redactKeys(err instanceof Error ? err.message : String(err));
      process.stderr.write(`poll failed (${message}) — retrying in ${Math.round(wait / 1000)}s\n`);
      await sleep(wait);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    }
  }

  manager.shutdown();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// Runnable directly (`npm run bot`) as well as through `intern bot`.
if (require.main === module) {
  runBot().catch((err: unknown) => {
    const message = redactKeys(err instanceof Error ? err.message : String(err));
    process.stderr.write(`\n${message}\n`);
    process.exit(1);
  });
}
