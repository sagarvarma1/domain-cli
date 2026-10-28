import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { detectPublicIp, findOwner, openAccounts, REGISTRARS, type Accounts } from "./accounts.js";
import { configPath, DEFAULT_TLDS, loadConfig, loadSavedConfig, saveConfig, type Config } from "./config.js";
import { Namecheap } from "./namecheap.js";
import { Cancelled, confirmOrAbort, explainNotPossible, ok, printJson, printQuote, UsageError, warn, withSpinner } from "./output.js";
import { Porkbun } from "./porkbun.js";
import { RegistrarError, type Availability, type Domain, type Registrar, type RegistrarName } from "./registrar.js";
import { cmdTransfer, cmdTransfers } from "./transfer.js";
import { ask, c, isInteractive, money, table } from "./ui.js";

export { UsageError };

const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

const HELP = `${c.bold("dom")}: buy and manage domains from your terminal

${c.bold("Usage")}
  dom <command> [args] [flags]

${c.bold("Accounts")}
  login [porkbun|namecheap]      Connect a registrar account
  logout [porkbun|namecheap]     Forget saved keys (all, if none named)
  accounts                       Show connected accounts
  balance                        Account credit everywhere

${c.bold("Find & buy")} ${c.dim("(via Porkbun)")}
  search <name|domain>...        Check availability and price
                                 (a bare name tries ${DEFAULT_TLDS.slice(0, 4).join(", ")}, …)
  price [tld...]                 Registration / renewal / transfer prices
  buy <domain>                   Register a domain (1 year, asks first)

${c.bold("Manage")} ${c.dim("(any connected registrar, found automatically)")}
  list                           All your domains, across accounts
  renew <domain>                 Renew for a year
  autorenew <domain> on|off      Turn auto-renew on or off
  lock|unlock <domain>           Registrar transfer lock
  ns <domain>                    Show nameservers
  ns <domain> set <ns>...        Replace nameservers ("default" = registrar's own)
  dns <domain>                   List DNS records
  dns <domain> add <type> <name> <content>
  dns <domain> edit <id> [--type T] [--name N] [--content C]
  dns <domain> rm <id>

${c.bold("Move domains")} ${c.dim("(e.g. off Squarespace, which has no API)")}
  transfer <domain>              Move a domain to Porkbun, keeping DNS working
  transfer <domain> --resume     Finish a transfer that stopped partway
  transfers                      Transfers in progress

${c.bold("Settings")}
  config                         Show config
  config set tlds com,dev,io     Set default TLDs for search

${c.bold("Flags")}
  -y, --yes            Skip confirmation prompts
      --dry-run        Show what buy/renew/transfer would cost without paying
      --json           Machine-readable output
  -r, --registrar R    Use this account (porkbun, namecheap) instead of auto-detecting
      --tlds a,b,c     search: TLDs to try
      --expiring N     list: only domains expiring within N days
      --ttl N          dns: record TTL in seconds
      --prio N         dns: priority for MX/SRV
      --no-privacy     buy: register without WHOIS privacy
      --auth-code C    transfer: the EPP code (otherwise asked for, hidden)
      --sandbox        login namecheap: use Namecheap's sandbox
      --mock           Use Porkbun's mock API (no keys, canned data)
  -h, --help           Show this help
  -v, --version        Show version

${c.bold("Examples")}
  dom search coolname
  dom buy coolname.dev
  dom dns coolname.dev add A @ 76.76.21.21
  dom transfer mysite.com
`;

