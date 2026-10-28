import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { expandCandidates, main, normalizeDomain } from "../src/app.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { RegistrarError } from "../src/registrar.js";
import { fakeFetch, namecheapZone } from "./helpers.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
let out: string[] = [];

beforeEach(() => {
  process.env.DOM_CONFIG = join(mkdtempSync(join(tmpdir(), "dom-test-")), "config.json");
  process.env.PORKBUN_API_KEY = "pk1_sb_test";
  process.env.PORKBUN_SECRET_API_KEY = "sk1_sb_test";
  process.env.NO_COLOR = "1";
  delete process.env.NAMECHEAP_USERNAME;
  delete process.env.NAMECHEAP_API_KEY;
  delete process.env.NAMECHEAP_CLIENT_IP;
  out = [];
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

test("normalizeDomain strips scheme, path and case", () => {
  assert.equal(normalizeDomain("  HTTPS://Cool.Dev/path?q=1 "), "cool.dev");
  assert.equal(normalizeDomain("cool.dev."), "cool.dev");
});

test("expandCandidates expands bare names and validates", () => {
  assert.deepEqual(expandCandidates(["cool", "cool.dev", "Cool.com"], ["com", "dev"]), ["cool.com", "cool.dev"]);
  assert.throws(() => expandCandidates(["bad_name"], ["com"]), /letters, numbers and hyphens/);
  assert.throws(() => expandCandidates(["-bad.com"], ["com"]), /doesn't look like a domain/);
});

test("buy --yes: checks, quotes, then registers with the quoted cost", async () => {
  const f = fakeFetch({
    "/domain/checkDomain/cool.dev": () => ({
      json: { status: "SUCCESS", response: { avail: "yes", price: "12.98", premium: "no", additional: { renewal: { price: "14.98" } } } },
    }),
    "/domain/create/cool.dev": (b) => ({
      json: b.dryRun
        ? { status: "SUCCESS", dryRun: true, wouldSucceed: true, cost: 1298, balance: 2000, sufficientFunds: true, duration: 1 }
        : { status: "SUCCESS", domain: "cool.dev", cost: b.cost, orderId: 7, balance: 702 },
    }),
  });
  globalThis.fetch = f.impl;

  await main(["buy", "cool.dev", "--yes"]);
  assert.deepEqual(
    f.calls.map((c) => [c.url.replace(/.*\/v3/, ""), c.body.dryRun ?? false, c.body.cost]),
    [
      ["/domain/checkDomain/cool.dev", false, undefined],
      ["/domain/create/cool.dev", true, 0],
      ["/domain/create/cool.dev", false, 1298],
    ],
  );
  const text = out.join("\n");
  assert.match(text, /Cost\s+\$12\.98/);
  assert.match(text, /Renews at\s+\$14\.98\/yr/);
  assert.match(text, /sandbox/);
  assert.match(text, /cool\.dev is yours! Charged \$12\.98/);
});

test("buy --dry-run never registers", async () => {
  const f = fakeFetch({
    "/domain/checkDomain/cool.dev": () => ({ json: { status: "SUCCESS", response: { avail: "yes", price: "12.98", premium: "no" } } }),
    "/domain/create/cool.dev": () => ({
      json: { status: "SUCCESS", dryRun: true, wouldSucceed: true, cost: 1298, balance: 2000, sufficientFunds: true },
    }),
  });
  globalThis.fetch = f.impl;
  await main(["buy", "cool.dev", "--dry-run"]);
  assert.equal(f.calls.filter((c) => c.url.includes("/domain/create") && !c.body.dryRun).length, 0);
  assert.match(out.join("\n"), /Dry run: nothing was bought/);
});

test("buy stops before paying when credit is short", async () => {
  const f = fakeFetch({
    "/domain/checkDomain/cool.dev": () => ({ json: { status: "SUCCESS", response: { avail: "yes", price: "12.98", premium: "no" } } }),
    "/domain/create/cool.dev": () => ({
      json: { status: "SUCCESS", dryRun: true, wouldSucceed: false, cost: 1298, balance: 500, sufficientFunds: false },
    }),
  });
  globalThis.fetch = f.impl;
  await assert.rejects(main(["buy", "cool.dev", "--yes"]), (e: RegistrarError) => e.code === "INSUFFICIENT_FUNDS" && /\$7\.98/.test(e.message));
  assert.equal(f.calls.length, 2);
});

test("buy refuses taken domains without quoting", async () => {
  const f = fakeFetch({ "/domain/checkDomain/taken.com": () => ({ json: { status: "SUCCESS", response: { avail: "no" } } }) });
  globalThis.fetch = f.impl;
  await assert.rejects(main(["buy", "taken.com", "-y"]), /taken/);
  assert.equal(f.calls.length, 1);
});

test("buy without --yes outside a terminal refuses instead of buying", async () => {
  const f = fakeFetch({
    "/domain/checkDomain/cool.dev": () => ({ json: { status: "SUCCESS", response: { avail: "yes", price: "12.98", premium: "no" } } }),
    "/domain/create/cool.dev": (b) => ({
      json: b.dryRun ? { status: "SUCCESS", wouldSucceed: true, cost: 1298, balance: 2000, sufficientFunds: true } : { status: "SUCCESS" },
    }),
  });
  globalThis.fetch = f.impl;
  await assert.rejects(main(["buy", "cool.dev"]), /--yes/);
  assert.equal(f.calls.filter((c) => !c.body.dryRun && c.url.includes("/create")).length, 0);
});

test("search prints a table with prices", async () => {
  globalThis.fetch = fakeFetch({
    "/domain/checkDomain": () => ({
      json: {
        status: "SUCCESS",
        domains: { "x.com": { avail: "no" }, "x.dev": { avail: "yes", price: "12.98", premium: "no", additional: { renewal: { price: "14.98" } } } },
      },
    }),
  }).impl;
  await main(["search", "x", "--tlds", "com,dev"]);
  const text = out.join("\n");
  assert.match(text, /x\.com\s+taken/);
  assert.match(text, /x\.dev\s+available\s+\$12\.98\s+renews \$14\.98/);
  assert.match(text, /dom buy x\.dev/);
});

test("missing keys gives a helpful error", async () => {
  delete process.env.PORKBUN_API_KEY;
  delete process.env.PORKBUN_SECRET_API_KEY;
  await assert.rejects(main(["list"]), /dom login/);
});

test("config is written readable only by the owner", async () => {
  const path = await saveConfig({ accounts: { porkbun: { apiKey: "a", secretKey: "b" } } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).accounts.porkbun.secretKey, "b");
});

test("v0.1 configs with top-level Porkbun keys still load", async () => {
  delete process.env.PORKBUN_API_KEY;
  delete process.env.PORKBUN_SECRET_API_KEY;
  await saveConfig({ provider: "porkbun", apiKey: "old", secretKey: "keys" } as any);
  assert.deepEqual((await loadConfig()).accounts.porkbun, { apiKey: "old", secretKey: "keys" });
});

// ---------- multiple accounts ----------

function withNamecheap() {
  process.env.NAMECHEAP_USERNAME = "me";
  process.env.NAMECHEAP_API_KEY = "nck";
}

const ncDomain = (name: string, extra = "") =>
  `<Domain Name="${name}" Created="01/02/2020" Expires="05/06/2027" IsExpired="false" IsLocked="true" AutoRenew="true" WhoisGuard="ENABLED" IsOurDNS="true" ${extra}/>`;

test("list merges domains from every connected account, soonest expiry first", async () => {
  withNamecheap();
  globalThis.fetch = fakeFetch(
    {
      "/domain/listAll": () => ({
        json: { status: "SUCCESS", domains: [{ domain: "pork.dev", status: "ACTIVE", expireDate: "2028-01-01 00:00:00", autoRenew: 1, whoisPrivacy: 1 }] },
      }),
    },
    { "namecheap.domains.getList": () => `<DomainGetListResult>${ncDomain("cheap.com")}</DomainGetListResult><Paging><TotalItems>1</TotalItems></Paging>` },
  ).impl;
  await main(["list"]);
  const text = out.join("\n");
  assert.match(text, /cheap\.com\s+namecheap\s+2027-05-06/);
  assert.match(text, /pork\.dev\s+porkbun\s+2028-01-01/);
  assert.ok(text.indexOf("cheap.com") < text.indexOf("pork.dev"));
});

test("one account failing doesn't hide the others", async () => {
  withNamecheap();
  globalThis.fetch = fakeFetch(
    { "/domain/listAll": () => ({ json: { status: "SUCCESS", domains: [{ domain: "pork.dev", expireDate: "2028-01-01" }] } }) },
    {
      "namecheap.domains.getList": () =>
        `<ApiResponse Status="ERROR"><Errors><Error Number="1011150">Invalid request IP</Error></Errors></ApiResponse>`,
    },
  ).impl;
  const errors: string[] = [];
  const realError = console.error;
  console.error = (m: string) => void errors.push(m);
  try {
    await main(["list"]);
  } finally {
    console.error = realError;
  }
  assert.match(out.join("\n"), /pork\.dev/);
  assert.match(errors.join("\n"), /Namecheap: Invalid request IP/);
});

test("dns commands go to whichever account holds the domain", async () => {
  withNamecheap();
  const zone = namecheapZone("cheap.com", [{ name: "@", type: "A", address: "1.1.1.1" }]);
  const f = fakeFetch(
    { "/domain/listAll": () => ({ json: { status: "SUCCESS", domains: [] } }) },
    {
      "namecheap.domains.getList": () => `<DomainGetListResult>${ncDomain("cheap.com")}</DomainGetListResult>`,
      ...zone.handlers,
    },
  );
  globalThis.fetch = f.impl;
  await main(["dns", "cheap.com", "add", "CNAME", "www", "cheap.com."]);
  assert.deepEqual(zone.hosts.map((h) => [h.type, h.name]), [["A", "@"], ["CNAME", "www"]]);
  assert.equal(f.calls.some((c) => c.url.includes("/dns/create")), false, "never touched Porkbun DNS");
  assert.equal(f.calls.find((c) => c.url.includes("namecheap"))!.body.ClientIp, "203.0.113.7", "detected IP");
});

test("a domain in no account gives a clear error", async () => {
  withNamecheap();
  globalThis.fetch = fakeFetch(
    { "/domain/listAll": () => ({ json: { status: "SUCCESS", domains: [] } }) },
    { "namecheap.domains.getList": () => `<DomainGetListResult></DomainGetListResult>` },
  ).impl;
  await assert.rejects(main(["dns", "elsewhere.com"]), /isn't in any connected account \(Porkbun, Namecheap\)/);
});

test("--registrar skips the lookup", async () => {
  withNamecheap();
  const f = fakeFetch({
    "/dns/retrieve/pork.dev": () => ({ json: { status: "SUCCESS", records: [{ id: "1", name: "pork.dev", type: "A", content: "1.2.3.4", ttl: 600 }] } }),
  });
  globalThis.fetch = f.impl;
  await main(["dns", "pork.dev", "-r", "porkbun"]);
  assert.deepEqual(f.calls.map((c) => c.url.replace(/.*\/v3/, "")), ["/dns/retrieve/pork.dev"]);
});

test("Namecheap-only setups can't buy, with a pointer to Porkbun", async () => {
  delete process.env.PORKBUN_API_KEY;
  delete process.env.PORKBUN_SECRET_API_KEY;
  withNamecheap();
  await assert.rejects(main(["buy", "new.dev", "-y"]), /goes through Porkbun.*dom login porkbun/);
});

// ---------- transfers ----------

test("transfer from Namecheap: quote, hold, copy DNS exactly, switch nameservers, release", async () => {
  withNamecheap();
  const zone = namecheapZone("moving.test", [
    { name: "@", type: "A", address: "1.1.1.1", ttl: 60 },
    { name: "@", type: "MX", address: "mx.mail.com", mxPref: 10 },
    { name: "go", type: "URL", address: "https://example.com" },
  ], "MX");
  const ncCalls: string[] = [];
  const f = fakeFetch(
    {
      "/pricing/get": () => ({ json: { status: "SUCCESS", pricing: { test: { registration: "9", renewal: "9", transfer: "8.50" } } } }),
      "/domain/transfer/moving.test": (b) => ({
        json: b.dryRun
          ? { status: "SUCCESS", dryRun: true, wouldSucceed: true, cost: b.cost, balance: 2000, sufficientFunds: true, duration: 1 }
          : { status: "SUCCESS", domain: "moving.test", orderId: 55, transferId: 9 },
      }),
      "/domain/prepareTransfer/moving.test": () => ({ json: { status: "SUCCESS", porkbunNameservers: ["a.ns.porkbun.com", "b.ns.porkbun.com"] } }),
      "/dns/import/moving.test": (b) => ({ json: { status: "SUCCESS", created: b.records.length, skipped: 0, failed: 0 } }),
      "/domain/startTransfer/moving.test": () => ({ json: { status: "SUCCESS", message: "Transfer released." } }),
    },
    {
      "namecheap.domains.getList": () => `<DomainGetListResult>${ncDomain("moving.test")}</DomainGetListResult>`,
      "namecheap.domains.dns.setCustom": (p) => (ncCalls.push(`setCustom ${p.Nameservers}`), `<DomainDNSSetCustomResult Updated="true" />`),
      ...zone.handlers,
    },
  );
  globalThis.fetch = f.impl;
  const realError = console.error;
  console.error = () => {};
  try {
    await main(["transfer", "moving.test", "--auth-code", "s3cret", "--yes"]);
  } finally {
    console.error = realError;
  }

  const porkbunSteps = f.calls.filter((c) => c.url.includes("porkbun")).map((c) => c.url.replace(/.*\/v3/, "") + (c.body.dryRun ? " (dry run)" : ""));
  assert.deepEqual(porkbunSteps, [
    "/pricing/get",
    "/domain/transfer/moving.test (dry run)",
    "/domain/transfer/moving.test",
    "/domain/prepareTransfer/moving.test",
    "/dns/import/moving.test",
    "/domain/startTransfer/moving.test",
  ]);
  const transfer = f.calls.find((c) => c.url.endsWith("/domain/transfer/moving.test") && !c.body.dryRun)!;
  assert.deepEqual([transfer.body.authCode, transfer.body.cost, transfer.body.holdForDnsSetup], ["s3cret", 850, true]);

  const imported = f.calls.find((c) => c.url.includes("/dns/import"))!.body.records;
  assert.deepEqual(imported, [
    { name: "", type: "A", content: "1.1.1.1", ttl: 600 },
    { name: "", type: "MX", content: "mx.mail.com", ttl: 1799, prio: 10 },
  ]);
  assert.deepEqual(ncCalls, ["setCustom a.ns.porkbun.com,b.ns.porkbun.com"]);
  assert.match(out.join("\n"), /Transfer released/);
  assert.doesNotMatch(out.join("\n"), /s3cret/, "auth code is never printed");
});

test("transfer --dry-run pays nothing", async () => {
  const f = fakeFetch({
    "/pricing/get": () => ({ json: { status: "SUCCESS", pricing: { test: { transfer: "8.50" } } } }),
    "/domain/transfer/dry.test": () => ({ json: { status: "SUCCESS", dryRun: true, wouldSucceed: true, cost: 850, balance: 2000, sufficientFunds: true } }),
    "/dns/scan/dry.test": () => ({ json: { status: "SUCCESS", records: [{ name: "www", type: "A", content: "5.5.5.5", ttl: 600 }] } }),
  });
  globalThis.fetch = f.impl;
  await main(["transfer", "dry.test", "--auth-code", "x", "--dry-run"]);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/domain/transfer/dry.test") && !c.body.dryRun).length, 0);
  assert.match(out.join("\n"), /1 DNS record to copy, from a scan/);
  assert.match(out.join("\n"), /Dry run: nothing was transferred/);
});
