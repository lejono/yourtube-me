/**
 * YouTube channel generation from a kid's profile (Claude Sonnet).
 *
 * Calls Claude Sonnet via the CLI to suggest 10-15 real YouTube channels
 * appropriate for the child's age and interests. Gracefully degrades:
 * returns [] on any failure.
 *
 * Uses node:child_process execFile (not exec) to avoid shell injection.
 */

import { execFile } from 'node:child_process';
import { withClaudeUsageLog } from '../../lib/ai-usage.js';
import { claudeCliArgs, claudeCliOptions } from './claude-cli.js';

const CHANNEL_GEN_TIMEOUT_MS = 120_000;
export const CLAUDE_MODEL = 'sonnet';

// Inject a mock executor in tests
let _execForTesting = null;

/**
 * Replace the CLI executor.
 * @param {Function|null} fn - (prompt) => Promise<string>
 */
export function _setExecForTesting(fn) {
  _execForTesting = fn;
}

/**
 * Execute the Claude CLI with the given prompt, return stdout/stderr.
 * @param {string} prompt
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function executeOpus(prompt) {
  if (_execForTesting) {
    return Promise.resolve(_execForTesting(prompt)).then(stdout => ({ stdout, stderr: '' }));
  }

  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      claudeCliArgs(CLAUDE_MODEL),
      claudeCliOptions({ timeout: CHANNEL_GEN_TIMEOUT_MS }),
      (err, stdout, stderr) => {
        if (err) {
          const wrapped = new Error(`Claude CLI failed: ${err.message}\n${stderr}`);
          wrapped.code = err.code;
          wrapped.signal = err.signal;
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      },
    );

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Call the Claude CLI with the given prompt, log usage, return stdout.
 * Deletes the CLAUDECODE env var before spawning.
 * @param {string} prompt
 * @param {string} operation
 * @returns {Promise<string>}
 */
async function callOpus(prompt, operation) {
  const { stdout } = await withClaudeUsageLog({
    component: 'worker',
    operation,
    model: CLAUDE_MODEL,
    prompt,
  }, () => executeOpus(prompt));

  return stdout;
}

/**
 * Build the prompt for Opus channel generation.
 * @param {{ kid_name: string, age: number|null, interests: string[], guidelines: string|null }} kidProfile
 * @returns {string}
 */
function buildPrompt(kidProfile) {
  const { kid_name, age, interests = [], guidelines } = kidProfile;
  const interestList = interests.length > 0 ? interests.join(', ') : 'general kids content';
  const ageStr = age ? `${age} years old` : 'school age';
  const guidelinesStr = guidelines ? `\nParent guidelines: ${guidelines}` : '';

  return `You are helping set up a curated YouTube feed for a child.

Child: ${kid_name}, ${ageStr}
Interests: ${interestList}${guidelinesStr}

Suggest 10-15 real YouTube channels that would be a great fit for this child.
Only suggest channels that actually exist on YouTube.

Respond with a JSON object in this exact format:
{
  "channels": [
    {
      "name": "Channel Name",
      "description": "1-2 sentence description of the channel aimed at the parent, so they can decide without looking it up.",
      "reason": "Brief reason why this channel fits this specific child's interests and age.",
      "searchQuery": "Channel Name YouTube"
    }
  ]
}

Only return the JSON object, no other text.`;
}

/**
 * Parse the raw CLI response into an array of channel suggestions.
 * Returns [] on any parse error or unexpected shape.
 * @param {string} raw
 * @returns {Array<{ name: string, reason: string, searchQuery: string }>}
 */
export function parseChannelResponse(raw) {
  if (!raw) return [];

  let parsed;
  try {
    // Claude --output-format json wraps in { type, result: "..." }
    // The result field may contain markdown fences around the JSON
    const outer = JSON.parse(raw);
    if (outer && typeof outer.result === 'string') {
      const stripped = outer.result.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      parsed = JSON.parse(stripped);
    } else if (outer && outer.channels) {
      parsed = outer;
    } else {
      parsed = outer;
    }
  } catch {
    // Try raw as plain JSON string, stripping fences
    try {
      const stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      parsed = JSON.parse(stripped);
    } catch {
      return [];
    }
  }

  if (!parsed || !Array.isArray(parsed.channels)) return [];

  return parsed.channels.filter(
    ch => ch && typeof ch.name === 'string' && ch.name && typeof ch.searchQuery === 'string' && ch.searchQuery
  );
}

/**
 * Ask Opus to suggest YouTube channels for a kid.
 * @param {{ kid_name: string, age: number|null, interests: string[], guidelines: string|null }} kidProfile
 * @returns {Promise<Array<{ name: string, reason: string, searchQuery: string }>>}
 */
export async function generateChannels(kidProfile) {
  try {
    const prompt = buildPrompt(kidProfile);
    const raw = await callOpus(prompt, 'channel.generate');
    return parseChannelResponse(raw);
  } catch (err) {
    console.warn('[channel-gen] Failed to generate channels:', err.message);
    return [];
  }
}

/**
 * Build the prompt for Opus channel refinement.
 * @param {{ kid_name: string, age: number|null, interests: string[], guidelines: string|null }} kidProfile
 * @param {Array<{ title: string, status: string }>} currentChannels
 * @param {string[]} feedbackMessages
 * @returns {string}
 */