type Flags = {
  json?: boolean;
  yes?: boolean;
  "dry-run"?: boolean;
  mock?: boolean;
  help?: boolean;
  version?: boolean;
  registrar?: string;
  tlds?: string;
  expiring?: string;
  contains?: string;
  ttl?: string;
  prio?: string;
  type?: string;
  name?: string;
  content?: string;
  "no-privacy"?: boolean;
  "auth-code"?: string;
  resume?: boolean;
  "no-dns-copy"?: boolean;
  sandbox?: boolean;
};

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      mock: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      registrar: { type: "string", short: "r" },
      tlds: { type: "string" },
      expiring: { type: "string" },
      contains: { type: "string" },
      ttl: { type: "string" },
      prio: { type: "string" },
      type: { type: "string" },
      name: { type: "string" },
      content: { type: "string" },
      "no-privacy": { type: "boolean" },
      "auth-code": { type: "string" },
      resume: { type: "boolean" },
      "no-dns-copy": { type: "boolean" },
      sandbox: { type: "boolean" },
    },
  });
  return { flags: values as Flags, args: positionals };
}

// ---------- helpers ----------

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
}

function requireDomain(input: string | undefined, usage: string): string {
  if (!input) throw new UsageError(`Missing domain.\nUsage: ${usage}`);
  const domain = normalizeDomain(input);
  if (!DOMAIN_RE.test(domain)) throw new UsageError(`"${input}" doesn't look like a domain (e.g. example.com)`);
  return domain;
}

/** "coolname" → coolname.com, coolname.dev, …; "coolname.dev" stays as is. */
export function expandCandidates(inputs: string[], tlds: string[]): string[] {
  const out: string[] = [];
  for (const raw of inputs) {
    const term = normalizeDomain(raw);
    if (term.includes(".")) {
      if (!DOMAIN_RE.test(term)) throw new UsageError(`"${raw}" doesn't look like a domain`);
      out.push(term);
    } else {
      if (!LABEL_RE.test(term)) throw new UsageError(`"${raw}" can only contain letters, numbers and hyphens`);
      out.push(...tlds.map((t) => `${term}.${t}`));
    }
  }
  return [...new Set(out)];
}

const splitList = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);

function int(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${flag} must be a whole number`);
  return n;
}

function registrarName(input: string | undefined): RegistrarName | undefined {
  if (input === undefined) return undefined;
  const found = REGISTRARS.find((r) => r.name === input.toLowerCase());
  if (!found) throw new UsageError(`Unknown registrar "${input}". Supported: ${REGISTRARS.map((r) => r.name).join(", ")}`);
  return found.name;
}

function requireAny(accounts: Accounts): void {
  if (!accounts.all.length) {
    throw new UsageError(
      "No registrar accounts connected yet. Run `dom login porkbun` or `dom login namecheap`.\n" +
        "(Or set PORKBUN_API_KEY / PORKBUN_SECRET_API_KEY, or NAMECHEAP_USERNAME / NAMECHEAP_API_KEY.)",
    );
  }
}

function requirePorkbun(accounts: Accounts, what: string): Porkbun {
  if (!accounts.porkbun) {
    throw new UsageError(`${what} goes through Porkbun. Connect it with \`dom login porkbun\` (keys: https://porkbun.com/account/api).`);
  }
  return accounts.porkbun;
}

/** The account that holds `domain`: --registrar if given, else whichever connected account has it. */
async function ownerOf(accounts: Accounts, flags: Flags, domain: string): Promise<Registrar> {
  requireAny(accounts);
  const named = registrarName(flags.registrar);
  if (named) {
    const r = accounts.get(named);
    if (!r) throw new UsageError(`${named} isn't connected. Run \`dom login ${named}\`.`);
    return r;
  }
  return withSpinner(`Finding ${domain}`, () => findOwner(accounts, domain));
}

function unsupported(r: Registrar, what: string, where: string): never {
  throw new RegistrarError(`${r.label}'s API doesn't support ${what}. Do it at ${where}.`, "UNSUPPORTED");
}

const SITES: Record<RegistrarName, string> = { porkbun: "porkbun.com", namecheap: "namecheap.com" };

// ---------- accounts ----------

