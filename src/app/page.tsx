"use client";

import { useState } from "react";

interface Citation {
  index: number;
  sourceId: string;
  title: string;
  label: string | null;
  url: string | null;
}

type Confidence = "definitive" | "uncertain" | null;

interface Answer {
  question: string;
  answer: string;
  confidence: Confidence;
  citations: Citation[];
}

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  if (confidence === "definitive") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
        Answer
      </span>
    );
  }
  if (confidence === "uncertain") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
        Not certain - check these
      </span>
    );
  }
  return null;
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Answer[]>([]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Something went wrong.");
        return;
      }
      setHistory((prev) => [
        { question: q, answer: body.answer, confidence: body.confidence, citations: body.citations },
        ...prev,
      ]);
      setQuestion("");
    } catch {
      setError("Something went wrong reaching the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Heroclix Rules Assistant</h1>
        <p className="mt-1 text-sm text-slate-500">
          Ask a rules question and get an answer grounded in the official Heroclix sources, with
          citations.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="mt-6 flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How does Outwit interact with Probability Control?"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Asking..." : "Ask"}
        </button>
      </form>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <div className="mt-8 flex-1 space-y-8">
        {history.length === 0 && !loading && (
          <p className="text-sm text-slate-400">Your questions and answers will appear here.</p>
        )}
        {history.map((item, i) => (
          <article key={i} className="border-t border-slate-200 pt-6 first:border-t-0 first:pt-0">
            <p className="text-sm font-medium text-slate-900">{item.question}</p>
            <div className="mt-2 flex items-start gap-2">
              {item.confidence && (
                <span className="mt-0.5 shrink-0">
                  <ConfidenceBadge confidence={item.confidence} />
                </span>
              )}
              <p className="whitespace-pre-wrap text-sm text-slate-700">{item.answer}</p>
            </div>
            {item.citations.length > 0 && (
              <ol className="mt-4 space-y-1 text-xs text-slate-500">
                {item.citations.map((c) => (
                  <li key={c.index}>
                    [{c.index}]{" "}
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" className="underline">
                        {c.title}
                      </a>
                    ) : (
                      c.title
                    )}
                    {c.label ? ` (${c.label})` : ""}
                  </li>
                ))}
              </ol>
            )}
          </article>
        ))}
      </div>

      <footer className="mt-10 text-xs text-slate-400">
        Answers are generated from indexed rules sources only. Always confirm rulings with your
        event organizer for competitive play.
      </footer>
    </div>
  );
}
