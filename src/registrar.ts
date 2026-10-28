// Provider-neutral types. Each registrar implements `Registrar`, so the CLI never
// talks to a specific API directly. All money is integer cents.

export type RegistrarName = "porkbun" | "namecheap";

export interface Availability {
  domain: string;
  /** null means the registry didn't answer — unknown, not taken. */
  available: boolean | null;
  premium: boolean;
  priceCents?: number;
  renewalCents?: number;
  promo: boolean;
  note?: string;
}

export interface TldPrice {
  tld: string;
  registrationCents: number;
  renewalCents: number;
  transferCents: number;
}

export interface Quote {
  domain: string;
  costCents: number;
  balanceCents: number;
  years: number;
  sufficientFunds: boolean;
  wouldSucceed: boolean;
  /** True when the registrar has no dry run and the cost comes from its price list. */
  estimate?: boolean;
  message?: string;
}

export interface Order {
  domain: string;
  costCents: number;
  orderId?: number | string;
  balanceCents?: number;
  expires?: string;
}

export interface Domain {
  domain: string;
  registrar: RegistrarName;
  status: string;
  created: string;
  /** ISO date (YYYY-MM-DD…) */
  expires: string;
  autoRenew: boolean;
  whoisPrivacy: boolean;
  locked: boolean;
  apiAccess: boolean;
  /** False when the domain's nameservers point somewhere else, so registrar DNS edits won't resolve. */
  usesRegistrarDns?: boolean;
}

export interface DnsRecord {
  id: string;
  /** Relative name: "@" for the apex, "www" for www.example.com. */
  name: string;
  type: string;
  content: string;
  ttl: number;
  prio?: number;
  notes?: string;
}

export interface DnsRecordInput {
  name?: string;
  type?: string;
  content?: string;
  ttl?: number;
  prio?: number;
}

export interface ListFilter {
  expiringWithinDays?: number;
  contains?: string;
}

export interface Account {
  account: string;
  scopes: string[];
  sandbox: boolean;
}

export interface Registrar {
  readonly name: RegistrarName;
  /** Human name for messages, e.g. "Porkbun". */
  readonly label: string;
  readonly sandbox: boolean;

  verify(): Promise<Account>;
  balance(): Promise<{ cents: number; display: string }>;
  check(domains: string[]): Promise<Availability[]>;
  pricing?(tlds?: string[]): Promise<TldPrice[]>;

  // Registration is optional: Namecheap needs full contact details per order, so dom buys via Porkbun.
  quoteRegistration?(domain: string): Promise<Quote>;
  register?(domain: string, costCents: number, opts?: { whoisPrivacy?: boolean }): Promise<Order>;
  quoteRenewal(domain: string): Promise<Quote>;
  renew(domain: string, costCents: number): Promise<Order>;

  getDomain(domain: string): Promise<Domain | undefined>;
  listDomains(filter?: ListFilter): Promise<Domain[]>;
  setAutoRenew?(domain: string, on: boolean): Promise<void>;
  setLock?(domain: string, locked: boolean): Promise<void>;
  getNameservers(domain: string): Promise<string[]>;
  setNameservers(domain: string, ns: string[]): Promise<void>;

  listRecords(domain: string): Promise<DnsRecord[]>;
  createRecord(domain: string, record: DnsRecordInput): Promise<string>;
  editRecord(domain: string, id: string, record: DnsRecordInput): Promise<void>;
  deleteRecord(domain: string, id: string): Promise<void>;
}

export class RegistrarError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RegistrarError";
  }
}