async function cmdLogin(flags: Flags, args: string[]) {
  if (!isInteractive()) {
    throw new UsageError(
      "`dom login` needs a terminal. In scripts, set PORKBUN_API_KEY + PORKBUN_SECRET_API_KEY or NAMECHEAP_USERNAME + NAMECHEAP_API_KEY.",
    );
  }
  let which = registrarName(args[0]);
  if (!which) {
    const answer = await ask(`Which registrar? ${c.dim("(porkbun / namecheap)")} `);
    which = registrarName(answer || "porkbun")!;
  }
  const saved = await loadSavedConfig();
  if (which === "porkbun") return loginPorkbun(saved);
  return loginNamecheap(saved, flags);
}

async function loginPorkbun(saved: Config) {
  console.log(`Create an API key at ${c.cyan("https://porkbun.com/account/api")}`);
  console.log(c.dim("Tip: a sandbox key (pk1_sb_…) lets you try everything with fake money.\n"));
  const apiKey = await ask("API key (pk1_…): ");
  const secretKey = await ask("Secret key (sk1_…): ", { hidden: true });
  if (!apiKey || !secretKey) throw new UsageError("Both keys are required.");

  const account = await withSpinner("Checking keys", () => new Porkbun({ apiKey, secretKey, onWarning: warn }).verify());
  const path = await saveConfig({ ...saved, accounts: { ...saved.accounts, porkbun: { apiKey, secretKey } } });
  ok(`Connected Porkbun as ${c.bold(account.account)}${account.sandbox ? c.yellow(" (sandbox)") : ""}`);
  console.log(c.dim(`Keys saved to ${path} (readable only by you)`));
  if (!account.scopes.includes("full") && !account.scopes.includes("purchase")) {
    warn("This key can't make purchases. Give it the `purchase` permission to use buy, renew and transfer.");
  }
}

