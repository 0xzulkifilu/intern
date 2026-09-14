// Terminal rendering: colour, and turning engine events into readable output.
//
// Colour is applied through a tiny local helper rather than a dependency, for one
// reason that matters here: this runs during a mint, and a supply-chain
// compromise in a decorative package would sit in a process holding private keys.
// The whole feature is ~30 lines of ANSI escapes, so the trade is easy.
//
// NO_COLOR and a non-TTY stdout both disable colour, so piping to a log file
// produces clean text.

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  Boolean(process.stdout.isTTY);

function wrap(open: number, close: number) {
  return (text: string): string => (enabled ? `[${open}m${text}[${close}m` : text);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const symbols = {
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  info: "·",
  arrow: "→",
  fire: "▲",
};

export function heading(text: string): string {
  return `\n${c.bold(text)}`;
}

export function field(label: string, value: string, width = 16): string {
  return `  ${c.gray(label.padEnd(width))} ${value}`;
}

export function ok(text: string): string {
  return `  ${c.green(symbols.ok)} ${text}`;
}

export function fail(text: string): string {
  return `  ${c.red(symbols.fail)} ${text}`;
}

export function warn(text: string): string {
  return `  ${c.yellow(symbols.warn)} ${text}`;
}

export function info(text: string): string {
  return `  ${c.gray(symbols.info)} ${c.gray(text)}`;
}

export function banner(): string {
  return c.cyan(
    c.bold(`
   ██╗███╗   ██╗████████╗███████╗██████╗ ███╗   ██╗
   ██║████╗  ██║╚══██╔══╝██╔════╝██╔══██╗████╗  ██║
   ██║██╔██╗ ██║   ██║   █████╗  ██████╔╝██╔██╗ ██║
   ██║██║╚██╗██║   ██║   ██╔══╝  ██╔══██╗██║╚██╗██║
   ██║██║ ╚████║   ██║   ███████╗██║  ██║██║ ╚████║
   ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝`),
  );
}

/**
 * A single-line status that overwrites itself, for countdowns.
 *
 * Only when stdout is a TTY: writing \r into a redirected stream produces one
 * enormous unreadable line, so a pipe gets nothing here and relies on the
 * periodic log lines instead.
 */
export function transient(text: string): void {
  if (!process.stdout.isTTY) return;
  const width = process.stdout.columns ?? 80;
  const line = text.length > width - 1 ? `${text.slice(0, width - 2)}…` : text;
  process.stdout.write(`\r[2K${line}`);
}

export function clearTransient(): void {
  if (process.stdout.isTTY) process.stdout.write("\r[2K");
}

/** Right-align numbers in a column so latency figures are comparable at a glance. */
export function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

export function table(rows: string[][], gap = 2): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const pad = (widths[i] ?? 0) - stripAnsi(cell).length;
          return i === row.length - 1 ? cell : cell + " ".repeat(pad);
        })
        .join(" ".repeat(gap)),
    )
    .join("\n");
}

// Padding must be computed on visible width, and colour codes are invisible.
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}
