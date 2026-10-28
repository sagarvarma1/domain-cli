import assert from "node:assert/strict";
import { test } from "node:test";
import { Namecheap, splitDomain, usDateToIso } from "../src/namecheap.js";
import { RegistrarError } from "../src/registrar.js";
import { attr, find, findAll, parseXml } from "../src/xml.js";
import { fakeFetch, namecheapZone } from "./helpers.js";

const client = (handlers: Parameters<typeof fakeFetch>[1], warnings: string[] = []) => {
  const f = fakeFetch({}, handlers);
  return { nc: new Namecheap({ username: "me", apiKey: "k", clientIp: "203.0.113.7", fetch: f.impl, onWarning: (w) => warnings.push(w) }), ...f };
};

test("xml parser reads elements, attributes, text and entities", () => {
  const doc = parseXml(`<?xml version="1.0"?><!-- c --><A x="1 &amp; 2"><B>hi &lt;there&gt;</B><b y='q' /><C><![CDATA[<raw>]]></C></A>`);
  const a = find(doc, "A")!;
  assert.equal(attr(a, "X"), "1 & 2");
  assert.equal(find(a, "B")!.text, "hi <there>");
  assert.equal(findAll(a, "b").length, 2, "case-insensitive");
  assert.equal(find(a, "C")!.text, "<raw>");
});

test("dates and domain splitting", () => {
  assert.equal(usDateToIso("2/5/2027"), "2027-02-05");
  assert.deepEqual(splitDomain("example.co.uk"), { SLD: "example", TLD: "co.uk" });
});

