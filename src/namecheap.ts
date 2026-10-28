import { attr, find, findAll, parseXml, type XmlNode } from "./xml.js";
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
} from "./registrar.js";

// Namecheap XML API: https://www.namecheap.com/support/api/intro/
// Reference implementation: https://github.com/namecheap/go-namecheap-sdk
export const NAMECHEAP_API = "https://api.namecheap.com/xml.response";
export const NAMECHEAP_SANDBOX_API = "https://api.sandbox.namecheap.com/xml.response";

const LIST_PAGE_SIZE = 100;
const CHECK_CHUNK = 50;
/** What Namecheap reports for a record left on "Automatic" TTL. */
const DEFAULT_TTL = 1799;

export interface NamecheapOptions {
  username: string;
  apiKey: string;
  /** Your public IPv4 address — Namecheap only answers whitelisted IPs. A function is called once, on first use. */
  clientIp: string | (() => Promise<string>);
  sandbox?: boolean;
  baseUrl?: string;
  fetch?: typeof fetch;
  onWarning?: (warning: string) => void;
}

/** Namecheap error numbers worth explaining, beyond their own message. */
const HINTS: Record<string, string> = {
  "1011150": "Whitelist this IP at namecheap.com → Profile → Tools → API Access, then retry.",
  "1011102": "Check your API key, and that API access is enabled at namecheap.com → Profile → Tools → API Access.",
  "1010102": "Check your API key, and that API access is enabled at namecheap.com → Profile → Tools → API Access.",
  "2019166": "That domain isn't in this Namecheap account.",
  "2016166": "That domain isn't in this Namecheap account.",
  "2030288": "This domain doesn't use Namecheap's DNS, so its records live with whoever runs its nameservers.",
};

const truthy = (v: string | undefined) => v?.toLowerCase() === "true";

/** "02/15/2027" → "2027-02-15" */
export function usDateToIso(date: string | undefined): string {
  const m = date?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : (date ?? "");
}

/** Namecheap addresses domains as SLD + TLD; for a registered name, that's the first label and the rest. */
export function splitDomain(domain: string): { SLD: string; TLD: string } {
  const i = domain.indexOf(".");
  if (i < 1) throw new RegistrarError(`"${domain}" isn't a full domain name`);
  return { SLD: domain.slice(0, i), TLD: domain.slice(i + 1) };
}

interface Host {
  id: string;
  name: string;
  type: string;
  address: string;
  mxPref?: number;
  ttl: number;
}

interface Zone {
  emailType: string;
  usingOurDns: boolean;
  hosts: Host[];
}

export class Namecheap implements Registrar {
  readonly name = "namecheap";
  readonly label = "Namecheap";
  readonly sandbox: boolean;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private clientIp?: Promise<string>;

