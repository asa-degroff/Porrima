/**
 * Streaming Token Buffer for TTS
 * 
 * Implements three-tier boundary detection for optimal TTS chunking:
 * - Tier 1: Word boundary (minimum) - never split mid-word
 * - Tier 2: Clause boundary (preferred) - natural pauses at commas/conjunctions
 * - Tier 3: Sentence boundary (ideal) - best prosody via sentence tokenizer
 * 
 * Based on Deepgram's TTS chunking research.
 */

import Tokenizer from 'sentence-tokenizer';

export interface BoundaryResult {
  shouldEmit: boolean;
  reason: 'word' | 'clause' | 'sentence' | 'max-length' | 'cjk';
  chunkText: string;
}

export interface StreamingTokenBufferOptions {
  minTokens: number;      // Minimum tokens before emitting (default: 30)
  maxTokens: number;      // Maximum tokens before forcing emit (default: 80)
  maxChars: number;       // Safety limit in characters (default: 500)
  boundaryTier: 'clause' | 'sentence';  // Preferred boundary detection mode
  language?: 'en' | 'zh' | 'ja' | 'ko'; // Language hint for CJK detection
}

/**
 * Clause boundary regex - matches natural speech pause points
 * Matches: sentence-ending punctuation, semicolons, commas + FANBOYS conjunctions
 */
const CLAUSE_REGEX = /[.!?,;:]$|, (and|but|or|nor|for|yet|so)$/;

/**
 * Sentence-ending punctuation. Optional closing quotes/parens are accepted.
 */
const SENTENCE_REGEX = /[.!?]["')\]]?$/;

/**
 * CJK punctuation (Chinese, Japanese, Korean)
 */
const CJK_CLAUSE_PUNCT = /[。！？、，；：.!?,;:]$/;
const CJK_SENTENCE_PUNCT = /[。！？!?]$/;

function hasSentenceBoundary(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!SENTENCE_REGEX.test(trimmed)) return false;

  try {
    const tokenizer = new Tokenizer();
    tokenizer.setEntry(trimmed);
    return tokenizer.getSentences().length > 0;
  } catch (e) {
    console.warn('[StreamingTokenBuffer] sentenceTokenizer failed:', e);
    return true;
  }
}

/**
 * Streaming token buffer for TTS generation
 * 
 * Accumulates tokens from LLM streaming output and emits chunks
 * at natural speech boundaries (word/clause/sentence) for optimal TTS prosody.
 */
export class StreamingTokenBuffer {
  private tokens: string[] = [];
  private readonly options: Required<StreamingTokenBufferOptions>;
  
  constructor(options: Partial<StreamingTokenBufferOptions> = {}) {
    this.options = {
      minTokens: options.minTokens ?? 30,    // ~1-2 seconds speech
      maxTokens: options.maxTokens ?? 80,    // ~4-5 seconds speech
      maxChars: options.maxChars ?? 500,     // Safety limit
      boundaryTier: options.boundaryTier ?? 'clause',
      language: options.language ?? 'en',
    };
  }
  
  /**
   * Push a token from the LLM stream
   */
  push(token: string): void {
    this.tokens.push(token);
  }
  
  /**
   * Check if we should emit an audio chunk
   * 
   * Three-tier strategy:
   * 1. Word boundary (always required) - don't split mid-word
   * 2. Clause boundary (preferred for streaming) - regex-based, fast
   * 3. Sentence boundary (best prosody) - NLTK-based, slightly slower
   */
  checkBoundary(): BoundaryResult {
    const text = this.tokens.join('');
    const lastToken = this.tokens[this.tokens.length - 1];
    const trimmedText = text.trimEnd();
    
    // Tier 1: Word boundary (always required)
    const isWordBoundary = /\s$/.test(lastToken) || /[.!?,;:]$/.test(lastToken);
    
    if (!isWordBoundary) {
      return { shouldEmit: false, reason: 'word', chunkText: '' };
    }
    
    // Emergency flush: max length reached
    if (this.tokens.length >= this.options.maxTokens || text.length >= this.options.maxChars) {
      return { shouldEmit: true, reason: 'max-length', chunkText: text };
    }
    
    // CJK language handling (no spaces) - check BEFORE minTokens
    if (this.isCJK()) {
      if (this.options.boundaryTier === 'sentence') {
        if (CJK_SENTENCE_PUNCT.test(trimmedText)) {
          return { shouldEmit: true, reason: 'sentence', chunkText: text };
        }
        return { shouldEmit: false, reason: 'word', chunkText: '' };
      }

      // CJK doesn't use minTokens in clause mode - use character count instead
      if (text.length >= 50 || CJK_CLAUSE_PUNCT.test(trimmedText)) {
        return { shouldEmit: true, reason: 'cjk', chunkText: text };
      }
      return { shouldEmit: false, reason: 'word', chunkText: '' };
    }
    
    // Minimum length check (don't emit tiny chunks)
    if (this.tokens.length < this.options.minTokens) {
      return { shouldEmit: false, reason: 'word', chunkText: '' };
    }
    
    // Tier 2: Sentence boundary (best prosody, waits for full sentence).
    if (this.options.boundaryTier === 'sentence') {
      if (hasSentenceBoundary(trimmedText)) {
        return { shouldEmit: true, reason: 'sentence', chunkText: text };
      }
      return { shouldEmit: false, reason: 'word', chunkText: '' };
    }

    // Tier 3: Clause boundary (preferred for lower-latency streaming).
    if (CLAUSE_REGEX.test(trimmedText)) {
      return { shouldEmit: true, reason: 'clause', chunkText: text };
    }
    
    return { shouldEmit: false, reason: 'word', chunkText: '' };
  }
  
  /**
   * Flush the buffer and return accumulated text
   */
  flush(): string {
    const text = this.tokens.join('');
    this.tokens = [];
    return text;
  }
  
  /**
   * Get current token count
   */
  get length(): number {
    return this.tokens.length;
  }
  
  /**
   * Get current character count
   */
  get charLength(): number {
    return this.tokens.join('').length;
  }
  
  /**
   * Detect CJK language (Chinese, Japanese, Korean)
   * CJK text doesn't use spaces, so we count characters instead of words
   */
  public isCJK(): boolean {
    if (this.options.language && ['zh', 'ja', 'ko'].includes(this.options.language)) {
      return true;
    }
    
    // Heuristic: check for CJK Unicode ranges
    const text = this.tokens.join('');
    const cjkRegex = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
    return cjkRegex.test(text);
  }
  
  /**
   * Clear the buffer without returning text
   * Used when pausing on tool execution
   */
  clear(): void {
    this.tokens = [];
  }
  
  /**
   * Get the accumulated text without clearing
   */
  peek(): string {
    return this.tokens.join('');
  }
}

/**
 * Pre-load sentence tokenizer on module import
 * This avoids first-call latency during streaming
 */
try {
  // Warmup with a test sentence
  const tokenizer = new Tokenizer();
  tokenizer.setEntry('Warmup sentence.');
  tokenizer.getSentences();
} catch (e) {
  console.warn('[StreamingTokenBuffer] Sentence tokenizer warmup failed - will load on first use');
}
