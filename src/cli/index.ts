#!/usr/bin/env node
// CLI entry point.
//
// Every command that can spend money follows the same shape: resolve → report →
// confirm → fire. The reporting step is not decoration; it is where a wrong chain,
// a wrong contract, an unaffordable ceiling or a sold-out drop becomes visible
// while it is still free to fix.
//
// `check`, `watch`, `rpc` and `clock` never sign anything, so they are safe to run
// against a live drop while deciding.

import { ArgError, CliArgs, HELP, parseArgs } from "./args";
import { CHAINS, explorerAddress, resolveChain } from "../core/chains";
import { syncClock } from "../core/clock";
import { planRpcs, resolveRpcsForChain, maskRpc, toRpcUrl } from "../core/rpc";
import { planWarnings } from "../core/seadrop";
import { runMint, resolveFireTime } from "../core/engine";
import { runAllowlistMint, withNonces } from "../core/allowlist";
import {
  AmbiguousChainError,
  PrepareOptions,
  PreparedRun,
  closeRun,
  noDropMessage,
  prepareRun,
} from "../core/prepare";
import { orderCandidates } from "../core/detect";
import { shortAddress } from "../core/target";
import { waitForPublicStage, waitForScheduledStage } from "../core/watcher";
import { fetchDropSchedule, liveStage, nextStage } from "../core/opensea";
import {
  checkBalances,
  formatEth,
  gweiToWei,
  redactKeys,
  requiredBalance,
  walletsFromEnv,
} from "../core/wallets";
import { formatRemaining, formatUtc, parseTimeInput } from "../core/timing";
import { loadEnv, readDefaults, writeEnvTemplate } from "../util/env";
import { c, banner, field, heading, info, ok, warn, table } from "../util/render";
import { askChoice, closePrompts } from "../util/prompt";
import { createReporter, printGasSummary, printPlan, printRpcPlan, printStages } from "./report";
import {
  ExecutionConfig,
  collectExecutionConfig,
  collectTargetConfig,
  confirmFire,
} from "./wizard";

const VERSION = "1.0.0";

