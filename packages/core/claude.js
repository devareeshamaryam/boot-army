import Anthropic from '@anthropic-ai/sdk';

/**
 * Default model. `claude-3-5-sonnet-20240620` was retired by Anthropic on
 * 2025-10-22 and now returns an error, so a current model is used instead.
 * Override per call via `options.model`, or globally via ANTHROPIC_MODEL.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';

const DEFAULT_MAX_TOKENS = 1024;

/** One SDK client per API key, so repeated calls reuse connections. */
const clients = new Map();

function getClient(apiKey) {
  let client = clients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

/**
 * Send a single-turn prompt to Claude and return the text reply.
 *
 * @param {string} prompt - The user message.
 * @param {string} [apiKey=process.env.ANTHROPIC_API_KEY] - Anthropic API key.
 * @param {object} [options]
 * @param {string} [options.model] - Model ID. Defaults to ANTHROPIC_MODEL or DEFAULT_CLAUDE_MODEL.
 * @param {number} [options.maxTokens=1024] - Maximum tokens in the reply.
 * @param {string} [options.system] - Optional system prompt.
 * @returns {Promise<string>} The concatenated text blocks of Claude's reply.
 * @throws {TypeError} On invalid arguments.
 * @throws {Anthropic.APIError} On API errors (auth, rate limit, bad model, etc.).
 */
export async function askClaude(prompt, apiKey = process.env.ANTHROPIC_API_KEY, options = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('askClaude: prompt must be a non-empty string');
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('askClaude: apiKey is required (pass it or set ANTHROPIC_API_KEY)');
  }

  const {
    model = process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    system,
  } = options;

  const response = await getClient(apiKey).messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    ...(system ? { system } : {}),
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}