// Chain auto-detection: the three-way decision.
//
// `classifyProbes` is the part that must not be wrong. Collapsing "ambiguous" into
// "single" does not throw, does not warn, and mints on an arbitrary chain — a
// CREATE2 collection has the same address on every chain it was deployed to, so
// the wrong pick is a real transaction on a real network. Pure and probe-driven,
// so all three outcomes are testable without a network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChainProbe,
  classifyProbes,
  describeDetection,
  noCodeMessage,
  orderCandidates,
} from "../src/core/detect";
import { CHAINS } from "../src/core/chains";

function probe(chainKey: string, hasCode: boolean, over: Partial<ChainProbe> = {}): ChainProbe {
  return {
    chainKey,
    chainName: chainKey,
    hasCode,
    codeSize: hasCode ? 4_200 : 0,
    ...over,
  };
}

describe("classifyProbes", () => {
  it("takes the single chain that has code", () => {
    const detection = classifyProbes([
      probe("ethereum", false),
      probe("base", true),
      probe("optimism", false),
    ]);
    assert.equal(detection.kind, "single");
    assert.equal(detection.kind === "single" && detection.chainKey, "base");
  });

  it("asks when several chains have code", () => {
    // The whole point of the test file: this must never silently resolve.
    const detection = classifyProbes([
      probe("ethereum", true),
      probe("base", true),
      probe("optimism", false),
    ]);
    assert.equal(detection.kind, "ambiguous");
    assert.deepEqual(
      detection.kind === "ambiguous" ? detection.candidates : [],
      ["ethereum", "base"],
    );
  });

  it("does not resolve an ambiguity by picking the bigger deployment", () => {
    // Code size says nothing about which deployment the user meant.
    const detection = classifyProbes([
      probe("ethereum", true, { codeSize: 100 }),
      probe("base", true, { codeSize: 90_000 }),
    ]);
    assert.equal(detection.kind, "ambiguous");
  });

  it("reports none when nothing has code", () => {
    const detection = classifyProbes([probe("ethereum", false), probe("base", false)]);
    assert.equal(detection.kind, "none");
  });

  it("reports none when every endpoint failed, not a false single", () => {
    // An unreachable chain is "unknown", never "no code there". Treating a failed
    // probe as a negative is how the one chain that did answer wins by default.
    const detection = classifyProbes([
      probe("ethereum", false, { error: "timeout" }),
      probe("base", false, { error: "HTTP 502" }),
    ]);
    assert.equal(detection.kind, "none");
  });

  it("keeps every probe on the result for reporting", () => {
    const probes = [probe("ethereum", false), probe("base", true)];
    assert.deepEqual(classifyProbes(probes).probes, probes);
  });

  it("handles an empty probe set without throwing", () => {
    assert.equal(classifyProbes([]).kind, "none");
  });
});

describe("noCodeMessage", () => {
  const address = "0x1111111111111111111111111111111111111111";

  it("separates chains that answered from chains that did not", () => {
    // The distinction the user acts on: a typo in the address (everything answered,
    // nothing found) versus a chain intern could not reach (retry) or support.
    const message = noCodeMessage(address, [
      probe("ethereum", false),
      probe("base", false, { error: "timeout" }),
    ]);
    assert.match(message, /probed and empty: ethereum/);
    assert.match(message, /no endpoint answered: base/);
  });

  it("names the address and offers the explicit escape hatch", () => {
    const message = noCodeMessage(address, [probe("ethereum", false)]);
    assert.match(message, new RegExp(address));
    assert.match(message, /--chain/);
  });

  it("omits the empty half rather than printing a bare heading", () => {
    const message = noCodeMessage(address, [probe("ethereum", false)]);
    assert.ok(!message.includes("no endpoint answered:"));
  });
});

describe("orderCandidates", () => {
  it("returns candidates in registry order, not argument order", () => {
    // A picker that reorders itself between renders is a picker people misclick.
    const forward = orderCandidates(["base", "ethereum"]).map((c) => c.key);
    const backward = orderCandidates(["ethereum", "base"]).map((c) => c.key);
    assert.deepEqual(forward, backward);
  });

  it("resolves candidate keys to full chain profiles", () => {
    const ordered = orderCandidates(["ethereum"]);
    assert.equal(ordered.length, 1);
    assert.equal(ordered[0]!.key, "ethereum");
    assert.ok(ordered[0]!.chainId > 0);
  });

  it("drops keys that are not configured chains", () => {
    assert.deepEqual(orderCandidates(["not-a-chain"]), []);
  });

  it("returns every chain when everything is a candidate", () => {
    const all = CHAINS.map((c) => c.key);
    assert.equal(orderCandidates(all).length, CHAINS.length);
  });
});

describe("describeDetection", () => {
  it("names the chain it resolved to", () => {
    const text = describeDetection(classifyProbes([probe("ethereum", true)]));
    assert.match(text, /detected on/i);
  });

  it("says how many chains are in play when ambiguous", () => {
    const text = describeDetection(
      classifyProbes([probe("ethereum", true), probe("base", true)]),
    );
    assert.match(text, /2 chains/);
  });

  it("says nothing was found when nothing was", () => {
    const text = describeDetection(classifyProbes([probe("ethereum", false)]));
    assert.match(text, /no code found/i);
  });
});
