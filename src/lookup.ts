import { resolveNs } from "node:dns/promises";
import type { Availability } from "./registrar.js";

// Availability without any account: ask each TLD's registry over RDAP (the public
// successor to WHOIS). For TLDs whose registry has no RDAP service (.io, .co, .sh…),
// fall back to DNS: a name with nameservers is certainly taken; one without is only
// *likely* free, since a registered name can exist without DNS.

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const CONCURRENCY = 6;

export interface LookupOptions {
  fetch?: typeof fetch;
  resolveNs?: (domain: string) => Promise<string[]>;
}

type Bootstrap = Map<string, string>;

async function loadBootstrap(fetchImpl: typeof fetch): Promise<Bootstrap> {
  const map: Bootstrap = new Map();
  try {
    const res = await fetchImpl(BOOTSTRAP_URL, { signal: AbortSignal.timeout(8000) });
    const data = (await res.json()) as { services?: [string[], string[]][] };
    for (const [tlds, urls] of data.services ?? []) {
      const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
      if (url) for (const t of tlds) map.set(t.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
    }
  } catch {
    // Without the bootstrap list every name falls back to DNS.
  }
  return map;
}

async function viaRdap(domain: string, server: string, fetchImpl: typeof fetch): Promise<boolean | undefined> {
  try {
    const res = await fetchImpl(`${server}domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return true;
    if (res.ok) return false;
  } catch {
    // fall through to DNS
  }
  return undefined; // rate-limited or down: not an answer
}

async function viaDns(domain: string, lookup: (d: string) => Promise<string[]>): Promise<"taken" | "likely" | "unknown"> {
  try {
    await lookup(domain);
    return "taken";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return "likely"; // NXDOMAIN: the name doesn't exist in DNS
    if (code === "ENODATA") return "taken"; // the name exists, just without NS records
    return "unknown";
  }
}

export async function publicAvailability(domains: string[], opts: LookupOptions = {}): Promise<Availability[]> {
  const fetchImpl = opts.fetch ?? fetch;
  const lookup = opts.resolveNs ?? resolveNs;
  const bootstrap = await loadBootstrap(fetchImpl);

  const check = async (domain: string): Promise<Availability> => {
    const base = { domain, premium: false, promo: false };
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    const server = bootstrap.get(tld);
    if (server) {
      const free = await viaRdap(domain, server, fetchImpl);
      if (free !== undefined) return { ...base, available: free };
    }
    const dns = await viaDns(domain, lookup);
    if (dns === "taken") return { ...base, available: false };
    if (dns === "likely") return { ...base, available: true, likely: true, note: `likely: .${tld} has no public registry lookup` };
    return { ...base, available: null, note: "couldn't check, try again" };
  };

  const results: Availability[] = new Array(domains.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, domains.length) }, async () => {
      while (next < domains.length) {
        const i = next++;
        results[i] = await check(domains[i]!);
      }
    }),
  );
  return results;
}
