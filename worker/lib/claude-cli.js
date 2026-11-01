/**
 * Shared arguments and options for running `claude -p` from the worker.
 *
 * Prompts carry text that outsiders control (video titles, descriptions,
 * parents' free-text interests and feedback), so the CLI runs with every
 * built-in tool and MCP server disabled, from an empty scratch directory.
 * It can only read the prompt and write a reply.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let scratchDir = null;

function emptyScratchDir() {
  if (!scratchDir) {
    // mkdtemp creates a fresh 0700 directory; no shared, predictable parent.
    scratchDir = mkdtempSync(join(tmpdir(), 'yourtube-claude-'));
  }
  return scratchDir;
}

export function claudeCliArgs(model) {
  return [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--tools', '',
    '--strict-mcp-config',
  ];
}

export function claudeCliOptions(extra = {}) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return { cwd: emptyScratchDir(), env, maxBuffer: 1024 * 1024, ...extra };
}