/** Ctrl+C must never leave a run half-fired without saying so. */
function installSignalHandlers(controller: AbortController): void {
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) process.exit(130); // second Ctrl+C: leave immediately
    interrupted = true;
    controller.abort();
    process.stdout.write(
      c.yellow("\n  Interrupted. Nothing further will be sent; in-flight transactions continue.\n"),
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    if (err instanceof ArgError) {
      process.stderr.write(`${c.red("✗")} ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (args.version) {
    process.stdout.write(`intern ${VERSION}\n`);
    return;
  }
  if (args.help || args.command === "help" || args.command === null) {
    if (!args.json) process.stdout.write(`${banner()}\n`);
    process.stdout.write(HELP);
    return;
  }

  loadEnv();
  const defaults = readDefaults();
  const controller = new AbortController();
  installSignalHandlers(controller);

  switch (args.command) {
    case "init":
      return cmdInit();
    case "rpc":
      return cmdRpc(args, defaults.chain);
    case "clock":
      return cmdClock(args, defaults.chain);
    case "check":
      return cmdCheck(args, defaults);
    case "watch":
      return cmdWatch(args, defaults, controller.signal);
    case "allowlist":
      return cmdAllowlist(args, defaults, controller.signal);
    case "mint":
      return cmdMint(args, defaults, controller.signal);
    case "bot":
      return cmdBot();
    default:
      process.stderr.write(`${c.red("✗")} Unknown command "${args.command}".\n`);
      process.exit(2);
  }
}

// ── shared preparation ───────────────────────────────────────────────────────

/**
 * `prepareRun`, but resolving an ambiguous bare address by asking.
 *
 * A bare address with no `--chain` is probed on every chain (Task 2). One hit
 * settles it silently; several hits are genuinely undecidable — the same address
 * is a different deployment on each — so the core throws rather than guess. Here is
 * where the CLI answers that: a numbered picker at a TTY, the same one the wizard
 * uses; a clear error naming the candidates and `--chain` when input is scripted,
 * because a pipe cannot choose and picking for it could mint on the wrong network.
 */
async function prepareResolvingChain(opts: PrepareOptions): Promise<PreparedRun> {
  try {
    return await prepareRun(opts);
  } catch (err: unknown) {
    if (!(err instanceof AmbiguousChainError)) throw err;

    const candidates = orderCandidates(err.candidates);
    if (!process.stdin.isTTY) {
      throw new Error(
        `${shortAddress(err.address)} has contract code on ${candidates.length} chains ` +
          `(${candidates.map((chain) => chain.key).join(", ")}). ` +
          `Re-run with --chain to say which one you mean.`,
      );
    }

    process.stdout.write(
      warn(`${err.address} has contract code on ${candidates.length} chains — same address, different deployments.\n`),
    );
    const chainKey = await askChoice(
      "Which chain did you mean?",
      candidates.map((chain) => ({
        label: chain.name,
        value: chain.key,
        hint: `id ${chain.chainId}`,
      })),
      0,
    );
    // Chain now fixed, so this pass cannot come back ambiguous.
    return prepareRun({ ...opts, chainKey });
  }
}

// ── init ─────────────────────────────────────────────────────────────────────

function cmdInit(): void {
  const result = writeEnvTemplate();
  if (!result.created) {
    process.stdout.write(warn(`${result.path} already exists — left untouched.\n`));
    return;
  }
  process.stdout.write(ok(`Wrote ${result.path} (mode 0600).\n`));
  process.stdout.write(
    info("Fill in a private RPC first — it is the single biggest speed factor.\n"),
  );
  process.stdout.write(info("Add .env to .gitignore before committing anything.\n"));
}

// ── rpc ──────────────────────────────────────────────────────────────────────

async function cmdRpc(args: CliArgs, defaultChain: string): Promise<void> {
  const chain = requireChain(args.chain ?? defaultChain);
  const manual = (args.rpc ?? [])
    .map((entry) => toRpcUrl(entry, chain.key))
    .filter((url): url is string => url !== null);
  const resolved = resolveRpcsForChain(chain.key, manual);

  process.stdout.write(heading(`Endpoints for ${chain.name}`) + "\n");
  process.stdout.write(info(`${resolved.source}\n`));
  process.stdout.write(info(`sampling each endpoint 5× and taking the median…\n`));

  const plan = await planRpcs(resolved.urls, chain.chainId, { samples: 5 });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          chain: chain.key,
          chainId: chain.chainId,
          read: plan.read.map(maskRpc),
          blast: plan.blast.map(maskRpc),
          health: plan.health.map((h) => ({
            endpoint: maskRpc(h.url),
            label: h.label,
            chainId: h.chainId,
            latencyMs: h.latencyMs,
            readable: h.readable,
            ...(h.error ? { error: h.error } : {}),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  printRpcPlan(plan, chain);
  if (plan.read.length > 0) {
    process.stdout.write(
      info(`fastest read endpoint: ${maskRpc(plan.read[0]!)} — reads will go here\n`),
    );
  }
}

// ── clock ────────────────────────────────────────────────────────────────────

async function cmdClock(args: CliArgs, defaultChain: string): Promise<void> {
  const chain = requireChain(args.chain ?? defaultChain);
  const resolved = resolveRpcsForChain(chain.key);

  process.stdout.write(heading(`Clock check against ${chain.name}`) + "\n");
  process.stdout.write(info("sampling HTTP Date headers and the chain head…\n"));

  const sync = await syncClock(resolved.urls, chain.blockTimeSec, { rounds: 4 });
  if (!sync.synced) {
    process.stdout.write(warn("No endpoint answered — cannot measure the clock.\n"));
    process.exitCode = 1;
    return;
  }

  const rows = sync.samples
    .slice()
    .sort((a, b) => a.rttMs - b.rttMs)
    .slice(0, 10)
    .map((s) => [
      `  ${s.source}`,
      `${s.offsetMs >= 0 ? "+" : ""}${Math.round(s.offsetMs)}ms`,
      c.gray(`rtt ${s.rttMs}ms`),
    ]);
  process.stdout.write(`${table(rows)}\n\n`);

  const sign = sync.offsetMs >= 0 ? "+" : "";
  process.stdout.write(
    field("offset", `${sign}${sync.offsetMs}ms ${c.gray(`(±${sync.uncertaintyMs}ms)`)}`) + "\n",
  );
  process.stdout.write(
    field(
      "meaning",
      Math.abs(sync.offsetMs) < 50
        ? "clock is accurate — no correction needed"
        : sync.offsetMs > 0
          ? `local clock is ${sync.offsetMs}ms SLOW — uncorrected, mints would fire ${sync.offsetMs}ms late`
          : `local clock is ${-sync.offsetMs}ms FAST — uncorrected, mints would fire early and revert`,
    ) + "\n",
  );
  process.stdout.write(ok("intern corrects for this automatically on every run.\n"));
  if (Math.abs(sync.offsetMs) > 500) {
    process.stdout.write(warn("Over 500ms out. Enable NTP: `timedatectl set-ntp true`.\n"));
  }
}

// ── check ────────────────────────────────────────────────────────────────────

async function cmdCheck(args: CliArgs, defaults: ReturnType<typeof readDefaults>): Promise<void> {
  const target = requireTarget(args);
  const quantity = args.quantity ?? defaults.quantity;

  const run = await prepareResolvingChain({
    target,
    chainKey: args.chain,
    quantity,
    manualRpcs: args.rpc ?? [],
    apiKey: defaults.openseaApiKey,
    maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
    priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => process.stdout.write(info(`${message}\n`)),
  });

  try {
    for (const message of run.warnings) process.stdout.write(warn(`${message}\n`));
    printRpcPlan(run.rpc.plan, run.chain);

    process.stdout.write(heading("Collection") + "\n");
    if (run.collection) process.stdout.write(field("name", run.collection.name) + "\n");
    process.stdout.write(field("contract", run.contract) + "\n");
    process.stdout.write(field("explorer", explorerAddress(run.chain.chainId, run.contract)) + "\n");
    if (run.detection) {
      process.stdout.write(info(`chain determined by probing for contract code\n`));
    }

    // Every stage — on-chain public plus whatever OpenSea lists — in the same
    // seven columns the bot's 📊 Stages panel shows. Printed whether or not a
    // public drop exists, because "the public stage is not configured but an
    // allowlist opens in 2h" is exactly what the user needs to see.
    printStages(run.stages, run.chain, Date.now());

    if (!run.plan) {
      process.stdout.write(`\n${warn(noDropMessage(run.contract, run.chain.name, defaults.openseaApiKey !== null))}\n`);
      process.exitCode = 1;
      return;
    }

    printPlan(run.plan, run.chain, quantity);
    for (const message of planWarnings(run.plan, Date.now())) {
      process.stdout.write(warn(`${message}\n`));
    }
    printGasSummary(
      run.gas.maxFeePerGas,
      run.gas.maxPriorityFeePerGas,
      run.gas.gasLimit,
      run.fees.baseFeeWei,
    );

    // Wallet eligibility, when there are wallets to check. `check` never signs, so
    // this is purely a read of what would happen.
    const wallets = walletsFromEnv();
    if (wallets.length === 0) {
      process.stdout.write(info("\nNo wallets in .env — skipping the balance check.\n"));
    } else {
      const required = requiredBalance(run.plan.value, run.gas);
      const reports = await checkBalances(run.rpc.provider, wallets, required);
      process.stdout.write(heading("Wallets") + "\n");
      for (const report of reports) {
        const balance =
          report.balance === null ? c.gray("unreadable") : formatEth(report.balance, run.chain.nativeSymbol);
        const line = `[W${report.index}] ${report.address}  ${balance}`;
        if (report.balance !== null && report.balance < required) {
          process.stdout.write(
            `  ${c.red("✗")} ${line}  ${c.red(`short ${formatEth(report.shortfall, run.chain.nativeSymbol)}`)}\n`,
          );
        } else {
          process.stdout.write(ok(`${line}\n`));
        }
      }
      process.stdout.write(
        info(`each wallet needs ${formatEth(required, run.chain.nativeSymbol)} (value + gasLimit × maxFeePerGas)\n`),
      );
    }

    process.stdout.write(
      `\n${ok(`Nothing was sent. To mint: ${c.bold(`intern mint ${target}${args.chain ? ` --chain ${args.chain}` : ""}`)}\n`)}`,
    );
  } finally {
    closeRun(run);
  }
}

// ── watch ────────────────────────────────────────────────────────────────────

async function cmdWatch(
  args: CliArgs,
  defaults: ReturnType<typeof readDefaults>,
  signal: AbortSignal,
): Promise<void> {
  const target = requireTarget(args);
  const quantity = args.quantity ?? defaults.quantity;

  const run = await prepareResolvingChain({
    target,
    chainKey: args.chain,
    quantity,
    manualRpcs: args.rpc ?? [],
    apiKey: defaults.openseaApiKey,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => process.stdout.write(info(`${message}\n`)),
  });

  try {
    process.stdout.write(heading(`Watching ${run.contract} on ${run.chain.name}`) + "\n");
    process.stdout.write(info("Reads only — nothing will be sent. Ctrl+C to stop.\n"));
    printStages(run.stages, run.chain, Date.now());

    const plan = await waitForPublicStage(run.rpc.provider, run.contract, quantity, {
      signal,
      onUpdate: (update) => {
        const stamp = c.gray(new Date().toLocaleTimeString());
        const mark = update.kind === "opened" ? c.green("✓") : update.kind === "rescheduled" ? c.yellow("⚠") : c.gray("·");
        process.stdout.write(`  ${mark} ${stamp} ${update.message}\n`);
      },
    });

    printPlan(plan, run.chain, quantity);
    process.stdout.write(
      `\n${ok(`Stage is configured. To mint it: ${c.bold(`intern mint ${target} --chain ${run.chain.key}`)}\n`)}`,
    );
  } finally {
    closeRun(run);
  }
}

// ── mint ─────────────────────────────────────────────────────────────────────

async function cmdMint(
  args: CliArgs,
  defaults: ReturnType<typeof readDefaults>,
  signal: AbortSignal,
): Promise<void> {
  process.stdout.write(`${banner()}\n`);

  // Interactive when anything essential is missing; scripted when it is all given.
  const envWallets = walletsFromEnv();
  const interactive = !args.yes || envWallets.length === 0 || args.target === undefined;

  const config = interactive
    ? await collectTargetConfig(defaults, {
        ...(args.target ? { target: args.target } : {}),
        ...(args.chain ? { chainKey: args.chain } : {}),
        ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
        ...(args.rpc ? { manualRpcs: args.rpc } : {}),
        ...(envWallets.length > 0 && args.yes ? { wallets: envWallets } : {}),
      })
    : {
        wallets: envWallets,
        chainKey: args.chain ?? defaults.chain,
        target: requireTarget(args),
        quantity: args.quantity ?? defaults.quantity,
        manualRpcs: args.rpc ?? [],
      };

  const run = await prepareResolvingChain({
    target: config.target,
    chainKey: config.chainKey,
    quantity: config.quantity,
    manualRpcs: config.manualRpcs,
    apiKey: defaults.openseaApiKey,
    maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
    priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => process.stdout.write(info(`${message}\n`)),
  });

  try {
    for (const message of run.warnings) process.stdout.write(warn(`${message}\n`));
    printRpcPlan(run.rpc.plan, run.chain);
    printStages(run.stages, run.chain, Date.now());

    // No drop configured. --watch waits for one; otherwise this is a dead end and
    // saying so precisely beats "not a SeaDrop collection".
    let plan = run.plan;
    if (!plan) {
      if (!args.watch) {
        process.stdout.write(`\n${warn(noDropMessage(run.contract, run.chain.name, defaults.openseaApiKey !== null))}\n`);
        process.stdout.write(info("Add --watch to wait for the stage to be configured.\n"));
        process.exitCode = 1;
        return;
      }
      process.stdout.write(heading("Waiting for the stage to be configured") + "\n");
      plan = await waitForPublicStage(run.rpc.provider, run.contract, config.quantity, {
        signal,
        onUpdate: (update) => process.stdout.write(info(`${update.message}\n`)),
      });
      run.plan = plan;
    }

    printPlan(plan, run.chain, config.quantity);

    // Gas and timing: from flags when given, interactively otherwise.
    const execution: ExecutionConfig = interactive
      ? await collectExecutionConfig(run, defaults)
      : {
          maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
          priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
          gasLimit: args.gasLimit ?? defaults.gasLimit,
          timing: args.now ? "now" : args.at ? { atMs: parseTimeInput(args.at) } : "stage",
          leadMs: args.leadMs ?? defaults.leadMs,
        };

    const gas = {
      maxFeePerGas:
        execution.maxFeeGwei != null ? gweiToWei(execution.maxFeeGwei) : run.gas.maxFeePerGas,
      maxPriorityFeePerGas:
        execution.priorityGwei != null
          ? gweiToWei(execution.priorityGwei)
          : run.gas.maxPriorityFeePerGas,
      gasLimit: execution.gasLimit,
    };
    printGasSummary(gas.maxFeePerGas, gas.maxPriorityFeePerGas, gas.gasLimit, run.fees.baseFeeWei);

    if (!args.yes) {
      const confirmed = await confirmFire(run, execution, config.wallets, run.chain);
      if (!confirmed) {
        process.stdout.write(ok("Cancelled. Nothing was sent.\n"));
        return;
      }
    }
    // Release stdin before firing: readline competing with the countdown line
    // corrupts both, and no further input is needed.
    closePrompts();

    const { fireAtMs } = resolveFireTime(
      plan,
      execution.timing === "now"
        ? "now"
        : execution.timing === "stage"
          ? "stage"
          : { atMs: execution.timing.atMs },
      execution.leadMs,
    );

    const report = createReporter({
      chain: run.chain,
      addresses: config.wallets.map((w) => w.address),
    });

    const result = await runMint(
      {
        chain: run.chain,
        plan,
        wallets: config.wallets,
        readUrls: run.rpc.plan.read,
        blastUrls: run.rpc.plan.blast,
        gas,
        fireAtMs,
        leadMs: execution.leadMs,
        skipSimulation: args.skipSimulation,
        requireSimulation: args.requireSimulation,
        receiptTimeoutMs: defaults.receiptTimeoutMs,
        signal,
      },
      report,
    );

    printRunSummary(result);
    if (result.minted === 0) process.exitCode = 1;
  } finally {
    closeRun(run);
  }
}

// ── allowlist ────────────────────────────────────────────────────────────────

async function cmdAllowlist(
  args: CliArgs,
  defaults: ReturnType<typeof readDefaults>,
  signal: AbortSignal,
): Promise<void> {
  process.stdout.write(`${banner()}\n`);

  if (!defaults.openseaApiKey) {
    process.stderr.write(
      `${c.red("✗")} An allowlist mint needs OPENSEA_API_KEY: the signature is issued by OpenSea and cannot be produced locally.\n`,
    );
    process.stderr.write(`  ${c.gray("Public stages need no key — use `intern mint`.")}\n`);
    process.exit(2);
  }
  const apiKey = defaults.openseaApiKey;

  const wallets = walletsFromEnv();
  if (wallets.length === 0) {
    process.stderr.write(`${c.red("✗")} No wallets in .env. Set PRIVATE_KEY or PRIVATE_KEYS.\n`);
    process.exit(2);
  }

  const target = requireTarget(args);
  const quantity = args.quantity ?? defaults.quantity;

  const run = await prepareResolvingChain({
    target,
    chainKey: args.chain,
    quantity,
    manualRpcs: args.rpc ?? [],
    apiKey,
    maxFeeGwei: args.maxFeeGwei ?? defaults.maxFeeGwei,
    priorityGwei: args.priorityGwei ?? defaults.priorityGwei,
    gasLimit: args.gasLimit ?? defaults.gasLimit,
    defaultChain: defaults.chain,
    onProgress: (message) => process.stdout.write(info(`${message}\n`)),
  });

  try {
    const slug = run.slug;
    if (!slug) {
      throw new Error(
        "An allowlist mint needs the collection slug, which only OpenSea can map. Pass the OpenSea link or slug rather than a contract address.",
      );
    }

    for (const message of run.warnings) process.stdout.write(warn(`${message}\n`));
    printRpcPlan(run.rpc.plan, run.chain);
    printGasSummary(
      run.gas.maxFeePerGas,
      run.gas.maxPriorityFeePerGas,
      run.gas.gasLimit,
      run.fees.baseFeeWei,
    );

    // Wait for a stage OpenSea will actually sign for.
    const schedule = await fetchDropSchedule(slug, apiKey);
    const now = Date.now();
    const open = liveStage(schedule, now);
    if (!open) {
      const upcoming = nextStage(schedule, now);
      if (!upcoming) throw new Error("No stage is open and none is scheduled. Nothing was sent.");
      process.stdout.write(
        heading(`Waiting for "${upcoming.label}" — opens in ${formatRemaining(upcoming.startMs - now)}`) + "\n",
      );
      process.stdout.write(info(`${formatUtc(upcoming.startMs)} UTC\n`));
      await waitForScheduledStage(slug, apiKey, {
        signal,
        onUpdate: (update) => process.stdout.write(info(`${update.message}\n`)),
      });
    } else {
      process.stdout.write(ok(`"${open.label}" is open now.\n`));
    }

    process.stdout.write(
      info("Requesting signatures. OpenSea will not issue one before the stage opens, so this round trip is inside the race.\n"),
    );

    const nonced = await withNonces(run.rpc.provider, wallets);
    closePrompts();

    const report = createReporter({ chain: run.chain, addresses: wallets.map((w) => w.address) });
    const result = await runAllowlistMint(
      {
        chain: run.chain,
        slug,
        contract: run.contract,
        apiKey,
        quantity,
        wallets: nonced,
        readUrls: run.rpc.plan.read,
        blastUrls: run.rpc.plan.blast,
        gas: run.gas,
        receiptTimeoutMs: defaults.receiptTimeoutMs,
        signal,
      },
      report,
    );

    printRunSummary(result);
    if (result.minted === 0) process.exitCode = 1;
  } finally {
    closeRun(run);
  }
}

// ── bot ──────────────────────────────────────────────────────────────────────

async function cmdBot(): Promise<void> {
  // Imported lazily so the CLI does not pay for the bot's module graph on every
  // invocation, and so a missing bot token fails at `intern bot` rather than at
  // `intern --help`.
  const { runBot } = await import("../bot/index");
  await runBot();
}

// ── shared ───────────────────────────────────────────────────────────────────

function printRunSummary(result: {
  minted: number;
  failed: number;
  dispatchMs: number;
  timingErrorMs: number;
  clock: { offsetMs: number; synced: boolean };
}): void {
  process.stdout.write(heading("Summary") + "\n");
  process.stdout.write(field("dispatch", `${result.dispatchMs.toFixed(2)}ms to write every transaction`) + "\n");
  if (result.timingErrorMs !== 0) {
    process.stdout.write(
      field("timing", `${result.timingErrorMs > 0 ? "+" : ""}${result.timingErrorMs.toFixed(0)}ms from the target instant`) + "\n",
    );
  }
  if (result.clock.synced && Math.abs(result.clock.offsetMs) >= 50) {
    process.stdout.write(
      field("clock", `corrected for a ${result.clock.offsetMs}ms local error`) + "\n",
    );
  }
  process.stdout.write(field("minted", String(result.minted)) + "\n");
  if (result.failed > 0) process.stdout.write(field("failed", String(result.failed)) + "\n");
}

function requireChain(key: string) {
  const chain = resolveChain(key);
  if (!chain) {
    process.stderr.write(
      `${c.red("✗")} Unknown chain "${key}". Supported: ${CHAINS.map((entry) => entry.key).join(", ")}.\n`,
    );
    process.exit(2);
  }
  return chain;
}

function requireTarget(args: CliArgs): string {
  if (args.target && args.target.trim()) return args.target.trim();
  process.stderr.write(
    `${c.red("✗")} No target given. Pass an OpenSea link, a collection slug, or a contract address.\n`,
  );
  process.exit(2);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // redactKeys guards the one path where a key could reach a terminal: ethers
  // embeds the offending value in some of its own error messages.
  process.stderr.write(`\n${c.red("✗")} ${redactKeys(message)}\n`);
  if (process.env.INTERN_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(c.gray(`${redactKeys(err.stack)}\n`));
  }
  process.exit(1);
});
