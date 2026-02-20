/**
 * SIP Call Handler with Conversation Loop
 * v12: Device registry integration with proper method names
 */

const { setTimeout: sleep } = require('node:timers/promises');

// Audio cue URLs
const READY_BEEP_URL = 'http://127.0.0.1:3000/static/ready-beep.wav';
const GOTIT_BEEP_URL = 'http://127.0.0.1:3000/static/gotit-beep.wav';
const HOLD_MUSIC_URL = 'http://127.0.0.1:3000/static/hold-music.mp3';

// Default voice ID (Morpheus)
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

// Claude Code-style thinking phrases
const THINKING_PHRASES = [
  "Pondering...",
  "Elucidating...",
  "Cogitating...",
  "Ruminating...",
  "Contemplating...",
  "Consulting the oracle...",
  "Summoning knowledge...",
  "Engaging neural pathways...",
  "Accessing the mainframe...",
  "Querying the void...",
  "Let me think about that...",
  "Processing...",
  "Hmm, interesting question...",
  "One moment...",
  "Searching my brain...",
];

function getRandomThinkingPhrase() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

function extractCallerId(req) {
  var from = req.get("From") || "";
  var match = from.match(/sip:([+\d]+)@/);
  if (match) return match[1];
  var numMatch = from.match(/<sip:(\d+)@/);
  if (numMatch) return numMatch[1];
  return "unknown";
}

/**
 * Extract dialed extension from SIP To header
 */
function extractDialedExtension(req) {
  var to = req.get("To") || "";
  var match = to.match(/sip:(\d+)@/);
  if (match) {
    return match[1];
  }
  return null;
}

function isGoodbye(transcript) {
  const lower = transcript.toLowerCase().trim();
  const goodbyePhrases = ['goodbye', 'good bye', 'bye', 'hang up', 'end call', "that's all", 'thats all'];
  return goodbyePhrases.some(function(phrase) {
    return lower === phrase || lower.includes(' ' + phrase) ||
           lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase);
  });
}

/**
 * Extract voice-friendly line from Claude's response
 * Priority: VOICE_RESPONSE > CUSTOM COMPLETED > COMPLETED > first sentence
 */
