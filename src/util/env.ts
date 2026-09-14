// Configuration, and the rules about where secrets may live.
//
// Two kinds of value get read here and they are treated differently:
//
//   Operational settings (chain, gas, RPC URLs, lead time) are read from .env and
//   from flags, with flags winning. They are printed freely.
//
//   Secrets (private keys, API keys, bot tokens) are read but never echoed, never
//   written back to disk, and never included in an error message. `redactKeys`
//   guards the paths where a value could reach a log or a Telegram chat.
//
// A note on .env for private keys: it is plaintext on disk, which is a real
// exposure and is worse than pasting into a prompt that keeps the key in memory
// only. It is supported because the alternative — retyping keys before every mint
// — pushes people toward worse habits, but the CLI says so out loud rather than
// pretending the trade-off is not there.

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

export function loadEnv(cwd: string = process.cwd()): void {
  const envPath = path.resolve(cwd, ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
}

export interface Defaults {
  chain: string;
  quantity: number;
  gasLimit: bigint;
  maxFeeGwei: number | null;
  priorityGwei: number | null;
  leadMs: number;
  openseaApiKey: string | null;
  telegramToken: string | null;
  telegramAllowedIds: number[];
  receiptTimeoutMs: number;
}

function numberFrom(raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bigintFrom(raw: string | undefined, fallback: bigint): bigint {
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const value = BigInt(raw.trim());
    return value > 0n ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Telegram access control: an explicit allowlist of numeric user ids.
 *
 * This is the only thing standing between a bot token and someone else's wallet,
 * so it is deliberately an allowlist rather than a password. A token can leak from
 * a screenshot, a shell history, or a misconfigured backup; an id allowlist means
 * a leaked token alone is not enough to spend funds. The bot refuses to run
 * without one for exactly that reason.
 */
function idsFrom(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function readDefaults(env: NodeJS.ProcessEnv = process.env): Defaults {
  const apiKey = env.OPENSEA_API_KEY?.trim();
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  return {
    chain: (env.CHAIN ?? "base").trim().toLowerCase(),
    quantity: Math.max(1, Math.floor(numberFrom(env.QUANTITY, 1) ?? 1)),
    gasLimit: bigintFrom(env.GAS_LIMIT, 250_000n),
    maxFeeGwei: numberFrom(env.MAX_FEE_PER_GAS, null),
    priorityGwei: numberFrom(env.MAX_PRIORITY_FEE, null),
    leadMs: Math.max(0, Math.floor(numberFrom(env.LEAD_MS, 0) ?? 0)),
    openseaApiKey: apiKey && apiKey.length > 0 ? apiKey : null,
    telegramToken: token && token.length > 0 ? token : null,
    telegramAllowedIds: idsFrom(env.TELEGRAM_ALLOWED_IDS),
    receiptTimeoutMs: Math.max(
      5_000,
      Math.floor(numberFrom(env.RECEIPT_TIMEOUT_MS, 90_000) ?? 90_000),
    ),
  };
}

const ENV_TEMPLATE = `# intern — configuration
#
# Everything here is optional; the CLI prompts for what it needs. Values set here
# become the defaults so a contested mint needs no typing.

# ── Wallets ─────────────────────────────────────────────────────────────────
# PLAINTEXT ON DISK. Prefer pasting keys at the prompt (memory only) and use this
# only on a machine you control. Never a seed phrase. Never commit this file.
# PRIVATE_KEY=
# PRIVATE_KEYS=key1,key2

# ── Network ─────────────────────────────────────────────────────────────────
# ethereum | base | robinhood | ink | arbitrum | optimism | polygon | zora
CHAIN=base

# A private RPC is the single biggest speed factor in a contested mint.
# Per-chain entries win over the generic one; comma-separate for several.
# RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
# RPC_URL_ETHEREUM=
# RPC_URL_ROBINHOOD=
# RPC_URL=
# EXTRA_RPC_URLS=

# ── Mint ────────────────────────────────────────────────────────────────────
QUANTITY=1
GAS_LIMIT=250000
# Fee ceiling in gwei. Left unset, it is derived from the live base fee, which is
# usually what you want — a ceiling is a maximum, not a payment.
# MAX_FEE_PER_GAS=
# MAX_PRIORITY_FEE=

# Fire this many ms before the stage opens. 0 (default) fires at T-0. A non-zero
# value risks reverting with NotActive; only set it if you know the chain's
# inclusion behaviour.
LEAD_MS=0
RECEIPT_TIMEOUT_MS=90000

# ── OpenSea ─────────────────────────────────────────────────────────────────
# Needed only for slug lookups and allowlist/FCFS stages. Public mints read
# everything from the chain and need no key at all.
# OPENSEA_API_KEY=

# ── Telegram bot ────────────────────────────────────────────────────────────
# From @BotFather.
# TELEGRAM_BOT_TOKEN=
# REQUIRED for the bot to start: numeric user ids allowed to command it. Get
# yours from @userinfobot. A leaked token is not enough to spend funds unless the
# attacker is also on this list.
# TELEGRAM_ALLOWED_IDS=123456789
`;

/** Write a commented .env template. Never overwrites an existing file. */
export function writeEnvTemplate(cwd: string = process.cwd()): { path: string; created: boolean } {
  const envPath = path.resolve(cwd, ".env");
  if (fs.existsSync(envPath)) return { path: envPath, created: false };
  fs.writeFileSync(envPath, ENV_TEMPLATE, { encoding: "utf8", mode: 0o600 });
  return { path: envPath, created: true };
}

export { ENV_TEMPLATE };
