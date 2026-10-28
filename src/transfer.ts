import { resolveNs } from "node:dns/promises";
import type { Accounts } from "./accounts.js";
import { confirmOrAbort, explainNotPossible, ok, printJson, printQuote, UsageError, warn, withSpinner } from "./output.js";
import type { Porkbun } from "./porkbun.js";
import type { DnsRecordInput, Registrar } from "./registrar.js";
import { ask, c, isInteractive, table } from "./ui.js";

export interface TransferFlags {
  yes?: boolean;
  json?: boolean;
  "dry-run"?: boolean;
  "auth-code"?: string;
  resume?: boolean;
  "no-dns-copy"?: boolean;
}

/** Record types Porkbun can host. Namecheap's URL/URL301/FRAME are forwarding features, not DNS. */
const PORTABLE_TYPES = new Set(["A", "AAAA", "MX", "CNAME", "ALIAS", "TXT", "SRV", "TLSA", "CAA", "SSHFP", "HTTPS", "SVCB"]);

/** Nameserver hosts run by third-party DNS providers: a transfer leaves these untouched. */
const EXTERNAL_DNS = [
  /cloudflare\.com$/,
  /vercel-dns\.com$/,
  /awsdns-/,
  /azure-dns\./,
  /nsone\.net$/,
  /digitalocean\.com$/,
  /netlify/,
  /dnsimple\.com$/,
  /dnsmadeeasy\.com$/,
  /ultradns\./,
  /hetzner\.com$/,
  /linode\.com$/,
  /porkbun\.com$/,
];

const SOURCE_STEPS: Record<string, string[]> = {
  namecheap: [
    "namecheap.com → Domain List → Manage → Sharing & Transfer",
    "Turn off Domain Lock (dom can do this for you), then click AUTH CODE — Namecheap emails it to you",
  ],
  squarespace: [
    "Squarespace → Domains → click the domain",
    "Turn off the transfer lock, then get the transfer authorization (EPP) code",
    "Squarespace has no API, so this one step is on their website (menu names can shift a little)",
  ],
  generic: ["At your current registrar: unlock the domain and request its transfer authorization (EPP) code"],
};

export type DnsHome = "registrar" | "external" | "unknown";

export function classifyNameservers(ns: string[]): DnsHome {
  if (!ns.length) return "unknown";
  return ns.every((n) => EXTERNAL_DNS.some((re) => re.test(n.toLowerCase().replace(/\.$/, "")))) ? "external" : "registrar";
}

async function lookupNs(domain: string): Promise<string[]> {
  try {
    return (await resolveNs(domain)).map((n) => n.toLowerCase());
  } catch {
    return [];
  }
}

/** Current registrar's name from public RDAP data, e.g. "Squarespace Domains II LLC". */
async function lookupRegistrar(domain: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[] };
    const registrar = data.entities?.find((e) => e.roles?.includes("registrar"));
    return registrar?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3];
  } catch {
    return undefined;
  }
}

function sourceKey(registrarName: string | undefined, connected: Registrar | undefined): string {
  if (connected) return connected.name;
  const n = registrarName?.toLowerCase() ?? "";
  if (n.includes("squarespace") || n.includes("google")) return "squarespace";
  if (n.includes("namecheap")) return "namecheap";
  return "generic";
}

/** Exact records from a connected registrar's API when we can, else Porkbun's scan of live DNS. */
async function gatherRecords(domain: string, porkbun: Porkbun, source: Registrar | undefined) {
  let records: DnsRecordInput[];
  let origin: string;
  if (source) {
    const live = await withSpinner(`Reading DNS records from ${source.label}`, () => source.listRecords(domain));
    records = live.map((r) => ({ name: r.name, type: r.type, content: r.content, ttl: r.ttl, prio: r.prio }));
    origin = `${source.label} (exact copy)`;
  } else {
    records = await withSpinner("Scanning the domain's live DNS", () => porkbun.scanDns(domain));
    origin = "a scan of live DNS (covers common names, not guaranteed complete)";
  }
  const skipped = records.filter((r) => !PORTABLE_TYPES.has(String(r.type).toUpperCase()));
  for (const r of skipped) {
    if (!["NS", "SOA"].includes(String(r.type).toUpperCase())) {
      warn(`Skipping ${r.type} ${r.name} → ${r.content}: Porkbun sets up URL forwarding separately (dom doesn't copy it).`);
    }
  }
  // Porkbun's minimum TTL is 600; Namecheap allows 60.
  const portable = records
    .filter((r) => PORTABLE_TYPES.has(String(r.type).toUpperCase()))
    .map((r) => ({ ...r, ttl: r.ttl && r.ttl < 600 ? 600 : r.ttl }));
  return { records: portable, origin };
}

