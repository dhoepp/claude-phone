# Claude Phone Setup - No 3CX (Direct SIP)

## What We're Doing

Skip 3CX entirely. Drachtio already listens on port 5060 and accepts SIP calls directly.
You call the Pi from a SIP softphone app on your phone.

```
Phone (SIP softphone)  --->  sip:9000@10.3.16.46:5060
                                    |
                              Raspberry Pi
                         drachtio -> FreeSWITCH
                              voice-app
                                    |
                         claude-api-server (port 3333)
```

---

## Step 1: Create .env file

```bash
cp ~/claude-phone/.env.example ~/claude-phone/.env
nano ~/claude-phone/.env
```

Set these values:

```env
EXTERNAL_IP=10.3.16.46

# Drachtio (leave defaults)
DRACHTIO_HOST=127.0.0.1
DRACHTIO_PORT=9022
DRACHTIO_SECRET=cymru
DRACHTIO_SIP_PORT=5060

# FreeSWITCH (leave defaults)
FREESWITCH_HOST=127.0.0.1
FREESWITCH_PORT=8021
FREESWITCH_SECRET=JambonzR0ck$

# SIP - dummy values since we're not registering with any PBX
SIP_DOMAIN=local
SIP_REGISTRAR=127.0.0.1
SIP_EXTENSION=9000
SIP_AUTH_ID=none
SIP_PASSWORD=none

# Claude API server - running locally on the Pi
CLAUDE_API_URL=http://127.0.0.1:3333

# >>> PASTE YOUR API KEYS HERE <<<
ELEVENLABS_API_KEY=PASTE_HERE
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
OPENAI_API_KEY=PASTE_HERE

# App settings
HTTP_PORT=3000
WS_PORT=3001
AUDIO_DIR=/app/audio
```

---

## Step 2: Create devices.json

```bash
cat > ~/claude-phone/voice-app/config/devices.json << 'EOF'
{
  "9000": {
    "name": "Claude",
    "extension": "9000",
    "authId": "",
    "password": "",
    "voiceId": "JBFqnCBsd6RMkjVDRZzb",
    "prompt": "You are Claude, a helpful AI voice assistant. Keep voice responses concise, under 40 words. Be conversational and natural."
  }
}
EOF
```

---

## Step 3: Patch index.js to skip 3CX registration

Edit `~/claude-phone/voice-app/index.js`. Find this line (~line 108):

```js
    registrar.registerAll(deviceRegistry.getRegistrationConfigs());
```

Replace it with:

```js
    // Skip registration if no real SIP credentials (no 3CX)
    const regConfigs = deviceRegistry.getRegistrationConfigs();
    const hasRealCreds = Object.values(regConfigs).some(
      d => d.authId && d.authId !== "" && d.authId !== "none"
    );
    if (hasRealCreds) {
      registrar.registerAll(regConfigs);
    } else {
      console.log("[MULTI-REGISTRAR] No SIP credentials - skipping registration (direct SIP mode)");
    }
```

---

## Step 4: Build and start Docker containers

```bash
cd ~/claude-phone
docker compose up -d --build
```

Check logs:
```bash
docker compose logs -f voice-app
```

You should see "READY Voice interface is fully connected!" and NO registration errors.

---

## Step 5: Start the Claude API server

The API server wraps Claude Code CLI. In a separate byobu window:

```bash
cd ~/claude-phone/claude-api-server
npm install
node server.js
```

This runs on port 3333. Keep it running.

If Claude Code CLI isn't installed on the Pi yet:
```bash
npm install -g @anthropic-ai/claude-code
```

---

## Step 6: Call from a SIP softphone

Install any SIP client app on your phone or Mac.

### Recommended apps:
| Platform | App | Notes |
|----------|-----|-------|
| Mac | **Telephone** (`brew install --cask telephone`) | Free, simple |
| iOS | **Ooh SIP Dialer** or **Groundwire** | Free / $10 |
| Android | **CSipSimple** or **Ooh SIP** | Free |

### How to call:
Dial this SIP URI directly: `sip:9000@10.3.16.46`

Or set up an "account" with:
- Server: `10.3.16.46`
- Username: `anything` (doesn't matter)
- Password: `anything`
- Registration will fail and that's fine - you can still dial out

---

## Testing Checklist

1. Docker containers running: `docker compose ps` (should show drachtio, freeswitch, voice-app)
2. API server healthy: `curl http://127.0.0.1:3333/health`
3. Call `sip:9000@10.3.16.46` from softphone
4. Hear greeting -> beep -> speak -> get response

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No audio | Verify `EXTERNAL_IP=10.3.16.46` in .env matches Pi's actual IP |
| Call rejected / 488 | Check `docker compose logs voice-app` for codec errors |
| "Something went wrong" | API server not running - check `curl http://127.0.0.1:3333/health` |
| Registration errors in logs | Expected if Step 3 patch not applied - harmless but noisy |
| voice-app can't connect to drachtio | Wait 10s after `docker compose up`, drachtio needs time to start |

---

## API Keys You Need

1. **ELEVENLABS_API_KEY** - from https://elevenlabs.io (for text-to-speech)
2. **OPENAI_API_KEY** - from https://platform.openai.com (for Whisper speech-to-text)
3. **ANTHROPIC_API_KEY** - for Claude Code CLI (set via `claude` command or env var on the Pi)
