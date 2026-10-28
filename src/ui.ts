import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
};

export const money = (cents: number | undefined) => (cents === undefined ? "—" : `$${(cents / 100).toFixed(2)}`);

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header.map(c.dim), ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(cell))));
  return all
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - visible(cell))))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question: string, { hidden = false } = {}): Promise<string> {
  let muted = false;
  // Echo nothing while a secret is typed, but still show the prompt itself.
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(question);
    muted = hidden;
    return (await answer).trim();
  } finally {
    rl.close();
    if (hidden) process.stdout.write("\n");
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} ${c.dim("[y/N]")} `);
  return /^y(es)?$/i.test(answer);
}

export function spinner(text: string): { stop: () => void } {
  if (!process.stderr.isTTY) return { stop() {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => process.stderr.write(`\r${c.cyan(frames[i++ % frames.length]!)} ${text}`), 80);
  return {
    stop() {
      clearInterval(timer);
      process.stderr.write("\r\x1b[K");
    },
  };
}
