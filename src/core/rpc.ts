// RPC endpoint resolution, health probing, and latency ranking.
//
// Endpoint order decides two different things and they need different criteria:
//
//   Reading  — one endpoint is used for nonces, balances, eth_call, gas and
//              receipts. It must actually answer queries and it should be the
//              fastest one that does, since every read is on the setup path.
//
//   Blasting — every endpoint gets the signed bytes simultaneously. Here a
//              sequencer that refuses all reads is often the single best path to
//              inclusion, so it stays in the list. What must be excluded is any
//              endpoint on the *wrong chain*: broadcasting there leaks a signed
//              transaction to a network where the nonce may be reusable.
//
// So endpoints are probed, ranked by measured latency, and split accordingly.

import { ChainProfile, allRpcs, resolveChain } from "./chains";

export interface ResolvedRpcs {
  urls: string[];
  source: string;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/** Dedupe by normalized URL — trailing slashes and case differ, the node doesn't. */
function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    let norm = url.trim();
    try {
      const parsed = new URL(norm);
      parsed.hash = "";
      norm = parsed.toString().replace(/\/$/, "");
    } catch {
      /* keep as typed; the probe will reject it if malformed */
    }
    const dedupeKey = norm.toLowerCase();
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      out.push(url.trim());
    }
  }
  return out;
}

/**
 * Providers encode the network in the hostname (base-mainnet.g.alchemy.com),
 * which lets a single generic RPC_URL be matched to the right chain even when
 * CHAIN is unset — rather than silently pointing an Ethereum URL at Base.
 */
function urlMatchesChain(url: string, profile: ChainProfile): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (profile.rpc.alchemyHost && host === profile.rpc.alchemyHost.toLowerCase()) return true;
  return allRpcs(profile).some((p) => {
    try {
      return new URL(p).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  });
}

/**
 * Private endpoints configured for this chain, in precedence order:
 *   1. RPC_URL_<CHAIN>  (comma-separated)
 *   2. RPC_URL + EXTRA_RPC_URLS, when CHAIN names this chain
 *   3. any generic entry whose hostname names this chain
 */
export function privateRpcsFromEnv(
  chainKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const profile = resolveChain(chainKey);
  if (!profile) return [];

  const perChain = splitList(env[`RPC_URL_${chainKey.toUpperCase()}`]);
  if (perChain.length > 0) return perChain;

  const generic = [...splitList(env.RPC_URL), ...splitList(env.EXTRA_RPC_URLS)];
  const envChain = (env.CHAIN || "").trim().toLowerCase();
  if (envChain === chainKey && generic.length > 0) return generic;

  const matched = generic.filter((u) => urlMatchesChain(u, profile));
  return matched.length > 0 ? matched : [];
}

/** Manual entry beats .env; public endpoints always trail as fallbacks. */
export function resolveRpcsForChain(
  chainKey: string,
  manual: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRpcs {
  const profile = resolveChain(chainKey);
  if (!profile) throw new Error(`Unknown chain: "${chainKey}"`);

  if (manual.length > 0) {
    return {
      urls: dedupe([...manual, ...allRpcs(profile)]),
      source: "entered RPC + public fallbacks",
    };
  }
  const fromEnv = privateRpcsFromEnv(chainKey, env);
  if (fromEnv.length > 0) {
    return { urls: dedupe([...fromEnv, ...allRpcs(profile)]), source: ".env + public fallbacks" };
  }
  return {
    urls: dedupe(allRpcs(profile)),
    source: "public endpoints only — likely too slow for a contested mint",
  };
}

/** Accept a full URL or a bare provider key, expanded against the chain's host. */
export function toRpcUrl(value: string, chainKey: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  if (raw.includes("://")) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return raw;
    } catch {
      return null;
    }
  }
  const host = resolveChain(chainKey)?.rpc.alchemyHost;
  if (!host) return null;
  if (!/^[A-Za-z0-9_-]{16,}$/.test(raw)) return null;
  return `https://${host}/v2/${raw}`;
}

/** Hide the key segment so a screenshot or shoulder-surf doesn't leak it. */
export function maskRpc(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return u.origin;
    const last = segments[segments.length - 1]!;
    segments[segments.length - 1] = last.length > 8 ? `${last.slice(0, 4)}…${last.slice(-4)}` : "…";
    return `${u.origin}/${segments.join("/")}`;
  } catch {
    return url;
  }
}

