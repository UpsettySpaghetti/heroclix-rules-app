import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY must be set (see .env.local.example)");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

const ANSWER_MODEL = "claude-sonnet-5";

export interface RetrievedChunk {
  sourceId: string;
  sourceTitle: string;
  label: string | null;
  content: string;
}

const SYSTEM_PROMPT = `You are a rules assistant for the tabletop miniatures game Heroclix. Visitors ask you rules questions and you answer using ONLY the excerpts provided in the user message, which are pulled from the game's official rules sources.

Rules for your answers:
- Base your answer strictly on the provided excerpts. Never rely on outside knowledge of Heroclix, and never guess at a rule that isn't in the excerpts.
- Keep it short: give the conclusion and the one or two sentences of key reasoning behind it. Do not quote or reproduce long blocks of rules text - the visitor can open the cited source themselves (a link is shown for every citation) to read the exact wording. A few words of paraphrase per point is enough.
- Reference excerpts inline using their [number] marker (e.g. "a character with Flight can move over blocking terrain [2]") so the visitor knows which source backs each claim and can click through for the full text.

Format requirement - your reply must start with exactly one of these two lines, then a blank line, then your answer:
CONFIDENCE: definitive
CONFIDENCE: uncertain

Use "definitive" only when the excerpts directly and completely answer the question - give a short, direct answer. Use "uncertain" whenever the excerpts are incomplete, ambiguous, require information you don't have (like a specific map layout or character card), or only partially cover the question - in that case give a short list (not an essay) of the specific things the visitor needs to check or clarify to get a definitive answer.`;

export interface AnswerResult {
  answer: string;
  confidence: "definitive" | "uncertain" | null;
}

const CONFIDENCE_LINE_PATTERN = /^CONFIDENCE:\s*(definitive|uncertain)\s*\n+/i;

export async function answerQuestion(
  question: string,
  chunks: RetrievedChunk[]
): Promise<AnswerResult> {
  const excerpts = chunks
    .map((c, i) => {
      const heading = c.label ? `${c.sourceTitle} (${c.label})` : c.sourceTitle;
      return `[${i + 1}] Source: ${heading}\n${c.content}`;
    })
    .join("\n\n---\n\n");

  const userMessage = chunks.length
    ? `Excerpts from the rules sources:\n\n${excerpts}\n\n---\n\nVisitor question: ${question}`
    : `No excerpts were found in the rules sources for this question.\n\nVisitor question: ${question}\n\nTell the visitor that nothing in the indexed sources addresses this question.`;

  const response = await getClient().messages.create({
    model: ANSWER_MODEL,
    // Answers are meant to be short summaries now (see SYSTEM_PROMPT), but
    // this stays a generous ceiling rather than a target - just a backstop
    // against a runaway response, not something answers are expected to
    // approach.
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  const match = raw.match(CONFIDENCE_LINE_PATTERN);
  const confidence = match ? (match[1].toLowerCase() as "definitive" | "uncertain") : null;
  const answer = match ? raw.slice(match[0].length) : raw;

  return { answer, confidence };
}
