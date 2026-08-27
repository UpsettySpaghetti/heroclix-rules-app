import { randomUUID } from "crypto";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { getSupabaseAdmin, SOURCES_BUCKET } from "./supabase";
import { embedDocuments } from "./embeddings";
import { chunkText } from "./chunk";

export class IngestError extends Error {}

export type IngestProgressEvent =
  | { type: "chunked"; totalChunks: number }
  | { type: "embedding"; completed: number; total: number };

export type OnIngestProgress = (event: IngestProgressEvent) => void;

interface ExtractedText {
  text: string;
  // Per-page text, when the source format has a natural notion of pages
  // (currently just PDF) - lets chunks carry a "page N" citation label.
  pages?: { num: number; text: string }[];
}

async function extractFileText(
  fileName: string,
  mimeType: string,
  buffer: Buffer
): Promise<ExtractedText> {
  const ext = fileName.split(".").pop()?.toLowerCase();

  if (ext === "pdf" || mimeType === "application/pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return { text: result.text, pages: result.pages.map((p) => ({ num: p.num, text: p.text })) };
    } finally {
      await parser.destroy();
    }
  }

  if (
    ext === "docx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: value };
  }

  if (ext === "txt" || ext === "md" || mimeType.startsWith("text/")) {
    return { text: buffer.toString("utf-8") };
  }

  throw new IngestError(
    `Unsupported file type "${ext ?? mimeType}". Upload a PDF, DOCX, TXT, or MD file.`
  );
}

interface FetchedPage {
  title: string;
  // null when the page has no Readability-extractable "article" content -
  // e.g. a forum index or link-listing page. That's not a fetch failure:
  // the page is still worth visiting for its links, just not worth
  // indexing as a rules source in its own right.
  extracted: ExtractedText | null;
  // Every same-document <a href>, resolved to an absolute URL - used by the
  // crawler (lib/crawl.ts) to discover further pages. Readability mutates
  // the DOM it's given, so links are read from a separate, untouched parse
  // of the same HTML rather than reused from the Readability pass.
  links: string[];
}

// docs.google.com/document/{d,e}/<id>/... - the editor is a JS-rendered
// app, so a plain fetch() gets an empty shell rather than the document
// text. Google's own /export?format=html endpoint returns the same content
// as static HTML instead, which Readability can parse normally.
const GOOGLE_DOC_PATTERN = /^https:\/\/docs\.google\.com\/document\/(?:d|e)\/([\w-]+)/;

function googleDocsExportUrl(url: string): string | null {
  const match = url.match(GOOGLE_DOC_PATTERN);
  return match ? `https://docs.google.com/document/d/${match[1]}/export?format=html` : null;
}

