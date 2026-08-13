import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { PcgConfig } from "./config.js";

export interface Principal {
	subject: string;
	clientId: string;
	scopes: ReadonlySet<string>;
}

export class OAuthError extends Error {
	constructor(
		message: string,
		readonly status: 401 | 403 = 401,
		readonly error: "invalid_token" | "insufficient_scope" = "invalid_token",
	) {
		super(message);
	}
}

export interface TokenVerifier {
	verify(
		authorization: string | undefined,
		requiredScope: string,
		allowedClientIds: ReadonlySet<string>,
	): Promise<Principal>;
	verifyAny(
		authorization: string | undefined,
		requiredScopes: readonly string[],
		allowedClientIds: ReadonlySet<string>,
	): Promise<Principal>;
}

export class JwtTokenVerifier implements TokenVerifier {
	private readonly keySet: ReturnType<typeof createRemoteJWKSet>;

	constructor(private readonly config: Pick<PcgConfig, "issuer" | "audience" | "jwksUrl">) {
		this.keySet = createRemoteJWKSet(config.jwksUrl, { cooldownDuration: 30_000, timeoutDuration: 5_000 });
	}

	async verify(
		authorization: string | undefined,
		requiredScope: string,
		allowedClientIds: ReadonlySet<string>,
	): Promise<Principal> {
		const principal = await this.parse(authorization, allowedClientIds);
		if (!principal.scopes.has(requiredScope)) {
			throw new OAuthError(`Required scope '${requiredScope}' is absent`, 403, "insufficient_scope");
		}
		return principal;
	}

	async verifyAny(
		authorization: string | undefined,
		requiredScopes: readonly string[],
		allowedClientIds: ReadonlySet<string>,
	): Promise<Principal> {
		const principal = await this.parse(authorization, allowedClientIds);
		if (!requiredScopes.some((scope) => principal.scopes.has(scope))) {
			throw new OAuthError(`One of the required scopes is absent`, 403, "insufficient_scope");
		}
		return principal;
	}

	private async parse(authorization: string | undefined, allowedClientIds: ReadonlySet<string>): Promise<Principal> {
		const token = bearerToken(authorization);
		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(token, this.keySet, {
				issuer: this.config.issuer,
				audience: this.config.audience,
				algorithms: ["RS256", "ES256", "EdDSA"],
				clockTolerance: 10,
			}));
		} catch {
			throw new OAuthError("Access token is invalid, expired, or not issued for PCG");
		}
		const subject = stringClaim(payload.sub, "sub");
		const clientId = stringClaim(payload.client_id ?? payload.azp, "client_id or azp");
		if (!allowedClientIds.has(clientId)) throw new OAuthError("OAuth client is not approved for PCG");
		return { subject, clientId, scopes: scopesFrom(payload.scope) };
	}
}

export class StaticTokenVerifier implements TokenVerifier {
	constructor(private readonly tokens: ReadonlyMap<string, Principal>) {}

	async verify(
		authorization: string | undefined,
		requiredScope: string,
		allowedClientIds: ReadonlySet<string>,
	): Promise<Principal> {
		const principal = this.parse(authorization, allowedClientIds);
		if (!principal.scopes.has(requiredScope)) {
			throw new OAuthError(`Required scope '${requiredScope}' is absent`, 403, "insufficient_scope");
		}
		return principal;
	}

	async verifyAny(
		authorization: string | undefined,
		requiredScopes: readonly string[],
		allowedClientIds: ReadonlySet<string>,
	): Promise<Principal> {
		const principal = this.parse(authorization, allowedClientIds);
		if (!requiredScopes.some((scope) => principal.scopes.has(scope))) {
			throw new OAuthError(`One of the required scopes is absent`, 403, "insufficient_scope");
		}
		return principal;
	}

	private parse(authorization: string | undefined, allowedClientIds: ReadonlySet<string>): Principal {
		const token = bearerToken(authorization);
		const principal = this.tokens.get(token);
		if (!principal || !allowedClientIds.has(principal.clientId)) throw new OAuthError("Access token is invalid");
		return principal;
	}
}

function bearerToken(authorization: string | undefined): string {
	if (!authorization?.startsWith("Bearer ")) throw new OAuthError("Bearer access token is required");
	const token = authorization.slice("Bearer ".length).trim();
	if (!token || token.length > 16_384) throw new OAuthError("Bearer access token is invalid");
	return token;
}

function stringClaim(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new OAuthError(`Token ${name} claim is required`);
	return value;
}

function scopesFrom(value: unknown): ReadonlySet<string> {
	if (typeof value !== "string") throw new OAuthError("Token scope claim is required");
	return new Set(value.split(/\s+/).filter(Boolean));
}
