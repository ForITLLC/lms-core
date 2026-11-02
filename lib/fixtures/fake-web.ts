import { isIP, type LookupFunction } from "node:net";
import type { Resolver, Transport } from "@/lib/net/safe-fetch";

// A fake DNS and a server-free transport for lib/net/safe-fetch.ts tests. The
// transport connects the way net.connect does: an IP literal directly, a host
// name through the lookup it was handed, to the first address that lookup
// gives. Nothing touches the network.

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  // A streamed body, pulled one chunk at a time.
  chunks?: () => AsyncIterable<Uint8Array>;
  // The address the socket reports, when it differs from the one looked up.
  remoteAddress?: string;
  // Never answers until the request is aborted.
  hang?: boolean;
}

export type FakePage = FakeReply | ((hit: number) => FakeReply);

export interface Connection {
  host: string;
  address: string;
  url: string;
}

export function fakeWeb(dns: Record<string, string[]>, pages: Record<string, FakePage> = {}) {
  const connections: Connection[] = [];
  const lookups: string[] = [];
  const hits = new Map<string, number>();
  let destroyed = 0;

  const resolve: Resolver = async (host) => {
    lookups.push(host);
    const found = dns[host];
    if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: isIP(address) }));
  };

  const connect = (host: string, lookup: LookupFunction) =>
    new Promise<string>((resolved, failed) => {
      if (isIP(host)) {
        resolved(host);
        return;
      }
      lookup(host, { all: true }, (err, found) => {
        if (err) failed(err);
        else resolved(Array.isArray(found) ? found[0]!.address : found);
      });
    });

  const transport: Transport = async ({ url, lookup, signal }) => {
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const address = await connect(host, lookup);
    connections.push({ host, address, url: url.href });
    const hit = (hits.get(url.href) ?? 0) + 1;
    hits.set(url.href, hit);
    const page = pages[url.href];
    const reply: FakeReply = typeof page === "function"
      ? page(hit)
      : page ?? { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
    if (reply.hang) {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      });
    }
    const body = reply.chunks?.() ?? (async function* () {
      yield Buffer.from(reply.body ?? "");
    })();
    return {
      status: reply.status ?? 200,
      headers: Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      remoteAddress: reply.remoteAddress ?? address,
      body,
      destroy: () => {
        destroyed += 1;
      },
    };
  };

  return {
    resolve,
    transport,
    connections,
    lookups,
    hits,
    get destroyed() {
      return destroyed;
    },
  };
}
