/**
 * Claude HTTP API Server - Fast Spawn Mode
 *
 * Optimized for speed: uses --output-format json (single JSON result),
 * pre-warms by keeping a process pool, and parses output efficiently.
 *
 * Usage:
 *   node server-fast.js
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// Find claude binary
function findClaude() {
  const candidates = [
    path.join(process.env.HOME || '', '.local/bin/claude'),
    '/usr/local/bin/claude',
    'claude', // fallback to PATH
  ];
  for (const c of candidates) {
    try {
      if (c === 'claude' || fs.existsSync(c)) return c;
    } catch {}
  }
  return 'claude';
}

const CLAUDE_BIN = findClaude();
console.log('[STARTUP] Claude binary:', CLAUDE_BIN);

/**
 * Build clean environment for Claude Code CLI
 */
function buildClaudeEnvironment() {
  const HOME = process.env.HOME || '/home/dhoepp';
  const PAI_DIR = path.join(HOME, '.claude');

  // Load ~/.claude/.env
  const envPath = path.join(PAI_DIR, '.env');
  const paiEnv = {};
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          paiEnv[key] = valueParts.join('=');
        }
      }
    }
  }

  const env = {
    ...process.env,
    ...paiEnv,
    HOME,
    PAI_DIR,
  };

  // Critical: remove these to avoid nested session errors
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Let CLI use subscription auth
  delete env.ANTHROPIC_API_KEY;

  return env;
}

const claudeEnv = buildClaudeEnvironment();
console.log('[STARTUP] Environment ready');

// Session storage: callId -> true (for resume tracking)
const sessions = new Map();

const VOICE_CONTEXT = `[VOICE CALL CONTEXT] This query comes via voice call. You MUST include BOTH of these lines in your response: 🗣️ VOICE_RESPONSE: [Your conversational answer in 40 words or less. This is what gets spoken aloud via TTS. Be natural and helpful, like talking to a friend.] 🎯 COMPLETED: [Status summary in 12 words or less. This is for logging only.] IMPORTANT: The VOICE_RESPONSE line is what the caller HEARS. Make it conversational and complete. [END VOICE CONTEXT]`;

/**
 * Run a single claude query. Returns parsed JSON result.
 */
function runClaude({ prompt, callId, model }) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--model', model,
      '--max-turns', '3',
    ];

    // Session management
    if (callId) {
      if (sessions.has(callId)) {
        args.push('--resume', callId);
      } else {
        args.push('--session-id', callId);
        sessions.set(callId, true);
      }
    }

    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: claudeEnv,
    });

    let stdout = '';
    let stderr = '';

    proc.stdin.end();
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => reject(err));

    proc.on('close', (code) => {
      const duration_ms = Date.now() - startTime;

      if (code !== 0) {
        console.error(`[CLAUDE] Exit code ${code}, stderr: ${stderr.substring(0, 300)}`);
        return reject(new Error(`Claude exited with code ${code}: ${stderr.substring(0, 200)}`));
      }

      try {
        // stdout might be a single JSON line, or multiple JSONL lines
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        let response = '';
        let sessionId = null;
        let cost_usd = 0;

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);

            // Extract text from assistant messages
            if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
              for (const block of msg.message.content) {
                if (block.type === 'text' && block.text) {
                  response += block.text;
                }
              }
            }

            // Result message (--output-format json gives just this)
            if (msg.type === 'result') {
              if (msg.result) response = msg.result;
              sessionId = msg.session_id || sessionId;
              cost_usd = msg.total_cost_usd || cost_usd;
            }
          } catch {}
        }

        // Final fallback: if no response parsed, use raw stdout
        if (!response) response = stdout.trim();

        resolve({ response, sessionId, duration_ms, cost_usd });
      } catch (e) {
        resolve({
          response: stdout.trim() || '(no response)',
          sessionId: null,
          duration_ms,
          cost_usd: 0,
        });
      }
    });
  });
}

// =====================================================================
// Express Routes
// =====================================================================

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.post('/ask', async (req, res) => {
  const { prompt, callId, devicePrompt } = req.body;
  const startTime = Date.now();
  const ts = new Date().toISOString();

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt' });
  }

  const existingSession = callId ? sessions.has(callId) : false;
  console.log(`[${ts}] QUERY: "${prompt.substring(0, 80)}"`);
  console.log(`[${ts}] SESSION: callId=${callId || 'none'}, existing=${existingSession}`);

  try {
    let fullPrompt = '';
    if (devicePrompt) {
      fullPrompt += `[DEVICE IDENTITY] ${devicePrompt} [END DEVICE IDENTITY] `;
    }
    fullPrompt += VOICE_CONTEXT + ' ' + prompt;

    const result = await runClaude({
      prompt: fullPrompt,
      callId,
      model: CLAUDE_MODEL,
    });

    console.log(`[${new Date().toISOString()}] RESPONSE (${result.duration_ms}ms, $${result.cost_usd.toFixed(4)}): "${result.response.substring(0, 100)}..."`);

    if (result.sessionId && callId) {
      sessions.set(callId, result.sessionId);
    }

    res.json({
      success: true,
      response: result.response,
      sessionId: result.sessionId,
      duration_ms: result.duration_ms,
    });
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    console.error(`[${ts}] ERROR: ${error.message}`);

    res.json({
      success: true,
      response: "I'm having trouble processing that right now. Try again in a moment.",
      duration_ms,
    });
  }
});

app.post('/ask-structured', async (req, res) => {
  const { prompt, callId, devicePrompt } = req.body || {};

  try {
    let fullPrompt = prompt || '';
    if (devicePrompt) fullPrompt = devicePrompt + ' ' + fullPrompt;

    const result = await runClaude({ prompt: fullPrompt, callId, model: CLAUDE_MODEL });
    res.json({ success: true, data: result.response, raw_response: result.response, duration_ms: result.duration_ms });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/end-session', (req, res) => {
  const { callId } = req.body;
  if (callId && sessions.has(callId)) {
    sessions.delete(callId);
    console.log(`[${new Date().toISOString()}] SESSION ENDED: ${callId}`);
  }
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'fast-spawn',
    model: CLAUDE_MODEL,
    activeSessions: sessions.size,
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Claude HTTP API Server (Fast Spawn)',
    version: '2.0.0',
    mode: 'Uses --output-format json for clean parsing, session resume for multi-turn',
  });
});

// =====================================================================
// Startup
// =====================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(64));
  console.log('  Claude HTTP API Server (Fast Spawn)');
  console.log('='.repeat(64));
  console.log(`\n  Listening on: http://0.0.0.0:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  Model: ${CLAUDE_MODEL}`);
  console.log(`  Claude: ${CLAUDE_BIN}\n`);
});

process.on('SIGTERM', () => { console.log('\nShutting down...'); process.exit(0); });
process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
