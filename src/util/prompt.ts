// Interactive prompts on node:readline, no dependencies.
//
// Menus are numbered rather than arrow-key driven on purpose. A sniper gets driven
// under time pressure, often over SSH, and typing "2 <enter>" behaves identically
// in every terminal — including Windows Terminal and PowerShell — with no raw-mode
// key handling to get wrong.
//
// Lines are queued as they arrive rather than read on demand. A piped stdin emits
// every line at once, and `rl.question()` only captures the line that arrives
// *after* it is called, so without a queue a scripted run drops every answer past
// the first and hangs on question two.

import readline from "readline";
import { c } from "./render";

let rl: readline.Interface | null = null;
let shuttingDown = false;
const queue: string[] = [];
let waiter: ((line: string) => void) | null = null;

// Terminal mode only when stdin really is a TTY. Forcing it on makes readline
// treat a redirected stdin as raw keystrokes and echo the whole buffer at once.
const isTty = Boolean(process.stdin.isTTY);

function getRl(): readline.Interface {
  if (rl) return rl;
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTty,
  });

  rl.on("line", (line) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });

  // Ctrl+C, Ctrl+D, or piped input running out mid-question. Without this the
  // pending promise never settles and the process exits with no explanation.
  rl.on("close", () => {
    if (waiter && !shuttingDown) {
      process.stdout.write(c.yellow("\n  Input closed — cancelling. Nothing was sent.\n"));
      process.exit(130);
    }
  });
  return rl;
}

/** Release stdin. Call before firing so readline never competes with the log. */
export function closePrompts(): void {
  shuttingDown = true;
  if (rl) {
    rl.close();
    rl = null;
  }
}

function readLine(): Promise<string> {
  getRl();
  const queued = queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  return new Promise((resolve) => {
    waiter = resolve;
  });
}

export async function ask(prompt: string, fallback = ""): Promise<string> {
  process.stdout.write(prompt);
  const answer = (await readLine()).trim();
  // A TTY echoes the typed text; a pipe does not, which runs every prompt into one
  // unreadable line. Echo it ourselves so a scripted run leaves an auditable
  // transcript of what was answered.
  if (!isTty) process.stdout.write(`${answer}\n`);
  return answer.length > 0 ? answer : fallback;
}

/**
 * Read without echoing.
 *
 * In a TTY readline's redraw is muted entirely rather than selectively: every
 * redraw string contains the prompt *and* the input concatenated, so filtering
 * would leak the key one character at a time. Outside a TTY readline never echoes.
 */
export async function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!isTty) {
    const answer = await readLine();
    process.stdout.write("\n");
    return answer.trim();
  }

  const iface = getRl() as unknown as { _writeToOutput?: (s: string) => void };
  const original = iface._writeToOutput;
  iface._writeToOutput = () => {};
  try {
    return (await readLine()).trim();
  } finally {
    iface._writeToOutput = original;
    process.stdout.write("\n");
  }
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

export async function askChoice<T>(
  title: string,
  choices: Choice<T>[],
  defaultIndex = 0,
): Promise<T> {
  if (choices.length === 0) throw new Error("No choices to pick from.");
  process.stdout.write(`\n${c.bold(title)}\n`);
  choices.forEach((choice, i) => {
    const hint = choice.hint ? c.gray(`  — ${choice.hint}`) : "";
    process.stdout.write(`    ${c.cyan(c.bold(`${i + 1})`))} ${choice.label}${hint}\n`);
  });

  const safeDefault = Math.min(Math.max(0, defaultIndex), choices.length - 1);
  for (;;) {
    const raw = await ask(
      c.gray(`  › 1-${choices.length} [${safeDefault + 1}]: `),
      String(safeDefault + 1),
    );
    const idx = parseInt(raw, 10) - 1;
    const picked = choices[idx];
    if (picked) {
      process.stdout.write(c.green(`  ${"✓"} ${picked.label}\n`));
      return picked.value;
    }
    process.stdout.write(c.red(`  ✗ Enter a number from 1 to ${choices.length}.\n`));
  }
}

export async function askNumber(
  question: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): Promise<number> {
  const { min = -Infinity, max = Infinity, integer = false } = opts;
  for (;;) {
    const raw = await ask(c.gray(`  › ${question} [${fallback}]: `), String(fallback));
    const value = Number(raw);
    const valid =
      Number.isFinite(value) &&
      value >= min &&
      value <= max &&
      (!integer || Number.isInteger(value));
    if (valid) return value;
    const bounds = [
      integer ? "a whole number" : "a number",
      min > -Infinity ? `≥ ${min}` : "",
      max < Infinity ? `≤ ${max}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    process.stdout.write(c.red(`  ✗ Enter ${bounds}.\n`));
  }
}

export async function askText(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  return ask(c.gray(`  › ${question}${suffix}: `), fallback);
}

export async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  for (;;) {
    const raw = (await ask(c.gray(`  › ${question} (${hint}): `), defaultYes ? "y" : "n"))
      .toLowerCase()
      .trim();
    if (["y", "yes"].includes(raw)) return true;
    if (["n", "no"].includes(raw)) return false;
    process.stdout.write(c.red("  ✗ Answer y or n.\n"));
  }
}
