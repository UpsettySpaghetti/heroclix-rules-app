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
- If the excerpts don't fully answer the question, say plainly what is and isn't covered rather than filling the gap yourself.
- Be precise and detailed - Heroclix rulings often hinge on exact wording, timing, keywords, and modifiers, so quote or closely paraphrase the relevant text.
- Reference excerpts inline using their [number] marker (e.g. "a character with Flight can move over blocking terrain [2]") so the visitor can see exactly which source backs each claim.`;

export interface AnswerResult {
  answer: string;
}

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
    // Detailed rules answers - especially ones quoting several excerpts and
    // citing many sources - can easily run long. 1500 was cutting real
    // answers off mid-sentence.
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return { answer: textBlock && textBlock.type === "text" ? textBlock.text : "" };
}