function showRecords(records: DnsRecordInput[]) {
  console.log(table(records.map((r) => [String(r.type), r.name || "@", String(r.content), r.prio ? String(r.prio) : ""]), ["TYPE", "NAME", "CONTENT", "PRIO"]));
}

/** Fill the held transfer's zone, point the domain at it, and release the transfer. */
async function finishHeldTransfer(domain: string, porkbun: Porkbun, source: Registrar | undefined, flags: TransferFlags, records: DnsRecordInput[]) {
  const porkbunNs = await withSpinner("Creating the DNS zone at Porkbun", () => porkbun.prepareTransfer(domain));
  if (records.length) {
    const result = await withSpinner(`Copying ${records.length} records`, () => porkbun.importDns(domain, records));
    ok(`DNS copied to Porkbun: ${result.created} created, ${result.skipped} already there${result.failed ? c.red(`, ${result.failed} failed`) : ""}`);
    for (const f of result.failures) warn(`Couldn't copy ${JSON.stringify(f)}`);
  }

  // Point the domain at Porkbun's (now filled) zone before the move, so there's no gap where nothing answers.
  if (porkbunNs.length && source?.setNameservers) {
    console.log(`\nPorkbun's nameservers: ${porkbunNs.join(", ")}`);
    await confirmOrAbort(flags.yes, `Switch ${domain} to Porkbun's nameservers at ${source.label} now? (Recommended: DNS keeps working through the move)`);
    await withSpinner(`Updating nameservers at ${source.label}`, () => source.setNameservers(domain, porkbunNs));
    ok(`Nameservers switched at ${source.label}`);
  } else if (porkbunNs.length) {
    console.log(
      `\n${c.bold("One manual step:")} at your current registrar, set ${domain}'s nameservers to:\n` +
        porkbunNs.map((n) => `  ${n}`).join("\n") +
        c.dim("\nYour records are already at Porkbun, so switching now keeps everything working through the transfer."),
    );
  }

  let force = false;
  if (!records.length) {
    warn("No DNS records were copied. Releasing a transfer with an empty zone means the domain won't resolve at Porkbun.");
    await confirmOrAbort(flags.yes, "Release the transfer anyway?");
    force = true;
  }
  const message = await withSpinner("Releasing the transfer", () => porkbun.startTransfer(domain, { force }));
  ok(message ?? "Transfer released to the registry.");
}

