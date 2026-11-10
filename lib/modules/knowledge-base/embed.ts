import { ManagedIdentityCredential } from "@azure/identity";
import type { KbEmbeddingEnv } from "./env";
import { KB_EMBEDDING_DIMENSIONS } from "./vector";

/**
 * Turns passages into vectors with Azure OpenAI (`text-embedding-3-small` on
 * the KB's Foundry resource), through the OpenAI-compatible v1 API:
 *
 *   POST https://<resource host>/openai/v1/embeddings
 *   { "model": "<deployment name>", "input": ["...", "..."] }
 *
 * The endpoint variable may be the resource's base URL or the "Target URI"
 * Foundry shows for the deployment; only its scheme and host are used, so
 * either works and an api-version in it is ignored.
 *
 * Authentication: an `api-key` locally (KB_EMBEDDING_API_KEY), the
 * platform's managed identity in production (role Cognitive Services OpenAI
 * User on the resource), never a key there - env.ts refuses one.
 *
 * The model's name is recorded on every vector (kb_chunks.embedding_model).
 * A different model is a different space: its vectors cannot be compared with
 * these, so changing it is a migration plus a full re-embed.
 */

export const KB_EMBEDDING_MODEL = "text-embedding-3-small";

/** Entra audience for the Azure OpenAI v1 API (Foundry docs, 2026). */
export const KB_EMBEDDING_TOKEN_SCOPE = "https://ai.azure.com/.default";

const RETRIES = 6;
const MAX_WAIT_S = 60;

export type KbEmbedding = { vectors: number[][]; tokens: number };

/** Embeds a batch, in order. Throws KbEmbeddingError when the service refuses. */
export type KbEmbedder = (texts: string[]) => Promise<KbEmbedding>;

export class KbEmbeddingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KbEmbeddingError";
  }
}

export type EmbeddingFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The v1 embeddings URL on the endpoint's host. */
export function embeddingsUrl(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}/openai/v1/embeddings`;
}

export function azureEmbedder(
  env: KbEmbeddingEnv,
  options: {
    fetchImpl?: EmbeddingFetch;
    /** Production: a bearer token from the managed identity. */
    getToken?: () => Promise<string>;
    sleep?: (ms: number) => Promise<void>;
    /** Tries per batch. The sync waits out quota (6); a person searching should not (search uses 2). */
    maxAttempts?: number;
    /** Abandon one request after this long. Unset: no limit beyond the platform's. */
    timeoutMs?: number;
  } = {},
): KbEmbedder {
  const attempts = options.maxAttempts ?? RETRIES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = embeddingsUrl(env.endpoint);
  if (env.apiKey === null && !options.getToken && process.env.NODE_ENV !== "production") {
    // Outside Azure there is no managed identity to ask; say what to set.
    throw new KbEmbeddingError("Set KB_EMBEDDING_API_KEY in .env.local (production uses the managed identity).", 0);
  }
  const getToken = env.apiKey === null ? (options.getToken ?? managedIdentityToken()) : null;

  return async (texts) => {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const body = JSON.stringify({ model: env.deployment, input: texts });

    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.apiKey !== null) headers["api-key"] = env.apiKey;
      else headers.Authorization = `Bearer ${await getToken!()}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
        });
      } catch (error) {
        const reason = networkReason(error);
        // A name that does not resolve or a certificate Node will not trust
        // does not fix itself in a minute; say so at once.
        if (reason.permanent || attempt >= attempts) {
          throw new KbEmbeddingError(`Could not reach ${url}: ${reason.text}`, 0);
        }
        await sleep(Math.min(2 ** attempt, MAX_WAIT_S) * 1000);
        continue;
      }

      const retry = response.status === 429 || response.status >= 500;
      if (retry && attempt < attempts) {
        // Azure says how long the quota needs; otherwise back off.
        const header = Number(response.headers.get("retry-after") ?? Number.NaN);
        await sleep(Math.min(Number.isFinite(header) ? header : 2 ** attempt, MAX_WAIT_S) * 1000);
        continue;
      }
      if (!response.ok) throw await embeddingError(response, env);

      const json = (await response.json()) as {
        data?: { index: number; embedding: number[] }[];
        usage?: { total_tokens?: number; prompt_tokens?: number };
      };
      const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== texts.length) {
        throw new KbEmbeddingError(`Asked for ${texts.length} embeddings and got ${data.length}.`, response.status);
      }
      for (const item of data) {
        if (!Array.isArray(item.embedding) || item.embedding.length !== KB_EMBEDDING_DIMENSIONS) {
          throw new KbEmbeddingError(
            `The deployment returned ${item.embedding?.length ?? 0}-dimension vectors; kb_chunks.embedding is ` +
              `vector(${KB_EMBEDDING_DIMENSIONS}). Is "${env.deployment}" a ${KB_EMBEDDING_MODEL} deployment?`,
            response.status,
          );
        }
      }
      return {
        vectors: data.map((d) => d.embedding),
        tokens: json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0,
      };
    }
  };
}

