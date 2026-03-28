/**
 * Chunker
 *
 * Splits raw page text into semantically coherent chunks for embedding.
 *
 * DESIGN DECISIONS:
 * 1. Code blocks are NEVER split — they're kept whole even if they exceed maxTokens.
 *    A split code block loses its meaning entirely.
 * 2. Headings anchor chunk boundaries — a new heading always starts a new chunk.
 * 3. Overlap: the last 50 tokens of chunk N are prepended to chunk N+1.
 *    This prevents a sentence split from losing context.
 * 4. Token estimation: we use char/4 as a fast approximation (GPT tokenizer averages ~4 chars/token).
 *    Exact tokenization would require loading tiktoken WASM — not worth the startup cost here.
 */

import { createHash } from 'node:crypto';
import type { CrawlTarget, DocumentChunk } from '../types/rag.types.js';

// ─── HTML → plain text ────────────────────────────────────────────────────────

/**
 * Strips HTML tags and normalizes whitespace.
 * Preserves code block markers so the chunker can detect them.
 *
 * We do NOT use a full HTML parser here (too heavy as a dependency).
 * The regex approach is sufficient for Atlassian docs which are well-structured.
 */
export function extractTextFromHtml(html: string): string {
  return html
    // Preserve code blocks with a marker before stripping tags
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) =>
      `\n\`\`\`\n${code.replace(/<[^>]+>/g, '').trim()}\n\`\`\`\n`,
    )
    // Convert headings to markdown-style (anchors chunk boundaries)
    .replace(/<h([1-4])[^>]*>(.*?)<\/h\1>/gi, (_, level: string, text: string) =>
      `\n${'#'.repeat(parseInt(level, 10))} ${text.replace(/<[^>]+>/g, '').trim()}\n`,
    )
    // Paragraphs → double newline
    .replace(/<\/p>/gi, '\n\n')
    // List items → bullet
    .replace(/<li[^>]*>/gi, '\n- ')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Normalize whitespace (collapse multiple blank lines)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Title extractor ──────────────────────────────────────────────────────────

export function extractTitleFromHtml(html: string): string {
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (titleMatch?.[1] !== undefined) {
    return titleMatch[1]
      .replace(/\s*[|\-–]\s*Atlassian Developer.*/i, '')
      .trim();
  }
  const h1Match = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
  return h1Match?.[1]?.replace(/<[^>]+>/g, '').trim() ?? 'Untitled';
}

// ─── Token estimation ─────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  // ~4 chars per token for English technical text
  return Math.ceil(text.length / 4);
}

// ─── Chunker ──────────────────────────────────────────────────────────────────

interface ChunkerConfig {
  readonly maxTokens: number;
  readonly overlapTokens: number;
}

const DEFAULT_CONFIG: ChunkerConfig = {
  maxTokens: 500,
  overlapTokens: 50,
};

/**
 * Splits text into chunks on heading boundaries first,
 * then further splits oversized sections by paragraph.
 */
export function chunkText(
  text: string,
  config: ChunkerConfig = DEFAULT_CONFIG,
): ReadonlyArray<string> {
  const chunks: string[] = [];

  // Split on heading boundaries (## or ###)
  const sections = text.split(/(?=\n#{1,4}\s)/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length === 0) continue;

    const tokens = estimateTokens(trimmed);

    if (tokens <= config.maxTokens) {
      chunks.push(trimmed);
      continue;
    }

    // Section is too large — split by paragraph, preserving code blocks
    const subChunks = splitByParagraph(trimmed, config);
    chunks.push(...subChunks);
  }

  // Add overlap: prepend tail of previous chunk to current chunk
  return addOverlap(chunks, config.overlapTokens);
}

function splitByParagraph(
  text: string,
  config: ChunkerConfig,
): ReadonlyArray<string> {
  const chunks: string[] = [];
  let current = '';
  let inCodeBlock = false;

  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    // Track code block state — never split inside ```
    if (para.includes('```')) {
      inCodeBlock = !inCodeBlock;
    }

    const combined = current.length > 0 ? `${current}\n\n${para}` : para;
    const tokens = estimateTokens(combined);

    if (tokens <= config.maxTokens || inCodeBlock) {
      current = combined;
    } else {
      if (current.length > 0) {
        chunks.push(current.trim());
      }
      current = para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

function addOverlap(
  chunks: ReadonlyArray<string>,
  overlapTokens: number,
): ReadonlyArray<string> {
  if (chunks.length <= 1) return chunks;

  const result: string[] = [chunks[0] ?? ''];
  const overlapChars = overlapTokens * 4; // Token → char approximation

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1] ?? '';
    const current = chunks[i] ?? '';

    // Take the tail of the previous chunk as overlap prefix
    const overlapText = prev.slice(-overlapChars);
    result.push(`${overlapText}\n\n${current}`.trim());
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildChunks(
  page: { url: string; title: string; rawText: string; crawledAt: string },
  target: CrawlTarget,
  config: ChunkerConfig = DEFAULT_CONFIG,
): ReadonlyArray<DocumentChunk> {
  const texts = chunkText(page.rawText, config);
  const totalChunks = texts.length;

  return texts.map((content, index) => {
    const chunkId = createHash('sha256')
      .update(`${page.url}::${index}`)
      .digest('hex')
      .slice(0, 32);

    return {
      id: chunkId,
      sourceUrl: page.url,
      sourceTitle: page.title,
      category: target.category,
      chunkIndex: index,
      totalChunks,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      tokenEstimate: estimateTokens(content),
      hasCodeBlock: content.includes('```'),
      crawledAt: page.crawledAt,
    };
  });
}
