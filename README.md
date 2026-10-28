# dom

Buy and manage domains from your terminal, across registrars. Search, buy, renew, edit DNS and nameservers, and move domains off registrars whose websites you'd rather not use.

```
$ dom list
DOMAIN        REGISTRAR  EXPIRES     AUTORENEW  PRIVACY
oldsite.com   namecheap  2026-11-20  on         on
coolname.dev  porkbun    2027-10-28  on         on

$ dom dns oldsite.com add CNAME www cname.vercel-dns.com
✓ Added CNAME www → cname.vercel-dns.com

$ dom search coolname
DOMAIN        STATUS     1ST YEAR
coolname.com  taken
coolname.io   available  $28.12     renews $51.80
...

$ dom transfer mysquarespacesite.com
mysquarespacesite.com: Squarespace Domains II LLC → Porkbun
DNS is at the registrar, so dom copies your records to Porkbun first. Your site and email keep working.
```

## Supported registrars

| | Porkbun | Namecheap | Squarespace |
|---|---|---|---|
| List domains | ✓ | ✓ | no API, so move them with `dom transfer` |
| DNS records (list/add/edit/rm) | ✓ | ✓ (when using Namecheap DNS) | |
| Nameservers | ✓ | ✓ | |
| Renew | ✓ | ✓ | |
| Auto-renew on/off | ✓ | ✗ (not in their API) | |
| Transfer lock | | ✓ | |
| Search with prices / buy | ✓ | search only | |
| Transfer **in** | ✓ (`dom transfer`) | | |

Domain commands find the account a domain lives in automatically. Use `-r porkbun` / `-r namecheap` to choose one yourself.

## Install

```sh
git clone https://github.com/sagarvarma1/domain-cli.git
cd domain-cli
npm install      # also builds
npm link         # puts `dom` on your PATH (undo: npm unlink -g dom-cli)
```

Requires Node 20+. No runtime dependencies.

## Quick start

```sh
dom search coolname          # no account needed
dom login --sandbox          # instant test account with $1,000 of fake money
dom buy coolname.dev         # try the whole flow; nothing real is bought
dom login porkbun            # when you're ready: approve dom in your browser
```

**Searching needs no account.** Without one, `dom` asks each domain's registry directly over RDAP (the official public lookup that replaced WHOIS), and shows Porkbun's public prices. A few registries (.io, .co, .sh, .me) have no public lookup. For those, `dom` checks DNS and shows **likely free**, and `dom buy` confirms the exact availability and price.

**Buying needs your own Porkbun account.** You own your domains and pay Porkbun directly; `dom` never sits in between. Run `dom buy` without an account and dom offers to connect one on the spot.

## Connect your accounts

### Porkbun (buying, transfers, management)

1. `dom login porkbun` opens Porkbun in your browser. Sign in, or create an account, and click **Approve**. `dom` receives its key automatically, so there's nothing to copy or paste. It asks only for the permissions it uses: read, purchase, domains and DNS.
   - `dom login --sandbox` makes a throwaway test account with fake credit, for trying things out.
   - `dom login porkbun --manual` lets you paste keys from <https://porkbun.com/account/api> instead.
2. Purchases are paid from your **Porkbun account credit**, not your card. Add credit at <https://porkbun.com/account/credit>. Porkbun limits API spending to $100/month unless you change it.
3. Each domain needs **API access** turned on in Porkbun's dashboard. `dom list` flags any that don't have it.

### Namecheap (manage what you already have there)

1. Turn on API access at <https://ap.www.namecheap.com/settings/tools/apiaccess/>. Namecheap only allows this for accounts that meet a minimum (a few domains or some balance). Their page tells you whether yours qualifies.
2. On the same page, **whitelist your public IP**. `dom login namecheap` shows you which IP that is. If your IP changes (new Wi-Fi, VPN), add the new one, or pin one with `NAMECHEAP_CLIENT_IP`.
3. `dom login namecheap`

Namecheap's API replaces a domain's whole DNS zone on every write. `dom` always reads the current records, makes your one change, and writes everything back, keeping your email (MX) settings. If the domain's nameservers point somewhere other than Namecheap, `dom` refuses to write, because the change wouldn't do anything.

### Squarespace

Squarespace has no public API for domains or DNS, so no tool can manage them where they are. `dom transfer` moves them to Porkbun without downtime (see below). After that, everything works from the terminal.

Keys are saved to `~/.config/dom/config.json` (mode 600). For CI, use environment variables instead: `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY`, `NAMECHEAP_USERNAME`, `NAMECHEAP_API_KEY`, `NAMECHEAP_CLIENT_IP`.

## Moving a domain: `dom transfer`

