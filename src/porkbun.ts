import { randomUUID } from "node:crypto";
import {
  RegistrarError,
  type Account,
  type Availability,
  type DnsRecord,
  type DnsRecordInput,
  type Domain,
  type ListFilter,
  type Order,
  type Quote,
  type Registrar,
  type TldPrice,
} from "./registrar.js";

// Porkbun API v3: https://porkbun.com/api/json/v3/documentation
export const PORKBUN_API = "https://api.porkbun.com/api/json/v3";
export const PORKBUN_MOCK_API = "https://api.porkbun.com/api/json/v3/mock";

const BULK_CHECK_MAX = 25;
const LIST_PAGE_SIZE = 1000;

export interface PorkbunOptions {
  apiKey: string;
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Porkbun attaches advisory `warnings` (e.g. "DNS change won't resolve"); they're surfaced here. */
  onWarning?: (warning: string) => void;
}

type Json = Record<string, any>;

export function toCents(price: unknown): number | undefined {
  if (price === undefined || price === null || price === "") return undefined;
  const n = typeof price === "number" ? price : Number.parseFloat(String(price).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

const yes = (v: unknown) => v === true || v === 1 || v === "1" || v === "yes";

export class Porkbun implements Registrar {
  readonly name = "porkbun";
  readonly label = "Porkbun";
  readonly sandbox: boolean;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PorkbunOptions) {
    this.baseUrl = (opts.baseUrl ?? PORKBUN_API).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    // Sandbox keys (pk1_sb_…) run against Porkbun's simulated datastore with fake credit.
    this.sandbox = opts.apiKey.startsWith("pk1_sb_");
  }

  /** `accept` lists non-SUCCESS statuses that are answers rather than errors (e.g. PENDING while polling). */
  private async post(path: string, body: Json = {}, headers: Record<string, string> = {}, accept: string[] = []): Promise<Json> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        // Public endpoints (pricing) work keyless; empty keys are omitted rather than sent as invalid.
        body: JSON.stringify(this.opts.apiKey ? { apikey: this.opts.apiKey, secretapikey: this.opts.secretKey, ...body } : body),
      });
    } catch (err) {
      throw new RegistrarError(`Could not reach Porkbun: ${(err as Error).message}`, "NETWORK_ERROR");
    }

    let data: Json;
    try {
      data = (await res.json()) as Json;
    } catch {
      throw new RegistrarError(`Porkbun returned HTTP ${res.status} with a non-JSON body`, "BAD_RESPONSE", res.status);
    }

    for (const w of (data.warnings as string[] | undefined) ?? []) this.opts.onWarning?.(w);

    if (data.status !== "SUCCESS" && !accept.includes(data.status)) {
      let message = String(data.message ?? `Request failed (HTTP ${res.status})`);
      if (res.status === 429) {
        const wait = res.headers.get("retry-after") ?? data.ttlRemaining;
        if (wait) message += ` — try again in ${wait}s`;
      }
      throw new RegistrarError(message, data.code, res.status);
    }
    return data;
  }

  // ---- getting keys without copy-paste (these work on a keyless client) ----

  /**
   * Start a browser approval. The account holder opens `authUrl`, signs in (or signs up) and approves;
   * `retrieveApiKey` then hands back both keys once to whoever holds the PKCE verifier.
   */
  async requestApiKey(opts: { name: string; codeChallenge: string; scopes?: string[] }) {
    const data = await this.post("/apikey/request", {
      name: opts.name,
      codeChallenge: opts.codeChallenge,
      codeChallengeMethod: "S256",
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
    });
    return { requestToken: String(data.requestToken), authUrl: String(data.authUrl), expires: String(data.expiration ?? "") };
  }

  /** undefined while the account holder hasn't approved yet. */
  async retrieveApiKey(requestToken: string, codeVerifier: string): Promise<{ apiKey: string; secretKey: string } | undefined> {
    const data = await this.post("/apikey/retrieve", { requestToken, codeVerifier }, {}, ["PENDING"]);
    if (data.status === "PENDING") return undefined;
    if (!data.apikey || !data.secretapikey) {
      throw new RegistrarError("Porkbun approved the key but didn't return the secret. Run `dom login porkbun` again.", data.code);
    }
    return { apiKey: String(data.apikey), secretKey: String(data.secretapikey) };
  }

  /** A throwaway sandbox account with fake credit, no signup. */
  async requestSandboxKey(name: string): Promise<{ apiKey: string; secretKey: string }> {
    const data = await this.post("/apikey/request", { name, sandbox: true });
    return { apiKey: String(data.apikey), secretKey: String(data.secretapikey) };
  }

  async verify(): Promise<Account> {
    const data = await this.post("/ping");
    if (!data.credentialsValid) throw new RegistrarError("Porkbun did not accept these API keys", "INVALID_API_KEYS_001");
    return { account: String(data.account ?? "unknown"), scopes: data.scopes ?? [], sandbox: this.sandbox };
  }

  async balance() {
    const data = await this.post("/account/balance");
    const cents = Number(data.balance ?? 0);
    return { cents, display: String(data.display ?? `$${(cents / 100).toFixed(2)}`) };
  }

  async pricing(tlds?: string[]): Promise<TldPrice[]> {
    const data = await this.post("/pricing/get", tlds?.length ? { tlds } : {});
    return Object.entries((data.pricing ?? {}) as Record<string, Json>).map(([tld, p]) => ({
      tld,
      registrationCents: toCents(p.registration) ?? 0,
      renewalCents: toCents(p.renewal) ?? 0,
      transferCents: toCents(p.transfer) ?? 0,
    }));
  }

  async check(domains: string[]): Promise<Availability[]> {
    const unique = [...new Set(domains.map((d) => d.toLowerCase()))];
    const found = new Map<string, Availability>();

    // A single name uses the single-check endpoint, which has its own (separate) rate budget.
    if (unique.length === 1) {
      const domain = unique[0]!;
      const data = await this.post(`/domain/checkDomain/${encodeURIComponent(domain)}`);
      return [parseCheck(domain, data.response ?? {})];
    }

    for (let i = 0; i < unique.length; i += BULK_CHECK_MAX) {
      const chunk = unique.slice(i, i + BULK_CHECK_MAX);
      const data = await this.post("/domain/checkDomain", { domains: chunk });
      for (const [domain, r] of Object.entries((data.domains ?? {}) as Record<string, Json>)) {
        found.set(domain.toLowerCase(), parseCheck(domain, r));
      }
      for (const domain of (data.unresolved ?? []) as string[]) {
        found.set(domain.toLowerCase(), { domain, available: null, premium: false, promo: false, note: "registry didn't answer, retry" });
      }
      for (const entry of (data.invalid ?? []) as Json[]) {
        const domain = String(entry.domain ?? entry.name ?? "");
        if (domain) {
          found.set(domain.toLowerCase(), { domain, available: false, premium: false, promo: false, note: String(entry.reason ?? "invalid") });
        }
      }
    }

    return unique.map(
      (d) => found.get(d) ?? { domain: d, available: null, premium: false, promo: false, note: "no answer" },
    );
  }

  private quote(op: "create" | "renew", domain: string, body: Json): Promise<Json> {
    // cost: 0 + dryRun asks Porkbun to quote rather than match a known price.
    return this.post(`/domain/${op}/${encodeURIComponent(domain)}`, { ...body, cost: 0, dryRun: true });
  }

  async quoteRegistration(domain: string): Promise<Quote> {
    return parseQuote(domain, await this.quote("create", domain, { agreeToTerms: "yes" }));
  }

  async register(domain: string, costCents: number, opts: { whoisPrivacy?: boolean } = {}): Promise<Order> {
    const body: Json = { cost: costCents, agreeToTerms: "yes" };
    if (opts.whoisPrivacy !== undefined) body.whoisPrivacy = opts.whoisPrivacy;
    // One idempotency key per purchase: a retried request can't double-charge.
    const data = await this.post(`/domain/create/${encodeURIComponent(domain)}`, body, { "Idempotency-Key": randomUUID() });
    return { domain: data.domain ?? domain, costCents: Number(data.cost), orderId: data.orderId, balanceCents: data.balance };
  }

  async quoteRenewal(domain: string): Promise<Quote> {
    return parseQuote(domain, await this.quote("renew", domain, {}));
  }

  async renew(domain: string, costCents: number): Promise<Order> {
    const data = await this.post(`/domain/renew/${encodeURIComponent(domain)}`, { cost: costCents }, { "Idempotency-Key": randomUUID() });
    return {
      domain: data.domain ?? domain,
      costCents: Number(data.cost),
      orderId: data.orderId,
      balanceCents: data.balance,
      expires: data.expirationDate,
    };
  }

  async getDomain(domain: string): Promise<Domain | undefined> {
    const data = await this.post("/domain/listAll", { domain });
    const d = ((data.domains ?? []) as Json[]).find((x) => String(x.domain).toLowerCase() === domain.toLowerCase());
    return d && parseDomain(d);
  }

  async listDomains(filter: ListFilter = {}): Promise<Domain[]> {
    const out: Domain[] = [];
    const body: Json = {};
    if (filter.expiringWithinDays !== undefined) body.expiringWithinDays = filter.expiringWithinDays;
    if (filter.contains) body.nameContains = filter.contains;

    for (let start = 0; ; start += LIST_PAGE_SIZE) {
      const data = await this.post("/domain/listAll", { ...body, start });
      const page = (data.domains ?? []) as Json[];
      out.push(...page.map(parseDomain));
      if (page.length < LIST_PAGE_SIZE) return out;
    }
  }

  async setAutoRenew(domain: string, on: boolean): Promise<void> {
    const data = await this.post(`/domain/updateAutoRenew/${encodeURIComponent(domain)}`, { status: on ? "on" : "off" });
    const result = data.results?.[domain] as Json | undefined;
    if (result && result.status && result.status !== "SUCCESS") {
      throw new RegistrarError(String(result.message ?? "Could not update auto-renew"), result.code);
    }
  }

  async getNameservers(domain: string): Promise<string[]> {
    const data = await this.post(`/domain/getNs/${encodeURIComponent(domain)}`);
    return (data.ns ?? []) as string[];
  }

  async setNameservers(domain: string, ns: string[]): Promise<void> {
    await this.post(`/domain/updateNs/${encodeURIComponent(domain)}`, { ns });
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const data = await this.post(`/dns/retrieve/${encodeURIComponent(domain)}`);
    return ((data.records ?? []) as Json[]).map((r) => ({
      id: String(r.id),
      name: relativeName(String(r.name ?? ""), domain),
      type: String(r.type),
      content: String(r.content),
      ttl: Number(r.ttl),
      prio: r.prio === undefined || r.prio === null || r.prio === "" ? undefined : Number(r.prio),
      notes: r.notes || undefined,
    }));
  }

  async createRecord(domain: string, record: DnsRecordInput): Promise<string> {
    const data = await this.post(`/dns/create/${encodeURIComponent(domain)}`, recordBody(record));
    return String(data.id);
  }

  async editRecord(domain: string, id: string, record: DnsRecordInput): Promise<void> {
    await this.post(`/dns/edit/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`, recordBody(record));
  }

  async deleteRecord(domain: string, id: string): Promise<void> {
    await this.post(`/dns/delete/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`);
  }

  // ---- inbound transfers (Porkbun is where `dom transfer` moves domains to) ----

  async quoteTransfer(domain: string, authCode: string): Promise<Quote> {
    const tld = domain.slice(domain.indexOf(".") + 1);
    const [price] = await this.pricing([tld]);
    if (!price) throw new RegistrarError(`Porkbun doesn't support .${tld} transfers`, "INVALID_TLD");
    const data = await this.post(`/domain/transfer/${encodeURIComponent(domain)}`, {
      authCode,
      cost: price.transferCents,
      dryRun: true,
    });
    return parseQuote(domain, data);
  }

  /** `holdForDnsSetup` charges but parks the transfer so the zone can be filled before the domain moves. */
  async transferIn(domain: string, authCode: string, costCents: number, opts: { holdForDnsSetup?: boolean } = {}) {
    const body: Json = { authCode, cost: costCents };
    if (opts.holdForDnsSetup) body.holdForDnsSetup = true;
    const data = await this.post(`/domain/transfer/${encodeURIComponent(domain)}`, body, { "Idempotency-Key": randomUUID() });
    return { orderId: data.orderId, transferId: data.transferId, balanceCents: data.balance, message: data.message as string | undefined };
  }

  /** Creates the zone for a held transfer and returns Porkbun's nameservers. */
  async prepareTransfer(domain: string): Promise<string[]> {
    const data = await this.post(`/domain/prepareTransfer/${encodeURIComponent(domain)}`);
    return (data.porkbunNameservers ?? []) as string[];
  }

  async startTransfer(domain: string, opts: { force?: boolean } = {}): Promise<string | undefined> {
    const data = await this.post(`/domain/startTransfer/${encodeURIComponent(domain)}`, opts.force ? { force: true } : {});
    return data.message;
  }

  async listTransfers(): Promise<{ domain: string; status: string; description: string; date: string }[]> {
    const data = await this.post("/domain/listTransfers");
    return ((data.transfers ?? []) as Json[]).map((t) => ({
      domain: String(t.domain),
      status: String(t.status ?? ""),
      description: String(t.statusDescription ?? ""),
      date: String(t.transferDate ?? ""),
    }));
  }

  /** Best-effort read of what a domain publishes right now, from its live nameservers. */
  async scanDns(domain: string): Promise<DnsRecordInput[]> {
    const data = await this.post(`/dns/scan/${encodeURIComponent(domain)}`);
    return ((data.records ?? []) as Json[]).map((r) => ({
      name: String(r.name ?? ""),
      type: String(r.type),
      content: String(r.content),
      ttl: r.ttl === undefined ? undefined : Number(r.ttl),
      prio: r.prio === undefined || r.prio === null ? undefined : Number(r.prio),
    }));
  }

  async importDns(domain: string, records: DnsRecordInput[]) {
    const data = await this.post(`/dns/import/${encodeURIComponent(domain)}`, { records: records.map(recordBody) });
    return {
      created: Number(data.created ?? 0),
      skipped: Number(data.skipped ?? 0),
      failed: Number(data.failed ?? 0),
      failures: (data.failures ?? []) as Json[],
    };
  }
}

