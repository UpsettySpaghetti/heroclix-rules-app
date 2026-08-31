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
- Keep it short: give the conclusion and the one or two sentences of key reasoning behind it. Do not quote or reproduce long blocks of rules text - the visitor sees exactly which rule/section each citation refers to and can look it up themselves. A few words of paraphrase per point is enough.
- Reference excerpts inline using their [number] marker (e.g. "a character with Flight can move over blocking terrain [2]") so the visitor knows which source backs each claim.

Format requirement - your reply must start with exactly these two lines, then a blank line, then your answer:
CONFIDENCE: definitive
RULE_REFS: {"1":"16.5c Elevated Terrain and Line of Fire","2":null}

The CONFIDENCE line: use "definitive" only when the excerpts directly and completely answer the question - give a short, direct answer. Use "uncertain" whenever the excerpts are incomplete, ambiguous, require information you don't have (like a specific map layout or character card), or only partially cover the question - in that case give a short list (not an essay) of the specific things the visitor needs to check or clarify to get a definitive answer.

The RULE_REFS line: compact JSON mapping every excerpt number you cited to the rule/section number AND its short title, exactly as printed at the start of that excerpt's text (e.g. "16.5c Elevated Terrain and Line of Fire", "20.6b Loss of Powers and Abilities") - copy it exactly, do not invent or reword it. Use null for any excerpt you cited that doesn't show a rule number and title in its text. Only include excerpt numbers you actually used inline in your answer - omit any you didn't cite.`;

export interface AnswerResult {
  answer: string;
  confidence: "definitive" | "uncertain" | null;
  ruleRefs: Record<string, string>;
}

const CONFIDENCE_PATTERN = /^CONFIDENCE:\s*(definitive|uncertain)\s*\n+/i;
const RULE_REFS_PATTERN = /RULE_REFS:\s*(\{[^\n]*\})\s*\n*/i;

// Pulls the two header lines out wherever they actually landed, rather than
// requiring both in the exact "CONFIDENCE then RULE_REFS then blank line"
// order the prompt asks for - without extended thinking (see below), the
// model doesn't always follow that structure exactly (RULE_REFS has shown
// up trailing at the end of the answer, or been omitted entirely), and a
// strict combined match would silently treat the whole raw response -
// including literal header lines - as the answer instead of degrading
// gracefully.
function parseAnswer(raw: string): AnswerResult {
  let text = raw;
  let confidence: "definitive" | "uncertain" | null = null;
  let ruleRefs: Record<string, string> = {};

  const confidenceMatch = text.match(CONFIDENCE_PATTERN);
  if (confidenceMatch) {
    confidence = confidenceMatch[1].toLowerCase() as "definitive" | "uncertain";
    text = text.slice(confidenceMatch[0].length);
  }

  const rulesMatch = text.match(RULE_REFS_PATTERN);
  if (rulesMatch) {
    try {
      const parsed = JSON.parse(rulesMatch[1]) as Record<string, string | null>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value.trim()) ruleRefs[key] = value.trim();
      }
    } catch {
      ruleRefs = {};
    }
    text = (text.slice(0, rulesMatch.index) + text.slice(rulesMatch.index! + rulesMatch[0].length)).trim();
  }

  return { answer: text.trim(), confidence, ruleRefs };
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
    // Answers are meant to be short summaries now (see SYSTEM_PROMPT), but
    // this stays a generous ceiling rather than a target - just a backstop
    // against a runaway response, not something answers are expected to
    // approach.
    max_tokens: 1024,
    // This model uses "adaptive" thinking by default - Claude decides on
    // its own whether/how much to reason internally, and that reasoning
    // draws from the same max_tokens budget as the visible answer. That's
    // what caused a real reported bug: on one question thinking alone used
    // 586 of the 1024 tokens, leaving too little room and truncating the
    // answer mid-sentence. Disabled outright: this app only needs Claude to
    // synthesize a short answer from given excerpts, not do deep multi-step
    // reasoning, so a predictable token budget is worth more here than
    // whatever thinking might add.
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";

  return parseAnswer(raw);
}
