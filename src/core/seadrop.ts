// SeaDrop mint construction, entirely from on-chain state.
//
// A public stage is unsigned: SeaDrop.mintPublic() takes only the drop's own
// parameters, so the whole transaction can be assembled from contract reads.
// That removes OpenSea's access token, its expiry, its rate limits and — the
// part that decides FCFS outcomes — the API round trip, because every
// transaction can be signed before the stage opens.
//
// Two contract families are supported:
//
//   SeaDrop v1 (0x00005EA0…) — the singleton. Drop config lives in the
//   singleton, keyed by token contract. mintPublic() is called on the singleton.
//
//   ERC721SeaDropV2 / ERC1155SeaDrop — config lives on the token itself and
//   minting goes through it. Newer OpenSea drops use this, and a v1-only
//   implementation reads all zeros and reports "not a SeaDrop collection".
//
// Allowlist/FCFS stages are different in kind: mintSigned() carries a
// server-produced signature bound to one wallet and one salt, so that path
// requires OpenSea and has no local equivalent. It lives in allowlist.ts.

import { BigNumberish, Contract, Interface, JsonRpcProvider, getAddress } from "ethers";

async function callFn<T>(
  c: Contract,
  name: string,
  ...args: unknown[]
): Promise<T> {
  const fn = (c as unknown as Record<string, unknown>)[name];

  if (typeof fn !== "function") {
    throw new Error(`ABI missing ${name}`);
  }

  return fn(...args) as Promise<T>;
}

export const SEADROP_V1 = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

// OpenSea's standard fee collector — the usual allowed recipient on their drops.
// Only used when a drop leaves the recipient list empty AND unrestricted, since
// SeaDrop rejects the zero address outright.
export const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

const ZERO = "0x0000000000000000000000000000000000000000";

const PUBLIC_DROP_TUPLE =
  "tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)";

// v1 singleton surface.
const V1_ABI = [
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  `function getPublicDrop(address nftContract) view returns (${PUBLIC_DROP_TUPLE})`,
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
];

// v2 token-contract surface. `getPublicDrop()` takes no argument because the
// config belongs to this token, and mintPublic() carries a stage index.
const V2_ABI = [
  "function mintPublic(address feeRecipient, address minterIfNotPayer, uint256 quantity, uint256 publicDropIndex) payable",
  `function getPublicDrop() view returns (${PUBLIC_DROP_TUPLE})`,
  "function getAllowedFeeRecipients() view returns (address[])",
];

// Supply reads, used to warn on a sold-out or nearly-exhausted drop. Optional:
// plenty of contracts omit maxSupply, so failures here are never fatal.
const SUPPLY_ABI = [
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
];

const MINT_STATS_ABI = [
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
];

export const v1Interface = new Interface(V1_ABI);
export const v2Interface = new Interface(V2_ABI);

export type SeaDropVariant = "v1-singleton" | "v2-token";

