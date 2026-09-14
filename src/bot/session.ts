// Per-chat panel state, and the authorization boundary.
//
// The shape of this file is one idea: a chat has exactly one panel message, and
// every interaction edits it. `/start` sends it; every button and every command
// after that is an `editMessageText` on the same message id. Nothing stacks, so
// the chat does not fill with the history of how the current screen was reached.
//
// Four decisions here are security decisions rather than UX ones.
//
//   Private keys are never accepted over Telegram. Not as a message, not deleted
//   afterwards, not "just this once". A Telegram message has already been through
//   Telegram's servers by the time the bot sees it, it sits in the chat's history
//   on every device signed into that account, and message deletion is a courtesy
//   rather than a guarantee. The bot signs with the wallets in .env on the machine
//   it runs on, and if there are none it refuses to arm. The CLI is where keys get
//   entered.
//
//   Authorization is a numeric-id allowlist, checked on every update — and an
//   inline button is an update. A callback_query is a bearer entry point exactly
//   like a command: the panel is visible to everyone in a group, so anyone in that
//   group can press its buttons, and `callback_query.from.id` is checked against
//   the same allowlist as `message.from.id`. In a group both the presser and the
//   group must be listed. Skipping this check on callbacks would mean the ✅ Send
//   button spends the owner's wallets for whoever can see it.
//
//   One run at a time across all chats. The wallet set comes from a single .env, so
//   two concurrent runs would sign different transactions with the same nonces and
//   one of them would be silently discarded by the network. Read-only panels
//   (check, stages, status) do *not* take this lock — watching a drop must never be
//   the reason a mint cannot start.
//
//   Nothing signs before ✅ Send. Preparation is idempotent and read-only; the
//   confirm panel states chain, contract, wallet count and worst-case total spend,
//   and the only path to a transaction is that one button.

import { explorerAddress } from "../core/chains";
import { CorrectedClock } from "../core/clock";
import { orderCandidates } from "../core/detect";
import { resolveFireTime, runMint } from "../core/engine";
import { BalanceReport, LoadedWallet, checkBalances, formatEth, redactKeys, requiredBalance } from "../core/wallets";
import {
  AmbiguousChainError,
  PreparedRun,
  closeRun,
  noDropMessage,
  prepareRun,
  refreshRun,
} from "../core/prepare";
import { Defaults } from "../util/env";
import { WatchUpdate, waitForPublicStage } from "../core/watcher";
import { formatLocal, parseTimeInput } from "../core/timing";
import { parseTarget, shortAddress } from "../core/target";
import {
  InlineButton,
  TelegramClient,
  TgCallbackQuery,
  TgChat,
  TgMessage,
  TgUpdate,
  bold,
  code,
  esc,
  link,
} from "./api";
import { createTelegramReporter, formatGas } from "./format";
import {
  BACK_ONLY,
  MAIN_MENU,
  PanelAction,
  chainKeyboard,
  confirmKeyboard,
  encodeCallback,
  parseCallback,
  quantityKeyboard,
  refreshKeyboard,
  renderAskTarget,
  renderChainPicker,
  renderConfirm,
  renderMenu,
  renderStages,
  updatedFooter,
} from "./panel";
import { AUTO_REFRESH_MS, EditGate, RefreshSource, debouncedToast } from "./refresh";

/** A prepared run left unconfirmed this long is dropped and its provider closed. */
const DRAFT_TTL_MS = 15 * 60_000;

/** What the panel is currently showing. */
type View =
  | "menu"
  | "awaitTarget"
  | "awaitChain"
  | "awaitQuantity"
  | "awaitTime"
  | "confirm"
  | "running"
  | "check"
  | "stages"
  | "wallets"
  | "status";

/** Which flow the target being collected belongs to. */
type Intent = "mint" | "check" | "watch" | "stages";

interface Draft {
  intent: Intent;
  target?: string;
  chainKey?: string;
  quantity?: number;
  run?: PreparedRun;
  preparedAt?: number;
  balances?: BalanceReport[];
  /** Candidate chains from an ambiguous detection, awaiting a pick. */
  candidates?: string[];
}

interface Session {
  chatId: number;
  /** The one panel message this chat owns. */
  panelId: number | null;
  view: View;
  draft: Draft;
  controller?: AbortController;
  expiry?: NodeJS.Timeout;
  /** Set while ⏱ Auto is on. */
  autoTimer?: NodeJS.Timeout;
  /** Paces edits to this chat's panel. */
  gate: EditGate;
  /** Row statuses at the last render, to notice a stage transition. */
  stageSignature?: string;
}

export interface SessionManagerOptions {
  client: TelegramClient;
  defaults: Defaults;
  wallets: LoadedWallet[];
  allowedIds: number[];
  /** Corrected clock. All countdowns and footers read from this, never Date.now(). */
  clock?: CorrectedClock;
}

export const BOT_COMMANDS = [
  { command: "start", description: "Open the control panel" },
  { command: "mint", description: "Mint a drop — link, slug, or contract address" },
  { command: "check", description: "Inspect a drop without sending anything" },
  { command: "stages", description: "Every stage of a drop, with countdowns" },
  { command: "watch", description: "Wait for a public stage to open, then report" },
  { command: "wallets", description: "Show the loaded wallets and balances" },
  { command: "status", description: "What this chat is currently doing" },
  { command: "cancel", description: "Abandon the current setup or abort a run" },
  { command: "help", description: "How to use intern" },
];