function extractVoiceLine(response) {
  // Priority 1: VOICE_RESPONSE (new format)
  var voiceMatch = response.match(/🗣️\s*VOICE_RESPONSE:\s*([^\n]+)/im);
  if (voiceMatch) {
    var text = voiceMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 60) {
      return text;
    }
  }

  // Priority 2: CUSTOM COMPLETED
  var customMatch = response.match(/🗣️\s*CUSTOM\s+COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (customMatch) {
    text = customMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 50) {
      return text;
    }
  }

  // Priority 3: COMPLETED
  var completedMatch = response.match(/🎯\s*COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (completedMatch) {
    return completedMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
  }

  // Priority 4: First ~60 words (do not split on ! or ? - natural speech)
  var words = response.replace(/[*#`]/g, "").trim().split(/\s+/).slice(0, 120);
  if (words.length > 0) {
    return words.join(" ");
  }

  return response.substring(0, 500).trim();
}

/**
 * Main conversation loop
 * @param {Object} deviceConfig - Device configuration (name, prompt, voiceId, etc.) or null for default
 */
async function conversationLoop(endpoint, dialog, callUuid, options, deviceConfig, callerId) {
  const { ttsService, whisperClient, claudeBridge, wsPort, audioForkServer } = options;

  let session = null;
  let forkRunning = false;
  const callTranscript = [];
  const callStart = new Date().toISOString();


  // Get device-specific settings
  const deviceName = deviceConfig ? deviceConfig.name : 'Morpheus';
  const devicePrompt = deviceConfig ? deviceConfig.prompt : null;

  // Notify n8n that a call started
  try {
    const http = require("http");
    const startPayload = JSON.stringify({ callId: callUuid, device: deviceName, callerId: callerId || "unknown", message: "call started", time: callStart });
    const startReq = http.request({
      hostname: "10.3.16.46", port: 5678, path: "/webhook/claude-phone", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(startPayload) },
      timeout: 5000
    });
    startReq.on("error", function(e) { console.log("[WEBHOOK] Start error: " + e.message); });
    startReq.write(startPayload);
    startReq.end();
    console.log("[WEBHOOK] Call started notification sent");
  } catch (e) {
    console.log("[WEBHOOK] Start failed: " + e.message);
  }
  const voiceId = (deviceConfig && deviceConfig.voiceId) ? deviceConfig.voiceId : DEFAULT_VOICE_ID;
  const greeting = deviceConfig && deviceConfig.name !== 'Morpheus'
    ? "Hello! I'm " + deviceConfig.name + ". How can I help you today?"
    : "Hello! I'm your server. How can I help you today?";

  try {
    console.log('[' + new Date().toISOString() + '] CONVERSATION Starting (session: ' + callUuid + ', device: ' + deviceName + ', voice: ' + voiceId + ')...');

    // Play device-specific greeting with device voice
    const greetingUrl = await ttsService.generateSpeech(greeting, voiceId);
    await endpoint.play(greetingUrl);

    // Start fork for entire call
    const wsUrl = 'ws://127.0.0.1:' + wsPort + '/' + encodeURIComponent(callUuid);
    const sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });

    await endpoint.forkAudioStart({
      wsUrl: wsUrl,
      mixType: 'mono',
      sampling: '16k'
    });
    forkRunning = true;

    session = await sessionPromise;
    console.log('[' + new Date().toISOString() + '] AUDIO Fork connected');

    // Main conversation loop
    let turnCount = 0;
    const MAX_TURNS = 20;

    while (turnCount < MAX_TURNS) {
      turnCount++;
      console.log('[' + new Date().toISOString() + '] CONVERSATION Turn ' + turnCount + '/' + MAX_TURNS);

      // READY BEEP
      try {
        await endpoint.play(READY_BEEP_URL);
      } catch (e) {
        console.log('[' + new Date().toISOString() + '] BEEP: Ready beep failed, continuing');
      }

      session.setCaptureEnabled(true);
      console.log('[' + new Date().toISOString() + '] LISTEN Waiting for speech...');

      let utterance = null;
      try {
        utterance = await session.waitForUtterance({ timeoutMs: 30000 });
        console.log('[' + new Date().toISOString() + '] LISTEN Got: ' + utterance.audio.length + ' bytes');
      } catch (err) {
        console.log('[' + new Date().toISOString() + '] LISTEN Timeout: ' + err.message);
      }

      session.setCaptureEnabled(false);

      if (!utterance) {
        const promptUrl = await ttsService.generateSpeech("I didn't hear anything. Are you still there?", voiceId);
        await endpoint.play(promptUrl);
        continue;
      }

      // GOT-IT BEEP
      try {
        await endpoint.play(GOTIT_BEEP_URL);
      } catch (e) {
        console.log('[' + new Date().toISOString() + '] BEEP: Got-it beep failed, continuing');
      }

      // Transcribe
      const transcript = await whisperClient.transcribe(utterance.audio, {
        format: 'pcm',
        sampleRate: 16000
      });

      console.log('[' + new Date().toISOString() + '] WHISPER: "' + transcript + '"');

      callTranscript.push({ role: "user", text: transcript, time: new Date().toISOString() });

      if (!transcript || transcript.trim().length < 2) {
        const clarifyUrl = await ttsService.generateSpeech("Sorry, I didn't catch that. Could you repeat?", voiceId);
        await endpoint.play(clarifyUrl);
        continue;
      }

      if (isGoodbye(transcript)) {
        callTranscript.push({ role: "assistant", text: "Goodbye! Call again anytime.", time: new Date().toISOString() });
        const byeUrl = await ttsService.generateSpeech("Goodbye! Call again anytime.", voiceId);
        await endpoint.play(byeUrl);
        break;
      }

      // THINKING FEEDBACK
      const thinkingPhrase = getRandomThinkingPhrase();
      console.log('[' + new Date().toISOString() + '] THINKING: "' + thinkingPhrase + '"');
      const thinkingUrl = await ttsService.generateSpeech(thinkingPhrase, voiceId);
      await endpoint.play(thinkingUrl);

      // Hold music in background
      let musicPlaying = false;
      endpoint.play(HOLD_MUSIC_URL).catch(function(e) {
        console.log('[' + new Date().toISOString() + '] MUSIC: Hold music failed, continuing');
      });
      musicPlaying = true;

      // Query Claude with device-specific prompt
      console.log('[' + new Date().toISOString() + '] CLAUDE Querying (device: ' + deviceName + ')...');
      const claudeResponse = await claudeBridge.query(
        transcript,
        { callId: callUuid, devicePrompt: devicePrompt }
      );

      // Stop hold music
      if (musicPlaying) {
        try {
          await endpoint.api('uuid_break', endpoint.uuid);
        } catch (e) {}
      }

      console.log('[' + new Date().toISOString() + '] CLAUDE Response received');

      // Extract and play voice line with device voice
      const voiceLine = extractVoiceLine(claudeResponse);
      console.log('[' + new Date().toISOString() + '] VOICE: "' + voiceLine + '"');

      callTranscript.push({ role: "assistant", text: voiceLine, time: new Date().toISOString() });
      const responseUrl = await ttsService.generateSpeech(voiceLine, voiceId);
      await endpoint.play(responseUrl);

      console.log('[' + new Date().toISOString() + '] CONVERSATION Turn ' + turnCount + ' complete');
    }

    if (turnCount >= MAX_TURNS) {
      const maxUrl = await ttsService.generateSpeech("We've been talking for a while. Goodbye!", voiceId);
      await endpoint.play(maxUrl);
    }

  } catch (error) {
    console.error('[' + new Date().toISOString() + '] CONVERSATION Error:', error.message);
    try {
      if (session) session.setCaptureEnabled(false);
      const errUrl = await ttsService.generateSpeech("Sorry, something went wrong.", voiceId);
      await endpoint.play(errUrl);
    } catch (e) {}
  } finally {
    console.log('[' + new Date().toISOString() + '] CONVERSATION Cleanup...');

    try {
      await claudeBridge.endSession(callUuid);
    } catch (e) {}

    if (forkRunning) {
      try {
        await endpoint.forkAudioStop();
      } catch (e) {}
    }

    // Send transcript to n8n webhook
    try {
      const http = require("http");
      const transcriptText = callTranscript.map(function(t) {
        return (t.role === "user" ? "Caller" : "Claude") + ": " + t.text.trim();
      }).join("\n");
      const payload = JSON.stringify({
        callId: callUuid,
        device: deviceName,
        callerId: callerId || "unknown",
        startTime: callStart,
        endTime: new Date().toISOString(),
        turns: callTranscript.length,
        transcript: transcriptText
      });
      const webhookReq = http.request({
        hostname: "10.3.16.46",
        port: 5678,
        path: "/webhook/claude-phone",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 5000
      });
      webhookReq.on("error", function(e) { console.log("[WEBHOOK] Error: " + e.message); });
      webhookReq.write(payload);
      webhookReq.end();
      console.log("[WEBHOOK] Transcript sent (" + callTranscript.length + " turns)");
    } catch (e) {
      console.log("[WEBHOOK] Failed: " + e.message);
    }

    try { dialog.destroy(); } catch (e) {}
  }
}

