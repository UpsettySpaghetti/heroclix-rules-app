// Splits extracted document text into overlapping, paragraph-aligned chunks
// small enough to embed and retrieve individually, but large enough to keep
// a rule's surrounding context (exceptions, timing, cross-references) intact.
const MAX_WORDS = 220;
const OVERLAP_WORDS = 40;

export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWordCount = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join("\n\n"));
  };

  for (const paragraph of paragraphs) {
    const wordCount = paragraph.split(/\s+/).length;

    if (currentWordCount + wordCount > MAX_WORDS && current.length) {
      flush();
      const overlapText = current.join(" ").split(/\s+/).slice(-OVERLAP_WORDS).join(" ");
      current = overlapText ? [overlapText] : [];
      currentWordCount = overlapText ? overlapText.split(/\s+/).length : 0;
    }

    current.push(paragraph);
    currentWordCount += wordCount;
  }
  flush();

  return chunks;
}
