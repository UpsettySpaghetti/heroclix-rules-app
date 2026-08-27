// Thin wrapper around the Voyage AI embeddings API (Anthropic's recommended
// embedding partner - Claude itself has no embeddings endpoint).
// https://docs.voyageai.com/reference/embeddings-api

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const EMBEDDING_MODEL = "voyage-3.5";
export const EMBEDDING_DIMENSIONS = 1024;

// Keeps each request's token count well under Voyage's 10K-tokens/minute
// cap for accounts with no payment method on file (~250-300 tokens per
// chunk at our chunk size, so 32 chunks stays comfortably under that even
// as a single request).
const BATCH_SIZE = 32;

// Accounts with no payment method on file are limited to 3 requests/minute
// (still using the same free 200M-token allowance - it's a rate cap, not a
// cost). Retrying after a 429 alone isn't enough: if two ingestions (or an
// ingestion and a visitor's question) fire requests back-to-back, they can
// keep tripping the cap on each other indefinitely. So every Voyage call -
// document batches and query lookups alike - goes through a single queue
// below that paces requests to stay under the limit in the first place;
// the retry-on-429 here is just a safety net on top of that.
const MIN_INTERVAL_MS = 21_000; // 60s / 3 requests, plus a small safety margin
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 22_000;

type VoyageInputType = "query" | "document";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serializes every Voyage request through this process so consecutive calls
// are always at least MIN_INTERVAL_MS apart, no matter how many callers
// (concurrent ingestions, a visitor's question) are asking for embeddings
// at once.
let queueTail: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function scheduleVoyageCall<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  // Swallow errors here so one failed call doesn't stall everyone queued
  // behind it - the real error still propagates to that call's own caller
  // via `result`.
  queueTail = result.catch(() => undefined);
  return result;
}

async function requestEmbeddings(
  input: string[],
  inputType: VoyageInputType,
  apiKey: string
): Promise<Response> {
  return fetch(VOYAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input,
      model: EMBEDDING_MODEL,
      input_type: inputType,
    }),
  });
}

async function callVoyage(input: string[], inputType: VoyageInputType): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY must be set (see .env.local.example)");
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await scheduleVoyageCall(() => requestEmbeddings(input, inputType, apiKey));

    if (res.ok) {
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const text = await res.text();
    throw new Error(`Voyage AI embedding request failed (${res.status}): ${text}`);
  }

  // Unreachable: the loop above always returns or throws.
  throw new Error("Voyage AI embedding request failed after retrying.");
}

export async function embedDocuments(
  texts: string[],
  onBatch?: (completed: number, total: number) => void
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await callVoyage(batch, "document");
    results.push(...embeddings);
    onBatch?.(results.length, texts.length);
  }
  return results;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await callVoyage([text], "query");
  return embedding;
}
