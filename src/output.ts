import { RegistrarError, type Quote } from "./registrar.js";
import { c, confirm, isInteractive, money, spinner, table } from "./ui.js";

/** A mistake in how dom was invoked; printed without a stack trace. */
export class UsageError extends Error {}

export const printJson = (v: unknown) => console.log(JSON.stringify(v, null, 2));
export const ok = (msg: string) => console.log(`${c.green("✓")} ${msg}`);
export const warn = (msg: string) => console.error(`${c.yellow("!")} ${msg}`);

export async function withSpinner<T>(text: string, fn: () => Promise<T>): Promise<T> {
  const s = spinner(text);
  try {
    return await fn();
  } finally {
    s.stop();
  }
}

export class Cancelled extends Error {
  constructor() {
    super("Cancelled. Nothing was changed.");
  }
}

export async function confirmOrAbort(yes: boolean | undefined, question: string): Promise<void> {
  if (yes) return;
  if (!isInteractive()) throw new UsageError("Not a terminal, so I can't ask for confirmation. Re-run with --yes.");
  if (!(await confirm(question))) throw new Cancelled();
}

export function printQuote(kind: string, q: Quote, opts: { renewalCents?: number; sandbox?: boolean; registrar?: string } = {}) {
  const after = q.balanceCents - q.costCents;
  const lines = [
    [c.dim(kind), c.bold(q.domain)],
    ...(opts.registrar ? [[c.dim("Registrar"), opts.registrar]] : []),
    [c.dim("Term"), `${q.years} year${q.years === 1 ? "" : "s"}`],
    [c.dim("Cost"), c.bold(money(q.costCents)) + (q.estimate ? c.dim(" (from the price list)") : "")],
  ];
  if (opts.renewalCents !== undefined) lines.push([c.dim("Renews at"), `${money(opts.renewalCents)}/yr`]);
  lines.push([
    c.dim("Credit"),
    `${money(q.balanceCents)} → ${q.sufficientFunds ? money(after) : c.red(`short by ${money(q.costCents - q.balanceCents)}`)}`,
  ]);
  if (opts.sandbox) lines.push([c.dim("Mode"), c.yellow("sandbox (fake money)")]);
  console.log(table(lines));
}

export function explainNotPossible(q: Quote, creditUrl = "https://porkbun.com/account/credit"): never {
  if (!q.sufficientFunds) {
    throw new RegistrarError(
      `Not enough account credit. Add at least ${money(q.costCents - q.balanceCents)} at ${creditUrl}`,
      "INSUFFICIENT_FUNDS",
    );
  }
  throw new RegistrarError(q.message ?? "The registrar says this purchase would not go through.");
}
