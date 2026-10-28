import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { pkcePair, porkbunBrowserLogin, porkbunSandboxLogin } from "../src/login.js";
import { publicAvailability } from "../src/lookup.js";
import { fakeFetch } from "./helpers.js";

const noSleep = async () => {};

test("PKCE challenge is base64url(sha256(verifier))", () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("browser login opens the approval page, polls until approved, returns both keys", async () => {
  let polls = 0;
  let challenge = "";
  const f = fakeFetch({
    "/apikey/request": (b) => {
      challenge = b.codeChallenge;
      assert.equal(b.codeChallengeMethod, "S256");
      assert.deepEqual(b.scopes, ["read", "purchase", "domains", "dns"]);
      assert.equal(b.apikey, undefined, "no credentials sent");
      return { json: { status: "SUCCESS", requestToken: "t".repeat(64), authUrl: "https://porkbun.com/account/api/approve/x" } };
    },
    "/apikey/retrieve": (b) => {
      assert.equal(createHash("sha256").update(b.codeVerifier).digest("base64url"), challenge, "verifier matches");
      return ++polls < 3
        ? { json: { status: "PENDING" } }
        : { json: { status: "SUCCESS", apikey: "pk1_new", secretapikey: "sk1_new" } };
    },
  });
  const opened: string[] = [];
  const keys = await porkbunBrowserLogin({ fetch: f.impl, open: (u) => opened.push(u), sleep: noSleep });
  assert.deepEqual(keys, { apiKey: "pk1_new", secretKey: "sk1_new" });
  assert.deepEqual(opened, ["https://porkbun.com/account/api/approve/x"]);
  assert.equal(polls, 3);
});

test("browser login stops on a denial instead of polling forever", async () => {
  const f = fakeFetch({
    "/apikey/request": () => ({ json: { status: "SUCCESS", requestToken: "t", authUrl: "https://porkbun.com/a" } }),
    "/apikey/retrieve": () => ({ status: 400, json: { status: "ERROR", code: "REQUEST_DENIED", message: "The request was denied." } }),
  });
  await assert.rejects(porkbunBrowserLogin({ fetch: f.impl, open: () => {}, sleep: noSleep }), /denied/);
});

test("browser login times out", async () => {
  const f = fakeFetch({
    "/apikey/request": () => ({ json: { status: "SUCCESS", requestToken: "t", authUrl: "https://porkbun.com/a" } }),
    "/apikey/retrieve": () => ({ json: { status: "PENDING" } }),
  });
  await assert.rejects(porkbunBrowserLogin({ fetch: f.impl, open: () => {}, sleep: noSleep, timeoutMs: 0 }), /Timed out/);
});

test("sandbox login needs no approval", async () => {
  const f = fakeFetch({
    "/apikey/request": (b) => {
      assert.equal(b.sandbox, true);
      return { json: { status: "SUCCESS", apikey: "pk1_sb_a", secretapikey: "sk1_sb_b", sandbox: true } };
    },
  });
  assert.deepEqual(await porkbunSandboxLogin({ fetch: f.impl }), { apiKey: "pk1_sb_a", secretKey: "sk1_sb_b" });
});

test("public availability: RDAP where the registry has it, DNS otherwise", async () => {
  const rdapFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("data.iana.org")) {
      return new Response(JSON.stringify({ services: [[["com", "dev"], ["https://rdap.example/"]]] }));
    }
    if (url === "https://rdap.example/domain/free.com") return new Response("", { status: 404 });
    if (url === "https://rdap.example/domain/taken.com") return new Response("{}", { status: 200 });
    if (url === "https://rdap.example/domain/busy.dev") return new Response("", { status: 429 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const dnsError = (code: string) => Object.assign(new Error(code), { code });
  const resolveNs = async (d: string): Promise<string[]> => {
    if (d === "used.io" || d === "busy.dev") return ["ns1.host.com"];
    if (d === "nodns.io") throw dnsError("ENODATA");
    if (d === "flaky.io") throw dnsError("ETIMEOUT");
    throw dnsError("ENOTFOUND");
  };

  const res = await publicAvailability(["free.com", "taken.com", "busy.dev", "new.io", "used.io", "nodns.io", "flaky.io"], {
    fetch: rdapFetch,
    resolveNs,
  });
  assert.deepEqual(
    res.map((r) => [r.domain, r.available, r.likely ?? false]),
    [
      ["free.com", true, false],
      ["taken.com", false, false],
      ["busy.dev", false, false], // RDAP rate-limited → DNS shows it's in use
      ["new.io", true, true],
      ["used.io", false, false],
      ["nodns.io", false, false],
      ["flaky.io", null, false],
    ],
  );
});