export async function cmdTransfer(accounts: Accounts, flags: TransferFlags, domain: string) {
  const porkbun = accounts.porkbun;
  if (!porkbun) throw new UsageError("Transfers move domains into Porkbun. Connect it first: dom login porkbun");

  // A connected non-Porkbun account that holds the domain lets us read DNS exactly and change NS/lock for you.
  const others = accounts.all.filter((r) => r !== porkbun);
  const sourceLookups = await withSpinner("Looking up the domain", () =>
    Promise.all([
      Promise.all(others.map((r) => r.getDomain(domain).then((d) => (d ? r : undefined)).catch(() => undefined))),
      lookupNs(domain),
      lookupRegistrar(domain),
    ]),
  );
  const [owners, ns, registrarName] = sourceLookups;
  const source = owners.find(Boolean);

  if (flags.resume) {
    const { records } = await gatherRecords(domain, porkbun, source);
    return finishHeldTransfer(domain, porkbun, source, flags, records);
  }

  const dnsHome = flags["no-dns-copy"] ? "external" : classifyNameservers(ns);
  const from = source?.label ?? registrarName ?? "your current registrar";
  if (!flags.json) {
    console.log(`${c.bold(domain)}: ${from} → ${c.bold("Porkbun")}`);
    console.log(c.dim(`Nameservers: ${ns.join(", ") || "couldn't look up"}`));
    console.log(
      c.dim(
        dnsHome === "external"
          ? "DNS is hosted elsewhere (not at the registrar), so it keeps working through the move.\n"
          : "DNS is at the registrar, so dom copies your records to Porkbun first. Your site and email keep working.\n",
      ),
    );
  }

  // Step 1: unlock + auth code at the old registrar.
  let authCode = flags["auth-code"];
  if (!authCode) {
    if (source?.setLock) {
      const d = await source.getDomain(domain);
      if (d?.locked) {
        await confirmOrAbort(flags.yes, `${domain} is locked at ${source.label}. Unlock it so it can transfer?`);
        await withSpinner("Unlocking", () => source.setLock!(domain, false));
        ok(`Unlocked at ${source.label}`);
      }
    }
    console.log(c.bold("Get the transfer code:"));
    for (const step of SOURCE_STEPS[sourceKey(registrarName, source)]!) console.log(`  • ${step}`);
    console.log(c.dim("  (Domains registered or transferred in the last 60 days can't move yet. That's an ICANN rule.)\n"));
    if (!isInteractive()) throw new UsageError("Pass the code with --auth-code <code>.");
    authCode = await ask("Auth code: ", { hidden: true });
    if (!authCode) throw new UsageError("An auth code is needed to transfer.");
  }

  // Step 2: price and checks, nothing charged.
  const quote = await withSpinner("Getting a quote", () => porkbun.quoteTransfer(domain, authCode!));
  if (flags.json && flags["dry-run"]) return printJson(quote);
  if (!flags.json) {
    printQuote("Transfer", quote, { sandbox: porkbun.sandbox });
    console.log(c.dim("A transfer includes a 1-year extension: the year you pay for is added to the current expiry."));
  }
  if (!quote.wouldSucceed) explainNotPossible(quote);

  // Step 3: collect records before paying, so you see what will be copied.
  const copyDns = dnsHome !== "external";
  const { records, origin } = copyDns ? await gatherRecords(domain, porkbun, source) : { records: [], origin: "" };
  if (copyDns && !flags.json) {
    console.log(`\n${records.length} DNS record${records.length === 1 ? "" : "s"} to copy, from ${origin}:`);
    if (records.length) showRecords(records);
  }
  if (flags["dry-run"]) return console.log(c.dim("\nDry run: nothing was transferred or charged."));

  await confirmOrAbort(flags.yes, `\nTransfer ${c.bold(domain)} to Porkbun for ${c.bold(`$${(quote.costCents / 100).toFixed(2)}`)}?`);

  // Step 4: pay. With DNS to copy, the transfer is held until the zone is ready.
  const started = await withSpinner("Starting the transfer", () =>
    porkbun.transferIn(domain, authCode!, quote.costCents, { holdForDnsSetup: copyDns }),
  );
  ok(`Transfer ordered${started.orderId ? c.dim(` (order ${started.orderId})`) : ""}`);

  if (copyDns) {
    try {
      await finishHeldTransfer(domain, porkbun, source, flags, records);
    } catch (err) {
      warn(`The transfer is paid for and waiting. Finish it with: dom transfer ${domain} --resume`);
      throw err;
    }
  }

  if (flags.json) return printJson({ domain, ...started });
  console.log(
    c.dim(
      `\nTransfers usually take 5–7 days. ${from} may email you to approve it, and approving makes it faster.\n` +
        "Check progress with: dom transfers",
    ),
  );
}

export async function cmdTransfers(accounts: Accounts, flags: TransferFlags) {
  if (!accounts.porkbun) throw new UsageError("Connect Porkbun first: dom login porkbun");
  const transfers = await withSpinner("Fetching transfers", () => accounts.porkbun!.listTransfers());
  if (flags.json) return printJson(transfers);
  if (!transfers.length) return console.log("No transfers in progress.");
  console.log(table(transfers.map((t) => [c.bold(t.domain), t.status.toLowerCase(), t.date.slice(0, 10), c.dim(t.description)]), ["DOMAIN", "STATUS", "STARTED", ""]));
}