async function loginNamecheap(saved: Config, flags: Flags) {
  const sandbox = Boolean(flags.sandbox);
  const site = sandbox ? "sandbox.namecheap.com" : "namecheap.com";
  console.log(`1. Turn on API access at ${c.cyan(`https://ap.www.${site}/settings/tools/apiaccess/`)}`);
  console.log(c.dim("   (Profile → Tools → Namecheap API Access. Namecheap only allows this on accounts that meet a\n    minimum, e.g. a few domains or some account balance; their page says if yours qualifies.)"));
  const ip = await withSpinner("Detecting your public IP", () => detectPublicIp());
  console.log(`2. On that page, add this IP to the whitelist: ${c.bold(ip)}`);
  console.log(c.dim("   Namecheap only answers whitelisted IPs. If your IP changes, add the new one there too.\n"));

  const username = await ask("Namecheap username: ");
  const apiKey = await ask("API key: ", { hidden: true });
  if (!username || !apiKey) throw new UsageError("Username and API key are both required.");

  await withSpinner("Checking keys", () => new Namecheap({ username, apiKey, clientIp: ip, sandbox, onWarning: warn }).verify());
  const path = await saveConfig({ ...saved, accounts: { ...saved.accounts, namecheap: { username, apiKey, ...(sandbox ? { sandbox } : {}) } } });
  ok(`Connected Namecheap as ${c.bold(username)}${sandbox ? c.yellow(" (sandbox)") : ""}`);
  console.log(c.dim(`Keys saved to ${path} (readable only by you)`));
}

async function cmdLogout(args: string[]) {
  const which = registrarName(args[0]);
  const saved = await loadSavedConfig();
  if (which) {
    delete saved.accounts[which];
    await saveConfig(saved);
    return ok(`Removed saved ${which} keys.`);
  }
  await saveConfig({ ...saved, accounts: {} });
  ok("Removed all saved keys.");
}

async function cmdAccounts(accounts: Accounts, flags: Flags) {
  requireAny(accounts);
  const results = await withSpinner("Checking accounts", () => Promise.allSettled(accounts.all.map((r) => r.verify())));
  const rows = accounts.all.map((r, i) => {
    const res = results[i]!;
    return res.status === "fulfilled"
      ? { registrar: r.name, account: res.value.account, ok: true, sandbox: res.value.sandbox, permissions: res.value.scopes }
      : { registrar: r.name, ok: false, error: (res.reason as Error).message };
  });
  if (flags.json) return printJson(rows);
  console.log(
    table(
      rows.map((r) => [
        c.bold(r.registrar),
        r.ok ? (r as { account: string }).account : "",
        r.ok ? c.green("connected") + ((r as { sandbox: boolean }).sandbox ? c.yellow(" sandbox") : "") : c.red((r as { error: string }).error),
      ]),
      ["REGISTRAR", "ACCOUNT", "STATUS"],
    ),
  );
  const missing = REGISTRARS.filter((r) => !accounts.get(r.name));
  if (missing.length) console.log(c.dim(`\nAlso available: ${missing.map((r) => `dom login ${r.name}`).join(", ")}`));
}

async function cmdBalance(accounts: Accounts, flags: Flags) {
  requireAny(accounts);
  const results = await withSpinner("Fetching balances", () => Promise.allSettled(accounts.all.map((r) => r.balance())));
  const rows = accounts.all.map((r, i) => {
    const res = results[i]!;
    return { registrar: r.name, ...(res.status === "fulfilled" ? { cents: res.value.cents } : { error: (res.reason as Error).message }) };
  });
  if (flags.json) return printJson(rows);
  console.log(table(rows.map((r) => [c.bold(r.registrar), "cents" in r ? money(r.cents) : c.red(r.error!)]), ["REGISTRAR", "CREDIT"]));
}

// ---------- find & buy ----------

function statusCell(a: Availability): string {
  if (a.available === null) return c.yellow("unknown");
  if (!a.available) return c.dim(a.note === "already yours" ? "yours" : "taken");
  if (a.premium) return c.yellow("premium");
  return c.green("available");
}

async function cmdSearch(accounts: Accounts, config: Config, flags: Flags, args: string[]) {
  if (!args.length) throw new UsageError("Usage: dom search <name|domain>...");
  requireAny(accounts);
  // Porkbun's check includes prices; Namecheap's only says yes/no.
  const r = accounts.porkbun ?? accounts.all[0]!;
  const tlds = flags.tlds ? splitList(flags.tlds) : config.tlds?.length ? config.tlds : DEFAULT_TLDS;
  const candidates = expandCandidates(args, tlds);
  const results = await withSpinner(`Checking ${candidates.length} domain${candidates.length === 1 ? "" : "s"}`, () => r.check(candidates));
  if (flags.json) return printJson(results);

  const rows = results.map((a) => [
    a.available ? c.bold(a.domain) : a.domain,
    statusCell(a),
    a.available ? money(a.priceCents) + (a.promo ? c.cyan(" promo") : "") : "",
    a.available && a.renewalCents !== undefined ? c.dim(`renews ${money(a.renewalCents)}`) : c.dim(a.note ?? ""),
  ]);
  console.log(table(rows, ["DOMAIN", "STATUS", "1ST YEAR", ""]));

  const buyable = results.filter((a) => a.available && !a.premium);
  if (buyable.length) console.log(c.dim(`\nBuy one with: dom buy ${buyable[0]!.domain}`));
  if (results.some((a) => a.premium && a.available)) {
    console.log(c.dim("Premium names can't be bought through the API. Use the registrar's website for those."));
  }
}

async function cmdPrice(config: Config, flags: Flags, args: string[]) {
  // Porkbun's price list is public, so this works before any login.
  const pb = config.accounts.porkbun;
  const r = flags.mock ? openAccounts(config, { mock: true }).porkbun! : new Porkbun({ apiKey: pb?.apiKey ?? "", secretKey: pb?.secretKey ?? "" });
  const tlds = args.flatMap(splitList);
  const prices = await withSpinner("Fetching prices", () => r.pricing(tlds.length ? tlds : undefined));
  prices.sort((a, b) => a.tld.localeCompare(b.tld));
  if (flags.json) return printJson(prices);
  console.log(
    table(
      prices.map((p) => [`.${p.tld}`, money(p.registrationCents), money(p.renewalCents), money(p.transferCents)]),
      ["TLD", "REGISTER", "RENEW", "TRANSFER"],
    ),
  );
}

async function cmdBuy(accounts: Accounts, flags: Flags, args: string[]) {
  const domain = requireDomain(args[0], "dom buy <domain>");
  const r = requirePorkbun(accounts, "Buying");

  const [check] = await withSpinner(`Checking ${domain}`, () => r.check([domain]));
  if (!check || check.available === null) throw new RegistrarError(`The registry didn't answer for ${domain}. Try again.`);
  if (!check.available) {
    throw new RegistrarError(check.note === "already yours" ? `${domain} is already in your account.` : `${domain} is taken.`);
  }
  if (check.premium) throw new RegistrarError(`${domain} is a premium name and can't be bought via the API. Use porkbun.com.`);

  const quote = await withSpinner("Getting a quote", () => r.quoteRegistration(domain));
  if (flags.json && flags["dry-run"]) return printJson({ ...quote, renewalCents: check.renewalCents });
  if (!flags.json) printQuote("Register", quote, { renewalCents: check.renewalCents, sandbox: r.sandbox });

  if (!quote.wouldSucceed) explainNotPossible(quote);
  if (flags["dry-run"]) return console.log(c.dim("\nDry run: nothing was bought."));

  if (!flags.json) {
    console.log(
      c.dim(
        "\nBuying means you agree to Porkbun's registration agreement and terms (https://porkbun.com/legal).\n" +
          "Domains auto-renew by default; turn that off with `dom autorenew <domain> off`.",
      ),
    );
  }
  await confirmOrAbort(flags.yes, `Buy ${c.bold(domain)} for ${c.bold(money(quote.costCents))}?`);

  const order = await withSpinner(`Registering ${domain}`, () =>
    r.register(domain, quote.costCents, flags["no-privacy"] ? { whoisPrivacy: false } : {}),
  );
  if (flags.json) return printJson(order);
  ok(`${c.bold(order.domain)} is yours! Charged ${money(order.costCents)}${order.orderId ? c.dim(` (order ${order.orderId})`) : ""}`);
  if (order.balanceCents !== undefined) console.log(c.dim(`Remaining credit: ${money(order.balanceCents)}`));
  console.log(c.dim(`Next: dom dns ${order.domain} add A @ <your-server-ip>`));
}

// ---------- manage ----------

async function cmdRenew(accounts: Accounts, flags: Flags, args: string[]) {
  const domain = requireDomain(args[0], "dom renew <domain>");
  const r = await ownerOf(accounts, flags, domain);
  const quote = await withSpinner("Getting a quote", () => r.quoteRenewal(domain));
  if (flags.json && flags["dry-run"]) return printJson({ registrar: r.name, ...quote });
  if (!flags.json) printQuote("Renew", quote, { sandbox: r.sandbox, registrar: r.label });

  if (!quote.wouldSucceed) explainNotPossible(quote, r.name === "namecheap" ? "namecheap.com → Profile → Billing" : undefined);
  if (flags["dry-run"]) return console.log(c.dim("\nDry run: nothing was renewed."));

  await confirmOrAbort(flags.yes, `Renew ${c.bold(domain)} at ${r.label} for ${c.bold(money(quote.costCents))}?`);
  const order = await withSpinner(`Renewing ${domain}`, () => r.renew(domain, quote.costCents));
  if (flags.json) return printJson(order);
  ok(`Renewed ${c.bold(order.domain)} for ${money(order.costCents)}${order.expires ? `, now expires ${order.expires}` : ""}`);
}

function daysUntil(date: string): number | undefined {
  const t = Date.parse(date.replace(" ", "T") + (date.length > 10 && !date.includes("Z") ? "Z" : ""));
  return Number.isNaN(t) ? undefined : Math.ceil((t - Date.now()) / 86_400_000);
}

async function cmdList(accounts: Accounts, flags: Flags) {
  requireAny(accounts);
  const filter = { expiringWithinDays: int(flags.expiring, "expiring"), contains: flags.contains };
  const results = await withSpinner("Fetching domains", () => Promise.allSettled(accounts.all.map((r) => r.listDomains(filter))));
  const domains: Domain[] = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled") domains.push(...res.value);
    else warn(`${accounts.all[i]!.label}: ${(res.reason as Error).message}`);
  });
  domains.sort((a, b) => a.expires.localeCompare(b.expires));
  if (flags.json) return printJson(domains);
  if (!domains.length) return console.log("No domains found. Find one with `dom search <name>`.");

  const rows = domains.map((d) => {
    const days = daysUntil(d.expires);
    const expires = d.expires.slice(0, 10);
    const notes = [
      d.status && d.status !== "ACTIVE" ? c.yellow(d.status.toLowerCase()) : "",
      d.apiAccess ? "" : c.yellow("API access off"),
      d.usesRegistrarDns === false ? c.dim("DNS hosted elsewhere") : "",
    ].filter(Boolean);
    return [
      c.bold(d.domain),
      d.registrar,
      days !== undefined && days <= 30 ? c.yellow(`${expires} (${days}d)`) : expires,
      d.autoRenew ? "on" : c.yellow("off"),
      d.whoisPrivacy ? "on" : c.dim("off"),
      notes.join(", "),
    ];
  });
  console.log(table(rows, ["DOMAIN", "REGISTRAR", "EXPIRES", "AUTORENEW", "PRIVACY", ""]));
  if (domains.some((d) => !d.apiAccess)) {
    console.log(c.dim("\nDomains with API access off can only be managed on porkbun.com until you turn it on there."));
  }
  console.log(c.dim("\nDomains at Squarespace or elsewhere? Move them here with `dom transfer <domain>`."));
}

