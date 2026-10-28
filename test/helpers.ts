type Call = { url: string; body: Record<string, any>; headers: Record<string, string> };
type Reply = { status?: number; json?: unknown; text?: string };

/**
 * A fetch stand-in that records every request. Porkbun calls are routed by path
 * (`routes`), Namecheap calls by their `Command` (`namecheap`, answering with the
 * inner XML of <CommandResponse>), and the IP / RDAP lookups get canned answers.
 */
export function fakeFetch(
  routes: Record<string, (body: any) => Reply>,
  namecheap: Record<string, (params: Record<string, string>) => string> = {},
) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("ipify")) return new Response(JSON.stringify({ ip: "203.0.113.7" }));
    if (url.includes("rdap.org")) return new Response("{}", { status: 404 });

    if (url.includes("namecheap.com")) {
      const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
      calls.push({ url, body: params, headers: init?.headers as Record<string, string> });
      const handler = namecheap[params.Command!];
      const inner = handler?.(params);
      const xml =
        inner === undefined
          ? `<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors><Error Number="9999">no fake for ${params.Command}</Error></Errors></ApiResponse>`
          : inner.startsWith("<ApiResponse")
            ? inner
            : `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response"><Errors /><Warnings /><CommandResponse Type="${params.Command}">${inner}</CommandResponse></ApiResponse>`;
      return new Response(xml);
    }

    const path = url.replace(/^https:\/\/[^/]+\/api\/json\/v3/, "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({ status: "ERROR", code: "NOT_FOUND", message: `no route ${path}` }), { status: 404 });
    const { status = 200, json, text } = route(body);
    return new Response(text ?? JSON.stringify(json), { status, headers: { "retry-after": "7" } });
  }) as typeof fetch;
  return { impl, calls };
}

/** A tiny in-memory Namecheap DNS zone that round-trips getHosts / setHosts like the real API. */
export function namecheapZone(domain: string, initial: { name: string; type: string; address: string; ttl?: number; mxPref?: number }[], emailType = "NONE") {
  let hosts = initial.map((h, i) => ({ id: String(100 + i), ttl: 1799, ...h }));
  let email = emailType;
  let nextId = 500;
  const state = {
    get hosts() {
      return hosts;
    },
    get emailType() {
      return email;
    },
    handlers: {
      "namecheap.domains.dns.getHosts": () =>
        `<DomainDNSGetHostsResult Domain="${domain}" EmailType="${email}" IsUsingOurDNS="true">` +
        hosts
          .map(
            (h) =>
              `<host HostId="${h.id}" Name="${h.name}" Type="${h.type}" Address="${h.address.replace(/"/g, "&quot;")}" MXPref="${h.mxPref ?? 10}" TTL="${h.ttl}" IsActive="true" />`,
          )
          .join("") +
        `</DomainDNSGetHostsResult>`,
      "namecheap.domains.dns.setHosts": (p: Record<string, string>) => {
        email = p.EmailType ?? "NONE";
        const next: typeof hosts = [];
        for (let i = 1; p[`HostName${i}`] !== undefined; i++) {
          next.push({
            id: String(nextId++),
            name: p[`HostName${i}`]!,
            type: p[`RecordType${i}`]!,
            address: p[`Address${i}`]!,
            ttl: Number(p[`TTL${i}`]),
            ...(p[`MXPref${i}`] ? { mxPref: Number(p[`MXPref${i}`]) } : {}),
          });
        }
        hosts = next;
        return `<DomainDNSSetHostsResult Domain="${domain}" IsSuccess="true" />`;
      },
    },
  };
  return state;
}
