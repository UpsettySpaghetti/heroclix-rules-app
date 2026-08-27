"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Source {
  id: string;
  title: string;
  kind: "file" | "link";
  originUrl: string | null;
  addedAt: string;
  chunkCount: number;
}

interface Progress {
  completed: number;
  total: number;
  startedAt: number;
}

interface CrawlState {
  pagesDone: number;
  pagesSkipped: number;
  pagesFailed: number;
  currentUrl: string | null;
}

function now(): number {
  return Date.now();
}

type SourceSummary = { title: string; chunkCount: number };

// The union of every NDJSON line the ingest/crawl/refresh API routes can
// stream, plus the plain `{ error }` shape returned by early validation
// failures (which aren't streamed at all, just a single JSON body).
type StreamEvent =
  | { type: "chunked"; totalChunks: number }
  | { type: "embedding"; completed: number; total: number }
  | { type: "done"; source: SourceSummary }
  | { type: "crawl-page-start"; url: string; pageNumber: number }
  | { type: "crawl-page-progress"; url: string; completed: number; total: number }
  | { type: "crawl-page-done"; url: string; source: SourceSummary }
  | { type: "crawl-page-skipped"; url: string }
  | { type: "crawl-page-error"; url: string; message: string }
  | { type: "crawl-done"; pagesIndexed: number }
  | { type: "error"; message: string }
  | { error: string };

// Reads a streamed NDJSON response (one JSON object per line) as it
// arrives, yielding each parsed event - shared by both adding a source and
// refreshing one, since they stream the same event shapes.
async function* readNdjsonEvents(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as StreamEvent;
    }
  }
}