/**
 * Strip video tracks from SDP (FreeSWITCH doesn't support H.261 and rejects with 488)
 * Keeps only audio tracks to ensure codec negotiation succeeds
 */
function stripVideoFromSdp(sdp) {
  if (!sdp) return sdp;

  const lines = sdp.split('\r\n');
  const result = [];
  let inVideoSection = false;

  for (const line of lines) {
    // Check if we're entering a video media section
    if (line.startsWith('m=video')) {
      inVideoSection = true;
      continue; // Skip the m=video line
    }

    // Check if we're entering a new media section (audio, etc.)
    if (line.startsWith('m=') && !line.startsWith('m=video')) {
      inVideoSection = false;
    }

    // Skip all lines in the video section
    if (inVideoSection) {
      continue;
    }

    result.push(line);
  }

  return result.join('\r\n');
}

/**
 * Handle incoming SIP INVITE
 */
async function handleInvite(req, res, options) {
  const { mediaServer, deviceRegistry } = options;

  const callerId = extractCallerId(req);
  const dialedExt = extractDialedExtension(req);

  // Look up device config using deviceRegistry.get() (works with name OR extension)
  let deviceConfig = null;
  if (deviceRegistry && dialedExt) {
    deviceConfig = deviceRegistry.get(dialedExt);
    if (deviceConfig) {
      console.log('[' + new Date().toISOString() + '] CALL Device matched: ' + deviceConfig.name + ' (ext ' + dialedExt + ')');
    } else {
      console.log('[' + new Date().toISOString() + '] CALL Unknown extension ' + dialedExt + ', using default');
      deviceConfig = deviceRegistry.getDefault();
    }
  }

  // External calls (VoIP trunk) have no extension in To header - use first configured device
  if (!deviceConfig && deviceRegistry) {
    const allDevices = deviceRegistry.getAllDevices();
    const firstExt = Object.keys(allDevices)[0];
    if (firstExt) {
      deviceConfig = allDevices[firstExt];
      console.log('[' + new Date().toISOString() + '] CALL External call (no ext), using device: ' + deviceConfig.name);
    } else {
      deviceConfig = deviceRegistry.getDefault();
      console.log('[' + new Date().toISOString() + '] CALL External call, using Morpheus default');
    }
  }

  console.log('[' + new Date().toISOString() + '] CALL Incoming from: ' + callerId + ' to ext: ' + (dialedExt || 'unknown'));

  try {
    // Strip video from SDP to avoid FreeSWITCH 488 error with unsupported video codecs
    const originalSdp = req.body;
    const audioOnlySdp = stripVideoFromSdp(originalSdp);
    if (originalSdp !== audioOnlySdp) {
      console.log('[' + new Date().toISOString() + '] CALL Stripped video track from SDP');
    }

    const result = await mediaServer.connectCaller(req, res, { remoteSdp: audioOnlySdp });
    const { endpoint, dialog } = result;
    const callUuid = endpoint.uuid;

    console.log('[' + new Date().toISOString() + '] CALL Connected: ' + callUuid);

    dialog.on('destroy', function() {
      console.log('[' + new Date().toISOString() + '] CALL Ended');
      if (endpoint) endpoint.destroy().catch(function() {});
    });

    // Special handling: send DTMF 5 after 20s for specific caller
    if (callerId === '12024993650' || callerId === '+12024993650' || callerId === '2024993650') {
      console.log('[' + new Date().toISOString() + '] DTMF Waiting 20s before sending tone 5 to ' + callerId);
      await new Promise(function(r) { setTimeout(r, 20000); });
      try {
        await endpoint.api('uuid_send_dtmf', endpoint.uuid + ' 5');
        console.log('[' + new Date().toISOString() + '] DTMF Sent tone 5');
      } catch (e) {
        console.log('[' + new Date().toISOString() + '] DTMF Failed: ' + e.message);
      }
      await new Promise(function(r) { setTimeout(r, 6000); });
    }

    await conversationLoop(endpoint, dialog, callUuid, options, deviceConfig, callerId);
    return { endpoint: endpoint, dialog: dialog, callerId: callerId, callUuid: callUuid };

  } catch (error) {
    console.error('[' + new Date().toISOString() + '] CALL Error:', error.message);
    try { res.send(500); } catch (e) {}
    throw error;
  }
}

module.exports = {
  handleInvite: handleInvite,
  extractCallerId: extractCallerId,
  extractDialedExtension: extractDialedExtension
};