async function cmdAutorenew(accounts: Accounts, flags: Flags, args: string[]) {
  const domain = requireDomain(args[0], "dom autorenew <domain> on|off");
  const state = args[1]?.toLowerCase();
  if (state !== "on" && state !== "off") throw new UsageError("Usage: dom autorenew <domain> on|off");
  const r = await ownerOf(accounts, flags, domain);
  if (!r.setAutoRenew) unsupported(r, "changing auto-renew", `${SITES[r.name]} → Domain List`);
  await withSpinner("Updating", () => r.setAutoRenew!(domain, state === "on"));
  if (flags.json) return printJson({ domain, autoRenew: state === "on" });
  ok(`Auto-renew ${state} for ${c.bold(domain)}`);
}

async function cmdLock(accounts: Accounts, flags: Flags, args: string[], locked: boolean) {
  const verb = locked ? "lock" : "unlock";
  const domain = requireDomain(args[0], `dom ${verb} <domain>`);
  const r = await ownerOf(accounts, flags, domain);
  if (!r.setLock) unsupported(r, "changing the transfer lock", SITES[r.name]);
  await withSpinner(`${locked ? "Locking" : "Unlocking"} ${domain}`, () => r.setLock!(domain, locked));
  if (flags.json) return printJson({ domain, locked });
  ok(`${c.bold(domain)} is ${locked ? "locked" : "unlocked"} at ${r.label}`);
}

