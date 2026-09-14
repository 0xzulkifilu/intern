// Turn whatever the user pasted into a mint target.
//
// Accepted: an OpenSea URL (collection, drop, or item page), a bare collection
// slug, or a contract address. Item URLs also carry the chain, which is surfaced
// as a hint so a chain mismatch is caught before firing on the wrong network
// rather than after.

import { getAddress, isAddress } from "ethers";

export interface ParsedTarget {
  kind: "address" | "slug";
  value: string;
  /** Chain parsed out of the URL, when the URL carried one. */
  chainHint?: string;
  tokenId?: string;
}

// OpenSea's URL chain segment → our chain key.
const CHAIN_ALIASES: Record<string, string> = {
  ethereum: "ethereum",
  eth: "ethereum",
  mainnet: "ethereum",
  matic: "polygon",
  polygon: "polygon",
  base: "base",
  robinhood: "robinhood",
  ink: "ink",
  arbitrum: "arbitrum",
  arbitrum_one: "arbitrum",
  optimism: "optimism",
  zora: "zora",
};

function normalizeChain(segment: string): string {
  const key = segment.trim().toLowerCase();
  return CHAIN_ALIASES[key] ?? key;
}

function looksLikeAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function parseTarget(input: string): ParsedTarget {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("No target given — paste an OpenSea link, slug, or contract address.");

  if (looksLikeAddress(raw)) return { kind: "address", value: raw };

  if (/^https?:\/\//i.test(raw) || raw.toLowerCase().includes("opensea.io")) {
    return parseUrl(raw);
  }

  // Something that starts 0x and is otherwise hex is a mistyped address, not a
  // collection named "0x…". Passing it on as a slug produces a lookup failure that
  // blames OpenSea for what is actually a dropped character.
  if (/^0x[0-9a-fA-F]*$/i.test(raw)) {
    const digits = raw.length - 2;
    throw new Error(
      `"${input}" is ${digits} hex character(s) long; a contract address is 40. Check for a dropped or extra character.`,
    );
  }

  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(raw)) {
    throw new Error(
      `Could not read "${input}" as an OpenSea link, collection slug, or contract address.`,
    );
  }
  return { kind: "slug", value: raw.toLowerCase() };
}

function parseUrl(raw: string): ParsedTarget {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let segments: string[];
  try {
    segments = new URL(withProtocol).pathname
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    throw new Error(`Could not parse "${raw}" as a URL.`);
  }

  // /assets/<chain>/<address>/<tokenId> and /item/<chain>/<address>/<tokenId>
  const itemIdx = segments.findIndex((s) => s === "assets" || s === "item");
  if (itemIdx >= 0) {
    const rest = segments.slice(itemIdx + 1);
    const addrIdx = rest.findIndex(looksLikeAddress);
    if (addrIdx >= 0) {
      const target: ParsedTarget = { kind: "address", value: rest[addrIdx]! };
      if (addrIdx > 0) target.chainHint = normalizeChain(rest[addrIdx - 1]!);
      if (rest[addrIdx + 1]) target.tokenId = rest[addrIdx + 1]!;
      return target;
    }
  }

  // /collection/<slug>[/drop|/overview] and /<chain>/collection/<slug>
  const collectionIdx = segments.indexOf("collection");
  if (collectionIdx >= 0 && segments[collectionIdx + 1]) {
    const target: ParsedTarget = {
      kind: "slug",
      value: segments[collectionIdx + 1]!.toLowerCase(),
    };
    if (collectionIdx > 0) target.chainHint = normalizeChain(segments[collectionIdx - 1]!);
    return target;
  }

  const loose = segments.find(looksLikeAddress);
  if (loose) return { kind: "address", value: loose };

  throw new Error(
    `No collection slug or contract address found in "${raw}" — paste an OpenSea collection or item link.`,
  );
}

export interface NormalizedAddress {
  address: string;
  /**
   * True when the input was mixed-case and failed EIP-55. Mixed case that fails
   * the checksum is the signature of a typo or a corrupted copy-paste; all-lower
   * or all-upper carries no checksum information and is simply normalized.
   */
  checksumWarning: boolean;
}

export function normalizeAddress(raw: string): NormalizedAddress | null {
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  return {
    address: getAddress(value.toLowerCase()),
    checksumWarning: mixedCase && !isAddress(value),
  };
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
