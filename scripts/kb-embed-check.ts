import "./load-env";

/**
 * Checks the Azure OpenAI embedding configuration with one request, and
 * touches no database.
 *
 *   npm run kb:embed:check
 *
 * Reads KB_EMBEDDING_ENDPOINT, KB_EMBEDDING_DEPLOYMENT and (locally)
 * KB_EMBEDDING_API_KEY, embeds two short passages, and prints the URL it
 * called, the width of the vectors, the tokens Azure counted, how long it
 * took, and how alike the two passages came out. A failure prints Azure's
 * own reason. runbook.md -> "Knowledge Base embeddings".
 */

async function main() {
  const { readKbEmbeddingEnv } = await import("../lib/modules/knowledge-base/env");
  const { azureEmbedder, embeddingsUrl } = await import("../lib/modules/knowledge-base/embed");

  const env = readKbEmbeddingEnv();
  if (!env.present) {
    console.error(`Not configured. Set in .env.local: ${env.missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Calling ${embeddingsUrl(env.values.endpoint)} with deployment "${env.values.deployment}"`);
  console.log(`Authentication: ${env.values.apiKey ? "api-key" : "managed identity"}`);

  const started = Date.now();
  const { vectors, tokens } = await azureEmbedder(env.values)([
    "Supply air valve AV-1, 1,200 CFM, approved submittal",
    "Venturi air valve for supply airflow, approved",
  ]);
  const [a, b] = vectors;
  const dot = a!.reduce((sum, x, i) => sum + x * b![i]!, 0);
  const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  console.log(`OK in ${Date.now() - started} ms: ${vectors.length} vectors of ${a!.length} dimensions, ${tokens} tokens.`);
  console.log(`Cosine similarity of the two passages: ${(dot / (norm(a!) * norm(b!))).toFixed(3)}. Related passages score clearly higher than unrelated ones.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