async function cmdNs(accounts: Accounts, flags: Flags, args: string[]) {
  const domain = requireDomain(args[0], "dom ns <domain> [set <ns>...]");
  const r = await ownerOf(accounts, flags, domain);
  if (args[1] === "set") {
    const ns = args.slice(2).map(normalizeDomain);
    const toDefault = ns.length === 1 && ns[0] === "default";
    if (toDefault && r.name !== "namecheap") throw new UsageError(`"default" nameservers are only supported for Namecheap domains.`);
    if (!toDefault) {
      if (ns.length < 2) throw new UsageError("Give at least two nameservers: dom ns <domain> set ns1.host.com ns2.host.com");
      const bad = ns.find((n) => !DOMAIN_RE.test(n));
      if (bad) throw new UsageError(`"${bad}" isn't a valid nameserver hostname`);
    }
    if (!flags.json) {
      const current = await withSpinner("Fetching nameservers", () => r.getNameservers(domain));
      console.log(`${c.dim("Current:")} ${current.join(", ") || "none"}\n${c.dim("New:    ")} ${toDefault ? `${r.label}'s own DNS` : ns.join(", ")}`);
      console.log(c.dim("Changing nameservers changes who answers DNS for this domain. Records at the old host stop applying."));
    }
    await confirmOrAbort(flags.yes, `Update nameservers for ${c.bold(domain)}?`);
    await withSpinner("Updating nameservers", () => r.setNameservers(domain, ns));
    if (flags.json) return printJson({ domain, ns });
    return ok(`Nameservers updated for ${c.bold(domain)}. Changes can take up to 48h to spread.`);
  }
  if (args[1]) throw new UsageError(`Unknown ns action "${args[1]}". Use: dom ns <domain> set <ns>...`);

  const ns = await withSpinner("Fetching nameservers", () => r.getNameservers(domain));
  if (flags.json) return printJson({ domain, registrar: r.name, ns });
  for (const n of ns) console.log(n);
}

async function cmdDns(accounts: Accounts, flags: Flags, args: string[]) {
  const domain = requireDomain(args[0], "dom dns <domain> [add|edit|rm] ...");
  const [action = "list", ...rest] = args.slice(1);
  const ttl = int(flags.ttl, "ttl");
  const prio = int(flags.prio, "prio");

  // Validate arguments before any network call.
  if (!["list", "ls", "add", "create", "edit", "update", "rm", "delete"].includes(action)) {
    throw new UsageError(`Unknown dns action "${action}". Use list, add, edit or rm.`);
  }
  if ((action === "add" || action === "create") && (rest.length < 3 || !rest[0])) {
    throw new UsageError("Usage: dom dns <domain> add <type> <name> <content> [--ttl N] [--prio N]\n  e.g. dom dns example.com add A @ 1.2.3.4");
  }
  if (["edit", "update", "rm", "delete"].includes(action) && !rest[0]) {
    throw new UsageError(`Usage: dom dns <domain> ${action} <id>   (find ids with \`dom dns ${domain}\`)`);
  }

  const r = await ownerOf(accounts, flags, domain);

  switch (action) {
    case "list":
    case "ls": {
      const records = await withSpinner("Fetching DNS records", () => r.listRecords(domain));
      if (flags.json) return printJson(records);
      if (!records.length) return console.log(`No DNS records for ${domain}.`);
      console.log(
        table(
          records.map((rec) => [c.dim(rec.id), rec.type, rec.name, rec.content, String(rec.ttl), rec.prio ? String(rec.prio) : ""]),
          ["ID", "TYPE", "NAME", "CONTENT", "TTL", "PRIO"],
        ),
      );
      return;
    }
    case "add":
    case "create": {
      const [type, name, ...content] = rest as [string, string, ...string[]];
      const record = { type, name, content: content.join(" "), ttl, prio };
      const id = await withSpinner("Creating record", () => r.createRecord(domain, record));
      if (flags.json) return printJson({ id, ...record });
      return ok(`Added ${type.toUpperCase()} ${name} → ${record.content}${id ? c.dim(` (id ${id})`) : ""}`);
    }
    case "edit":
    case "update": {
      const id = rest[0]!;
      const record = { type: flags.type, name: flags.name, content: flags.content, ttl, prio };
      if (Object.values(record).every((v) => v === undefined)) {
        throw new UsageError("Nothing to change. Pass at least one of --type, --name, --content, --ttl, --prio.");
      }
      await withSpinner("Updating record", () => r.editRecord(domain, id, record));
      if (flags.json) return printJson({ id, ...record });
      return ok(`Updated record ${id}`);
    }
    default: {
      const id = rest[0]!;
      if (!flags.json && !flags.yes) {
        const rec = (await withSpinner("Fetching record", () => r.listRecords(domain))).find((x) => x.id === id);
        if (!rec) throw new UsageError(`No record with id ${id} on ${domain}.`);
        console.log(`${rec.type} ${rec.name} → ${rec.content}`);
      }
      await confirmOrAbort(flags.yes, `Delete this record from ${c.bold(domain)}?`);
      await withSpinner("Deleting record", () => r.deleteRecord(domain, id));
      if (flags.json) return printJson({ id, deleted: true });
      return ok(`Deleted record ${id}`);
    }
  }
}

async function cmdConfig(flags: Flags, args: string[]) {
  const [action, key, value] = args;
  const saved = await loadSavedConfig();
  if (!action || action === "get") {
    const shown = {
      accounts: Object.keys(saved.accounts).join(", ") || "none",
      tlds: (saved.tlds ?? DEFAULT_TLDS).join(", "),
      path: configPath(),
    };
    return flags.json ? printJson(shown) : console.log(table(Object.entries(shown).map(([k, v]) => [c.dim(k), String(v)])));
  }
  if (action === "set" && key === "tlds" && value) {
    const tlds = splitList(value);
    await saveConfig({ ...saved, tlds });
    return ok(`Search TLDs: ${tlds.join(", ")}`);
  }
  if (action === "reset" && key === "tlds") {
    await saveConfig({ accounts: saved.accounts });
    return ok(`Search TLDs reset to ${DEFAULT_TLDS.join(", ")}`);
  }
  throw new UsageError("Usage: dom config [get] | dom config set tlds com,dev,io | dom config reset tlds");
}

// ---------- main ----------

export async function main(argv: string[], opts: { fetch?: typeof fetch } = {}): Promise<void> {
  const { flags, args } = parse(argv);
  if (flags.version) return console.log(VERSION);
  const [command, ...rest] = args;
  if (!command || flags.help || command === "help") return console.log(HELP);

  const config = await loadConfig();
  const accounts = () => openAccounts(config, { mock: flags.mock || process.env.DOM_MOCK === "1", onWarning: warn, fetch: opts.fetch });

  switch (command) {
    case "login":
      return cmdLogin(flags, rest);
    case "logout":
      return cmdLogout(rest);
    case "accounts":
    case "whoami":
      return cmdAccounts(accounts(), flags);
    case "balance":
      return cmdBalance(accounts(), flags);
    case "search":
    case "check":
      return cmdSearch(accounts(), config, flags, rest);
    case "price":
    case "prices":
    case "pricing":
      return cmdPrice(config, flags, rest);
    case "buy":
    case "register":
      return cmdBuy(accounts(), flags, rest);
    case "renew":
      return cmdRenew(accounts(), flags, rest);
    case "list":
    case "ls":
      return cmdList(accounts(), flags);
    case "autorenew":
      return cmdAutorenew(accounts(), flags, rest);
    case "lock":
    case "unlock":
      return cmdLock(accounts(), flags, rest, command === "lock");
    case "ns":
      return cmdNs(accounts(), flags, rest);
    case "dns":
      return cmdDns(accounts(), flags, rest);
    case "transfer":
      return cmdTransfer(accounts(), flags, requireDomain(rest[0], "dom transfer <domain> [--auth-code CODE]"));
    case "transfers":
      return cmdTransfers(accounts(), flags);
    case "config":
      return cmdConfig(flags, rest);
    default:
      throw new UsageError(`Unknown command "${command}". Run \`dom --help\`.`);
  }
}

export function reportError(err: unknown): void {
  if (err instanceof Cancelled) {
    console.log(err.message);
  } else if (err instanceof UsageError || err instanceof RegistrarError) {
    console.error(`${c.red("✗")} ${err.message}${err instanceof RegistrarError && err.code ? c.dim(` [${err.code}]`) : ""}`);
  } else if (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`${c.red("✗")} ${err.message}\nRun \`dom --help\`.`);
  } else {
    console.error(err);
  }
}
