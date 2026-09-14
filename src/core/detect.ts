// Chain auto-detection for a bare contract address.
//
// An OpenSea link carries its chain and a slug can be looked up, but a bare
// address carries nothing. Requiring --chain for it is a real failure mode: the
// default is used, the address has no code on that chain, and the mint reverts or
// the drop reads as "not configured" — both of which look like a problem with the
// collection rather than a problem with the flag.
//
// So the address is probed on every configured chain at once. `eth_getCode` is the
// right question: it is a single cheap read, it needs no ABI, and a non-empty
// answer is proof that *something* is deployed there. It does not prove the thing
// is a SeaDrop collection — that is what buildMintPlan decides afterwards, on the
// chain this picked.
//
// Three outcomes, and the difference between them matters:
//
//   one chain has code   → use it, no question asked
//   several have code    → ASK. A CREATE2-deployed collection has the same address
//                          on every chain it was deployed to, and guessing which
//                          one the user meant is how you mint on the wrong network
//                          with no error to show for it.
//   none have code       → say so, and list what was probed, because the useful
//                          information is which chains were ruled out
//
// Send-only sequencers are excluded here. They reject reads, so probing them adds
// a guaranteed-failed request per chain and no information — the same reason
// planRpcs splits the read list from the blast list.

import { CHAINS, ChainProfile, resolveChain } from "./chains";

/** One chain's answer to "is there code at this address?". */
export interface ChainProbe {
  chainKey: string;
  chainName: string;
  /** True when the endpoint answered with non-empty bytecode. */
  hasCode: boolean;
  /** Bytecode size in bytes, when known. Useful only as a sanity signal. */
  codeSize: number;
  /** Set when no endpoint for this chain answered at all. */
  error?: string;
}

export type Detection =
  /** Exactly one chain has code. */
  | { kind: "single"; chainKey: string; probes: ChainProbe[] }
  /** Several chains have code — the caller must ask which. */
  | { kind: "ambiguous"; candidates: string[]; probes: ChainProbe[] }
  /** Nothing answered with code. */
  | { kind: "none"; probes: ChainProbe[] };

/**
 * Turn a set of probe results into a decision.
 *
 * Pure, and separated from the I/O above it so the three-way outcome can be
 * tested without a network. This is the part that must not be wrong: a bug that
 * collapses "ambiguous" into "single" mints on an arbitrary chain.
 */
export function classifyProbes(probes: ChainProbe[]): Detection {
  const withCode = probes.filter((p) => p.hasCode);

  if (withCode.length === 1) {
    return { kind: "single", chainKey: withCode[0]!.chainKey, probes };
  }
  if (withCode.length > 1) {
    return { kind: "ambiguous", candidates: withCode.map((p) => p.chainKey), probes };
  }
  return { kind: "none", probes };
}

/**
 * A message for the "nothing found" case that names what was ruled out.
 *
 * "Contract not found" tells the user nothing they can act on. The list of chains
 * probed is what distinguishes a typo in the address (nothing anywhere) from a
 * collection on a chain this build does not support (everything answered, no code).
 */
export function noCodeMessage(address: string, probes: ChainProbe[]): string {
  const reachable = probes.filter((p) => p.error === undefined).map((p) => p.chainKey);
  const unreachable = probes.filter((p) => p.error !== undefined).map((p) => p.chainKey);

  const lines = [`No contract code found at ${address} on any configured chain.`];
  if (reachable.length > 0) lines.push(`  probed and empty: ${reachable.join(", ")}`);
  if (unreachable.length > 0) {
    lines.push(`  no endpoint answered: ${unreachable.join(", ")}`);
  }
  lines.push("");
  lines.push("Either the address is mistyped, or the collection is on a chain intern");
  lines.push("does not support yet. Pass --chain explicitly to skip detection.");
  return lines.join("\n");
}

/**
 * Read `eth_getCode` from the first endpoint that answers.
 *
 * Endpoints are tried in order rather than all at once: this runs for every chain
 * simultaneously already, and fanning out inside each chain as well would turn one
 * detection into forty requests. The first usable answer is authoritative — code
 * presence is not a matter of opinion between endpoints.
 */
async function probeChain(
  chain: ChainProfile,
  address: string,
  timeoutMs: number,
): Promise<ChainProbe> {
  // Read-capable endpoints only. A sequencer would reject this and tell us nothing.
  const urls = chain.rpc.public;
  let lastError = "no endpoint configured";

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_getCode",
          params: [address, "latest"],
          id: 1,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json()) as { result?: string; error?: { message?: string } };

      if (typeof json.result === "string") {
        const code = json.result;
        // "0x" (and "0x0") mean no contract. Anything longer is bytecode.
        const hex = code.startsWith("0x") ? code.slice(2) : code;
        const hasCode = hex.length > 0 && /[1-9a-f]/i.test(hex);
        return {
          chainKey: chain.key,
          chainName: chain.name,
          hasCode,
          codeSize: Math.floor(hex.length / 2),
        };
      }
      lastError = json.error?.message ?? `HTTP ${res.status}`;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    chainKey: chain.key,
    chainName: chain.name,
    hasCode: false,
    codeSize: 0,
    error: lastError,
  };
}

// Detection is stable for the life of the process: a contract's code cannot be
// removed from a chain (barring SELFDESTRUCT, which no SeaDrop collection does),
// so the answer for a given address will not change while the bot is running. The
// cache matters because a panel that refreshes every 20s would otherwise re-probe
// eight chains on every tick.
const cache = new Map<string, Detection>();

export function clearDetectionCache(): void {
  cache.clear();
}

/**
 * Probe every configured chain concurrently for code at `address`.
 *
 * Concurrent across chains because they are independent and the latency is
 * entirely network-bound — serially this would take eight round trips instead of
 * one, on the interactive path where the user is waiting.
 */
export async function detectChain(
  address: string,
  opts: { timeoutMs?: number; chains?: ChainProfile[]; useCache?: boolean } = {},
): Promise<Detection> {
  const key = address.toLowerCase();
  if (opts.useCache !== false) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const chains = opts.chains ?? CHAINS;
  const probes = await Promise.all(
    chains.map((chain) => probeChain(chain, address, opts.timeoutMs ?? 6_000)),
  );

  const detection = classifyProbes(probes);
  if (opts.useCache !== false) cache.set(key, detection);
  return detection;
}

/**
 * Order candidate chains for a picker.
 *
 * Registry order, which is roughly "where OpenSea drops actually happen" —
 * Ethereum and Base first. Deliberately not sorted by code size or latency:
 * neither has anything to do with which deployment the user meant, and a list that
 * reorders itself between renders is a list people misclick.
 */
export function orderCandidates(candidates: string[]): ChainProfile[] {
  return CHAINS.filter((chain) => candidates.includes(chain.key));
}

/** Human summary of a detection, for logs and panel footers. */
export function describeDetection(detection: Detection): string {
  switch (detection.kind) {
    case "single": {
      const chain = resolveChain(detection.chainKey);
      return `detected on ${chain?.name ?? detection.chainKey}`;
    }
    case "ambiguous":
      return `deployed on ${detection.candidates.length} chains — pick one`;
    case "none":
      return "no code found on any configured chain";
  }
}
