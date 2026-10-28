import type { Config } from "./config.js";
import { Namecheap } from "./namecheap.js";
import { Porkbun, PORKBUN_MOCK_API } from "./porkbun.js";
import { RegistrarError, type Registrar, type RegistrarName } from "./registrar.js";

export const REGISTRARS: { name: RegistrarName; label: string }[] = [
  { name: "porkbun", label: "Porkbun" },
  { name: "namecheap", label: "Namecheap" },
];

export interface Accounts {
  all: Registrar[];
  get(name: RegistrarName): Registrar | undefined;
  /** Porkbun is the only account dom buys and transfers into. */
  porkbun?: Porkbun;
}

export interface AccountOptions {
  mock?: boolean;
  onWarning?: (w: string) => void;
  fetch?: typeof fetch;
}

/** Namecheap needs the caller's public IP in every request, and only answers whitelisted ones. */
export async function detectPublicIp(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl("https://api.ipify.org?format=json");
    const { ip } = (await res.json()) as { ip?: string };
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch {
    // fall through
  }
  throw new RegistrarError(
    "Couldn't detect your public IPv4 address for Namecheap. Set it with NAMECHEAP_CLIENT_IP or `dom login namecheap`.",
    "NO_CLIENT_IP",
  );
}

export function openAccounts(config: Config, opts: AccountOptions = {}): Accounts {
  const all: Registrar[] = [];
  let porkbun: Porkbun | undefined;

  if (opts.mock) {
    porkbun = new Porkbun({ apiKey: "mock", secretKey: "mock", baseUrl: PORKBUN_MOCK_API, onWarning: opts.onWarning, fetch: opts.fetch });
    return { all: [porkbun], get: (n) => (n === "porkbun" ? porkbun : undefined), porkbun };
  }

  const pb = config.accounts.porkbun;
  if (pb) {
    porkbun = new Porkbun({ ...pb, onWarning: opts.onWarning, fetch: opts.fetch });
    all.push(porkbun);
  }
  const nc = config.accounts.namecheap;
  if (nc) {
    const clientIp = nc.clientIp ?? (() => detectPublicIp(opts.fetch));
    all.push(new Namecheap({ ...nc, clientIp, onWarning: opts.onWarning, fetch: opts.fetch }));
  }
  return { all, get: (n) => all.find((r) => r.name === n), porkbun };
}

/** Which connected account holds this domain? Asks each in parallel. */
export async function findOwner(accounts: Accounts, domain: string): Promise<Registrar> {
  if (accounts.all.length === 1) return accounts.all[0]!;
  const results = await Promise.allSettled(accounts.all.map((r) => r.getDomain(domain)));
  const owner = accounts.all.find((_, i) => {
    const r = results[i]!;
    return r.status === "fulfilled" && r.value;
  });
  if (owner) return owner;

  const failures = results
    .map((r, i) => (r.status === "rejected" ? `${accounts.all[i]!.label}: ${(r.reason as Error).message}` : undefined))
    .filter(Boolean);
  throw new RegistrarError(
    `${domain} isn't in any connected account (${accounts.all.map((r) => r.label).join(", ")}).` +
      (failures.length ? `\n  Couldn't check ${failures.join("; ")}` : ""),
    "DOMAIN_NOT_FOUND",
  );
}