function buildRefinePrompt(kidProfile, currentChannels, feedbackMessages) {
  const { kid_name, age, interests = [], guidelines } = kidProfile;
  const ageStr = age ? `${age} years old` : 'school age';
  const interestList = interests.length > 0 ? interests.join(', ') : 'general kids content';
  const guidelinesStr = guidelines ? `\nParent guidelines: ${guidelines}` : '';

  const approved = currentChannels.filter(c => c.status === 'approved').map(c => c.title);
  const rejected = currentChannels.filter(c => c.status === 'rejected').map(c => c.title);

  const approvedStr = approved.length > 0 ? `\nCurrently approved channels: ${approved.join(', ')}` : '';
  const rejectedStr = rejected.length > 0 ? `\nChannels the parent skipped or rejected: ${rejected.join(', ')}` : '';
  const feedbackStr = feedbackMessages.map((m, i) => `  ${i + 1}. ${m}`).join('\n');

  return `You are helping refine a curated YouTube feed for a child.

Child: ${kid_name}, ${ageStr}
Interests: ${interestList}${guidelinesStr}${approvedStr}${rejectedStr}

Parent feedback:
${feedbackStr}

Based on the parent's feedback, suggest 5-10 additional or replacement YouTube channels that better match their preferences.
Avoid suggesting channels already in the approved or rejected lists.
Only suggest channels that actually exist on YouTube.

Respond with a JSON object in this exact format:
{
  "channels": [
    {
      "name": "Channel Name",
      "description": "1-2 sentence description of the channel aimed at the parent, so they can decide without looking it up.",
      "reason": "Brief reason why this channel fits this specific child's interests and age.",
      "searchQuery": "Channel Name YouTube"
    }
  ]
}

Only return the JSON object, no other text.`;
}

/**
 * Parse the raw CLI response for a guidelines review into an array of decisions.
 * Returns [] on any parse error or unexpected shape.
 * @param {string} raw
 * @returns {Array<{ title: string, compatible: boolean, reason: string }>}
 */
export function parseGuidelinesReview(raw) {
  if (!raw) return [];

  let parsed;
  try {
    const outer = JSON.parse(raw);
    if (outer && typeof outer.result === 'string') {
      const stripped = outer.result.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      parsed = JSON.parse(stripped);
    } else if (outer && outer.reviews) {
      parsed = outer;
    } else {
      parsed = outer;
    }
  } catch {
    try {
      const stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      parsed = JSON.parse(stripped);
    } catch {
      return [];
    }
  }

  if (!parsed || !Array.isArray(parsed.reviews)) return [];

  return parsed.reviews.filter(
    r => r && typeof r.title === 'string' && r.title && typeof r.compatible === 'boolean'
  );
}

/**
 * Build the prompt for Opus guidelines review.
 * @param {{ kid_name: string, age: number|null, interests: string[], guidelines: string }} kidProfile
 * @param {Array<{ title: string, reason?: string }>} channels
 * @returns {string}
 */
function buildGuidelinesReviewPrompt(kidProfile, channels) {
  const { kid_name, age, interests = [], guidelines } = kidProfile;
  const ageStr = age ? `${age} years old` : 'school age';
  const interestList = interests.length > 0 ? interests.join(', ') : 'general kids content';

  const channelList = channels.map((ch, i) =>
    `${i + 1}. ${ch.title}${ch.reason ? ` — ${ch.reason}` : ''}`
  ).join('\n');

  return `You are reviewing YouTube channel suggestions for a child's curated feed.

Child: ${kid_name}, ${ageStr}
Interests: ${interestList}
Parent guidelines: ${guidelines}

The following channels have been suggested based on the child's interests and age.
Review each one against the parent's guidelines and determine if it should be kept or removed.

Channels to review:
${channelList}

For each channel, respond with a JSON object:
{
  "reviews": [
    {
      "title": "Channel Name",
      "compatible": true,
      "reason": "Brief explanation of why this channel does or doesn't match the guidelines"
    }
  ]
}

Only return the JSON object, no other text.`;
}

/**
 * Ask Opus to review channels against parent guidelines.
 * @param {{ kid_name: string, age: number|null, interests: string[], guidelines: string }} kidProfile
 * @param {Array<{ title: string, channel_id: string, reason?: string }>} channels
 * @returns {Promise<Array<{ title: string, compatible: boolean, reason: string }>>}
 */
export async function reviewChannelsAgainstGuidelines(kidProfile, channels) {
  try {
    const prompt = buildGuidelinesReviewPrompt(kidProfile, channels);
    const raw = await callOpus(prompt, 'channel.review-guidelines');
    return parseGuidelinesReview(raw);
  } catch (err) {
    console.warn('[channel-gen] Failed to review channels against guidelines:', err.message);
    return [];
  }
}

/**
 * Ask Opus to refine channel suggestions based on parent feedback.
 * @param {{ kid_name: string, age: number|null, interests: string[], guidelines: string|null }} kidProfile
 * @param {Array<{ title: string, status: string }>} currentChannels - all channels (approved + rejected)
 * @param {string[]} feedbackMessages - parent feedback messages
 * @returns {Promise<Array<{ name: string, description: string, reason: string, searchQuery: string }>>}
 */
export async function refineChannels(kidProfile, currentChannels, feedbackMessages) {
  try {
    const prompt = buildRefinePrompt(kidProfile, currentChannels, feedbackMessages);
    const raw = await callOpus(prompt, 'channel.refine');
    return parseChannelResponse(raw);
  } catch (err) {
    console.warn('[channel-gen] Failed to refine channels:', err.message);
    return [];
  }
}
