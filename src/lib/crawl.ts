import { IngestError, IngestedSource, ingestLinkForCrawl } from "./ingest";

export const MAX_CRAWL_PAGES = 50;
// A hard cap on pages *visited* (indexed or not), separate from the
// indexed-page cap above - protects against a site made mostly of
// navigation/listing pages (which don't count toward MAX_CRAWL_PAGES)
// wandering through an unbounded number of pages before finding content.
const MAX_PAGES_VISITED = MAX_CRAWL_PAGES * 3;

export type CrawlEvent =
  | { type: "crawl-page-start"; url: string; pageNumber: number }
  | { type: "crawl-page-progress"; url: string; completed: number; total: number }
  | { type: "crawl-page-done"; url: string; source: IngestedSource }
  // A page with no Readability-extractable content (e.g. a forum index or
  // link-listing page) - not indexed as a source, but still crawled for
  // its links.
  | { type: "crawl-page-skipped"; url: string }
  | { type: "crawl-page-error"; url: string; message: string }
  | { type: "crawl-done"; pagesIndexed: number };

function normalize(url: URL): string {
  url.hash = "";
  return url.toString();
}

// A link only counts as "part of this site" if it's the same origin AND
// under the same directory as the page the crawl started from - so
// starting at example.com/rules/ stays within /rules/ and won't wander off
// into example.com/blog/ or another domain entirely.
function isInScope(candidate: URL, root: URL): boolean {
  if (candidate.origin !== root.origin) return false;
  const rootDir = root.pathname.replace(/[^/]*$/, "");
  return candidate.pathname.startsWith(rootDir);
}

export async function crawlSite(
  startUrl: string,
  onEvent: (event: CrawlEvent) => void
): Promise<{ pagesIndexed: number }> {
  const root = new URL(startUrl);
  const visited = new Set<string>();
  const queue: string[] = [normalize(root)];
  let pagesIndexed = 0;

  while (queue.length > 0 && pagesIndexed < MAX_CRAWL_PAGES && visited.size < MAX_PAGES_VISITED) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    onEvent({ type: "crawl-page-start", url, pageNumber: visited.size });

    try {
      const { source, links } = await ingestLinkForCrawl(url, (event) => {
        if (event.type === "embedding") {
          onEvent({ type: "crawl-page-progress", url, completed: event.completed, total: event.total });
        }
      });

      if (source) {
        pagesIndexed++;
        onEvent({ type: "crawl-page-done", url, source });
      } else {
        onEvent({ type: "crawl-page-skipped", url });
      }

      for (const link of links) {
        let linkUrl: URL;
        try {
          linkUrl = new URL(link);
        } catch {
          continue; // malformed href
        }
        if (linkUrl.protocol !== "http:" && linkUrl.protocol !== "https:") continue;

        const normalized = normalize(linkUrl);
        if (!visited.has(normalized) && isInScope(linkUrl, root)) {
          queue.push(normalized);
        }
      }
    } catch (err) {
      const message = err instanceof IngestError ? err.message : "Failed to index this page.";
      onEvent({ type: "crawl-page-error", url, message });
    }
  }

  onEvent({ type: "crawl-done", pagesIndexed });
  return { pagesIndexed };
}
