import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Porkbun } from "./porkbun.js";
import { RegistrarError } from "./registrar.js";

const APP_NAME = "dom (command-line domain manager)";
/** What dom uses: buying/renewing/transfers, nameservers and locks, DNS. `read` is always included. */
const SCOPES = ["read", "purchase", "domains", "dns"];

export interface Keys {
  apiKey: string;
  secretKey: string;
}

export interface BrowserLoginOptions {
  fetch?: typeof fetch;
  /** Called with the approval URL; the default opens the system browser. */
  open?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Shown while waiting: lets the CLI print the URL in case the browser didn't open. */
  onWaiting?: (authUrl: string) => void;
  /** Give up after this long; Porkbun's approval link lasts 30 minutes. */
  timeoutMs?: number;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser available (SSH, container): the URL is printed for the user to open.
  }
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Porkbun's PKCE key handoff: the user approves in the browser and both keys come back here,
 * so nothing is ever copied or pasted. The verifier never leaves this process.
 */
export async function porkbunBrowserLogin(opts: BrowserLoginOptions = {}): Promise<Keys> {
  const client = new Porkbun({ apiKey: "", secretKey: "", fetch: opts.fetch });
  const { verifier, challenge } = pkcePair();
  const { requestToken, authUrl } = await client.requestApiKey({ name: APP_NAME, codeChallenge: challenge, scopes: SCOPES });

  (opts.open ?? openInBrowser)(authUrl);
  opts.onWaiting?.(authUrl);

  const sleep = opts.sleep ?? sleepFor;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  // Retrieve is limited to 120 calls/hour per IP: poll briskly at first, then back off.
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    await sleep(attempt < 20 ? 3_000 : 15_000);
    try {
      const keys = await client.retrieveApiKey(requestToken, verifier);
      if (keys) return keys;
    } catch (err) {
      if (err instanceof RegistrarError && err.status === 429) {
        await sleep(60_000);
        continue;
      }
      throw err;
    }
  }
  throw new RegistrarError("Timed out waiting for approval. Run `dom login porkbun` to try again.", "LOGIN_TIMEOUT");
}

export async function porkbunSandboxLogin(opts: { fetch?: typeof fetch } = {}): Promise<Keys> {
  return new Porkbun({ apiKey: "", secretKey: "", fetch: opts.fetch }).requestSandboxKey(APP_NAME);
}
