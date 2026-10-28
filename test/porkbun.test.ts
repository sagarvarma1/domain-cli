import assert from "node:assert/strict";
import { test } from "node:test";
import { Porkbun, relativeName, toCents } from "../src/porkbun.js";
import { RegistrarError } from "../src/registrar.js";
import { fakeFetch } from "./helpers.js";

const client = (routes: Parameters<typeof fakeFetch>[0], warnings: string[] = []) => {
  const f = fakeFetch(routes);
  return { pb: new Porkbun({ apiKey: "pk1_sb_x", secretKey: "sk1_sb_x", fetch: f.impl, onWarning: (w) => warnings.push(w) }), ...f };
};

test("toCents handles strings, numbers and junk", () => {
  assert.equal(toCents("9.73"), 973);
  assert.equal(toCents("1,099.99"), 109999);
  assert.equal(toCents(10.995), 1100);
  assert.equal(toCents("string"), undefined);
  assert.equal(toCents(undefined), undefined);
});

test("relativeName strips the zone", () => {
  assert.equal(relativeName("www.example.com", "example.com"), "www");
  assert.equal(relativeName("example.com", "example.com"), "@");
  assert.equal(relativeName("", "example.com"), "@");
  assert.equal(relativeName("a.b.example.com.", "example.com"), "a.b");
});

test("sandbox is detected from the key prefix", () => {
  assert.equal(new Porkbun({ apiKey: "pk1_sb_abc", secretKey: "s" }).sandbox, true);
  assert.equal(new Porkbun({ apiKey: "pk1_abc", secretKey: "s" }).sandbox, false);
});

test("bulk check reads domains, unresolved and invalid, keeping input order", async () => {
  const { pb, calls } = client({
    "/domain/checkDomain": () => ({
      json: {
        status: "SUCCESS",
        domains: {
          "a.com": { avail: "no" },
          "a.dev": { avail: "yes", price: "12.98", premium: "no", firstYearPromo: "no", additional: { renewal: { price: "14.98" } } },
        },
        unresolved: ["a.io"],
        invalid: [{ domain: "a.zzz", reason: "unsupported TLD" }],
      },
    }),
  });
  const res = await pb.check(["a.com", "A.dev", "a.io", "a.zzz", "a.com"]);
  assert.deepEqual(
    res.map((r) => [r.domain, r.available, r.priceCents, r.renewalCents]),
    [
      ["a.com", false, undefined, undefined],
      ["a.dev", true, 1298, 1498],
      ["a.io", null, undefined, undefined],
      ["a.zzz", false, undefined, undefined],
    ],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body.domains, ["a.com", "a.dev", "a.io", "a.zzz"]);
  assert.equal(calls[0]!.body.apikey, "pk1_sb_x");
});

test("bulk check splits into chunks of 25", async () => {
  const { pb, calls } = client({
    "/domain/checkDomain": (b) => ({
      json: { status: "SUCCESS", domains: Object.fromEntries(b.domains.map((d: string) => [d, { avail: "no" }])) },
    }),
  });
  const names = Array.from({ length: 30 }, (_, i) => `n${i}.com`);
  const res = await pb.check(names);
  assert.equal(res.length, 30);
  assert.deepEqual(calls.map((c) => c.body.domains.length), [25, 5]);
});

test("single check uses the single endpoint", async () => {
  const { pb, calls } = client({
    "/domain/checkDomain/solo.dev": () => ({ json: { status: "SUCCESS", response: { avail: "yes", price: "10.18", premium: "no" } } }),
  });
  const [r] = await pb.check(["solo.dev"]);
  assert.equal(r!.available, true);
  assert.equal(r!.priceCents, 1018);
  assert.equal(calls[0]!.url.endsWith("/domain/checkDomain/solo.dev"), true);
});

