import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_TLDS = ["com", "net", "org", "io", "dev", "app", "co", "ai", "xyz", "sh"];

export interface PorkbunAccount {
  apiKey: string;
  secretKey: string;
}

export interface NamecheapAccount {
  username: string;
  apiKey: string;
  /** Pinned public IP; when unset it's detected on each run. */
  clientIp?: string;
  sandbox?: boolean;
}

export interface Config {
  accounts: {
    porkbun?: PorkbunAccount;
    namecheap?: NamecheapAccount;
  };
  /** TLDs tried when `dom search` gets a bare name like "coolname". */
  tlds?: string[];
}

export function configPath(): string {
  if (process.env.DOM_CONFIG) return process.env.DOM_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "dom", "config.json");
}

/** Reads the file as saved, without environment overrides — what `save` should build on. */
export async function loadSavedConfig(): Promise<Config> {
  let raw: any = {};
  try {
    raw = JSON.parse(await readFile(configPath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not read ${configPath()}: ${(err as Error).message}`);
    }
  }
  const config: Config = { accounts: { ...raw.accounts }, tlds: raw.tlds };
  // v0.1 kept Porkbun keys at the top level.
  if (raw.apiKey && raw.secretKey && !config.accounts.porkbun) {
    config.accounts.porkbun = { apiKey: raw.apiKey, secretKey: raw.secretKey };
  }
  return config;
}

export async function loadConfig(): Promise<Config> {
  const config = await loadSavedConfig();
  const env = process.env;
  // Environment wins over the file, so CI and one-off runs don't need `dom login`.
  if (env.PORKBUN_API_KEY && env.PORKBUN_SECRET_API_KEY) {
    config.accounts.porkbun = { apiKey: env.PORKBUN_API_KEY, secretKey: env.PORKBUN_SECRET_API_KEY };
  }
  if (env.NAMECHEAP_USERNAME && env.NAMECHEAP_API_KEY) {
    config.accounts.namecheap = {
      username: env.NAMECHEAP_USERNAME,
      apiKey: env.NAMECHEAP_API_KEY,
      clientIp: env.NAMECHEAP_CLIENT_IP || config.accounts.namecheap?.clientIp,
      sandbox: env.NAMECHEAP_SANDBOX === "1",
    };
  }
  return config;
}

export async function saveConfig(config: Config): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // writeFile's mode only applies when creating the file
  return path;
}

export async function deleteConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}