async function embeddingError(response: Response, env: KbEmbeddingEnv): Promise<KbEmbeddingError> {
  const text = await response.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const err = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
    if (err) detail = `${err.code ?? "error"}: ${err.message ?? ""}`;
  } catch {
    /* keep the raw text */
  }
  const hint =
    response.status === 401
      ? " The key or token was refused: check KB_EMBEDDING_API_KEY locally, or the managed identity in production."
      : response.status === 403
        ? " The identity has no Cognitive Services OpenAI User role on the resource."
        : response.status === 404
          ? ` No deployment named "${env.deployment}" on this resource, or the endpoint is not the Foundry resource.`
          : "";
  return new KbEmbeddingError(`Azure OpenAI answered ${response.status} (${detail}).${hint}`, response.status);
}

const CERTIFICATE_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
]);

/**
 * Node's fetch says only "fetch failed"; the reason is on `cause`. Named here
 * with what to do, because the three likely ones need different people.
 */
export function networkReason(error: unknown): { text: string; permanent: boolean } {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code ?? "";
  const detail = cause?.message ?? (error instanceof Error ? error.message : String(error));
  if (code === "ENOTFOUND") {
    return { text: `${detail}. The host name does not resolve: check the endpoint's spelling, or the network/VPN.`, permanent: true };
  }
  if (CERTIFICATE_CODES.has(code)) {
    return {
      text:
        `${detail} (${code}). Something on this network is inspecting HTTPS with a certificate Node does not trust ` +
        "(a corporate proxy). Start Node with NODE_OPTIONS=--use-system-ca so it uses the Windows certificate store, " +
        "or point NODE_EXTRA_CA_CERTS at the proxy's root certificate. runbook.md -> Knowledge Base embeddings.",
      permanent: true,
    };
  }
  return { text: code ? `${detail} (${code})` : detail, permanent: false };
}

function managedIdentityToken(): () => Promise<string> {
  const clientId = process.env.GRAPH_MANAGED_IDENTITY_CLIENT_ID?.trim();
  const credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
  return async () => {
    const token = await credential.getToken(KB_EMBEDDING_TOKEN_SCOPE);
    if (!token) throw new KbEmbeddingError("The managed identity returned no token for Azure OpenAI.", 0);
    return token.token;
  };
}

/**
 * What is embedded for a passage: where it is from, then the passage. The
 * file name and location carry meaning the text alone often lacks ("Air
 * Valves submittal, page 14"), so a question about a submittal can find it
 * even when the page itself only says "AV-1 1,200".
 */
export function embeddingInput(passage: {
  content: string;
  fileName: string;
  projectFolder: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  sheet: string | null;
  cellRange: string | null;
}): string {
  const where = passage.sheet
    ? `sheet ${passage.sheet}${passage.cellRange ? ` ${passage.cellRange}` : ""}`
    : passage.pageStart !== null
      ? passage.pageEnd !== null && passage.pageEnd !== passage.pageStart
        ? `pages ${passage.pageStart}-${passage.pageEnd}`
        : `page ${passage.pageStart}`
      : passage.section
        ? `section ${passage.section}`
        : "";
  const title = passage.fileName.replace(/\.[^.]+$/, "").replace(/_/g, " ");
  return `${title} (${passage.projectFolder}${where ? `, ${where}` : ""})\n${passage.content}`;
}
