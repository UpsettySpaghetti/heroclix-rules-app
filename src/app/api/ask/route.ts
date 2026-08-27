import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { embedQuery } from "@/lib/embeddings";
import { answerQuestion, RetrievedChunk } from "@/lib/claude";

const MATCH_COUNT = 8;

interface MatchRow {
  id: string;
  source_id: string;
  content: string;
  label: string | null;
  similarity: number;
  source_title: string;
  origin_url: string | null;
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

    const { answer, confidence, ruleRefs } = await answerQuestion(question.trim(), chunks);

    // Only excerpts Claude actually cited inline ([n] somewhere in the
    // answer) - the model retrieves more context than it ends up using for
    // any given question, and unused excerpts aren't worth listing.
    const citedIndices = new Set(
      Array.from(answer.matchAll(/\[(\d+)\]/g)).map((m) => Number(m[1]))
    );

    // Prefer the specific rule/section Claude identified in that excerpt's
    // text (e.g. "16.5c Elevated Terrain and Line of Fire") over the
    // ingestion-time label (a PDF page number, or the nearest Heading 2 for
    // HTML sources - see lib/ingest.ts) - a rule reference is far more
    // precise and source-independent than either of those. When a rule ref
    // is available it replaces the source title entirely (title + page
    // number is redundant next to "16.5c Elevated Terrain and Line of
    // Fire"); otherwise the source title + fallback label is shown as
    // before.
    const citations = rows
      .map((r, i) => {
        const index = i + 1;
        const ruleRef = ruleRefs[String(index)];
        return {
          index,
          sourceId: r.source_id,
          title: ruleRef || r.source_title,
          label: ruleRef ? null : r.label,
        };
      })
      .filter((c) => citedIndices.has(c.index));

    return NextResponse.json({ answer, confidence, citations });
  } catch (err) {
    console.error("Failed to answer question", err);
    return NextResponse.json({ error: "Something went wrong answering that." }, { status: 500 });
  }
}
