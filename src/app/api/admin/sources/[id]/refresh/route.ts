import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { IngestError, refreshLinkSource } from "@/lib/ingest";

// Streams the same chunked/embedding/done/error NDJSON events as adding a
// source, so the admin page can reuse its existing progress UI.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthenticatedRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const result = await refreshLinkSource(id, send);
        send({ type: "done", source: result });
      } catch (err) {
        if (err instanceof IngestError) {
          send({ type: "error", message: err.message });
        } else {
          console.error("Failed to refresh source", err);
          send({ type: "error", message: "Failed to refresh source." });
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