const HELP = [
  bold("intern"),
  esc("A minting bot for OpenSea SeaDrop. Same engine as the CLI."),
  "",
  esc("Everything works from the buttons on the panel. The commands are the same"),
  esc("actions for people who would rather type:"),
  "",
  `${code("/mint <link|slug|0x…>")} ${esc("— prepare a mint, then confirm before anything is sent")}`,
  `${code("/check <link|slug|0x…>")} ${esc("— read the drop, print the numbers, send nothing")}`,
  `${code("/stages <link|slug|0x…>")} ${esc("— every stage, with prices, windows and countdowns")}`,
  `${code("/watch <link|slug|0x…>")} ${esc("— wait for the public stage to open")}`,
  `${code("/wallets")} ${esc("— the wallets this bot signs with, and their balances")}`,
  `${code("/cancel")} ${esc("— abandon setup, abort a run, or stop a live panel")}`,
  "",
  esc("A bare 0x address needs no chain: every configured chain is probed and the"),
  esc("one holding the contract wins. If several hold it, you are asked which."),
  "",
  bold("Never send a private key here."),
  esc(
    "This bot signs with the wallets in its .env on the machine it runs on. A key pasted into a chat is already stored on Telegram's servers and on every device signed into your account. Use the CLI to enter keys.",
  ),
].join("\n");

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  /** chatId currently holding the run lock, or null. Mint runs only. */
  private running: number | null = null;
  private readonly clock: CorrectedClock;

  constructor(private readonly opts: SessionManagerOptions) {
    this.clock = opts.clock ?? new CorrectedClock(0);
  }

  private now(): number {
    return this.clock.now();
  }

  // ── authorization ──────────────────────────────────────────────────────────

  /**
   * Both the sender and, for groups, the chat must be listed.
   *
   * Applied identically to messages and to callback queries. A panel sitting in a
   * group is visible to every member, so "who pressed it" is exactly as much of an
   * open question as "who typed it".
   */
  private authorized(userId: number | undefined, chat: { id: number; type: string }): boolean {
    if (userId === undefined) return false;
    if (!this.opts.allowedIds.includes(userId)) return false;
    if (chat.type !== "private" && !this.opts.allowedIds.includes(chat.id)) return false;
    return true;
  }

  // ── dispatch ───────────────────────────────────────────────────────────────

  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.text) return;
    if (!this.authorized(message.from?.id, message.chat)) return;
    await this.handleText(message, message.text.trim());
  }

  private session(chatId: number): Session {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        chatId,
        panelId: null,
        view: "menu",
        draft: { intent: "mint" },
        gate: new EditGate(),
      };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  // ── the panel ──────────────────────────────────────────────────────────────

  /**
   * Draw the panel: edit the existing message, or send the first one.
   *
   * Every state change in the bot ends here. A failed edit falls back to sending a
   * new panel, because the usual cause is that the user deleted the old message
   * and a bot that then refuses to draw anything looks broken.
   */
  private async paint(
    session: Session,
    text: string,
    buttons: InlineButton[][],
  ): Promise<void> {
    session.gate.record(this.now());

    if (session.panelId !== null) {
      try {
        await this.opts.client.editMessage(session.chatId, session.panelId, text, { buttons });
        return;
      } catch {
        session.panelId = null; // deleted or too old to edit — fall through
      }
    }
    try {
      const sent = await this.opts.client.sendMessage(session.chatId, text, { buttons });
      session.panelId = sent.message_id;
    } catch {
      // A chat that has blocked the bot must not take the process down.
    }
  }

  /** A one-off message that is not the panel — run reports and run summaries. */
  private async say(chatId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    try {
      await this.opts.client.sendMessage(chatId, text, buttons ? { buttons } : {});
    } catch {
      // As above.
    }
  }

  private async showMenu(session: Session): Promise<void> {
    this.stopAuto(session);
    session.view = "menu";
    await this.paint(
      session,
      renderMenu(this.opts.defaults.chain, this.opts.wallets.length),
      MAIN_MENU,
    );
  }

  // ── text commands ──────────────────────────────────────────────────────────

  private async handleText(message: TgMessage, text: string): Promise<void> {
    const session = this.session(message.chat.id);

    // A slash command always wins over whatever the state machine was expecting,
    // so a half-finished setup can never trap a chat.
    const command = text.startsWith("/") ? text.slice(1).split(/[\s@]/)[0]?.toLowerCase() : null;
    const rest = text.includes(" ") ? text.slice(text.indexOf(" ") + 1).trim() : "";

    if (command) {
      switch (command) {
        case "start":
          await this.showMenu(session);
          return;
        case "help":
          await this.paint(session, HELP, BACK_ONLY);
          return;
        case "mint":
          await this.begin(session, "mint", rest);
          return;
        case "check":
          await this.begin(session, "check", rest);
          return;
        case "stages":
          await this.begin(session, "stages", rest);
          return;
        case "watch":
          await this.begin(session, "watch", rest);
          return;
        case "wallets":
          await this.showWallets(session);
          return;
        case "status":
          await this.showStatus(session);
          return;
        case "cancel":
        case "abort":
          await this.cancel(session);
          return;
        default:
          await this.paint(
            session,
            `${bold("Unknown command")}\n${esc(`/${command} is not a command. /help lists them.`)}`,
            BACK_ONLY,
          );
          return;
      }
    }

    switch (session.view) {
      case "awaitTarget":
        session.draft.target = text;
        await this.afterTarget(session);
        return;
      case "awaitQuantity": {
        const quantity = Number(text);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          await this.paint(
            session,
            `${bold("Quantity")}\n${esc("A whole number between 1 and 1000.")}`,
            quantityKeyboard(),
          );
          return;
        }
        session.draft.quantity = quantity;
        await this.prepare(session);
        return;
      }
      case "awaitTime": {
        try {
          const atMs = parseTimeInput(text, this.now());
          await this.fire(session, { atMs });
        } catch (err: unknown) {
          await this.paint(
            session,
            `${bold("Could not read that time")}\n${esc(err instanceof Error ? err.message : "Try HH:MM, an ISO timestamp, a unix time, or +90s.")}`,
            confirmKeyboard(),
          );
        }
        return;
      }
      default:
        // A bare address or link with no command is unambiguous enough to act on.
        if (/^(0x[0-9a-fA-F]{40}|https?:\/\/\S+)$/.test(text)) {
          await this.begin(session, "mint", text);
          return;
        }
        await this.paint(
          session,
          `${bold("Not sure what to do with that")}\n${esc("Pick an action, or /help.")}`,
          MAIN_MENU,
        );
    }
  }

  // ── callbacks ──────────────────────────────────────────────────────────────

  /**
   * Route a button press.
   *
   * Order matters: authorize, then acknowledge, then act. The acknowledgement is
   * sent before any of the work because Telegram spins the client's button for
   * about thirty seconds without it, and preparing a run takes several seconds —
   * long enough for a user to conclude nothing happened and press again.
   */
  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const chat: TgChat | undefined = query.message?.chat;

    if (!chat || !this.authorized(query.from.id, chat)) {
      // Rejected out loud: the presser can see the panel, so there is nothing to
      // conceal from them, and a silent refusal reads as a broken bot.
      await this.opts.client.answerCallback(
        query.id,
        "Not authorized to use this bot.",
        true,
      );
      return;
    }

    const parsed = parseCallback(query.data);
    if (!parsed) {
      // An unrecognised action means a stale keyboard from an older deployment.
      // Saying so beats doing nothing, and beats guessing what was meant.
      await this.opts.client.answerCallback(
        query.id,
        "That button is no longer valid — reopen the panel with /start.",
        true,
      );
      return;
    }

    const session = this.session(chat.id);
    // Adopt the message the button lives on, so a panel from a previous process
    // keeps working instead of being orphaned.
    if (session.panelId === null && query.message) session.panelId = query.message.message_id;

    // Refresh answers its own callback, because it needs to report a debounce.
    if (parsed.action !== "refresh") await this.opts.client.answerCallback(query.id);

    await this.dispatchAction(session, parsed.action, parsed.value, query.id);
  }

  private async dispatchAction(
    session: Session,
    action: PanelAction,
    value: string,
    queryId: string,
  ): Promise<void> {
    switch (action) {
      case "menu":
        await this.showMenu(session);
        return;
      case "mint":
        await this.begin(session, "mint", "");
        return;
      case "check":
        await this.begin(session, "check", "");
        return;
      case "stages":
        await this.begin(session, "stages", "");
        return;
      case "watch":
        await this.begin(session, "watch", "");
        return;
      case "wallets":
        await this.showWallets(session);
        return;
      case "status":
        await this.showStatus(session);
        return;
      case "cancel":
        await this.cancel(session);
        return;
      case "chain":
        await this.pickChain(session, value);
        return;
      case "qty": {
        // Callback data is echoed back by the client, so it is validated the same
        // way typed input is rather than trusted because we authored the button.
        const quantity = Number(value);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          await this.opts.client.answerCallback(queryId, "Invalid quantity.", true);
          return;
        }
        session.draft.quantity = quantity;
        await this.prepare(session);
        return;
      }
      case "send":
        await this.fire(session, "stage");
        return;
      case "fire":
        if (value === "custom") {
          session.view = "awaitTime";
          await this.paint(
            session,
            `${bold("Fire at")}\n${esc("Send a time — HH:MM, an ISO timestamp, a unix time, or +90s.")}`,
            confirmKeyboard(),
          );
          return;
        }
        await this.fire(session, value === "now" ? "now" : "stage");
        return;
      case "refresh":
        await this.refreshPanel(session, "manual", queryId);
        return;
      case "auto":
        await this.toggleAuto(session, value === "on", queryId);
        return;
      case "noop":
        return;
    }
  }

  // ── setup flow ─────────────────────────────────────────────────────────────

  private async begin(session: Session, intent: Intent, target: string): Promise<void> {
    if (session.view === "running") {
      await this.paint(
        session,
        `${bold("A run is in progress")}\n${esc("Cancel it before starting another.")}`,
        [[{ text: "❌ Cancel the run", callback_data: encodeCallback("cancel") }]],
      );
      return;
    }
    this.stopAuto(session);
    this.discardDraft(session);
    session.draft = { intent, ...(target ? { target } : {}) };

    if (!target) {
      session.view = "awaitTarget";
      const titles: Record<Intent, string> = {
        mint: "🎯 Mint",
        check: "🔍 Check",
        watch: "👀 Watch",
        stages: "📊 Stages",
      };
      await this.paint(session, renderAskTarget(titles[intent]), BACK_ONLY);
      return;
    }
    await this.afterTarget(session);
  }

  /**
   * Decide the chain, then move on.
   *
   * A URL carries its chain and a bare address is probed; only a slug, or an
   * address deployed to several chains, needs asking. Guessing here is the failure
   * this whole path exists to prevent: a slug resolves to a different contract on
   * every chain it is listed on, so the wrong guess prepares a mint against the
   * wrong deployment and only reveals it as a revert.
   */
  private async afterTarget(session: Session): Promise<void> {
    const target = session.draft.target ?? "";
    let parsedKind: "address" | "slug" | null = null;
    let hint: string | undefined;
    try {
      const parsed = parseTarget(target);
      parsedKind = parsed.kind;
      hint = parsed.chainHint;
    } catch {
      // Let resolveTarget produce the error message; it has one written for this.
    }

    if (hint) {
      session.draft.chainKey = hint;
      await this.askQuantity(session);
      return;
    }
    // A bare address is probed inside resolveTarget. A slug cannot be.
    if (parsedKind === "address") {
      await this.askQuantity(session);
      return;
    }

    session.view = "awaitChain";
    await this.paint(
      session,
      [
        bold("Chain"),
        "",
        esc(`Which chain is this collection on? Default is ${this.opts.defaults.chain}.`),
      ].join("\n"),
      chainKeyboard(),
    );
  }

  private async pickChain(session: Session, chainKey: string): Promise<void> {
    if (!chainKey) return;
    session.draft.chainKey = chainKey;
    delete session.draft.candidates;
    await this.askQuantity(session);
  }

  private async askQuantity(session: Session): Promise<void> {
    // Only a mint needs a quantity. Reading a drop does not depend on one.
    if (session.draft.intent !== "mint") {
      session.draft.quantity = this.opts.defaults.quantity;
      await this.prepare(session);
      return;
    }
    session.view = "awaitQuantity";
    await this.paint(
      session,
      [bold("Quantity"), "", esc("How many per wallet? Tap one, or send a number.")].join("\n"),
      quantityKeyboard(),
    );
  }

  /** Resolve, probe, read the drop, budget gas — then show every number. */
  private async prepare(session: Session): Promise<void> {
    const draft = session.draft;
    if (!draft.target) {
      session.view = "awaitTarget";
      await this.paint(session, renderAskTarget("Target"), BACK_ONLY);
      return;
    }

    await this.paint(session, `${bold("Working")}\n${esc("Resolving the target…")}`, []);
    const progress = (text: string): void => {
      void this.paint(session, `${bold("Working")}\n${esc(text)}`, []);
    };

    let run: PreparedRun;
    try {
      run = await prepareRun({
        target: draft.target,
        chainKey: draft.chainKey,
        quantity: draft.quantity ?? this.opts.defaults.quantity,
        apiKey: this.opts.defaults.openseaApiKey,
        maxFeeGwei: this.opts.defaults.maxFeeGwei,
        priorityGwei: this.opts.defaults.priorityGwei,
        gasLimit: this.opts.defaults.gasLimit,
        defaultChain: this.opts.defaults.chain,
        nowMs: this.now(),
        onProgress: progress,
      });
    } catch (err: unknown) {
      // The one error with a UI rather than a message: the address exists on
      // several chains, and only the user knows which deployment they meant.
      if (err instanceof AmbiguousChainError) {
        session.view = "awaitChain";
        session.draft.candidates = err.candidates;
        const candidates = orderCandidates(err.candidates);
        await this.paint(
          session,
          renderChainPicker(err.address, candidates),
          chainKeyboard(candidates),
        );
        return;
      }
      session.view = "menu";
      await this.paint(
        session,
        `${bold("Could not prepare that")}\n\n${esc(redactKeys(err instanceof Error ? err.message : String(err)))}`,
        MAIN_MENU,
      );
      return;
    }

    draft.run = run;
    draft.preparedAt = Date.now();

    if (draft.intent === "watch") {
      await this.watch(session);
      return;
    }
    if (draft.intent === "stages") {
      await this.showStages(session);
      return;
    }
    if (draft.intent === "check" || !run.plan) {
      await this.showCheck(session);
      return;
    }
    await this.confirm(session);
  }

  // ── read-only panels ───────────────────────────────────────────────────────

  /**
   * Read wallet balances against what this run would actually need.
   *
   * The figure checked is value + gasLimit × maxFeePerGas, which is what the node
   * reserves and therefore what it rejects against — not the expected cost, which
   * is smaller and would pass here and fail at broadcast.
   */
  private async readBalances(run: PreparedRun): Promise<BalanceReport[]> {
    if (!run.plan) return [];
    const required = requiredBalance(run.plan.value, run.gas);
    try {
      return await checkBalances(run.rpc.provider, this.opts.wallets, required);
    } catch {
      return [];
    }
  }

  private balanceLines(reports: BalanceReport[], symbol: string): string[] {
    if (reports.length === 0) return [];
    const lines = [bold("Wallets")];
    for (const report of reports) {
      const balance = report.balance === null ? "unreadable" : formatEth(report.balance, symbol);
      const mark = report.balance === null ? "·" : report.sufficient ? "✓" : "✗";
      lines.push(esc(`${mark} W${report.index} ${shortAddress(report.address)} — ${balance}`));
      if (!report.sufficient && report.balance !== null) {
        lines.push(esc(`   short ${formatEth(report.shortfall, symbol)}`));
      }
    }
    return lines;
  }

  /** 🔍 Check: the full picture, read-only, refreshable. */
  private async showCheck(session: Session): Promise<void> {
    const run = session.draft.run;
    if (!run) {
      await this.showMenu(session);
      return;
    }
    session.view = "check";
    session.draft.balances = await this.readBalances(run);
    session.stageSignature = stageSignature(run);
    await this.paint(session, this.renderCheck(session, run), refreshKeyboard(this.isAuto(session)));
  }

  private renderCheck(session: Session, run: PreparedRun): string {
    const nowMs = this.now();
    const quantity = session.draft.quantity ?? this.opts.defaults.quantity;
    const blocks: string[] = [];

    if (run.collection) {
      blocks.push(
        `${bold(run.collection.name)}\n${link("contract on the explorer", explorerAddress(run.chain.chainId, run.contract))}`,
      );
    } else {
      blocks.push(`${bold("Drop")}\n${code(run.contract)}`);
    }

    blocks.push(
      [
        esc(`chain: ${run.chain.name} (id ${run.chain.chainId})`),
        esc(`quantity: ${quantity} per wallet`),
        run.plan
          ? esc(
              `variant: ${run.plan.variant === "v1-singleton" ? "SeaDrop v1 singleton" : "SeaDrop v2 (config on token)"}`,
            )
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    blocks.push(renderStages(run.stages, run.chain, formatLocal, nowMs));

    if (!run.plan) {
      blocks.push(
        esc(noDropMessage(run.contract, run.chain.name, this.opts.defaults.openseaApiKey !== null)),
      );
    }

    blocks.push(
      formatGas(
        run.gas.maxFeePerGas,
        run.gas.maxPriorityFeePerGas,
        run.gas.gasLimit,
        run.fees.baseFeeWei,
        run.chain.nativeSymbol,
      ),
    );

    const balances = this.balanceLines(session.draft.balances ?? [], run.chain.nativeSymbol);
    if (balances.length > 0) blocks.push(balances.join("\n"));

    for (const warning of run.warnings) blocks.push(esc(`⚠ ${warning}`));
    blocks.push(updatedFooter(nowMs));
    return blocks.join("\n\n");
  }

  /** 📊 Stages: the stage table on its own, refreshable. */
  private async showStages(session: Session): Promise<void> {
    const run = session.draft.run;
    if (!run) {
      session.view = "awaitTarget";
      session.draft.intent = "stages";
      await this.paint(session, renderAskTarget("📊 Stages"), BACK_ONLY);
      return;
    }
    session.view = "stages";
    session.stageSignature = stageSignature(run);
    await this.paint(session, this.renderStagesPanel(run), refreshKeyboard(this.isAuto(session)));
  }

  private renderStagesPanel(run: PreparedRun): string {
    const nowMs = this.now();
    const head = run.collection
      ? bold(run.collection.name)
      : `${bold("Drop")} ${code(shortAddress(run.contract))}`;
    return [
      head,
      esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
      "",
      renderStages(run.stages, run.chain, formatLocal, nowMs),
      "",
      updatedFooter(nowMs),
    ].join("\n");
  }

  // ── refresh and auto mode ──────────────────────────────────────────────────

  private isAuto(session: Session): boolean {
    return session.autoTimer !== undefined;
  }

  /**
   * Re-read everything behind a live panel and redraw it in place.
   *
   * Debounced rather than queued: a second tap two seconds after the first would
   * return the same numbers, so it is acknowledged with a toast and dropped. The
   * acknowledgement always happens — that is what stops the client spinning.
   */
  private async refreshPanel(
    session: Session,
    source: RefreshSource,
    queryId?: string,
  ): Promise<void> {
    const nowMs = this.now();

    if (!session.gate.allows(source, nowMs)) {
      if (queryId) {
        await this.opts.client.answerCallback(
          queryId,
          debouncedToast(session.gate.waitMs(source, nowMs)),
        );
      }
      return;
    }
    if (queryId) await this.opts.client.answerCallback(queryId, "Refreshing…");

    const run = session.draft.run;
    if (!run || (session.view !== "check" && session.view !== "stages")) {
      this.stopAuto(session);
      return;
    }

    let fresh: PreparedRun;
    try {
      fresh = await refreshRun(run, {
        quantity: session.draft.quantity ?? this.opts.defaults.quantity,
        apiKey: this.opts.defaults.openseaApiKey,
        maxFeeGwei: this.opts.defaults.maxFeeGwei,
        priorityGwei: this.opts.defaults.priorityGwei,
        gasLimit: this.opts.defaults.gasLimit,
        nowMs: this.now(),
      });
    } catch (err: unknown) {
      // A failed read must not kill the panel: the next tick may well succeed, and
      // tearing down a countdown someone is watching because one RPC call timed
      // out is worse than showing slightly stale numbers.
      const message = redactKeys(err instanceof Error ? err.message : String(err));
      await this.opts.client
        .answerCallback(queryId ?? "", `Refresh failed: ${message.slice(0, 150)}`)
        .catch(() => {});
      return;
    }

    // The provider is shared, so the old run must not be closed here.
    session.draft.run = fresh;
    if (session.view === "check") {
      session.draft.balances = await this.readBalances(fresh);
    }

    // A stage that opens or closes changes what the buttons should mean, so auto
    // mode stops and hands control back rather than continuing to tick.
    const signature = stageSignature(fresh);
    const transitioned = session.stageSignature !== undefined && session.stageSignature !== signature;
    session.stageSignature = signature;
    if (transitioned) this.stopAuto(session);

    const text =
      session.view === "check" ? this.renderCheck(session, fresh) : this.renderStagesPanel(fresh);
    const body = transitioned
      ? `${text}\n\n${bold("A stage just changed — auto-refresh stopped.")}`
      : text;

    await this.paint(session, body, refreshKeyboard(this.isAuto(session)));
  }

  /**
   * Turn ⏱ Auto on or off.
   *
   * The interval re-reads on a timer and stops on any of: a second press, a stage
   * transition, a mint run starting, `/cancel`, or navigation away from the panel.
   * It is unref'd so a live panel never holds the process open by itself.
   */
  private async toggleAuto(session: Session, on: boolean, queryId: string): Promise<void> {
    if (session.view !== "check" && session.view !== "stages") {
      await this.opts.client.answerCallback(
        queryId,
        "Auto-refresh only applies to a Check or Stages panel.",
        true,
      );
      return;
    }

    if (!on) {
      this.stopAuto(session);
      const run = session.draft.run;
      if (run) {
        const text =
          session.view === "check" ? this.renderCheck(session, run) : this.renderStagesPanel(run);
        await this.paint(session, text, refreshKeyboard(false));
      }
      return;
    }

    this.stopAuto(session);
    session.autoTimer = setInterval(() => {
      void this.refreshPanel(session, "auto");
    }, AUTO_REFRESH_MS);
    session.autoTimer.unref?.();

    const run = session.draft.run;
    if (run) {
      const text =
        session.view === "check" ? this.renderCheck(session, run) : this.renderStagesPanel(run);
      await this.paint(session, text, refreshKeyboard(true));
    }
  }

  private stopAuto(session: Session): void {
    if (session.autoTimer) {
      clearInterval(session.autoTimer);
      delete session.autoTimer;
    }
  }

  // ── confirm and fire ───────────────────────────────────────────────────────

  /**
   * The last stop before anything irreversible.
   *
   * Every number that costs money if it is wrong, on one screen: chain, contract,
   * variant, price, caps, supply, the stage window, the gas ceiling, the wallets,
   * and the worst-case total. "Are you sure?" without these is a button people
   * press without reading.
   */
  private async confirm(session: Session): Promise<void> {
    const run = session.draft.run;
    if (!run?.plan) {
      await this.showCheck(session);
      return;
    }
    session.view = "confirm";
    this.armExpiry(session);

    const quantity = session.draft.quantity ?? this.opts.defaults.quantity;
    const balances = await this.readBalances(run);
    session.draft.balances = balances;

    const fireMode = this.opts.defaults.leadMs > 0
      ? `at the stage opening, −${this.opts.defaults.leadMs}ms lead`
      : "at the stage opening (T-0)";

    const body = renderConfirm({
      plan: run.plan,
      chain: run.chain,
      collectionName: run.collection?.name,
      quantity,
      wallets: this.opts.wallets,
      maxFeeWei: run.gas.maxFeePerGas,
      gasLimit: run.gas.gasLimit,
      stages: run.stages,
      fireMode,
      nowMs: this.now(),
    });

    const blocks = [body];
    const short = balances.filter((r) => !r.sufficient);
    if (short.length > 0) {
      blocks.push(
        [
          bold("⚠ Underfunded wallets"),
          ...short.map((r) =>
            esc(`W${r.index} ${shortAddress(r.address)} short ${formatEth(r.shortfall, run.chain.nativeSymbol)}`),
          ),
        ].join("\n"),
      );
    }
    for (const warning of run.warnings) blocks.push(esc(`⚠ ${warning}`));

    const startMs = run.plan.drop.startTime * 1000;
    const open = this.now() >= startMs;
    const buttons: InlineButton[][] = [
      [
        { text: open ? "✅ Send now" : "✅ Send", callback_data: encodeCallback("send") },
        { text: "❌ Cancel", callback_data: encodeCallback("cancel") },
      ],
    ];
    if (!open) {
      buttons.push([
        { text: "⚡ Fire now anyway", callback_data: encodeCallback("fire", "now") },
        { text: "🕐 At a time…", callback_data: encodeCallback("fire", "custom") },
      ]);
    }

    await this.paint(session, blocks.join("\n\n"), buttons);
  }

  private async fire(session: Session, mode: "stage" | "now" | { atMs: number }): Promise<void> {
    const chatId = session.chatId;
    const run = session.draft.run;
    if (!run?.plan) {
      await this.paint(
        session,
        `${bold("Nothing is prepared")}\n${esc("Start with 🎯 Mint.")}`,
        MAIN_MENU,
      );
      return;
    }
    if (this.running !== null && this.running !== chatId) {
      await this.paint(
        session,
        [
          bold("Another chat is mid-run"),
          "",
          esc(
            "The same wallets are already signing. Two runs would use the same nonces and one would be silently discarded, so this one is not starting.",
          ),
        ].join("\n"),
        MAIN_MENU,
      );
      return;
    }

    // A mint takes the panel out of live mode: the numbers are now fixed by the
    // transactions being signed, and a refresh loop editing the same message
    // would fight the run reporter for the rate limit.
    this.stopAuto(session);
    this.running = chatId;
    session.view = "running";
    this.clearExpiry(session);
    const controller = new AbortController();
    session.controller = controller;

    const { fireAtMs } = resolveFireTime(run.plan, mode, this.opts.defaults.leadMs);
    // A null fire time means "as soon as everything is signed" — there is no
    // instant to print, and printing the current time would imply a schedule
    // that does not exist.
    const when = fireAtMs === null ? "immediately" : formatLocal(fireAtMs);
    await this.paint(
      session,
      [
        bold("Running"),
        "",
        esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
        esc(`${this.opts.wallets.length} wallet(s) · ${when}`),
        "",
        esc("Progress is reported below. Cancel stops anything not yet broadcast."),
      ].join("\n"),
      [[{ text: "❌ Cancel", callback_data: encodeCallback("cancel") }]],
    );

    const reporter = createTelegramReporter(this.opts.client, chatId, run.chain);

    try {
      const result = await runMint(
        {
          chain: run.chain,
          plan: run.plan,
          wallets: this.opts.wallets,
          readUrls: run.rpc.plan.read,
          blastUrls: run.rpc.plan.blast,
          gas: run.gas,
          fireAtMs,
          leadMs: this.opts.defaults.leadMs,
          receiptTimeoutMs: this.opts.defaults.receiptTimeoutMs,
          signal: controller.signal,
        },
        reporter.handle,
      );
      await reporter.settle();

      const tail = [
        bold("Summary"),
        esc(`dispatch: ${result.dispatchMs.toFixed(2)}ms to write every transaction`),
      ];
      if (result.timingErrorMs !== 0) {
        tail.push(
          esc(
            `timing: ${result.timingErrorMs > 0 ? "+" : ""}${result.timingErrorMs.toFixed(0)}ms from the target instant`,
          ),
        );
      }
      tail.push(esc(`minted: ${result.minted} · failed: ${result.failed}`));
      await this.say(chatId, tail.join("\n"));
    } catch (err: unknown) {
      await reporter.settle();
      const message = redactKeys(err instanceof Error ? err.message : String(err));
      await this.say(chatId, `${bold("Run stopped")}\n${esc(message)}`);
    } finally {
      this.running = null;
      delete session.controller;
      this.discardDraft(session);
      await this.showMenu(session);
    }
  }

  // ── watch ──────────────────────────────────────────────────────────────────

  /**
   * Wait for a public stage to open.
   *
   * Read-only, so it does not take the run lock — but it does occupy this chat's
   * panel, because the panel is where its progress is reported.
   */
  private async watch(session: Session): Promise<void> {
    const chatId = session.chatId;
    const run = session.draft.run;
    if (!run) {
      await this.showMenu(session);
      return;
    }

    session.view = "running";
    const controller = new AbortController();
    session.controller = controller;

    await this.paint(
      session,
      [
        bold("👀 Watching"),
        "",
        esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
        "",
        esc("Polling the contract for the public stage. Nothing will be sent."),
      ].join("\n"),
      [[{ text: "❌ Stop watching", callback_data: encodeCallback("cancel") }]],
    );

    try {
      const found = await waitForPublicStage(
        run.rpc.provider,
        run.contract,
        session.draft.quantity ?? this.opts.defaults.quantity,
        {
          signal: controller.signal,
          onUpdate: (update: WatchUpdate) => {
            if (update.kind === "waiting") return; // too chatty for a chat
            void this.say(chatId, esc(update.message));
          },
        },
      );
      await this.say(
        chatId,
        [
          bold("🟢 Stage open"),
          esc(`${run.chain.name} · ${shortAddress(run.contract)}`),
          esc(`price: ${formatEth(found.drop.mintPrice, run.chain.nativeSymbol)}`),
          "",
          esc("Use 🎯 Mint to prepare and confirm against it."),
        ].join("\n"),
      );
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        await this.say(chatId, esc(redactKeys(err instanceof Error ? err.message : String(err))));
      }
    } finally {
      delete session.controller;
      this.discardDraft(session);
      await this.showMenu(session);
    }
  }

  // ── odds and ends ──────────────────────────────────────────────────────────

  private async showWallets(session: Session): Promise<void> {
    this.stopAuto(session);
    session.view = "wallets";
    const wallets = this.opts.wallets;

    if (wallets.length === 0) {
      await this.paint(
        session,
        `${bold("No wallets")}\n${esc("Set PRIVATE_KEYS in the bot's .env. Keys are never accepted over Telegram.")}`,
        BACK_ONLY,
      );
      return;
    }

    const lines = [bold(`👛 ${wallets.length} wallet(s)`), ""];
    for (const wallet of wallets) lines.push(`W${wallet.index} ${code(wallet.address)}`);
    lines.push("");
    lines.push(esc("Balances are checked against the real required amount during a mint,"));
    lines.push(esc("per chain — value plus the full gas ceiling, which is what a node reserves."));
    await this.paint(session, lines.join("\n"), BACK_ONLY);
  }

  private async showStatus(session: Session): Promise<void> {
    session.view = "status";
    const describe: Record<View, string> = {
      menu: "Idle.",
      awaitTarget: "Waiting for a link, slug, or contract address.",
      awaitChain: "Waiting for a chain.",
      awaitQuantity: "Waiting for a quantity.",
      awaitTime: "Waiting for a time to fire at.",
      confirm: "Prepared and waiting for confirmation. Nothing has been sent.",
      running: "Running. Cancel to abort.",
      check: "Showing a drop.",
      stages: "Showing a drop's stages.",
      wallets: "Showing wallets.",
      status: "Idle.",
    };

    const lines = [bold("📈 Status"), "", esc(describe[session.view])];
    const run = session.draft.run;
    if (run) {
      lines.push(esc(`target: ${shortAddress(run.contract)} on ${run.chain.name}`));
      if (run.detection) lines.push(esc(`chain: detected by probing (${run.detection.kind})`));
    }
    lines.push(
      esc(`clock: ${this.clock.offset >= 0 ? "+" : ""}${this.clock.offset}ms correction applied`),
    );
    lines.push(esc(`wallets: ${this.opts.wallets.length}`));
    if (this.isAuto(session)) lines.push(esc("auto-refresh: on"));
    if (this.running !== null) {
      lines.push(
        esc(this.running === session.chatId ? "This chat holds the run lock." : "Another chat holds the run lock."),
      );
    }
    lines.push("", updatedFooter(this.now()));
    await this.paint(session, lines.join("\n"), BACK_ONLY);
  }

  /**
   * Abort whatever is happening, from any panel.
   *
   * Handles three distinct situations with one button: a run in flight (abort it),
   * a live panel (stop the loop), and a half-finished setup (drop it). An already
   * broadcast transaction cannot be recalled, and the message says so rather than
   * implying the abort undid it.
   */
  private async cancel(session: Session): Promise<void> {
    const wasAuto = this.isAuto(session);
    this.stopAuto(session);

    if (session.controller && !session.controller.signal.aborted) {
      session.controller.abort();
      await this.paint(
        session,
        [
          bold("Aborting"),
          "",
          esc(
            "Nothing further will be sent. Anything already broadcast is on-chain and cannot be recalled.",
          ),
        ].join("\n"),
        MAIN_MENU,
      );
      return;
    }

    const had = session.view !== "menu" || session.draft.run !== undefined || wasAuto;
    this.discardDraft(session);
    session.view = "menu";
    await this.paint(
      session,
      [
        renderMenu(this.opts.defaults.chain, this.opts.wallets.length),
        "",
        esc(had ? "Cancelled. Nothing was sent." : "Nothing to cancel."),
      ].join("\n"),
      MAIN_MENU,
    );
  }

  /** Close the prepared run's provider. Sockets left open leak file descriptors. */
  private discardDraft(session: Session): void {
    this.clearExpiry(session);
    this.stopAuto(session);
    if (session.draft.run) closeRun(session.draft.run);
    session.draft = { intent: session.draft.intent };
    delete session.stageSignature;
  }

  private armExpiry(session: Session): void {
    this.clearExpiry(session);
    session.expiry = setTimeout(() => {
      if (session.view !== "confirm") return;
      this.discardDraft(session);
      session.view = "menu";
      void this.paint(
        session,
        [
          bold("That prepared mint went stale"),
          "",
          esc(
            "Prices and the stage may have moved, so it was dropped. Nothing was sent. Start again with 🎯 Mint.",
          ),
        ].join("\n"),
        MAIN_MENU,
      );
    }, DRAFT_TTL_MS);
    session.expiry.unref?.();
  }

  private clearExpiry(session: Session): void {
    if (session.expiry) {
      clearTimeout(session.expiry);
      delete session.expiry;
    }
  }

  /** Abort everything in flight — used on shutdown. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.controller?.abort();
      this.clearExpiry(session);
      this.stopAuto(session);
      if (session.draft.run) closeRun(session.draft.run);
    }
  }
}

/**
 * A fingerprint of every stage's status, for noticing a transition.
 *
 * Status rather than countdown: the countdown changes on every tick by design, so
 * comparing it would report a transition every 20 seconds. What matters is a row
 * crossing from upcoming to live, or live to ended.
 */
export function stageSignature(run: Pick<PreparedRun, "stages">): string {
  return run.stages.rows.map((row) => `${row.kind}:${row.label}:${row.status}`).join("|");
}
