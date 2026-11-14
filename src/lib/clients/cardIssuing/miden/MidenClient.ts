import { CardProviderApiError } from "../../../../domain/errors/CardProviderErrors.js";
import { newReference, sign } from "./signature.js";

export interface MidenConfig {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  uniqueKey: string;
  fetch?: typeof fetch;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): MidenConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`Missing env var ${k}`);
    return v;
  };
  return {
    baseUrl: need("MIDEN_BASE_URL"),
    tokenUrl: need("MIDEN_TOKEN_URL"),
    clientId: need("MIDEN_CLIENT_ID"),
    clientSecret: need("MIDEN_CLIENT_SECRET"),
    uniqueKey: need("MIDEN_UNIQUE_KEY"),
  };
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Non-2xx response from Miden. `body` is the raw response text. */
export class MidenApiError extends CardProviderApiError {
  constructor(
    readonly method: string,
    readonly path: string,
    status: number,
    body: string,
  ) {
    // The body stays on `.body`, out of `.message`: an error body may echo request data (PII, kycToken) into logs.
    super(`Miden ${method} ${path} failed: ${status}`, status, body);
    this.name = "MidenApiError";
  }
}

/** Thin signed client for the Miden Workspace API. */
export class MidenClient {
  private token?: { value: string; expiresAt: number };
  private readonly f: typeof fetch;

  constructor(private readonly cfg: MidenConfig) {
    this.f = cfg.fetch ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.f(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Miden token request failed: ${res.status}`);
    // Sandbox response (2026-10-19): { access_token, expires_in: 3600, token_type: "Bearer", scope: "CardAPIs" }.
    const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== "string" || !json.access_token || typeof json.expires_in !== "number") {
      throw new Error("Miden token response missing access_token or expires_in");
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  /**
   * `opts.reference` becomes the Reference header, which Miden uses as its 24h
   * idempotency key: pass a stable value to retry safely (same body), omit it for a fresh one.
   */
  async request<T>(method: string, path: string, body?: unknown, opts: { reference?: string; timeoutMs?: number } = {}): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const reference = opts.reference ?? newReference();
    const res = await this.f(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Reference: reference,
        Signature: sign({ method, url, reference, clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }),
        UniqueKey: this.cfg.uniqueKey,
        MidenAuthorization: `MidenAuth ${Buffer.from(this.cfg.clientId).toString("base64")}`,
        Authorization: `Bearer ${await this.accessToken()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A hung call must not hold a payment or a top-up open forever; a timeout is an indeterminate result.
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new MidenApiError(method, path, res.status, await res.text());
    return (await res.json()) as T;
  }
}
