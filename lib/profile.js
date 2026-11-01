/**
 * Taste profile generation using Claude CLI.
 *
 * Samples the kid's subscriptions and liked videos, sends them to Claude
 * for analysis, and saves a structured profile to profile.json.
 */

import { spawn } from 'node:child_process';
import { getChannels, getVideos, setProfile, getLikes, getSearchLog } from './store.js';
import { withClaudeUsageLog } from './ai-usage.js';

// --- Testing hook ---

let _claudeOverride = null;
export function _setClaudeForTesting(fn) { _claudeOverride = fn; }

// --- Claude CLI ---

function executeClaude(prompt, { model = 'sonnet', timeoutMs = 60000 } = {}) {
  if (_claudeOverride) {
    return Promise.resolve(_claudeOverride(prompt)).then(stdout => ({ stdout, stderr: '' }));
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn('claude', ['-p', '--model', model, '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      const err = new Error('Claude CLI timed out after 60s');
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', err => {
      clearTimeout(timer);
      const wrapped = new Error(`Claude CLI not available: ${err.message}`);
      wrapped.code = err.code;
      wrapped.stdout = stdout;
      wrapped.stderr = stderr;
      reject(wrapped);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        const err = new Error(`Claude CLI failed (exit ${code}): ${stderr}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callClaude(prompt, { model = 'sonnet', timeoutMs = 60000 } = {}) {
  const { stdout } = await withClaudeUsageLog({
    component: 'server',
    operation: 'profile.generate',
    model,
    prompt,
  }, () => executeClaude(prompt, { model, timeoutMs }));

  // --output-format json wraps the result in {"result":"..."} for real CLI
  // calls; tests can still inject plain result text.
  try {
    const envelope = JSON.parse(stdout);
    return envelope.result ?? stdout;
  } catch {
    return stdout;
  }
}

// --- Sampling ---

export async function sampleData() {
  const channels = await getChannels();
  const videosMap = await getVideos();

  const channelSummaries = channels.map(ch => ({
    title: ch.title,
    description: ch.description || '',
  }));

  // Up to 200 most recent liked videos, sorted by publishedAt descending
  const likedVideos = Object.entries(videosMap)
    .map(([id, v]) => ({ videoId: id, ...v }))
    .filter(v => v.source === 'liked')
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, 200);

  const videoSummaries = likedVideos.map(v => ({
    title: v.title,
    channelTitle: v.channelTitle || '',
    categoryId: v.categoryId || '',
    description: (v.description || '').slice(0, 200),
    tags: (v.tags || []).slice(0, 10),
  }));

  // Aggregate stats from liked videos
  const channelCounts = {};
  const categoryCounts = {};
  for (const v of likedVideos) {
    const ch = v.channelTitle || 'Unknown';
    channelCounts[ch] = (channelCounts[ch] || 0) + 1;
    const cat = v.categoryId || 'Unknown';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }

  const topChannels = Object.entries(channelCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const topCategories = Object.entries(categoryCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([id, count]) => ({ id, count }));

  // In-app likes (kid actively liked these in the UI)
  const inAppLikes = await getLikes();
  const inAppLikeSummaries = (inAppLikes || []).map(l => ({
    title: l.title,
    channelTitle: l.channelTitle || '',
  }));

  // In-app like channel frequency
  const likeChannelCounts = {};
  for (const l of inAppLikes || []) {
    const ch = l.channelTitle || 'Unknown';
    likeChannelCounts[ch] = (likeChannelCounts[ch] || 0) + 1;
  }

  // Search queries (what the kid searched for)
  const searchLog = await getSearchLog();
  const queryCounts = {};
  for (const entry of searchLog || []) {
    queryCounts[entry.query] = (queryCounts[entry.query] || 0) + 1;
  }
  const topQueries = Object.entries(queryCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([query, count]) => ({ query, count }));

  return {
    channels: channelSummaries,
    videos: videoSummaries,
    inAppLikes: inAppLikeSummaries,
    searchQueries: topQueries,
    stats: { topChannels, topCategories, totalVideos: likedVideos.length },
  };
}

// --- Prompt building ---

function buildPrompt(data) {
  const channelList = data.channels
    .map(ch => `- ${ch.title}${ch.description ? ': ' + ch.description : ''}`)
    .join('\n');

  const videoList = data.videos
    .map(v => {
      let line = `- "${v.title}" by ${v.channelTitle}`;
      if (v.categoryId) line += ` [cat: ${v.categoryId}]`;
      if (v.tags.length) line += ` tags: ${v.tags.join(', ')}`;
      return line;
    })
    .join('\n');

  const statsLine = [
    data.stats.topChannels.length
      ? 'Top channels: ' + data.stats.topChannels.map(c => `${c.name} (${c.count})`).join(', ')
      : '',
    data.stats.topCategories.length
      ? 'Top categories: ' + data.stats.topCategories.map(c => `${c.id} (${c.count})`).join(', ')
      : '',
  ].filter(Boolean).join('\n');

  // In-app likes section
  const inAppLikeList = (data.inAppLikes || [])
    .map(l => `- "${l.title}" by ${l.channelTitle}`)
    .join('\n');

  // Search queries section
  const searchQueryList = (data.searchQueries || [])
    .map(q => `- "${q.query}" (${q.count}x)`)
    .join('\n');

  return `You are analyzing a child's YouTube viewing preferences based on their subscriptions, liked videos, in-app activity, and search history.

## Subscriptions (${data.channels.length} channels)
${channelList || '(none)'}

## Liked Videos (${data.videos.length} videos, imported from YouTube)
${videoList || '(none)'}

## In-App Liked Videos (${(data.inAppLikes || []).length} videos the kid actively liked)
${inAppLikeList || '(none yet)'}

## Search Queries (what the kid searched for)
${searchQueryList || '(none yet)'}

## Stats
${statsLine || '(no stats available)'}

Based on this data, analyze this child's content preferences. Respond with ONLY a JSON object (no markdown, no explanation, no code blocks). Start your response with { and end with }.

Required structure:
{
  "interests": ["list of 3-10 topic interests, e.g. gaming, science, music"],
  "preferredFormats": ["list of 3-10 content formats, e.g. tutorials, gameplay, vlogs"],
  "avoidPatterns": ["list of 3-10 content patterns to avoid based on what's absent from their library"],
  "discoveryTerms": ["list of 3-10 YouTube search terms for finding similar content"]
}`;
}

// --- Response parsing ---

function parseResponse(raw) {
  const trimmed = raw.trim();

  // Direct parse
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // Extract from markdown code block
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }

  // Find first { ... } block
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return JSON.parse(braceMatch[0]);
  }

  throw new Error('Could not parse Claude response as JSON');
}

function validateProfile(profile) {
  const required = ['interests', 'preferredFormats', 'avoidPatterns', 'discoveryTerms'];
  for (const field of required) {
    if (!Array.isArray(profile[field])) {
      throw new Error(`Profile missing required array field: ${field}`);
    }
    if (profile[field].length === 0) {
      throw new Error(`Profile field "${field}" is empty`);
    }
  }
  return profile;
}

// --- Profile generation ---

export async function generateProfile(data) {
  const prompt = buildPrompt(data);

  let raw;
  try {
    raw = await callClaude(prompt);
  } catch (err) {
    throw new Error(`Profile generation failed: ${err.message}`);
  }

  let parsed;
  try {
    parsed = parseResponse(raw);
    validateProfile(parsed);
  } catch (firstErr) {
    // Retry once with stricter prompt
    const retryPrompt = prompt +
      '\n\nIMPORTANT: Respond with ONLY valid JSON. No explanation, no markdown, no code blocks. Start with { and end with }.';
    try {
      raw = await callClaude(retryPrompt);
      parsed = parseResponse(raw);
      validateProfile(parsed);
    } catch {
      throw new Error(`Could not parse profile from Claude: ${firstErr.message}`);
    }
  }

  return {
    interests: parsed.interests,
    preferredFormats: parsed.preferredFormats,
    avoidPatterns: parsed.avoidPatterns,
    discoveryTerms: parsed.discoveryTerms,
    sampleSize: data.stats.totalVideos,
    generatedAt: new Date().toISOString(),
    rawResponse: raw,
  };
}

// --- Persistence ---

export async function saveProfile(profile) {
  await setProfile(profile);
}

// --- Full rebuild ---

export async function rebuildProfile() {
  const data = await sampleData();

  if (data.channels.length === 0 && data.videos.length === 0) {
    throw new Error('No subscriptions or liked videos found. Import data first.');
  }

  const profile = await generateProfile(data);
  await saveProfile(profile);
  return profile;
}
