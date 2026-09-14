// Wallet arithmetic, key handling, and redaction.
//
// `requiredBalance` and `redactKeys` are both small enough to look obviously
// correct, and both are the kind of thing that is quietly wrong for months. One
// decides whether a mint is attempted at all; the other decides whether a private
// key ends up in a Telegram chat.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  affordableMaxFeeGwei,
  formatEth,
  gweiToWei,
  loadWallets,
  redactKeys,
  requiredBalance,
  suggestMaxFee,
  weiToGwei,
} from "../src/core/wallets";

// Deterministic throwaway keys. Never funded, never used anywhere.
const KEY_A = "0x0000000000000000000000000000000000000000000000000000000000000001";
const KEY_B = "0x0000000000000000000000000000000000000000000000000000000000000002";

describe("requiredBalance", () => {
  it("reserves the full gas ceiling, not the expected gas cost", () => {
    // This is what the *node* reserves before it will accept the transaction.
    // Budgeting the likely cost instead produces "insufficient funds" at the one
    // moment it cannot be fixed.
    const required = requiredBalance(10n ** 16n, {
      maxFeePerGas: gweiToWei(0.05),
      maxPriorityFeePerGas: gweiToWei(0.001),
      gasLimit: 250_000n,
    });
    assert.equal(required, 10n ** 16n + 250_000n * gweiToWei(0.05));
  });

  it("is the gas reservation alone for a free mint", () => {
    const gas = {
      maxFeePerGas: gweiToWei(1),
      maxPriorityFeePerGas: 0n,
      gasLimit: 100_000n,
    };
    assert.equal(requiredBalance(0n, gas), 100_000n * gweiToWei(1));
  });
});

describe("suggestMaxFee", () => {
  it("leaves room for the base fee to climb", () => {
    // Base fee can rise 12.5% per block. 2× base covers roughly six blocks of
    // sustained increase, which is the span that matters during a mint.
    const base = gweiToWei(10);
    const tip = gweiToWei(1);
    assert.equal(suggestMaxFee(base, tip), base * 2n + tip);
  });
});

describe("affordableMaxFeeGwei", () => {
  it("reports what a balance can actually cover per unit of gas", () => {
    const balance = gweiToWei(1) * 250_000n; // exactly 1 gwei/gas at this limit
    const result = affordableMaxFeeGwei(balance, 0n, 250_000n);
    assert.ok(Math.abs(result - 1) < 1e-9, `expected ~1 gwei, got ${result}`);
  });

  it("returns zero when the mint price alone exhausts the balance", () => {
    assert.equal(affordableMaxFeeGwei(100n, 100n, 250_000n), 0);
    assert.equal(affordableMaxFeeGwei(50n, 100n, 250_000n), 0);
  });
});

describe("gwei conversion", () => {
  it("round-trips", () => {
    assert.equal(gweiToWei(1), 1_000_000_000n);
    assert.equal(weiToGwei(1_000_000_000n), 1);
    assert.equal(gweiToWei(0.001), 1_000_000n);
  });
});

describe("formatEth", () => {
  it("labels the chain's own currency rather than assuming ETH", () => {
    assert.match(formatEth(10n ** 18n, "POL"), /POL/);
    assert.match(formatEth(10n ** 18n, "ETH"), /^1\b/);
  });

  it("does not round a small amount away to zero", () => {
    // "0 ETH" for a nonzero balance reads as "free" and is how people mint
    // believing they have spent nothing.
    const formatted = formatEth(10n ** 12n, "ETH");
    assert.ok(!/^0 /.test(formatted), `small amount rendered as ${formatted}`);
  });
});

describe("loadWallets", () => {
  it("accepts keys with and without the 0x prefix", () => {
    const withPrefix = loadWallets([KEY_A]);
    const without = loadWallets([KEY_A.slice(2)]);
    assert.equal(withPrefix.length, 1);
    assert.equal(withPrefix[0]!.address, without[0]!.address);
  });

  it("numbers wallets in the order given, so W0 means the first key", () => {
    const wallets = loadWallets([KEY_A, KEY_B]);
    assert.equal(wallets[0]!.index, 0);
    assert.equal(wallets[1]!.index, 1);
    assert.notEqual(wallets[0]!.address, wallets[1]!.address);
  });

  it("drops duplicates, which would collide on the same nonce", () => {
    // Two copies of one key are one wallet. Signing twice from the same nonce
    // means one transaction is discarded by the network with no error shown.
    const wallets = loadWallets([KEY_A, KEY_A, KEY_B]);
    assert.equal(wallets.length, 2);
  });

  it("ignores blank entries from a trailing comma or newline", () => {
    assert.equal(loadWallets(["", "  ", KEY_A]).length, 1);
  });

  it("refuses a malformed key without putting it in the message", () => {
    // The error text is shown to the user and may be logged; a key fragment in it
    // defeats the point of hiding the input in the first place.
    const bad = "0xnot-a-key";
    assert.throws(
      () => loadWallets([bad]),
      (err: unknown) => err instanceof Error && !err.message.includes("not-a-key"),
    );
  });
});

describe("redactKeys", () => {
  it("removes a 0x-prefixed private key from text", () => {
    const leaked = `failed to sign with ${KEY_A}`;
    const safe = redactKeys(leaked);
    assert.ok(!safe.includes(KEY_A), `key survived redaction: ${safe}`);
  });

  it("removes a bare 64-hex key with no prefix", () => {
    const safe = redactKeys(`key=${KEY_A.slice(2)}`);
    assert.ok(!safe.includes(KEY_A.slice(2)), `key survived redaction: ${safe}`);
  });

  it("leaves addresses and transaction hashes alone", () => {
    // Over-redacting makes error messages useless: a tx hash is exactly what a
    // user needs to look up what happened.
    const address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    assert.ok(redactKeys(`sent from ${address}`).includes(address));
  });

  it("redacts a bot token", () => {
    const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
    assert.ok(!redactKeys(`token ${token} rejected`).includes(token));
  });
});
