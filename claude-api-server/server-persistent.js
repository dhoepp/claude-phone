/**
 * Claude HTTP API Server - Persistent Process Mode
 *
 * Instead of spawning a new `claude` process per query (40-70s on Pi),
 * this keeps ONE persistent claude process running in interactive mode.
 * First query is slow (process startup), all subsequent queries are fast (~5s).
 *
 * Usage:
 *   node server-persistent.js
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

/**
 * Build environment for Claude Code CLI
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

  const fullPath = [
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/python@3.12/bin',
    '/opt/homebrew/opt/libpq/bin',
    path.join(HOME, '.bun/bin'),
    path.join(HOME, '.local/bin'),
    path.join(HOME, '.npm-global/bin'),
    path.join(HOME, '.pyenv/bin'),
    path.join(HOME, '.pyenv/shims'),
    path.join(HOME, 'go/bin'),
    '/usr/local/go/bin',
    path.join(HOME, 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');

  const env = {
    ...process.env,
    ...paiEnv,
    PATH: fullPath,
    HOME,
    PAI_DIR,
    PAI_HOME: HOME,
  };

  // Do NOT set CLAUDECODE - causes "nested session" error
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Do NOT set ANTHROPIC_API_KEY - let CLI use subscription auth
  delete env.ANTHROPIC_API_KEY;

  return env;
}

const claudeEnv = buildClaudeEnvironment();
console.log('[STARTUP] Environment built with', Object.keys(claudeEnv).length, 'variables');

const VOICE_CONTEXT = `[VOICE CALL CONTEXT] This query comes via voice call. You MUST include BOTH of these lines in your response: 🗣️ VOICE_RESPONSE: [Your conversational answer in 40 words or less. This is what gets spoken aloud via TTS. Be natural and helpful, like talking to a friend.] 🎯 COMPLETED: [Status summary in 12 words or less. This is for logging only.] IMPORTANT: The VOICE_RESPONSE line is what the caller HEARS. Make it conversational and complete - don't just say "Done" or "Task completed". Actually answer their question or confirm what you did in a natural way. [END VOICE CONTEXT]`;

// =====================================================================
// Persistent Claude Process
// =====================================================================

class PersistentClaude {
  constructor(env, model) {
    this.env = env;
    this.model = model;
    this.process = null;
    this.alive = false;
    this.busy = false;
    this.buffer = '';
    this.responseText = '';
    this.currentResolve = null;
    this.currentReject = null;
    this.currentTimer = null;
    this.queue = [];
    this.queryCount = 0;
    this.restartCount = 0;
    this.lastSessionId = null;
  }

  start() {
    console.log('[CLAUDE] Spawning persistent process...');
    console.log('[CLAUDE] Model:', this.model);
    const startTime = Date.now();

    this.process = spawn('claude', [
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--model', this.model,
      '--verbose',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });

    // --- stdout: JSONL messages ---
    this.process.stdout.on('data', (chunk) => {
      this.onStdout(chunk.toString());
    });

    // --- stderr: debug / warnings ---
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        // Only log non-empty stderr, keep it short
        for (const line of text.split('\n')) {
          if (line.trim()) console.log('[CLAUDE STDERR]', line.trim().substring(0, 200));
        }
      }
    });

    this.process.on('error', (err) => {
      console.error('[CLAUDE] Spawn error:', err.message);
      this.alive = false;
    });

    this.process.on('close', (code, signal) => {
      const elapsed = Date.now() - startTime;
      console.log(`[CLAUDE] Process exited (code=${code}, signal=${signal}) after ${elapsed}ms`);
      this.alive = false;
      this.busy = false;

      // Reject pending query
      if (this.currentReject) {
        this.currentReject(new Error(`Claude process exited (code ${code})`));
        this.clearPending();
      }

      // Auto-restart (with backoff)
      this.restartCount++;
      const delay = Math.min(5000 * this.restartCount, 30000);
      console.log(`[CLAUDE] Will restart in ${delay / 1000}s (restart #${this.restartCount})`);
      setTimeout(() => this.start(), delay);
    });

    this.alive = true;
    console.log(`[CLAUDE] Process spawned (PID ${this.process.pid}), ready for queries`);

    // Process any queued queries
    this.processQueue();
  }

  onStdout(raw) {
    this.buffer += raw;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        this.onMessage(msg);
      } catch {
        // Not JSON — might be a prompt character or raw text
        // Log it for debugging
        if (trimmed.length > 1) {
          console.log('[CLAUDE RAW]', trimmed.substring(0, 200));
        }
      }
    }
  }

  onMessage(msg) {
    // ---- Accumulate text from various message formats ----

    // Format: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
    if (msg.type === 'assistant' && msg.message) {
      if (typeof msg.message === 'string') {
        this.responseText += msg.message;
      } else if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            this.responseText += block.text;
          }
        }
      } else if (typeof msg.message.content === 'string') {
        this.responseText += msg.message.content;
      }
    }

    // Format: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
    if (msg.type === 'content_block_delta' && msg.delta) {
      if (msg.delta.text) {
        this.responseText += msg.delta.text;
      }
    }

    // ---- Result = response complete ----
    if (msg.type === 'result') {
      const finalText = msg.result || this.responseText || '(empty response)';
      this.lastSessionId = msg.session_id || this.lastSessionId;
      this.restartCount = 0; // reset backoff on successful result

      console.log(`[CLAUDE] Result received (${finalText.length} chars)`);

      if (this.currentResolve) {
        this.currentResolve({
          response: finalText,
          sessionId: this.lastSessionId,
        });
        this.clearPending();
      }

      this.responseText = '';
      this.busy = false;
      this.processQueue();
    }
  }

  /**
   * Send a query to the persistent claude process.
   * Returns a promise that resolves with { response, sessionId }.
   */
  query(prompt, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const task = { prompt, resolve, reject, timeoutMs };

      if (!this.busy && this.alive) {
        this.executeQuery(task);
      } else {
        console.log(`[CLAUDE] Queueing query (busy=${this.busy}, alive=${this.alive}, queue=${this.queue.length})`);
        this.queue.push(task);

        // If not alive, start will processQueue when ready
        if (!this.alive) {
          console.log('[CLAUDE] Process not alive, query will execute after restart');
        }
      }
    });
  }

  executeQuery(task) {
    this.busy = true;
    this.responseText = '';
    this.queryCount++;
    const queryNum = this.queryCount;

    console.log(`[CLAUDE] Executing query #${queryNum} (${task.prompt.length} chars)...`);

    // Timeout
    this.currentTimer = setTimeout(() => {
      console.log(`[CLAUDE] Query #${queryNum} timed out after ${task.timeoutMs}ms`);
      if (this.currentReject) {
        this.currentReject(new Error(`Query timed out after ${task.timeoutMs}ms`));
        this.clearPending();
      }
      this.responseText = '';
      this.busy = false;
      this.processQueue();
    }, task.timeoutMs);

    this.currentResolve = task.resolve;
    this.currentReject = task.reject;

    // Flatten to single line for interactive stdin
    // (in interactive mode, newline = submit)
    const singleLine = task.prompt.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    this.process.stdin.write(singleLine + '\n');
  }

  processQueue() {
    if (this.queue.length > 0 && !this.busy && this.alive) {
      const next = this.queue.shift();
      this.executeQuery(next);
    }
  }

  clearPending() {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    this.currentResolve = null;
    this.currentReject = null;
  }

  stop() {
    console.log('[CLAUDE] Stopping persistent process...');
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.alive = false;
  }
}

