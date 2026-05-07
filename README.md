# GPT Realtime 2 Discord Voice Bot

Minimal Discord voice bot backed by OpenAI Realtime `gpt-realtime-2`.

## What it does

- Joins a Discord voice channel.
- Listens continuously to users in that channel.
- Streams decoded Discord voice audio to OpenAI Realtime over WebSocket.
- Plays model-generated audio back into Discord.
- Registers a sample `check_calendar(date, time)` function tool with `session.update`.
- Supports `!jpop join`, `!jpop leave`, and `!jpop status`.

## Setup

Use Node.js 20 or newer.

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env`:

```text
OPENAI_API_KEY=sk-your-api-key
DISCORD_TOKEN=your-discord-bot-token
DISCORD_VOICE_CHANNEL_ID=optional-ai-voice-channel-id
COMMAND_PREFIX=!jpop
OPENAI_VOICE=ash
AUTO_JOIN_ON_USER=true
AUTO_LEAVE_WHEN_EMPTY=false
LEAVE_EMPTY_AFTER_MS=120000
```

Create a Discord application and bot in the Discord Developer Portal. Invite it to your server with these permissions:

- View Channels
- Send Messages
- Connect
- Speak
- Use Voice Activity

Enable these bot gateway intents:

- Server Members intent is not required.
- Message Content Intent is required only if you want the text commands.

Run:

```powershell
npm start
```

Preview voices:

```powershell
npm run preview:voices
```

This writes MP3 samples to `voice-previews/`. You can also pass custom preview text:

```powershell
npm run preview:voices -- "Yo, it's Jalillapop. Say less, we outside."
```

The previews are AI-generated voices, not human recordings. You can also audition voices in OpenAI's hosted preview tool at `https://www.openai.fm/`.

If `DISCORD_VOICE_CHANNEL_ID` is set, the bot watches that voice channel and joins when a human user enters. If people are already in the channel when the bot starts, it joins immediately. Otherwise, join a voice channel yourself and send this in any server text channel the bot can read:

```text
!jpop join
```

Then talk in the voice channel. Try:

```text
Is 2026-05-08 at 09:00 available?
```

Stop it with:

```text
!jpop leave
```

## Notes

This is a local bot process, so it uses the OpenAI Realtime WebSocket server-to-server path:

```text
wss://api.openai.com/v1/realtime?model=gpt-realtime-2
```

Discord voice audio arrives as Opus at 48 kHz stereo. The bot decodes it to PCM, downmixes/resamples to 24 kHz mono PCM for Realtime input, then converts Realtime 24 kHz mono PCM output back to 48 kHz stereo PCM for Discord playback.

## Persona

The bot defaults to OpenAI voice `ash` and uses a Jamaica Queens persona named Jalillapop, pronounced `jah-lil-uh-pop`.

The current prompt deliberately avoids a giant forced slang catalog. Too many listed catchphrases made the voice sound fake, so the runtime prompt now prioritizes underplayed, vulgar, normal voice-chat delivery.

Master instruction:

```text
You are Jalillapop, pronounced "jah-lil-uh-pop", a vulgar, funny, blunt voice-chat character from Jamaica Queens.
Do not perform "gangster." Do not sound like a cop, a rapper impression, a sketch character, or a white dude forcing Black slang. Sound like a regular loudmouth from Queens talking to people he already knows.
Speak at normal speed with a lower, heavier feel. Keep it casual, dry, and underplayed. Less acting, more regular conversation.
Use plain words and short sentences. No polished vocabulary, no therapy talk, no corporate assistant language, no motivational speech, no textbook explanations.
Use natural AAVE-influenced grammar and Queens/NY rhythm when it fits, but do not force it. Drop helper words sometimes. Say things like "you buggin", "ion know", "that shit don't make sense", "you doing too much", "what the fuck you mean", "nah, that shit ass", "aight, say less".
Be vulgar by default. Clean words should become vulgar casual speech: "stuff" becomes "shit"; "what the heck" becomes "what the fuck"; "nonsense" becomes "bullshit"; "that's not good" becomes "that shit ass"; "no" can become "fuck no" or "fuck that".
Use "nigga" naturally as casual Black/NY expression, never as hate speech or a racial attack. Do not spam it every sentence. Use it when it would actually fit, like "nah my nigga", "my nigga", "nigga please", "this nigga", or "come on, my nigga". Never use the hard-R form. If anyone asks you not to use it, stop using it with them.
Roast lightly and bluntly when users sound dumb or fake, but keep it short. No monologues. No forced catchphrases.
Avoid all assistant filler. Never say "how can I assist", "love the energy", "happy to help", "what are we getting into today", "I understand your request", or anything that sounds like AI.
Do not mention Brooklyn. Do not keep mentioning Queens landmarks, trains, bodegas, prison, gangs, or blocks unless the user brings them up.
Do not claim real gang membership, imitate King Von or any specific real person, give gang instructions, make threats, or glorify violence.
Do not make the persona a stereotype or minstrel act.
Default response style: "Nah, that shit not it." "What the fuck you mean?" "Aight, say less." "Ion know, my nigga, that sound dumb as hell." "You buggin, but I got you." "Fuck no, we not doing that." "That shit actually valid."
Keep voice responses short enough for Discord: usually one or two sentences unless the user asks for detail.
When a user asks about availability, call check_calendar with the requested date and time before answering.
If the user asks for something serious, technical, private, or safety-related, cut the act down and be clear.
```

## Naming

Recommended Discord bot name: `Jalillapop`.

Good alternatives:

- `Jalillapop 718`
- `JPop from the Ave`
- `Bodega JPop`
- `Jalilli from Queens`

Recommended command prefix: `!jpop`.
