import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, SOURCES_BUCKET } from "@/lib/supabase";
import { embedQuery } from "@/lib/embeddings";
import { answerQuestion, RetrievedChunk } from "@/lib/claude";

const MATCH_COUNT = 8;
// Just long enough for a visitor to click through from a fresh answer - the
// storage bucket is private, so links are signed fresh on every request
// rather than stored anywhere.
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

interface MatchRow {
  id: string;
  source_id: string;
  content: string;
  label: string | null;
  similarity: number;
  source_title: string;
  origin_url: string | null;
  source_kind: "file" | "link";
  storage_path: string | null;
}

// PDF chunks are labeled "page N" (see src/lib/ingest.ts) - browsers' native
// PDF viewers jump straight to that page given a #page=N fragment.
function pageAnchor(label: string | null): string {
  const match = label?.match(/^page (\d+)$/i);
  return match ? `#page=${match[1]}` : "";
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const question = body?.question;

  if (typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ error: "Provide a question." }, { status: 400 });
  }

  try {
    const queryEmbedding = await embedQuery(question.trim());
    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase.rpc("match_chunks", {
      query_embedding: queryEmbedding,
      match_count: MATCH_COUNT,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as MatchRow[];
    const chunks: RetrievedChunk[] = rows.map((r) => ({
      sourceId: r.source_id,
      sourceTitle: r.source_title,
      label: r.label,
      content: r.content,
    }));

    const { answer, confidence } = await answerQuestion(question.trim(), chunks);

    // Signed URLs so a citation for an uploaded file is clickable too, not
    // just link-based sources - generated fresh each request since the
    // storage bucket is private (nothing is ever made permanently public).
    const filePaths = [...new Set(rows.map((r) => r.storage_path).filter((p): p is string => !!p))];
    const signedUrls = new Map<string, string>();
    if (filePaths.length) {
      const { data: signed } = await supabase.storage
        .from(SOURCES_BUCKET)
        .createSignedUrls(filePaths, SIGNED_URL_EXPIRY_SECONDS);
      for (const s of signed ?? []) {
        if (s.signedUrl && !s.error) signedUrls.set(s.path ?? "", s.signedUrl);
      }
    }

    // One entry per excerpt, in the same order given to Claude, so a citation's
    // list position matches the [n] marker Claude used inline in the answer.
    const citations = rows.map((r, i) => {
      const baseUrl = r.origin_url ?? (r.storage_path ? signedUrls.get(r.storage_path) : null);
      return {
        index: i + 1,
        sourceId: r.source_id,
        title: r.source_title,
        label: r.label,
        url: baseUrl ? `${baseUrl}${pageAnchor(r.label)}` : null,
      };
    });

    return NextResponse.json({ answer, confidence, citations });
  } catch (err) {
    console.error("Failed to answer question", err);
    return NextResponse.json({ error: "Something went wrong answering that." }, { status: 500 });
  }
}