// =====================================================================
// Express Routes
// =====================================================================

// Request logging
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

/**
 * POST /ask
 */
app.post('/ask', async (req, res) => {
  const { prompt, callId, devicePrompt } = req.body;
  const startTime = Date.now();
  const ts = new Date().toISOString();

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt' });
  }

  console.log(`[${ts}] QUERY: "${prompt.substring(0, 80)}..."`);
  if (devicePrompt) console.log(`[${ts}] DEVICE: ${devicePrompt.substring(0, 50)}...`);

  try {
    // Build full prompt with voice context
    let fullPrompt = '';
    if (devicePrompt) {
      fullPrompt += `[DEVICE IDENTITY] ${devicePrompt} [END DEVICE IDENTITY] `;
    }
    fullPrompt += VOICE_CONTEXT + ' ' + prompt;

    const result = await persistentClaude.query(fullPrompt);
    const duration_ms = Date.now() - startTime;

    console.log(`[${new Date().toISOString()}] RESPONSE (${duration_ms}ms): "${result.response.substring(0, 100)}..."`);

    res.json({
      success: true,
      response: result.response,
      sessionId: result.sessionId,
      duration_ms,
    });
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    console.error(`[${ts}] ERROR: ${error.message}`);

    // Return a friendly voice-appropriate error
    res.json({
      success: true,
      response: "I'm having trouble processing that right now. The AI backend may be restarting. Try again in a moment.",
      duration_ms,
    });
  }
});

/**
 * POST /ask-structured (simplified — just use /ask for now)
 */
app.post('/ask-structured', async (req, res) => {
  // Forward to /ask for now
  req.body.prompt = req.body.prompt || '';
  const { prompt, callId, devicePrompt } = req.body;

  try {
    let fullPrompt = prompt;
    if (devicePrompt) fullPrompt = devicePrompt + ' ' + fullPrompt;

    const result = await persistentClaude.query(fullPrompt);
    const duration_ms = Date.now() - (req._startTime || Date.now());

    res.json({ success: true, data: result.response, raw_response: result.response, duration_ms });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /end-session
 * With persistent process, there's nothing to clean up per-session
 */
app.post('/end-session', (req, res) => {
  const { callId } = req.body;
  if (callId) {
    console.log(`[${new Date().toISOString()}] Session noted ended: ${callId}`);
  }
  res.json({ success: true });
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: persistentClaude.alive ? 'ok' : 'starting',
    mode: 'persistent',
    pid: persistentClaude.process ? persistentClaude.process.pid : null,
    busy: persistentClaude.busy,
    queueLength: persistentClaude.queue.length,
    totalQueries: persistentClaude.queryCount,
    restarts: persistentClaude.restartCount,
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Claude HTTP API Server (Persistent Mode)',
    version: '2.0.0',
    note: 'Keeps one claude process alive — first query slow, rest fast',
  });
});

// =====================================================================
// Startup
// =====================================================================

const persistentClaude = new PersistentClaude(claudeEnv, CLAUDE_MODEL);

// Start the persistent claude process
persistentClaude.start();

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(64));
  console.log('  Claude HTTP API Server (Persistent Mode)');
  console.log('='.repeat(64));
  console.log(`\n  Listening on: http://0.0.0.0:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`\n  First query will be slow (claude loading).`);
  console.log(`  Subsequent queries should be ~5s.\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  persistentClaude.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  persistentClaude.stop();
  process.exit(0);
});
