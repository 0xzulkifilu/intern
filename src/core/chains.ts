// Chain registry. Everything network-specific lives here, so supporting a new
// chain is one entry rather than a grep for hardcoded values.
//
// `key` is the identifier used in four places and they must agree:
//   1. the OpenSea API `chain` field
//   2. the `--chain` CLI flag
//   3. the `CHAIN` env var
//   4. the Telegram `/chain` command
//
// `public` endpoints are ordered best-first. Entries flagged `sendOnly` answer
// nothing but eth_sendRawTransaction (sequencers) — they are the fastest path to
// inclusion and are kept for broadcasting, never read from. `planRpcs` sorts
// query-capable endpoints ahead of them at runtime regardless of this order.

export interface ChainProfile {
  key: string;
  chainId: number;
  name: string;
  explorer: string; // no trailing slash
  nativeSymbol: string;
  /** Seconds per block — used to size the pre-fire window and receipt polling. */
  blockTimeSec: number;
  rpc: {
    alchemyHost?: string;
    public: string[];
    /** Endpoints known to reject reads; kept in the blast list only. */
    sendOnly?: string[];
  };
}

export const CHAINS: ChainProfile[] = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
    blockTimeSec: 12,
    rpc: {
      alchemyHost: "eth-mainnet.g.alchemy.com",
      public: [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.merkle.io",
        "https://cloudflare-eth.com",
        "https://rpc.ankr.com/eth",
        "https://eth.drpc.org",
      ],
    },
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
    blockTimeSec: 2,
    rpc: {
      alchemyHost: "base-mainnet.g.alchemy.com",
      public: [
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
        "https://base.drpc.org",
      ],
      sendOnly: ["https://mainnet-sequencer.base.org"],
    },
  },
  {
    key: "robinhood",
    chainId: 4663,
    name: "Robinhood Chain",
    explorer: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
    blockTimeSec: 2,
    rpc: {
      alchemyHost: "robinhood-mainnet.g.alchemy.com",
      public: ["https://rpc.mainnet.chain.robinhood.com"],
      sendOnly: ["https://sequencer.mainnet.chain.robinhood.com"],
    },
  },
  {
    key: "ink",
    chainId: 57073,
    name: "Ink",
    explorer: "https://explorer.inkonchain.com",
    nativeSymbol: "ETH",
    blockTimeSec: 1,
    rpc: {
      alchemyHost: "ink-mainnet.g.alchemy.com",
      public: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com"],
    },
  },
  {
    key: "arbitrum",
    chainId: 42161,
    name: "Arbitrum One",
    explorer: "https://arbiscan.io",
    nativeSymbol: "ETH",
    blockTimeSec: 1,
    rpc: {
      alchemyHost: "arb-mainnet.g.alchemy.com",
      public: [
        "https://arb1.arbitrum.io/rpc",
        "https://arbitrum-one-rpc.publicnode.com",
      ],
    },
  },
  {
    key: "optimism",
    chainId: 10,
    name: "Optimism",
    explorer: "https://optimistic.etherscan.io",
    nativeSymbol: "ETH",
    blockTimeSec: 2,
    rpc: {
      alchemyHost: "opt-mainnet.g.alchemy.com",
      public: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    },
  },
  {
    key: "polygon",
    chainId: 137,
    name: "Polygon",
    explorer: "https://polygonscan.com",
    nativeSymbol: "POL",
    blockTimeSec: 2,
    rpc: {
      alchemyHost: "polygon-mainnet.g.alchemy.com",
      public: ["https://polygon-rpc.com", "https://polygon-bor-rpc.publicnode.com"],
    },
  },
  {
    key: "zora",
    chainId: 7777777,
    name: "Zora",
    explorer: "https://explorer.zora.energy",
    nativeSymbol: "ETH",
    blockTimeSec: 2,
    rpc: {
      public: ["https://rpc.zora.energy"],
    },
  },
];

const DEFAULT_EXPLORER = "https://etherscan.io";

/** Resolve by numeric chainId (authoritative, from the live network) or by key. */
export function resolveChain(
  idOrKey: string | number | bigint | null | undefined,
): ChainProfile | undefined {
  if (idOrKey === null || idOrKey === undefined) return undefined;
  if (typeof idOrKey === "string") {
    const key = idOrKey.trim().toLowerCase();
    const byKey = CHAINS.find((c) => c.key === key);
    if (byKey) return byKey;
    // A numeric string is still a chain id.
    if (/^\d+$/.test(key)) return CHAINS.find((c) => c.chainId === Number(key));
    return undefined;
  }
  const id = Number(idOrKey);
  return CHAINS.find((c) => c.chainId === id);
}

/** Every endpoint for a chain, read-capable first, send-only trailing. */
export function allRpcs(profile: ChainProfile): string[] {
  return [...profile.rpc.public, ...(profile.rpc.sendOnly ?? [])];
}

export function explorerTx(
  idOrKey: string | number | bigint | null | undefined,
  txHash: string,
): string {
  const base = resolveChain(idOrKey)?.explorer ?? DEFAULT_EXPLORER;
  return `${base}/tx/${txHash}`;
}

export function explorerAddress(
  idOrKey: string | number | bigint | null | undefined,
  address: string,
): string {
  const base = resolveChain(idOrKey)?.explorer ?? DEFAULT_EXPLORER;
  return `${base}/address/${address}`;
}