function parseDomain(d: Json): Domain {
  return {
    domain: String(d.domain),
    registrar: "porkbun",
    status: String(d.status ?? ""),
    created: String(d.createDate ?? ""),
    expires: String(d.expireDate ?? ""),
    autoRenew: yes(d.autoRenew),
    whoisPrivacy: yes(d.whoisPrivacy),
    locked: yes(d.securityLock),
    apiAccess: d.apiAccess === undefined ? true : yes(d.apiAccess),
  };
}

function parseCheck(domain: string, r: Json): Availability {
  const available = r.avail === "yes";
  return {
    domain,
    available,
    premium: yes(r.premium),
    priceCents: available ? toCents(r.price) : undefined,
    renewalCents: available ? toCents(r.additional?.renewal?.price) : undefined,
    promo: yes(r.firstYearPromo),
    note: r.inYourAccount ? "already yours" : undefined,
  };
}

function parseQuote(domain: string, data: Json): Quote {
  return {
    domain: data.domain ?? domain,
    costCents: Number(data.cost ?? 0),
    balanceCents: Number(data.balance ?? 0),
    years: Number(data.duration ?? 1),
    sufficientFunds: Boolean(data.sufficientFunds),
    wouldSucceed: Boolean(data.wouldSucceed),
    message: data.message,
  };
}

/** "@" and "www" are accepted on input; Porkbun wants "" for the apex and no domain suffix. */
function recordBody(r: DnsRecordInput): Json {
  const body: Json = {};
  if (r.name !== undefined) body.name = r.name === "@" ? "" : r.name;
  if (r.type !== undefined) body.type = r.type.toUpperCase();
  if (r.content !== undefined) body.content = r.content;
  if (r.ttl !== undefined) body.ttl = r.ttl;
  if (r.prio !== undefined) body.prio = r.prio;
  return body;
}

export function relativeName(fqdn: string, domain: string): string {
  const name = fqdn.toLowerCase().replace(/\.$/, "");
  const zone = domain.toLowerCase();
  if (name === "" || name === zone) return "@";
  return name.endsWith(`.${zone}`) ? name.slice(0, -zone.length - 1) : name;
}