// The export endpoint's HTML has no <title> at all (just content + inline
// styles), but the regular editor URL's shell does carry the real document
// name in its <title> even though its body is JS-rendered and unusable for
// content. A cheap second fetch just for that.
async function fetchGoogleDocTitle(editUrl: string): Promise<string | null> {
  try {
    const res = await fetch(editUrl, { headers: { "User-Agent": "HeroclixRulesBot/1.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<title>([^<]*)<\/title>/i);
    const title = match?.[1]?.replace(/ - Google Docs$/, "").trim();
    return title || null;
  } catch {
    return null;
  }
}

// A handful of well-known phrases that show up on bot-detection challenge
// pages (Cloudflare, etc.) instead of real content - lets us give a clear,
// specific error rather than a confusing "no readable content found".
const BOT_CHALLENGE_PHRASES = [
  "Just a moment...",
  "Attention Required! | Cloudflare",
  "Enable JavaScript and cookies to continue",
  "Checking your browser before accessing",
];

async function fetchPage(url: string): Promise<FetchedPage> {
  const googleDocsUrl = googleDocsExportUrl(url);
  const fetchUrl = googleDocsUrl ?? url;

  const res = await fetch(fetchUrl, { headers: { "User-Agent": "HeroclixRulesBot/1.0" } });

  if (googleDocsUrl && !res.url.startsWith("https://docs.google.com/")) {
    // Google redirected to a sign-in/consent page instead of serving the
    // export - the doc isn't shared publicly.
    throw new IngestError(
      `This Google Doc isn't publicly accessible. In the doc, use Share -> General access -> "Anyone with the link" (Viewer), then try again.`
    );
  }

  if (res.headers.get("x-amzn-waf-action")) {
    throw new IngestError(
      `${url} is protected by this site's bot detection, which blocked this request instead of returning the page. Try saving the page yourself and uploading it as a file instead.`
    );
  }

  if (!res.ok) {
    throw new IngestError(`Could not fetch ${url} (HTTP ${res.status})`);
  }

  const html = await res.text();

  if (!html.trim()) {
    throw new IngestError(
      `${url} returned an empty response - the site may be blocking automated requests. Try saving the page yourself and uploading it as a file instead.`
    );
  }
  if (BOT_CHALLENGE_PHRASES.some((phrase) => html.includes(phrase))) {
    throw new IngestError(
      `${url} appears to be protected by bot detection that blocks automated requests. Try saving the page yourself and uploading it as a file instead.`
    );
  }

  // linkedom doesn't auto-resolve relative hrefs the way jsdom's `url`
  // option did, so each one is resolved against the page URL by hand.
  const linksDoc = parseHTML(html, { url }).document;
  const links = Array.from(linksDoc.querySelectorAll("a[href]"))
    .map((a) => {
      try {
        return new URL(a.getAttribute("href") ?? "", url).toString();
      } catch {
        return null;
      }
    })
    .filter((href): href is string => href !== null);

  // Readability mutates the document it's given, so it needs its own parse
  // rather than reusing linksDoc.
  const articleDoc = parseHTML(html, { url }).document;
  const article = new Readability(articleDoc as unknown as Document).parse();
  const extracted = article?.textContent?.trim() ? { text: article.textContent } : null;

  const title = googleDocsUrl ? await fetchGoogleDocTitle(url) : article?.title;

  return { title: title || url, extracted, links };
}

async function storeChunks(
  sourceId: string,
  extracted: ExtractedText,
  onProgress?: OnIngestProgress
) {
  const pieces: { content: string; label: string | null }[] = [];

  if (extracted.pages?.length) {
    for (const page of extracted.pages) {
      for (const content of chunkText(page.text)) {
        pieces.push({ content, label: `page ${page.num}` });
      }
    }
  } else {
    for (const content of chunkText(extracted.text)) {
      pieces.push({ content, label: null });
    }
  }

  if (!pieces.length) {
    throw new IngestError("No text could be extracted from this source.");
  }

  onProgress?.({ type: "chunked", totalChunks: pieces.length });

  const embeddings = await embedDocuments(
    pieces.map((p) => p.content),
    (completed, total) => onProgress?.({ type: "embedding", completed, total })
  );
  const supabase = getSupabaseAdmin();

  const rows = pieces.map((piece, index) => ({
    id: randomUUID(),
    source_id: sourceId,
    content: piece.content,
    embedding: embeddings[index],
    chunk_index: index,
    label: piece.label,
  }));

  const { error } = await supabase.from("chunks").insert(rows);
  if (error) throw new IngestError(`Failed to save chunks: ${error.message}`);

  return pieces.length;
}

export interface IngestedSource {
  id: string;
  title: string;
  kind: "file" | "link";
  chunkCount: number;
}

export async function ingestFile(
  title: string,
  fileName: string,
  mimeType: string,
  buffer: Buffer,
  onProgress?: OnIngestProgress
): Promise<IngestedSource> {
  const extracted = await extractFileText(fileName, mimeType, buffer);
  const supabase = getSupabaseAdmin();
  const sourceId = randomUUID();
  const storagePath = `${sourceId}-${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from(SOURCES_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType || "application/octet-stream" });
  if (uploadError) {
    throw new IngestError(`Failed to store uploaded file: ${uploadError.message}`);
  }

  const { error: insertError } = await supabase.from("sources").insert({
    id: sourceId,
    title,
    kind: "file",
    storage_path: storagePath,
  });
  if (insertError) {
    throw new IngestError(`Failed to save source: ${insertError.message}`);
  }

  // The source row (and uploaded file) already exist at this point - if
  // chunking/embedding fails partway through, clean both up rather than
  // leaving a zero-chunk "ghost" source behind.
  try {
    const chunkCount = await storeChunks(sourceId, extracted, onProgress);
    return { id: sourceId, title, kind: "file", chunkCount };
  } catch (err) {
    await supabase.storage.from(SOURCES_BUCKET).remove([storagePath]).catch(() => {});
    await supabase.from("sources").delete().eq("id", sourceId);
    throw err;
  }
}

async function ingestLinkInternal(
  url: string,
  titleOverride: string | undefined,
  onProgress: OnIngestProgress | undefined,
  requireContent: boolean
): Promise<{ source: IngestedSource | null; links: string[] }> {
  const { title: extractedTitle, extracted, links } = await fetchPage(url);

  if (!extracted) {
    if (requireContent) {
      throw new IngestError(`Could not extract readable article text from ${url}`);
    }
    return { source: null, links };
  }

  const title = titleOverride?.trim() || extractedTitle;
  const supabase = getSupabaseAdmin();
  const sourceId = randomUUID();

  const { error: insertError } = await supabase.from("sources").insert({
    id: sourceId,
    title,
    kind: "link",
    origin_url: url,
  });
  if (insertError) {
    throw new IngestError(`Failed to save source: ${insertError.message}`);
  }

  try {
    const chunkCount = await storeChunks(sourceId, extracted, onProgress);
    return { source: { id: sourceId, title, kind: "link", chunkCount }, links };
  } catch (err) {
    await supabase.from("sources").delete().eq("id", sourceId);
    throw err;
  }
}

export async function ingestLink(
  url: string,
  titleOverride?: string,
  onProgress?: OnIngestProgress
): Promise<IngestedSource> {
  const { source } = await ingestLinkInternal(url, titleOverride, onProgress, true);
  // requireContent: true guarantees source is non-null here (or throws).
  return source as IngestedSource;
}

// Used by the crawler (lib/crawl.ts), which also needs the links discovered
// on each page in order to find the next pages to visit. Unlike ingestLink,
// a page with no indexable content isn't an error here - e.g. a forum
// index page is still worth visiting for its links to individual threads,
// even though the index page itself has nothing worth embedding.
export async function ingestLinkForCrawl(
  url: string,
  onProgress?: OnIngestProgress
): Promise<{ source: IngestedSource | null; links: string[] }> {
  return ingestLinkInternal(url, undefined, onProgress, false);
}

// Re-fetches a link-based source's current content and replaces its
// indexed chunks in place (same source id, title, and origin_url) - lets
// the admin pick up edits to a page/doc without deleting and re-adding it.
// New chunks are embedded and inserted *before* the old ones are removed,
// so a failed refresh (page now blocked, no content, etc.) leaves the
// previously-indexed content untouched rather than wiping it out.
export async function refreshLinkSource(
  sourceId: string,
  onProgress?: OnIngestProgress
): Promise<IngestedSource> {
  const supabase = getSupabaseAdmin();

  const { data: existing, error: fetchError } = await supabase
    .from("sources")
    .select("title, kind, origin_url")
    .eq("id", sourceId)
    .single();

  if (fetchError || !existing) {
    throw new IngestError("Source not found.");
  }
  if (existing.kind !== "link" || !existing.origin_url) {
    throw new IngestError("Only link-based sources can be refreshed.");
  }

  const { extracted } = await fetchPage(existing.origin_url);
  if (!extracted) {
    throw new IngestError(`Could not extract readable content from ${existing.origin_url}.`);
  }

  const { data: oldChunks } = await supabase.from("chunks").select("id").eq("source_id", sourceId);
  const oldChunkIds = (oldChunks ?? []).map((c) => c.id);

  const chunkCount = await storeChunks(sourceId, extracted, onProgress);

  if (oldChunkIds.length) {
    await supabase.from("chunks").delete().in("id", oldChunkIds);
  }

  return { id: sourceId, title: existing.title, kind: "link", chunkCount };
}
