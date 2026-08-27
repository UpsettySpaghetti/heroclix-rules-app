import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { IngestError, ingestFile, ingestLink } from "@/lib/ingest";
import { crawlSite } from "@/lib/crawl";

// File uploads and crawls can legitimately run for minutes (many chunks to
// embed, or many pages to crawl); Vercel's default function timeout is far
// too short for that. 300s is the current cap on Vercel's free Hobby tier.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!isAuthenticatedRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sources")
    .select("id, title, kind, origin_url, added_at, chunks(count)")
    .order("added_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const sources = (data ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    kind: s.kind,
    originUrl: s.origin_url,
    addedAt: s.added_at,
    chunkCount: Array.isArray(s.chunks) ? (s.chunks[0]?.count ?? 0) : 0,
  }));

  return NextResponse.json({ sources });
}

// Streams newline-delimited JSON progress events as ingestion runs, so the
// admin page can show a live "chunk N of M" progress bar with an ETA
// instead of a single request that goes silent until it either finishes or
// fails - large PDFs can take several minutes, especially if Voyage's rate
// limit kicks in and ingestion has to retry.
export async function POST(req: NextRequest) {
  if (!isAuthenticatedRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  const url = form.get("url");
  const title = form.get("title");
  const crawl = form.get("crawl") === "true";

  if (!(file instanceof File) && !(typeof url === "string" && url.trim())) {
    return NextResponse.json(
      { error: "Provide either a file upload or a url field." },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        if (file instanceof File) {
          const result = await ingestFile(
            typeof title === "string" && title.trim() ? title.trim() : file.name,
            file.name,
            file.type,
            Buffer.from(await file.arrayBuffer()),
            send
          );
          send({ type: "done", source: result });
        } else if (crawl) {
          await crawlSite((url as string).trim(), send);
        } else {
          const result = await ingestLink(
            (url as string).trim(),
            typeof title === "string" ? title : undefined,
            send
          );
          send({ type: "done", source: result });
        }
      } catch (err) {
        if (err instanceof IngestError) {
          send({ type: "error", message: err.message });
        } else {
          console.error("Failed to ingest source", err);
          send({ type: "error", message: "Failed to add source." });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
