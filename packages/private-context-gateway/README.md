# Primecord Private Context Gateway (PCG) v1

A **private, single-tenant, read-first** MCP service for explicitly exported
Primecord context. PCG is a separate service; it never exposes the Discord
bridge, the Prime Agent kernel, a live local daemon, or live user sessions.

> **Protocol boundary:** PCG serves only stateless MCP `2026-07-28` over
> Streamable HTTP, using the released official TypeScript v2 SDK. It implements
> `server/discover`, per-request metadata, standard HTTP-header validation,
> modern cancellation, cache result fields, and the SDK's MRTR/subscription
> machinery. It deliberately rejects legacy `initialize` traffic rather than
> silently falling back to a stateful session protocol.

## What it does

| Endpoint / tool | Authorization | Bound |
|---|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | Public RFC 9728 metadata | No context data |
| `POST /connector/v1/snapshots` | approved M2M client + `pcg.snapshot.write` | explicit pre-redacted snapshot, ≤64 KiB, expiry required |
| `POST /mcp` | approved user-delegated client + `memory:search` and/or `memory:read` | 256 KiB JSON request |
| `primecord.memory.search` | `memory:search`, ACL rechecked | query ≤256 chars, ≤20 results, opaque handles/citations/excerpts |
| `primecord.memory.read` | `memory:read`, ACL rechecked | opaque handle, ≤16 KiB result |

The MCP inventory itself is scope-filtered: a caller without `memory:read`
never sees the read tool. A snapshot’s owner/readers ACL is inside the
encrypted payload and is checked separately for both search and read.

## Deployment contract

PCG binds to `127.0.0.1` by default. Put **Caddy** (or the organization’s
existing TLS reverse proxy) in front of it. The proxy terminates HTTPS and
must overwrite—not forward client-supplied—`Host`, `Forwarded`, and
`X-Forwarded-*` headers. Do not publish the loopback PCG port.

### Required configuration

```dotenv
# The public canonical origin. No path, credentials, or fragment.
PRIME_PCG_PUBLIC_URL=https://pcg.example.com
# Must exactly be $PRIME_PCG_PUBLIC_URL/mcp.
PRIME_PCG_AUDIENCE=https://pcg.example.com/mcp

# Pocket ID’s exact issuer and JWKS endpoint; PCG validates signed JWTs locally.
PRIME_PCG_ISSUER=https://id.example.com
PRIME_PCG_JWKS_URL=https://id.example.com/api/oidc/jwks

# An absolute local persistent directory, mode 0700, outside a source checkout.
PRIME_PCG_DATA_DIR=/var/lib/primecord-pcg
# 32 random bytes, base64url encoded. Generate once, protect as a deployment secret.
PRIME_PCG_MASTER_KEY=REPLACE_WITH_32_RANDOM_BYTES_BASE64URL

# Pocket ID client IDs, pre-registered by an administrator.
# Agent client: Authorization Code + PKCE/S256; requests only the named user scopes.
PRIME_PCG_ALLOWED_CLIENT_IDS=primecord-approved-agent
# Connector: confidential client credentials; requests only pcg.snapshot.write.
PRIME_PCG_CONNECTOR_CLIENT_IDS=primecord-snapshot-connector

# Public browser origins allowed to submit a browser Origin header. Leave empty if
# callers are non-browser clients. An unknown present Origin is denied.
PRIME_PCG_ALLOWED_ORIGINS=https://agent.example.com

# PCG receives this exact Host header from the local reverse proxy. Add its local
# host:port only if the proxy passes it unchanged.
PRIME_PCG_ALLOWED_HOSTS=127.0.0.1:8787
# Only set if the reverse proxy writes a trusted Forwarded host value.
PRIME_PCG_ALLOWED_FORWARDED_HOSTS=pcg.example.com

# Optional private-tenant inventory ceiling; default 1000.
PRIME_PCG_MAX_SNAPSHOTS=1000
```

The config validates the canonical audience exactly: it must be the public URL
plus `/mcp`. Tokens must have a matching issuer, signature, expiry, audience,
client ID and required scope. PCG does not introspect tokens or host an
authorization server.