export interface PublicDrop {
  mintPrice: bigint;
  startTime: number; // unix seconds
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

export interface SupplyInfo {
  totalSupply: bigint | null;
  maxSupply: bigint | null;
}

export interface MintStats {
  minterNumMinted: bigint;
  currentTotalSupply: bigint;
  maxSupply: bigint;
}

export interface MintPlan {
  variant: SeaDropVariant;
  /** Transaction target: the singleton for v1, the token contract for v2. */
  to: string;
  /** Identical for every wallet — minterIfNotPayer is zero, see below. */
  data: string;
  /** mintPrice × quantity, exactly what the contract expects. */
  value: bigint;
  drop: PublicDrop;
  feeRecipient: string;
  feeRecipientSource: string;
  nftContract: string;
  quantity: number;
  supply: SupplyInfo;
}

function decodeDrop(raw: {
  mintPrice: bigint | number;
  startTime: bigint | number;
  endTime: bigint | number;
  maxTotalMintableByWallet: bigint | number;
  feeBps: bigint | number;
  restrictFeeRecipients: boolean;
}): PublicDrop {
  return {
    mintPrice: BigInt(raw.mintPrice),
    startTime: Number(raw.startTime),
    endTime: Number(raw.endTime),
    maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
    feeBps: Number(raw.feeBps),
    restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
  };
}

/** An unset mapping entry decodes to all zeros rather than reverting. */
function isEmptyDrop(drop: PublicDrop): boolean {
  return (
    drop.startTime === 0 && drop.endTime === 0 && drop.maxTotalMintableByWallet === 0
  );
}

export interface DropLookup {
  variant: SeaDropVariant;
  drop: PublicDrop;
}

/**
 * Find the public drop, trying both contract families concurrently.
 *
 * Both are attempted at once rather than in sequence: the reads are independent
 * and a serial probe pays a full RPC round trip to discover the collection is
 * v2. Returns null when neither answers — not a SeaDrop collection, or a variant
 * this build doesn't know.
 */
export async function fetchPublicDrop(
  provider: JsonRpcProvider,
  nftContract: string,
): Promise<DropLookup | null> {
  const token = getAddress(nftContract);

  const v1 = new Contract(SEADROP_V1, V1_ABI, provider);
  const v2 = new Contract(token, V2_ABI, provider);

  const [v1Result, v2Result] = await Promise.allSettled([
    callFn<PublicDrop>(v1, "getPublicDrop", token),
    callFn<PublicDrop>(v2, "getPublicDrop"),
  ]);

  // v2 wins ties: when a token answers for itself that is authoritative, and a
  // stale v1 entry can linger after a collection migrates.
  if (v2Result.status === "fulfilled") {
    try {
      const drop = decodeDrop(v2Result.value);
      if (!isEmptyDrop(drop)) return { variant: "v2-token", drop };
    } catch {
      // Shape mismatch — some other contract exposes a same-named function.
    }
  }
  if (v1Result.status === "fulfilled") {
    try {
      const drop = decodeDrop(v1Result.value);
      if (!isEmptyDrop(drop)) return { variant: "v1-singleton", drop };
    } catch {
      /* not a SeaDrop drop */
    }
  }
  return null;
}

/**
 * SeaDrop reverts on a zero fee recipient, and on a disallowed one when the drop
 * restricts them — so this must come from the chain rather than a constant.
 */
export async function resolveFeeRecipient(
  provider: JsonRpcProvider,
  nftContract: string,
  variant: SeaDropVariant,
  restricted: boolean,
): Promise<{ address: string; source: string } | null> {
  const token = getAddress(nftContract);
  let allowed: string[] = [];
  try {
    allowed =
      variant === "v1-singleton"
        ? await callFn<string[]>(new Contract(SEADROP_V1, V1_ABI, provider), "getAllowedFeeRecipients", token)
        : await callFn<string[]>(new Contract(token, V2_ABI, provider), "getAllowedFeeRecipients");
  } catch {
    allowed = [];
  }

  const usable = allowed.filter((a) => getAddress(a) !== ZERO);
  if (usable.length > 0) {
    return { address: getAddress(usable[0]!), source: "allowed fee recipient (on-chain)" };
  }
  if (restricted) {
    // Nothing allowed and the drop enforces the list: a public mint cannot be
    // constructed at all, by us or by OpenSea.
    return null;
  }
  return {
    address: OPENSEA_FEE_RECIPIENT,
    source: "OpenSea default (drop does not restrict recipients)",
  };
}

async function fetchSupply(
  provider: JsonRpcProvider,
  nftContract: string,
): Promise<SupplyInfo> {
  const token = new Contract(getAddress(nftContract), SUPPLY_ABI, provider);
  const [total, max] = await Promise.allSettled([callFn<BigNumberish>(token, "totalSupply"), callFn<BigNumberish>(token, "maxSupply")]);
  return {
    totalSupply: total.status === "fulfilled" ? BigInt(total.value) : null,
    maxSupply: max.status === "fulfilled" ? BigInt(max.value) : null,
  };
}

export async function fetchMintStats(
  provider: JsonRpcProvider,
  nftContract: string,
  minter: string,
): Promise<MintStats> {
  const token = new Contract(getAddress(nftContract), MINT_STATS_ABI, provider);
  const stats = await callFn<readonly [BigNumberish, BigNumberish, BigNumberish]>(
    token,
    "getMintStats",
    getAddress(minter),
  );
  return {
    minterNumMinted: BigInt(stats[0]),
    currentTotalSupply: BigInt(stats[1]),
    maxSupply: BigInt(stats[2]),
  };
}

/**
 * minterIfNotPayer = address(0) means "credit the caller", which makes the
 * calldata byte-identical for every wallet. One encode, shared across the whole
 * wallet set, and nothing per-wallet left to compute at fire time.
 */
export function encodeMintPublic(
  variant: SeaDropVariant,
  nftContract: string,
  feeRecipient: string,
  quantity: number,
): string {
  if (variant === "v1-singleton") {
    return v1Interface.encodeFunctionData("mintPublic", [
      getAddress(nftContract),
      getAddress(feeRecipient),
      ZERO,
      BigInt(quantity),
    ]);
  }
  return v2Interface.encodeFunctionData("mintPublic", [
    getAddress(feeRecipient),
    ZERO,
    BigInt(quantity),
    0n, // publicDropIndex — 0 is the only stage a v2 public drop exposes here
  ]);
}

/** Decode our own calldata back, so a plan can be verified rather than trusted. */
export function decodeMintPublic(
  data: string,
): { name: string; args: readonly unknown[] } | null {
  for (const iface of [v1Interface, v2Interface]) {
    try {
      const parsed = iface.parseTransaction({ data });
      if (parsed) return { name: parsed.name, args: parsed.args };
    } catch {
      /* try the other variant */
    }
  }
  return null;
}

export async function buildMintPlan(
  provider: JsonRpcProvider,
  nftContract: string,
  quantity: number,
): Promise<MintPlan | null> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new Error(`Invalid quantity ${quantity} — must be an integer in 1..1000.`);
  }
  const token = getAddress(nftContract);

  const found = await fetchPublicDrop(provider, token);
  if (!found) return null;

  const [fee, supply] = await Promise.all([
    resolveFeeRecipient(provider, token, found.variant, found.drop.restrictFeeRecipients),
    fetchSupply(provider, token),
  ]);
  if (!fee) return null;

  return {
    variant: found.variant,
    to: found.variant === "v1-singleton" ? getAddress(SEADROP_V1) : token,
    data: encodeMintPublic(found.variant, token, fee.address, quantity),
    value: found.drop.mintPrice * BigInt(quantity),
    drop: found.drop,
    feeRecipient: fee.address,
    feeRecipientSource: fee.source,
    nftContract: token,
    quantity,
    supply,
  };
}

/** Warnings that would otherwise surface as an on-chain revert. */
export function planWarnings(plan: MintPlan, nowMs: number): string[] {
  const warnings: string[] = [];
  const { drop, quantity, supply } = plan;

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    warnings.push(
      `Drop allows ${drop.maxTotalMintableByWallet} per wallet but ${quantity} requested — the mint will revert.`,
    );
  }
  if (drop.endTime > 0 && nowMs >= drop.endTime * 1000) {
    warnings.push("This public stage has already ended on-chain.");
  }
  if (drop.mintPrice === 0n) {
    warnings.push("Mint price reads as 0 — free mint, or the drop is not configured yet.");
  }
  if (supply.maxSupply !== null && supply.totalSupply !== null && supply.maxSupply > 0n) {
    const left = supply.maxSupply - supply.totalSupply;
    if (left <= 0n) {
      warnings.push(`Sold out on-chain: ${supply.totalSupply}/${supply.maxSupply} minted.`);
    } else if (left < BigInt(quantity)) {
      warnings.push(
        `Only ${left} left of ${supply.maxSupply} — a ${quantity}-token mint will revert.`,
      );
    }
  }
  return warnings;
}
