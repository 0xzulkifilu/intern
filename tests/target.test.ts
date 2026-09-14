// Target parsing: OpenSea links, slugs, and addresses.
//
// This is the first thing a user's input touches, and a wrong answer here means
// minting the wrong contract on the wrong chain — so the cases that matter are the
// ones where a plausible input could resolve to something unintended.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAddress, parseTarget, shortAddress } from "../src/core/target";

const ADDR = "0x0000000000000000000000000000000000000001";

describe("parseTarget", () => {
  it("reads a bare address", () => {
    const target = parseTarget(ADDR);
    assert.equal(target.kind, "address");
    assert.equal(target.value, ADDR);
    assert.equal(target.chainHint, undefined);
  });

  it("reads a bare slug and lowercases it", () => {
    const target = parseTarget("Cool-Cats");
    assert.equal(target.kind, "slug");
    assert.equal(target.value, "cool-cats");
  });

  it("pulls chain and address out of an item URL", () => {
    const target = parseTarget(`https://opensea.io/assets/base/${ADDR}/42`);
    assert.equal(target.kind, "address");
    assert.equal(target.value, ADDR);
    assert.equal(target.chainHint, "base");
    assert.equal(target.tokenId, "42");
  });

  it("maps OpenSea's chain aliases onto our chain keys", () => {
    assert.equal(parseTarget(`https://opensea.io/assets/ethereum/${ADDR}/1`).chainHint, "ethereum");
    assert.equal(parseTarget(`https://opensea.io/assets/matic/${ADDR}/1`).chainHint, "polygon");
  });

  it("pulls the slug out of a collection URL", () => {
    const target = parseTarget("https://opensea.io/collection/my-drop");
    assert.equal(target.kind, "slug");
    assert.equal(target.value, "my-drop");
  });

  it("ignores the trailing /drop and /overview segments", () => {
    assert.equal(parseTarget("https://opensea.io/collection/my-drop/drop").value, "my-drop");
    assert.equal(parseTarget("https://opensea.io/collection/my-drop/overview").value, "my-drop");
  });

  it("tolerates a missing protocol and a trailing slash", () => {
    assert.equal(parseTarget("opensea.io/collection/my-drop/").value, "my-drop");
  });

  it("refuses empty and nonsense input instead of guessing a slug", () => {
    assert.throws(() => parseTarget(""), /No target given/);
    assert.throws(() => parseTarget("   "), /No target given/);
    assert.throws(() => parseTarget("what is this"), /Could not read/);
  });

  it("refuses a truncated address rather than treating it as a slug", () => {
    // A 39-character hex string is a typo'd address, not a collection named
    // "0x000…". Resolving it as a slug would send a user to a lookup failure with
    // a misleading message.
    assert.throws(
      () => parseTarget("0x000000000000000000000000000000000000000"),
      /39 hex character\(s\) long/,
    );
  });
});

describe("normalizeAddress", () => {
  it("accepts all-lowercase without a warning", () => {
    const result = normalizeAddress(ADDR);
    assert.ok(result);
    assert.equal(result.checksumWarning, false);
  });

  it("accepts a valid EIP-55 checksum", () => {
    const mixed = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const result = normalizeAddress(mixed);
    assert.ok(result);
    assert.equal(result.address, mixed);
    assert.equal(result.checksumWarning, false);
  });

  it("flags a mixed-case address whose checksum does not verify", () => {
    // Mixed case is a checksum claim. If it fails, the address has been
    // transcribed wrongly — one character off is a different wallet entirely.
    const result = normalizeAddress("0xDAC17F958D2ee523a2206206994597C13D831ec7");
    assert.ok(result);
    assert.equal(result.checksumWarning, true);
  });

  it("returns null for non-addresses", () => {
    assert.equal(normalizeAddress("nope"), null);
    assert.equal(normalizeAddress("0x123"), null);
  });
});

describe("shortAddress", () => {
  it("keeps both ends, which is what identifies a wallet at a glance", () => {
    const short = shortAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    assert.ok(short.startsWith("0xdAC1"));
    assert.ok(short.endsWith("1ec7"));
    assert.ok(short.length < 20);
  });
});