export function labelFor(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("sequencer.base.org")) return "base-sequencer";
  if (lower.includes("sequencer.mainnet.chain.robinhood.com")) return "robinhood-sequencer";
  if (lower.includes("alchemy")) return "alchemy";
  if (lower.includes("flashbots")) return "flashbots";
  if (lower.includes("quicknode")) return "quicknode";
  if (lower.includes("infura")) return "infura";
  if (lower.includes("ankr")) return "ankr";
  if (lower.includes("publicnode")) return "publicnode";
  if (lower.includes("drpc")) return "drpc";
  if (lower.includes("cloudflare")) return "cloudflare";
  if (lower.includes("merkle")) return "merkle";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface EndpointHealth {
  url: string;
  label: string;
  /** Reported chain id, or null when the endpoint answered nothing usable. */
  chainId: number | null;
  /** Median latency of the successful probes, or null when all failed. */
  latencyMs: number | null;
  error?: string;
  /** Answers reads: correct chain id AND a latency measurement. */
  readable: boolean;
}

export interface RpcPlan {
  /** Read endpoint, fastest verified first. Empty when nothing answers. */
  read: string[];
  /** Broadcast list: everything not on a provably wrong chain. */
  blast: string[];
  verified: boolean;
  health: EndpointHealth[];
  /** Removed for reporting a different chain id. */
  dropped: EndpointHealth[];
}

interface ProbeResult {
  chainId: number | null;
  latencyMs: number | null;
  error?: string;
}

async function probeOnce(url: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    let json: { result?: string; error?: { message?: string } };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return { chainId: null, latencyMs: null, error: `HTTP ${res.status} (non-JSON body)` };
    }
    if (typeof json.result === "string") {
      const id = parseInt(json.result, 16);
      return { chainId: Number.isFinite(id) ? id : null, latencyMs };
    }
    if (json.error?.message) return { chainId: null, latencyMs: null, error: json.error.message };
    return { chainId: null, latencyMs: null, error: `HTTP ${res.status}` };
  } catch (err: unknown) {
    return {
      chainId: null,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Probe every endpoint and rank the read list by measured latency.
 *
 * Each endpoint is sampled `samples` times because a single measurement on a
 * shared public node is mostly noise — one unlucky sample would demote the
 * fastest provider. The median is taken rather than the minimum: the goal is the
 * latency to expect during the mint, not the best case ever observed.
 *
 * A cold connection also pays TLS setup on its first sample, so the first result
 * is systematically slower. Sampling more than once removes that bias too.
 */
export async function planRpcs(
  urls: string[],
  expectedChainId: number,
  opts: { samples?: number; timeoutMs?: number } = {},
): Promise<RpcPlan> {
  const samples = Math.max(1, opts.samples ?? 3);
  const timeoutMs = opts.timeoutMs ?? 6000;
  const unique = dedupe(urls);

  const health: EndpointHealth[] = await Promise.all(
    unique.map(async (url) => {
      const latencies: number[] = [];
      let chainId: number | null = null;
      let error: string | undefined;

      for (let i = 0; i < samples; i++) {
        const result = await probeOnce(url, timeoutMs);
        if (result.chainId !== null) chainId = result.chainId;
        if (result.latencyMs !== null) latencies.push(result.latencyMs);
        if (result.error && !error) error = result.error;
        // A hard failure on the first sample will not become a success on the
        // third; stop paying the timeout for every one of them.
        if (i === 0 && result.chainId === null && result.latencyMs === null) break;
      }

      // Drop the first (TLS-cold) sample when there are enough left to matter.
      const measured = latencies.length >= 3 ? latencies.slice(1) : latencies;
      const entry: EndpointHealth = {
        url,
        label: labelFor(url),
        chainId,
        latencyMs: median(measured),
        readable: chainId === expectedChainId && measured.length > 0,
      };
      if (error) entry.error = error;
      return entry;
    }),
  );

  const dropped = health.filter((h) => h.chainId !== null && h.chainId !== expectedChainId);
  const kept = health.filter((h) => !dropped.includes(h));

  const read = kept
    .filter((h) => h.readable)
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    .map((h) => h.url);

  // Blast to everything that isn't provably on another chain. Read-capable
  // endpoints lead (fastest first), then the send-only ones.
  const sendOnly = kept.filter((h) => !h.readable).map((h) => h.url);
  const blast = [...read, ...sendOnly];

  return { read, blast, verified: read.length > 0, health, dropped };
}

/** Is this endpoint failure the benign "reads not supported" kind? */
export function isBenignProbeError(message: string): boolean {
  return /not allowed|does not exist|not supported|method not found|unsupported method/i.test(
    message,
  );
}