test("quote is a dry run with cost 0; register sends the quoted cost and an idempotency key", async () => {
  const { pb, calls } = client({
    "/domain/create/new.dev": (b) => ({
      json: b.dryRun
        ? { status: "SUCCESS", dryRun: true, wouldSucceed: true, cost: 1298, balance: 5000, sufficientFunds: true, duration: 1 }
        : { status: "SUCCESS", domain: "new.dev", cost: b.cost, orderId: 42, balance: 5000 - b.cost },
    }),
  });
  const q = await pb.quoteRegistration("new.dev");
  assert.deepEqual([q.costCents, q.balanceCents, q.wouldSucceed], [1298, 5000, true]);
  assert.equal(calls[0]!.body.dryRun, true);
  assert.equal(calls[0]!.body.cost, 0);

  const order = await pb.register("new.dev", q.costCents, { whoisPrivacy: false });
  assert.deepEqual([order.costCents, order.orderId, order.balanceCents], [1298, 42, 3702]);
  const buy = calls[1]!;
  assert.equal(buy.body.dryRun, undefined);
  assert.equal(buy.body.agreeToTerms, "yes");
  assert.equal(buy.body.whoisPrivacy, false);
  assert.match(buy.headers["Idempotency-Key"]!, /^[0-9a-f-]{36}$/);
});

test("API errors become RegistrarError with code; 429 mentions the wait", async () => {
  const { pb } = client({
    "/domain/create/x.com": () => ({ status: 400, json: { status: "ERROR", code: "INSUFFICIENT_FUNDS", message: "Not enough credit" } }),
    "/ping": () => ({ status: 429, json: { status: "ERROR", code: "RATE_LIMIT_EXCEEDED", message: "Slow down" } }),
    "/account/balance": () => ({ status: 503, text: "<html>503</html>" }),
  });
  await assert.rejects(pb.register("x.com", 100), (e: RegistrarError) => e.code === "INSUFFICIENT_FUNDS" && e.message === "Not enough credit");
  await assert.rejects(pb.verify(), (e: RegistrarError) => e.status === 429 && /7s/.test(e.message));
  await assert.rejects(pb.balance(), (e: RegistrarError) => e.code === "BAD_RESPONSE" && e.status === 503);
});

test("warnings are surfaced and DNS names are normalized", async () => {
  const warnings: string[] = [];
  const { pb, calls } = client(
    {
      "/dns/create/ex.com": () => ({ json: { status: "SUCCESS", id: 99, warnings: ["not delegated to us"] } }),
      "/dns/retrieve/ex.com": () => ({
        json: { status: "SUCCESS", records: [{ id: "1", name: "ex.com", type: "A", content: "1.2.3.4", ttl: "600", prio: "0" }] },
      }),
    },
    warnings,
  );
  assert.equal(await pb.createRecord("ex.com", { type: "a", name: "@", content: "1.2.3.4" }), "99");
  assert.deepEqual(calls[0]!.body, { apikey: "pk1_sb_x", secretapikey: "sk1_sb_x", type: "A", name: "", content: "1.2.3.4" });
  assert.deepEqual(warnings, ["not delegated to us"]);
  const [rec] = await pb.listRecords("ex.com");
  assert.deepEqual([rec!.name, rec!.ttl, rec!.prio], ["@", 600, 0]);
});

test("listDomains paginates until a short page", async () => {
  const { pb, calls } = client({
    "/domain/listAll": (b) => ({
      json: {
        status: "SUCCESS",
        domains: Array.from({ length: b.start === 0 ? 1000 : 3 }, (_, i) => ({ domain: `d${b.start + i}.com`, autoRenew: 1, apiAccess: 0 })),
      },
    }),
  });
  const all = await pb.listDomains({ expiringWithinDays: 30 });
  assert.equal(all.length, 1003);
  assert.deepEqual(calls.map((c) => c.body.start), [0, 1000]);
  assert.equal(calls[0]!.body.expiringWithinDays, 30);
  assert.deepEqual([all[0]!.autoRenew, all[0]!.apiAccess], [true, false]);
});