function formatEta(progress: Progress): string {
  if (progress.completed === 0) return "estimating time remaining...";
  const elapsedMs = now() - progress.startedAt;
  const msPerChunk = elapsedMs / progress.completed;
  const remainingMs = msPerChunk * (progress.total - progress.completed);
  if (remainingMs <= 1000) return "almost done";
  const totalSeconds = Math.round(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `~${minutes}m ${seconds}s remaining` : `~${seconds}s remaining`;
}

export default function AdminDashboard() {
  const router = useRouter();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [crawlState, setCrawlState] = useState<CrawlState | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileTitle, setFileTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [crawlMode, setCrawlMode] = useState(false);

  async function loadSources() {
    const res = await fetch("/api/admin/sources");
    if (!res.ok) {
      setError("Failed to load sources.");
      return;
    }
    const body = await res.json();
    setSources(body.sources);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/sources")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load sources."))))
      .then((body) => {
        if (!cancelled) setSources(body.sources);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load sources.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    await fetch("/api/admin/login", { method: "DELETE" });
    router.refresh();
  }

  async function submitForm(form: FormData) {
    setBusy(true);
    setError(null);
    setStatus(null);
    setProgress(null);
    setCrawlState(null);
    const startedAt = now();

    try {
      const res = await fetch("/api/admin/sources", { method: "POST", body: form });

      let finalError: string | null = null;
      let finalSource: { title: string; chunkCount: number } | null = null;
      let crawlSummary: { pagesIndexed: number; pagesFailed: number; pagesSkipped: number } | null =
        null;
      let pagesDone = 0;
      let pagesSkipped = 0;
      let pagesFailed = 0;
      let pageStartedAt = startedAt;

      for await (const event of readNdjsonEvents(res)) {
        if (!("type" in event)) {
          finalError = event.error;
          continue;
        }
        if (event.type === "chunked") {
          setProgress({ completed: 0, total: event.totalChunks, startedAt });
        } else if (event.type === "embedding") {
          setProgress({ completed: event.completed, total: event.total, startedAt });
        } else if (event.type === "done") {
          finalSource = event.source;
        } else if (event.type === "crawl-page-start") {
          pageStartedAt = now();
          setProgress(null);
          setCrawlState({ pagesDone, pagesSkipped, pagesFailed, currentUrl: event.url });
        } else if (event.type === "crawl-page-progress") {
          setProgress({ completed: event.completed, total: event.total, startedAt: pageStartedAt });
        } else if (event.type === "crawl-page-done") {
          pagesDone++;
          setProgress(null);
          setCrawlState({ pagesDone, pagesSkipped, pagesFailed, currentUrl: null });
        } else if (event.type === "crawl-page-skipped") {
          pagesSkipped++;
          setProgress(null);
          setCrawlState({ pagesDone, pagesSkipped, pagesFailed, currentUrl: null });
        } else if (event.type === "crawl-page-error") {
          pagesFailed++;
          setProgress(null);
          setCrawlState({ pagesDone, pagesSkipped, pagesFailed, currentUrl: null });
        } else if (event.type === "crawl-done") {
          crawlSummary = { pagesIndexed: event.pagesIndexed, pagesFailed, pagesSkipped };
        } else if (event.type === "error") {
          finalError = event.message;
        }
      }

      if (finalError) {
        setError(finalError);
        return;
      }
      if (!finalSource && !crawlSummary) {
        setError("Failed to add source.");
        return;
      }
      if (finalSource) {
        setStatus(`Added "${finalSource.title}" (${finalSource.chunkCount} chunks indexed).`);
        await loadSources();
      } else if (crawlSummary) {
        const notes = [
          crawlSummary.pagesSkipped ? `${crawlSummary.pagesSkipped} skipped (no content)` : null,
          crawlSummary.pagesFailed ? `${crawlSummary.pagesFailed} failed` : null,
        ].filter(Boolean);
        const suffix = notes.length ? ` (${notes.join(", ")})` : "";
        setStatus(`Crawled and indexed ${crawlSummary.pagesIndexed} page(s)${suffix}.`);
        await loadSources();
      }
    } catch {
      setError("Failed to add source.");
    } finally {
      setBusy(false);
      setProgress(null);
      setCrawlState(null);
    }
  }

  async function handleFileSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    if (fileTitle.trim()) form.set("title", fileTitle.trim());
    await submitForm(form);
    setFile(null);
    setFileTitle("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!linkUrl.trim()) return;
    const form = new FormData();
    form.set("url", linkUrl.trim());
    if (linkTitle.trim() && !crawlMode) form.set("title", linkTitle.trim());
    if (crawlMode) form.set("crawl", "true");
    await submitForm(form);
    setLinkUrl("");
    setLinkTitle("");
    setCrawlMode(false);
  }

  async function handleRefresh(id: string) {
    setBusy(true);
    setError(null);
    setStatus(null);
    setProgress(null);
    const startedAt = now();

    try {
      const res = await fetch(`/api/admin/sources/${id}/refresh`, { method: "POST" });

      let finalError: string | null = null;
      let finalSource: { title: string; chunkCount: number } | null = null;

      for await (const event of readNdjsonEvents(res)) {
        if (!("type" in event)) {
          finalError = event.error;
          continue;
        }
        if (event.type === "chunked") {
          setProgress({ completed: 0, total: event.totalChunks, startedAt });
        } else if (event.type === "embedding") {
          setProgress({ completed: event.completed, total: event.total, startedAt });
        } else if (event.type === "done") {
          finalSource = event.source;
        } else if (event.type === "error") {
          finalError = event.message;
        }
      }

      if (finalError) {
        setError(finalError);
        return;
      }
      if (!finalSource) {
        setError("Failed to refresh source.");
        return;
      }
      setStatus(`Refreshed "${finalSource.title}" (${finalSource.chunkCount} chunks indexed).`);
      await loadSources();
    } catch {
      setError("Failed to refresh source.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleDelete(id: string, title: string) {
    if (!confirm(`Remove "${title}" and everything indexed from it?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sources/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to delete source.");
        return;
      }
      await loadSources();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Rules sources</h1>
        <button onClick={handleLogout} className="text-sm text-slate-500 hover:text-slate-800">
          Sign out
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Only these sources are used to answer visitor questions on the public page.
      </p>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {status && (
        <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{status}</p>
      )}
      {busy && (
        <div className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {crawlState ? (
            <>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                <span>
                  Crawling - {crawlState.pagesDone} page{crawlState.pagesDone === 1 ? "" : "s"}{" "}
                  indexed
                  {crawlState.pagesSkipped > 0 ? `, ${crawlState.pagesSkipped} skipped` : ""}
                  {crawlState.pagesFailed > 0 ? `, ${crawlState.pagesFailed} failed` : ""}
                  {crawlState.currentUrl ? ` - now on ${crawlState.currentUrl}` : ""}
                </span>
              </div>
              {progress && (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      Embedding this page: chunk {progress.completed} of {progress.total}
                    </span>
                    <span>{formatEta(progress)}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-slate-900 transition-all"
                      style={{
                        width: `${Math.min(100, (progress.completed / Math.max(1, progress.total)) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              <p className="mt-1.5 text-xs text-slate-400">
                Crawling up to 50 pages within this site/section. It&apos;s safe to leave this tab
                open and come back.
              </p>
            </>
          ) : progress ? (
            <>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>
                  Embedding chunk {progress.completed} of {progress.total}
                </span>
                <span>{formatEta(progress)}</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-slate-900 transition-all"
                  style={{
                    width: `${Math.min(100, (progress.completed / Math.max(1, progress.total)) * 100)}%`,
                  }}
                />
              </div>
              <p className="mt-1.5 text-xs text-slate-400">
                Longer than expected? Voyage&apos;s free-tier rate limit may be forcing retries -
                it&apos;s safe to leave this tab open and come back.
              </p>
            </>
          ) : (
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
              Extracting text...
            </span>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <form
          onSubmit={handleFileSubmit}
          className="space-y-2 rounded-lg border border-slate-200 p-4"
        >
          <h2 className="text-sm font-medium text-slate-900">Upload a file</h2>
          <p className="text-xs text-slate-500">PDF, DOCX, TXT, or MD.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
          <input
            value={fileTitle}
            onChange={(e) => setFileTitle(e.target.value)}
            placeholder="Title (optional, defaults to filename)"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !file}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Adding..." : "Add file"}
          </button>
        </form>

        <form
          onSubmit={handleLinkSubmit}
          className="space-y-2 rounded-lg border border-slate-200 p-4"
        >
          <h2 className="text-sm font-medium text-slate-900">Add a link</h2>
          <p className="text-xs text-slate-500">A web page with rules text.</p>
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://..."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          {!crawlMode && (
            <input
              value={linkTitle}
              onChange={(e) => setLinkTitle(e.target.value)}
              placeholder="Title (optional, defaults to page title)"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          )}
          <label className="flex items-start gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={crawlMode}
              onChange={(e) => setCrawlMode(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Also crawl linked pages from this site (up to 50 pages, same domain and
              section only)
            </span>
          </label>
          <button
            type="submit"
            disabled={busy || !linkUrl.trim()}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Adding..." : crawlMode ? "Crawl and add" : "Add link"}
          </button>
        </form>
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-medium text-slate-900">
          Indexed sources {sources ? `(${sources.length})` : ""}
        </h2>
        {!sources && !error && <p className="mt-2 text-sm text-slate-500">Loading...</p>}
        {sources?.length === 0 && (
          <p className="mt-2 text-sm text-slate-500">No sources yet. Add one above.</p>
        )}
        <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200">
          {sources?.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{s.title}</p>
                <p className="text-xs text-slate-500">
                  {s.kind === "file" ? "Uploaded file" : "Link"} · {s.chunkCount} chunks
                  {s.originUrl && (
                    <>
                      {" "}
                      ·{" "}
                      <a
                        href={s.originUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        source
                      </a>
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {s.kind === "link" && (
                  <button
                    onClick={() => handleRefresh(s.id)}
                    disabled={busy}
                    className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-50"
                  >
                    Refresh
                  </button>
                )}
                <button
                  onClick={() => handleDelete(s.id, s.title)}
                  disabled={busy}
                  className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