```sh
dom transfer mysite.com              # walks you through it
dom transfer mysite.com --dry-run    # see the price and the DNS it would copy
dom transfers                        # check progress
```

What happens:

1. **Looks up** the current registrar and nameservers.
2. **Unlock + auth code.** For Namecheap domains, `dom` unlocks the domain for you; Namecheap then emails the auth code. For Squarespace, you turn off the transfer lock and copy the code on their site. This is the only website step. The code is entered hidden and never printed.
3. **Quote.** Porkbun checks the code, the price, and your credit without charging. A transfer adds a year to the current expiry.
4. **DNS copy.** If the DNS is hosted at the old registrar, the transfer is paid but held. `dom` copies your records into Porkbun: an exact copy via the Namecheap API, or Porkbun's scan of live DNS for Squarespace. You see the list before you confirm.
5. **Nameservers.** `dom` points the domain at Porkbun's nameservers, which already have your records, so nothing goes dark. On Namecheap this happens automatically. On Squarespace, `dom` shows you the nameservers to paste in.
6. **Release.** The transfer goes to the registry and usually takes 5–7 days. Approving the old registrar's confirmation email makes it faster.

If DNS is already hosted elsewhere (Cloudflare, Vercel, Route 53, …), nothing needs copying and the transfer just starts. If anything stops partway, `dom transfer <domain> --resume` picks up where it left off.

Domains registered or transferred in the last 60 days can't move yet. That's an ICANN rule.

## Commands

| Command | What it does |
|---|---|
| `dom login [porkbun\|namecheap]` | Connect an account |
| `dom accounts` / `dom balance` | Connected accounts and their credit |
| `dom list [--expiring 30]` | All domains, all accounts, soonest expiry first |
| `dom search <name\|domain>...` | Availability + price. A bare name tries your TLD list |
| `dom price [tld...]` | Register/renew/transfer prices (no login needed) |
| `dom buy <domain>` | Register for 1 year. Shows the exact cost and asks first |
| `dom renew <domain>` | Renew 1 year |
| `dom autorenew <domain> on\|off` | Toggle auto-renew |
| `dom lock\|unlock <domain>` | Transfer lock |
| `dom ns <domain> [set ns1 ns2 …\|default]` | Show or replace nameservers |
| `dom dns <domain>` | List DNS records |
| `dom dns <domain> add <type> <name> <content>` | Add a record (`@` = apex), `--ttl`, `--prio` |
| `dom dns <domain> edit <id> --content …` | Change a record |
| `dom dns <domain> rm <id>` | Delete a record |
| `dom transfer <domain>` / `dom transfers` | Move a domain to Porkbun / check progress |
| `dom config set tlds com,dev,io` | Default TLDs for `search` |

Global flags: `--json` (scriptable output), `-y/--yes` (skip prompts), `--dry-run` (buy/renew/transfer: quote only), `-r <registrar>`, `--mock` (Porkbun's mock API, no keys, canned data).

## Safety

- Anything that costs money gets a **quote first** (a Porkbun dry run, or Namecheap's price list plus your balance) and waits for your `y`. Outside a terminal, it needs `--yes`.
- Porkbun purchases send a unique `Idempotency-Key`, so a retried request can't charge you twice.
- DNS deletes and nameserver changes show what will change and ask first.
- Premium domains can't be bought through registrar APIs. `dom` tells you to use the website for those.

## Development

```sh
npm test                        # build + run tests (fake registrar APIs, no network)
node dist/src/cli.js list --mock
```

```
src/cli.ts         entry point
src/app.ts         argument parsing and commands
src/transfer.ts    `dom transfer`: no-downtime move to Porkbun
src/accounts.ts    connected accounts, finding which one holds a domain
src/login.ts       browser approval login (PKCE) and sandbox accounts
src/lookup.ts      account-free availability via RDAP, with DNS fallback
src/registrar.ts   provider-neutral interface + types
src/porkbun.ts     Porkbun API v3 client (JSON)
src/namecheap.ts   Namecheap API client (XML)
src/xml.ts         minimal XML reader for Namecheap
src/config.ts      ~/.config/dom/config.json + env vars
src/ui.ts, output.ts  tables, colors, prompts
```

### Adding a registrar

1. Implement `Registrar` from `src/registrar.ts` in `src/<name>.ts`. Optional methods (`register`, `setAutoRenew`, `setLock`, …) can be left out, and `dom` reports them as unsupported.
2. Add it to `REGISTRARS` and `openAccounts` in `src/accounts.ts`, and its credentials to `Config` in `src/config.ts`.
3. Add a `login` flow in `src/app.ts`, and tests with a fake API in `test/` (see `test/helpers.ts`).

Wanted: Cloudflare, GoDaddy, Name.com, Gandi, Dynadot. PRs welcome.

## License

MIT
