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

    // One entry per excerpt, in the same order given to Claude, so a citation's
    // list position matches the [n] marker Claude used inline in the answer.
    // Prefer the specific rule/section Claude identified in that excerpt's
    // text (e.g. "16.5c") over the ingestion-time label (a PDF page number,
    // or the nearest Heading 2 for HTML sources - see lib/ingest.ts) - a
    // rule number is a far more precise, source-independent reference than
    // either of those.
    const citations = rows.map((r, i) => {
      const ruleRef = ruleRefs[String(i + 1)];
      return {
        index: i + 1,
        sourceId: r.source_id,
        title: r.source_title,
        label: ruleRef ? `Rule ${ruleRef}` : r.label,
      };
    });

    return NextResponse.json({ answer, confidence, citations });
  } catch (err) {
    console.error("Failed to answer question", err);
    return NextResponse.json({ error: "Something went wrong answering that." }, { status: 500 });
  }
}