Configure the Pocket ID API resource as `https://pcg.example.com/mcp`, define
three focused permissions (`memory:search`, `memory:read`,
`pcg.snapshot.write`), and grant them only to the corresponding pre-registered
clients. PCG also recognizes its explicitly defined parent scope `memory` as a
broader grant for the two `memory:*` read scopes; do not use that parent unless
that broader access is intended. Dots and wildcard-like scope strings are not
implicitly hierarchical. Use Authorization Code + PKCE/S256 for a
human-approved agent and client credentials only for the connector.

### Caddy example

```caddy
pcg.example.com {
    reverse_proxy 127.0.0.1:8787 {
        # Do not relay client-controlled forwarding headers.
        header_up -Forwarded
        header_up -X-Forwarded-For
        header_up -X-Forwarded-Host
        header_up -X-Forwarded-Proto
        header_up Forwarded "host=pcg.example.com;proto=https"
        header_up Host "127.0.0.1:8787"
    }
}
```

Run the process with a service manager that supplies the configuration rather
than a committed `.env` file:

```sh
npm --prefix packages/private-context-gateway run build
node packages/private-context-gateway/dist/cli.js
```

## Connector contract

The connector makes an **outbound HTTPS** POST to the private PCG endpoint;
PCG never calls into or accepts a connection from a local Primecord install.
It must obtain its own Pocket ID M2M token for the exact PCG resource, send it
only in `Authorization: Bearer`, redact data before it is serialized, and
export only when a user/admin explicitly selects a snapshot.

```json
POST /connector/v1/snapshots
{
  "id": "a-new-opaque-random-id-at-least-16-characters",
  "owner": "user:alice",
  "readers": ["user:alice", "team:product"],
  "expiresAt": "2030-01-01T00:00:00.000Z",
  "citation": "Product decision record, approved export 2026-08-13",
  "content": "Already-redacted snapshot text"
}
```

`id` cannot be updated or reused. Re-export under a newly generated opaque ID.
Expiry is mandatory; expired records are removed when PCG starts and before a
new ingest. Retention is therefore the expiry selected at export, bounded by
the private deployment’s snapshot-count quota.

## Storage and audit

- Snapshot metadata (`id`, tenant, creation/expiry) is journaled; context,
  citation, owner, and reader identities are AES-256-GCM encrypted with
  associated tenant/id/expiry data. The snapshot file contains no plaintext
  context or ACL identity.
- Audit records are an append-only, fsync’d JSONL hash chain. They include time,
  action, principal, client ID, opaque resource ID, outcome, and result count—
  never context, citations, or bearer tokens.
- Copy both journals and the master key using the organization’s approved
  encrypted-backup process. Test restoring a copy before depending on it.
- Treat a failed audit-chain integrity check as a startup failure. Treat loss or
  exposure of the master key as an incident requiring snapshot invalidation and
  re-export.

## Explicit non-goals / deferrals

- `primecord.agent.ask`, job queue/status, writes, side effects, and approval
  automation.
- Automatic transcript export, a live Discord gateway proxy, or access to an
  active Prime Agent/session.
- Public multi-tenancy, dynamic client registration, PCG as an OAuth issuer,
  and client metadata URL fetching.
- Business-level change feeds or server-side jobs. The protocol-level
  `subscriptions/listen` mechanism is provided by the SDK, but PCG exposes no
  mutable context collection whose changes it publishes.
- Legacy HTTP+SSE, local stdio access, package-registry execution, and a
  legacy `initialize` compatibility endpoint.

## Validation

```sh
npm --prefix packages/private-context-gateway run test
npm --prefix packages/private-context-gateway run build
```

The tests cover protected-resource metadata/challenges, connector-only ingest,
encrypted-at-rest snapshots, modern `server/discover`, official-v2-client
interoperability, independent scope filtering, owner/reader ACLs, and read
limits. They are not a production security review.

## Sources

- [MCP 2026-07-28 Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP 2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Pocket ID API permissions](https://pocket-id.org/docs/guides/apis)