  constructor(private readonly opts: NamecheapOptions) {
    this.sandbox = Boolean(opts.sandbox);
    this.baseUrl = opts.baseUrl ?? (opts.sandbox ? NAMECHEAP_SANDBOX_API : NAMECHEAP_API);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call(command: string, params: Record<string, string> = {}): Promise<XmlNode> {
    const ip = this.opts.clientIp;
    this.clientIp ??= typeof ip === "string" ? Promise.resolve(ip) : ip();
    const body = new URLSearchParams({
      ApiUser: this.opts.username,
      ApiKey: this.opts.apiKey,
      UserName: this.opts.username,
      ClientIp: await this.clientIp,
      Command: command,
      ...params,
    });
    let res: Response;
    try {
      // POST, not GET: setHosts can carry hundreds of fields, and keys stay out of URLs.
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      throw new RegistrarError(`Could not reach Namecheap: ${(err as Error).message}`, "NETWORK_ERROR");
    }

    const text = await res.text();
    const doc = parseXml(text);
    const api = find(doc, "ApiResponse");
    if (!api) throw new RegistrarError(`Namecheap returned HTTP ${res.status} without an API response`, "BAD_RESPONSE", res.status);

    for (const w of findAll(find(api, "Warnings") ?? api, "Warning")) if (w.text) this.opts.onWarning?.(w.text);

    const errors = findAll(find(api, "Errors") ?? { name: "", attrs: {}, children: [], text: "" }, "Error");
    if (attr(api, "Status")?.toUpperCase() !== "OK" || errors.length) {
      const first = errors[0];
      const code = attr(first, "Number");
      const hint = code ? HINTS[code] : undefined;
      const message = (first?.text || "Namecheap returned an error") + (hint ? `\n  ${hint}` : "");
      throw new RegistrarError(message, code ? `NAMECHEAP_${code}` : "NAMECHEAP_ERROR", res.status);
    }
    return find(api, "CommandResponse") ?? api;
  }

  async verify(): Promise<Account> {
    await this.call("namecheap.users.getBalances");
    return { account: this.opts.username, scopes: ["full"], sandbox: this.sandbox };
  }

  async balance() {
    const r = find(await this.call("namecheap.users.getBalances"), "UserGetBalancesResult");
    const cents = Math.round(Number.parseFloat(attr(r, "AvailableBalance") ?? "0") * 100);
    return { cents, display: `$${(cents / 100).toFixed(2)}` };
  }

  async check(domains: string[]): Promise<Availability[]> {
    const unique = [...new Set(domains.map((d) => d.toLowerCase()))];
    const found = new Map<string, Availability>();
    for (let i = 0; i < unique.length; i += CHECK_CHUNK) {
      const res = await this.call("namecheap.domains.check", { DomainList: unique.slice(i, i + CHECK_CHUNK).join(",") });
      for (const r of findAll(res, "DomainCheckResult")) {
        const domain = (attr(r, "Domain") ?? "").toLowerCase();
        const premium = truthy(attr(r, "IsPremiumName"));
        const premiumPrice = Number.parseFloat(attr(r, "PremiumRegistrationPrice") ?? "");
        found.set(domain, {
          domain,
          available: truthy(attr(r, "Available")),
          premium,
          // Namecheap's check only prices premium names; regular prices come from getPricing.
          priceCents: premium && premiumPrice > 0 ? Math.round(premiumPrice * 100) : undefined,
          promo: false,
        });
      }
    }
    return unique.map((d) => found.get(d) ?? { domain: d, available: null, premium: false, promo: false, note: "no answer" });
  }

  private async tldPrice(tld: string, action: "REGISTER" | "RENEW" | "TRANSFER"): Promise<number | undefined> {
    const res = await this.call("namecheap.users.getPricing", { ProductType: "DOMAIN", ActionName: action, ProductName: tld });
    const product = findAll(res, "Product").find((p) => attr(p, "Name")?.toLowerCase() === tld.toLowerCase());
    const price = findAll(product ?? res, "Price").find((p) => attr(p, "Duration") === "1");
    const value = Number.parseFloat(attr(price, "YourPrice") || attr(price, "Price") || "");
    if (!Number.isFinite(value)) return undefined;
    // ICANN's per-year fee is billed on top for gTLDs and shows up here as AdditionalCost.
    const extra = Number.parseFloat(attr(price, "YourAdditonalCost") || attr(price, "AdditionalCost") || "0") || 0;
    return Math.round((value + extra) * 100);
  }

  async quoteRenewal(domain: string): Promise<Quote> {
    const d = await this.getDomain(domain);
    if (!d) throw new RegistrarError(`${domain} isn't in your Namecheap account`, "NAMECHEAP_2019166");
    const [cost, balance] = await Promise.all([this.tldPrice(splitDomain(domain).TLD, "RENEW"), this.balance()]);
    if (cost === undefined) throw new RegistrarError(`Namecheap didn't return a renewal price for ${domain}`);
    const sufficientFunds = balance.cents >= cost;
    return {
      domain,
      costCents: cost,
      balanceCents: balance.cents,
      years: 1,
      sufficientFunds,
      wouldSucceed: sufficientFunds,
      estimate: true,
    };
  }

  async renew(domain: string, _costCents: number): Promise<Order> {
    const res = await this.call("namecheap.domains.renew", { DomainName: domain, Years: "1" });
    const r = find(res, "DomainRenewResult");
    return {
      domain: attr(r, "DomainName") ?? domain,
      costCents: Math.round(Number.parseFloat(attr(r, "ChargedAmount") ?? "0") * 100),
      orderId: attr(r, "OrderID"),
      expires: usDateToIso(find(r ?? res, "ExpiredDate")?.text),
    };
  }

  private parseDomain(d: XmlNode): Domain {
    return {
      domain: (attr(d, "Name") ?? "").toLowerCase(),
      registrar: "namecheap",
      status: truthy(attr(d, "IsExpired")) ? "EXPIRED" : "ACTIVE",
      created: usDateToIso(attr(d, "Created")),
      expires: usDateToIso(attr(d, "Expires")),
      autoRenew: truthy(attr(d, "AutoRenew")),
      whoisPrivacy: attr(d, "WhoisGuard")?.toUpperCase() === "ENABLED",
      locked: truthy(attr(d, "IsLocked")),
      apiAccess: true,
      usesRegistrarDns: attr(d, "IsOurDNS") === undefined ? undefined : truthy(attr(d, "IsOurDNS")),
    };
  }

  async getDomain(domain: string): Promise<Domain | undefined> {
    const res = await this.call("namecheap.domains.getList", { SearchTerm: domain, PageSize: "100" });
    return findAll(res, "Domain")
      .map((d) => this.parseDomain(d))
      .find((d) => d.domain === domain.toLowerCase());
  }

  async listDomains(filter: ListFilter = {}): Promise<Domain[]> {
    const out: Domain[] = [];
    for (let page = 1; ; page++) {
      const params: Record<string, string> = { Page: String(page), PageSize: String(LIST_PAGE_SIZE), SortBy: "EXPIREDATE" };
      if (filter.contains) params.SearchTerm = filter.contains;
      const res = await this.call("namecheap.domains.getList", params);
      const domains = findAll(find(res, "DomainGetListResult") ?? res, "Domain").map((d) => this.parseDomain(d));
      out.push(...domains);
      const total = Number(find(res, "TotalItems")?.text ?? out.length);
      if (!domains.length || out.length >= total) break;
    }
    if (filter.expiringWithinDays === undefined) return out;
    const cutoff = Date.now() + filter.expiringWithinDays * 86_400_000;
    return out.filter((d) => Date.parse(d.expires) <= cutoff);
  }

  async setLock(domain: string, locked: boolean): Promise<void> {
    await this.call("namecheap.domains.setRegistrarLock", { DomainName: domain, LockAction: locked ? "LOCK" : "UNLOCK" });
  }

  async getNameservers(domain: string): Promise<string[]> {
    const res = await this.call("namecheap.domains.dns.getList", splitDomain(domain));
    return findAll(res, "Nameserver").map((n) => n.text.toLowerCase());
  }

  /** `["default"]` switches back to Namecheap's own DNS (BasicDNS). */
  async setNameservers(domain: string, ns: string[]): Promise<void> {
    if (ns.length === 1 && ns[0] === "default") {
      await this.call("namecheap.domains.dns.setDefault", splitDomain(domain));
      return;
    }
    await this.call("namecheap.domains.dns.setCustom", { ...splitDomain(domain), Nameservers: ns.join(",") });
  }

  // ---- DNS ----
  // Namecheap has no per-record create/edit/delete: setHosts replaces the whole zone.
  // So every change is read → modify → write the complete list back, with the email
  // mode preserved, and we refuse to write if the read didn't look like a real zone.

  private async readZone(domain: string): Promise<Zone> {
    const res = await this.call("namecheap.domains.dns.getHosts", splitDomain(domain));
    const r = find(res, "DomainDNSGetHostsResult");
    if (!r) throw new RegistrarError(`Namecheap returned no DNS data for ${domain}; not changing anything.`, "BAD_RESPONSE");
    const hosts = findAll(r, "host").map((h) => ({
      id: attr(h, "HostId") ?? "",
      name: attr(h, "Name") ?? "@",
      type: (attr(h, "Type") ?? "").toUpperCase(),
      address: attr(h, "Address") ?? "",
      mxPref: attr(h, "MXPref") === undefined ? undefined : Number(attr(h, "MXPref")),
      ttl: Number(attr(h, "TTL") ?? DEFAULT_TTL) || DEFAULT_TTL,
    }));
    return { emailType: (attr(r, "EmailType") ?? "NONE").toUpperCase(), usingOurDns: attr(r, "IsUsingOurDNS") !== "false", hosts };
  }

  private async writeZone(domain: string, zone: Zone, hosts: Omit<Host, "id">[]): Promise<void> {
    if (!zone.usingOurDns) {
      throw new RegistrarError(
        `${domain} uses custom nameservers, so Namecheap's DNS isn't live for it. Edit records wherever its nameservers are hosted, or run \`dom ns ${domain} set default\` first.`,
        "NAMECHEAP_2030288",
      );
    }
    // MX records are only accepted in "custom MX" mode; with none left, fall back to no email.
    const hasMx = hosts.some((h) => h.type === "MX");
    let emailType = zone.emailType;
    if (hasMx && emailType !== "MX") {
      if (emailType !== "NONE") this.opts.onWarning?.(`Switching ${domain} email from Namecheap's ${emailType} setting to your custom MX records.`);
      emailType = "MX";
    } else if (!hasMx && emailType === "MX") {
      emailType = "NONE";
    }

    const params: Record<string, string> = { ...splitDomain(domain), EmailType: emailType };
    hosts.forEach((h, i) => {
      const n = i + 1;
      params[`HostName${n}`] = h.name;
      params[`RecordType${n}`] = h.type;
      params[`Address${n}`] = h.address;
      params[`TTL${n}`] = String(h.ttl);
      if (h.type === "MX") params[`MXPref${n}`] = String(h.mxPref ?? 10);
    });
    const res = await this.call("namecheap.domains.dns.setHosts", params);
    if (!truthy(attr(find(res, "DomainDNSSetHostsResult"), "IsSuccess"))) {
      throw new RegistrarError(`Namecheap didn't confirm the DNS update for ${domain}`, "NAMECHEAP_ERROR");
    }
  }

  async listRecords(domain: string): Promise<DnsRecord[]> {
    const zone = await this.readZone(domain);
    if (!zone.usingOurDns) {
      this.opts.onWarning?.(`${domain} uses custom nameservers, so these Namecheap records aren't what's live.`);
    }
    // Namecheap reports MXPref (usually 10) on every host; it only means something for MX.
    return zone.hosts.map((h) => ({
      id: h.id,
      name: h.name || "@",
      type: h.type,
      content: h.address,
      ttl: h.ttl,
      prio: h.type === "MX" ? h.mxPref : undefined,
    }));
  }

  async createRecord(domain: string, record: DnsRecordInput): Promise<string> {
    if (!record.type || record.content === undefined) throw new RegistrarError("A record needs a type and content");
    const zone = await this.readZone(domain);
    const added = {
      name: !record.name ? "@" : record.name,
      type: record.type.toUpperCase(),
      address: record.content,
      ttl: record.ttl || DEFAULT_TTL,
      mxPref: record.prio,
    };
    await this.writeZone(domain, zone, [...zone.hosts, added]);
    // Namecheap re-numbers hosts on every write; find the new one to report its id.
    const after = await this.readZone(domain);
    const match = after.hosts.find((h) => h.type === added.type && h.name === added.name && h.address === added.address);
    return match?.id ?? "";
  }

  async editRecord(domain: string, id: string, record: DnsRecordInput): Promise<void> {
    const zone = await this.readZone(domain);
    if (!zone.hosts.some((h) => h.id === id)) throw new RegistrarError(`No record with id ${id} on ${domain}`, "NOT_FOUND");
    const hosts = zone.hosts.map((h) =>
      h.id !== id
        ? h
        : {
            ...h,
            name: record.name === undefined ? h.name : record.name || "@",
            type: record.type?.toUpperCase() ?? h.type,
            address: record.content ?? h.address,
            ttl: record.ttl ?? h.ttl,
            mxPref: record.prio ?? h.mxPref,
          },
    );
    await this.writeZone(domain, zone, hosts);
  }

  async deleteRecord(domain: string, id: string): Promise<void> {
    const zone = await this.readZone(domain);
    if (!zone.hosts.some((h) => h.id === id)) throw new RegistrarError(`No record with id ${id} on ${domain}`, "NOT_FOUND");
    await this.writeZone(domain, zone, zone.hosts.filter((h) => h.id !== id));
  }
}
