import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

type ResolvedAddress = { address: string; family: number };
type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export class EndpointPolicyError extends Error {
  readonly code = "INVALID_ENDPOINT" as const;

  constructor() {
    super("AI 服务地址必须是可公开访问的 HTTPS 地址，或受支持的本机 Ollama 地址。");
    this.name = "EndpointPolicyError";
  }
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4) return false;
    const [a, b, c] = octets;
    if (a === undefined || b === undefined) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (family === 6) {
    // URL canonicalization handles expanded and dotted IPv6 spellings consistently.
    let normalized: string;
    try {
      normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
      return false;
    }
    const [left = "", right = ""] = normalized.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const words = normalized.includes("::")
      ? [...start, ...Array(8 - start.length - end.length).fill("0"), ...end].map((word) =>
          Number.parseInt(word, 16),
        )
      : start.map((word) => Number.parseInt(word, 16));
    if (words.length !== 8) return false;
    const [first, second, , , , , high, low] = words;
    if (first === undefined || second === undefined || high === undefined || low === undefined)
      return false;
    const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    const dns64 =
      words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
    if (mapped || dns64) {
      return isPublicAddress([high >> 8, high & 255, low >> 8, low & 255].join("."));
    }
    // Only ordinary global unicast; exclude special-purpose/tunnel/documentation ranges.
    // IANA: iana-ipv6-special-registry. Tunnel encodings must not hide private IPv4.
    return (
      (first & 0xe000) === 0x2000 &&
      first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
      !(first === 0x3fff && second < 0x1000)
    );
  }
  return false;
}

const systemResolver: Resolver = async (hostname) =>
  await lookup(hostname, { all: true, verbatim: true });

export async function resolveAiEndpoint(
  endpoint: URL,
  resolver: Resolver = systemResolver,
): Promise<{ hostname: string; addresses: string[] }> {
  const isOllamaLoopback =
    endpoint.protocol === "http:" &&
    endpoint.hostname === "127.0.0.1" &&
    endpoint.port === "11434" &&
    (endpoint.pathname === "/v1" || endpoint.pathname === "/v1/chat/completions") &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash;
  if (isOllamaLoopback) {
    return { hostname: endpoint.hostname, addresses: [endpoint.hostname] };
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname.endsWith(".localhost")
  ) {
    throw new EndpointPolicyError();
  }
  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new EndpointPolicyError();
  const resolved = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname);
  if (resolved.length === 0 || resolved.some(({ address }) => !isPublicAddress(address))) {
    throw new EndpointPolicyError();
  }
  return { hostname, addresses: resolved.map(({ address }) => address) };
}
