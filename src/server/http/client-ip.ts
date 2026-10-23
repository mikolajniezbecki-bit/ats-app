// Client IP for the apply rate limit (tech-stack.md §3 rule 9, ats-project-scope.md
// F6): the Container Apps ingress address if present, otherwise the LAST
// x-forwarded-for entry (the client can set the first), otherwise 127.0.0.1.
// A value that isn't an IP address counts as absent. Pure; the address is
// never logged, only which source was used.
import { isIP } from "node:net";

export type IpSource = "envoy" | "xff-last" | "fallback";

/** Reads one header; with several values Headers joins them with ", ", so only the first header is used. */
type HeaderReader = { get(name: string): string | null };

function valid(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isIP(trimmed) ? trimmed : undefined;
}

export function getClientIp(headers: HeaderReader): { ip: string; source: IpSource } {
  const envoy = valid(headers.get("x-envoy-external-address"));
  if (envoy) return { ip: envoy, source: "envoy" };
  const forwarded = headers.get("x-forwarded-for");
  const last = valid(forwarded?.split(",").at(-1));
  if (last) return { ip: last, source: "xff-last" };
  return { ip: "127.0.0.1", source: "fallback" };
}

/** Expands an IPv6 address to its eight 16-bit groups (a dotted IPv4 tail counts as two). */
function ipv6Groups(ip: string): number[] {
  const parse = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [Number.parseInt(group, 16)];
          const [a, b, c, d] = group.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  if (!ip.includes("::")) return parse(ip);
  const [head, tail] = ip.split("::");
  const left = parse(head);
  const right = parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The rate-limit key: `apply:<ipv4>`, or `apply:<first 64 bits>::/64` for
 * IPv6, so a client can't rotate addresses inside its /64. IPv4-mapped
 * IPv6 (::ffff:1.2.3.4) counts as IPv4.
 */
export function rateLimitKeyForIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return `apply:${mapped[1]}`;
  if (isIP(ip) === 4) return `apply:${ip}`;
  const prefix = ipv6Groups(ip.split("%")[0].toLowerCase())
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":");
  return `apply:${prefix}::/64`;
}