test("requests carry credentials and client IP as a form POST", async () => {
  const { nc, calls } = client({ "namecheap.users.getBalances": () => `<UserGetBalancesResult Currency="USD" AvailableBalance="12.34" />` });
  assert.deepEqual(await nc.balance(), { cents: 1234, display: "$12.34" });
  assert.equal(calls[0]!.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(
    [calls[0]!.body.ApiUser, calls[0]!.body.UserName, calls[0]!.body.ApiKey, calls[0]!.body.ClientIp],
    ["me", "me", "k", "203.0.113.7"],
  );
});

test("API errors carry the number and a hint for IP whitelisting", async () => {
  const { nc } = client({
    "namecheap.users.getBalances": () =>
      `<ApiResponse Status="ERROR"><Errors><Error Number="1011150">Invalid request IP: 203.0.113.7</Error></Errors></ApiResponse>`,
  });
  await assert.rejects(nc.verify(), (e: RegistrarError) => e.code === "NAMECHEAP_1011150" && /Whitelist this IP/.test(e.message));
});

test("listDomains pages and converts dates", async () => {
  const { nc, calls } = client({
    "namecheap.domains.getList": (p) => {
      const page = Number(p.Page);
      const domains =
        page === 1
          ? Array.from({ length: 100 }, (_, i) => `<Domain ID="${i}" Name="d${i}.com" Created="01/02/2020" Expires="03/04/2027" IsExpired="false" IsLocked="true" AutoRenew="false" WhoisGuard="ENABLED" IsOurDNS="true" />`).join("")
          : `<Domain ID="x" Name="Last.IO" Created="01/02/2020" Expires="12/31/2026" IsExpired="false" IsLocked="false" AutoRenew="true" WhoisGuard="NOTPRESENT" IsOurDNS="false" />`;
      return `<DomainGetListResult>${domains}</DomainGetListResult><Paging><TotalItems>101</TotalItems><CurrentPage>${page}</CurrentPage><PageSize>100</PageSize></Paging>`;
    },
  });
  const all = await nc.listDomains();
  assert.equal(all.length, 101);
  assert.deepEqual(calls.map((c) => c.body.Page), ["1", "2"]);
  assert.deepEqual(all[0], {
    domain: "d0.com",
    registrar: "namecheap",
    status: "ACTIVE",
    created: "2020-01-02",
    expires: "2027-03-04",
    autoRenew: false,
    whoisPrivacy: true,
    locked: true,
    apiAccess: true,
    usesRegistrarDns: true,
  });
  assert.deepEqual([all[100]!.domain, all[100]!.usesRegistrarDns, all[100]!.whoisPrivacy], ["last.io", false, false]);
});

test("adding a record writes back every existing record (setHosts replaces the zone)", async () => {
  const zone = namecheapZone("ex.com", [
    { name: "@", type: "A", address: "1.1.1.1" },
    { name: "www", type: "CNAME", address: "ex.com." },
    { name: "@", type: "TXT", address: 'v=spf1 include:"x" ~all', ttl: 300 },
  ]);
  const { nc } = client(zone.handlers);
  const id = await nc.createRecord("ex.com", { type: "a", name: "api", content: "2.2.2.2" });
  assert.deepEqual(
    zone.hosts.map((h) => [h.name, h.type, h.address, h.ttl]),
    [
      ["@", "A", "1.1.1.1", 1799],
      ["www", "CNAME", "ex.com.", 1799],
      ["@", "TXT", 'v=spf1 include:"x" ~all', 300],
      ["api", "A", "2.2.2.2", 1799],
    ],
  );
  assert.equal(id, zone.hosts[3]!.id, "returns the new record's id after renumbering");
});

test("MX records switch the zone to custom-MX email, and removing the last one switches back", async () => {
  const zone = namecheapZone("ex.com", [{ name: "@", type: "A", address: "1.1.1.1" }], "FWD");
  const warnings: string[] = [];
  const { nc } = client(zone.handlers, warnings);
  await nc.createRecord("ex.com", { type: "MX", name: "@", content: "mx.mail.com", prio: 5 });
  assert.equal(zone.emailType, "MX");
  assert.equal(zone.hosts.find((h) => h.type === "MX")!.mxPref, 5);
  assert.match(warnings[0]!, /FWD/);

  const mx = (await nc.listRecords("ex.com")).find((r) => r.type === "MX")!;
  await nc.deleteRecord("ex.com", mx.id);
  assert.equal(zone.emailType, "NONE");
  assert.deepEqual(zone.hosts.map((h) => h.type), ["A"]);
});

test("edit changes only the chosen record; unknown ids never write", async () => {
  const zone = namecheapZone("ex.com", [
    { name: "@", type: "A", address: "1.1.1.1" },
    { name: "www", type: "A", address: "1.1.1.1" },
  ]);
  const { nc, calls } = client(zone.handlers);
  await nc.editRecord("ex.com", "101", { content: "9.9.9.9" });
  assert.deepEqual(zone.hosts.map((h) => h.address), ["1.1.1.1", "9.9.9.9"]);

  const writes = calls.filter((c) => c.body.Command === "namecheap.domains.dns.setHosts").length;
  await assert.rejects(nc.deleteRecord("ex.com", "nope"), /No record/);
  assert.equal(calls.filter((c) => c.body.Command === "namecheap.domains.dns.setHosts").length, writes);
});

test("refuses to write DNS when the domain doesn't use Namecheap's nameservers", async () => {
  const { nc, calls } = client({
    "namecheap.domains.dns.getHosts": () => `<DomainDNSGetHostsResult Domain="ex.com" EmailType="NONE" IsUsingOurDNS="false"></DomainDNSGetHostsResult>`,
  });
  await assert.rejects(nc.createRecord("ex.com", { type: "A", name: "@", content: "1.1.1.1" }), /custom nameservers/);
  assert.equal(calls.some((c) => c.body.Command === "namecheap.domains.dns.setHosts"), false);
});

test("nameservers: custom list and back to default", async () => {
  const { nc, calls } = client({
    "namecheap.domains.dns.setCustom": () => `<DomainDNSSetCustomResult Domain="ex.com" Updated="true" />`,
    "namecheap.domains.dns.setDefault": () => `<DomainDNSSetDefaultResult Domain="ex.com" Updated="true" />`,
    "namecheap.domains.dns.getList": () =>
      `<DomainDNSGetListResult Domain="ex.com" IsUsingOurDNS="true"><Nameserver>dns1.registrar-servers.com</Nameserver><Nameserver>dns2.registrar-servers.com</Nameserver></DomainDNSGetListResult>`,
  });
  assert.deepEqual(await nc.getNameservers("ex.com"), ["dns1.registrar-servers.com", "dns2.registrar-servers.com"]);
  await nc.setNameservers("ex.com", ["a.ns.com", "b.ns.com"]);
  await nc.setNameservers("ex.com", ["default"]);
  assert.deepEqual(
    calls.slice(1).map((c) => [c.body.Command, c.body.SLD, c.body.TLD, c.body.Nameservers]),
    [
      ["namecheap.domains.dns.setCustom", "ex", "com", "a.ns.com,b.ns.com"],
      ["namecheap.domains.dns.setDefault", "ex", "com", undefined],
    ],
  );
});

test("renewal quote uses your price plus ICANN fee and your balance", async () => {
  const { nc } = client({
    "namecheap.domains.getList": () => `<DomainGetListResult><Domain Name="ex.com" Expires="01/01/2027" /></DomainGetListResult>`,
    "namecheap.users.getPricing": (p) => {
      assert.deepEqual([p.ProductType, p.ActionName, p.ProductName], ["DOMAIN", "RENEW", "com"]);
      return `<UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="renew"><Product Name="com"><Price Duration="1" DurationType="YEAR" Price="15.16" YourPrice="14.58" AdditionalCost="0.20" YourAdditonalCost="0.20" Currency="USD" /><Price Duration="2" DurationType="YEAR" Price="30" YourPrice="29" /></Product></ProductCategory></ProductType></UserGetPricingResult>`;
    },
    "namecheap.users.getBalances": () => `<UserGetBalancesResult AvailableBalance="10.00" />`,
  });
  const q = await nc.quoteRenewal("ex.com");
  assert.deepEqual([q.costCents, q.balanceCents, q.sufficientFunds, q.estimate], [1478, 1000, false, true]);
});
