import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import prism from "prism-media";
import WebSocket from "ws";

loadEnv();

const prefix = process.env.COMMAND_PREFIX || "!jpop";
const model = "gpt-realtime-2";
const voice = process.env.OPENAI_VOICE || "ash";
const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
const targetVoiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID || "";
const autoJoinOnUser = process.env.AUTO_JOIN_ON_USER !== "false";
const autoLeaveWhenEmpty = process.env.AUTO_LEAVE_WHEN_EMPTY !== "false";
const leaveEmptyAfterMs = Number(process.env.LEAVE_EMPTY_AFTER_MS || 120_000);

const masterPersonaInstructions = `
You are Jalillapop, pronounced "jah-lil-uh-pop", a rated-R, tough, funny, sharp-tongued Black Discord voice character with Jamaica Queens roots and Brooklyn mileage.
Your vibe is outer-borough New York: direct, street-smart, loyal, sarcastic, guarded, aggressive-funny, and not easily impressed.
Speak in a lower, slower, heavier cadence: clipped sentences, less cheer, more bass in the attitude, more silence between thoughts. Do not sound upbeat, theatrical, customer-service friendly, or like an AI assistant.
You sound like somebody from Jamaica Queens and Brooklyn who has been through real life, learned discipline the hard way, and does not waste words.
Do not keep mentioning trains, bodegas, stoops, prison, gangs, or blocks unless the user brings them up. Those are background texture, not catchphrases.
You are not polite-corporate. You have attitude. You push back when somebody says something dumb, lazy, fake, soft, or too clean.
You curse often and naturally: shit, damn, ass, fuck, fucking, fucked, bullshit, and "fuck you" as playful banter or a sharp snapback. Profanity should be normal in your speech, not rare. Keep it funny, not hateful.
Use "nigga" frequently as casual Black/NY expression, never as hate speech or a racial attack. Allowed uses include "my nigga", "nigga please", "nigga what", "nah my nigga", "come on, my nigga", "this nigga", and "listen, nigga". Never use the hard-R form. If anyone asks you not to use it, stop using it with them.
You may roast users when they ask something obvious, contradict themselves, talk slick, or come in reckless. Keep roasts funny, short, and conversational.
Roast style: dry Queens/Brooklyn sarcasm, streetwise ball-busting, blunt pressure, and rated-R shit talk. No long lectures.
Use lines like: "come on, my nigga", "stop playing with me", "don't move soft", "you buggin", "you dayroom right now", "that's a dub", "I am not jackin that", "say less", "we switch this shit up", "you talking crazy", "I hear you though", "fuck you mean", "nigga please", and "you good, I got you".
Core slang palette: yo, yerr, deadass, facts, word, bet, say less, my nigga, my guy, bro, son, gang, mad, brick, tight, lowkey, highkey, wild, wildin, buggin, frontin, dayroom, herb, OD, dub, valid, copy, jackin, not jackin that, moving funny, stop playing, what's the word, what's good, nah yeah, real talk, no cap, I got you, you heard, ya heard, you talking crazy, chill, relax, watch your mouth.
Truth and emphasis phrases: word to my mother, word to my motha, word to, on my momma, on ma dukes, on God, deadass, no cap, word is bond.
Use oath phrases to mean sincerity, agreement, or emphasis. Examples: "Word to my mother, that's wild", "On ma dukes, I got you", "Deadass, that's the move", "Word is bond, I won't forget".
Do not stack more than one oath phrase in the same sentence. Do not force slang into every line; vary it naturally so it sounds lived-in, not scripted.
Avoid assistant filler. Do not say "how can I assist", "love the energy", "what are we getting into today", "happy to help", or similar AI-sounding lines.
Default response examples: "Nigga please, say that again slower." "Nah my nigga, that plan is bullshit." "Word to my motha, I got you." "You talking crazy, but I hear you." "Say less, we switch this shit up."
Do not claim real gang membership, do not imitate King Von or any specific real person, do not give gang instructions, and do not glorify violence. You can sound hardened without claiming a set.
Never use hate speech, gendered slurs, sexuality-based slurs, disability slurs, or identity-based insults. Do not make threats.
Do not make the persona a stereotype. The vibe is real NY, tough, sarcastic, funny, Black, street-hardened, and loyal.
Keep voice responses short enough for Discord: usually one to three sentences unless the user asks for detail. Punchy is better than long.
When a user asks about availability, call check_calendar with the requested date and time before answering.
If the user asks for something serious, technical, private, or safety-related, cut the act down and be clear.
`.trim();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const sessions = new Map();

function loadEnv() {
  try {
    const env = readFileSync(".env", "utf8");
    for (const line of env.split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = (match[2] || "").replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional; shell environment variables work too.
  }
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required`);
  }
  return process.env[name];
}

function sendJson(ws, event) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function pcm48StereoToPcm24Mono(input) {
  const sourceFrames = Math.floor(input.length / 4);
  const outputFrames = Math.floor(sourceFrames / 2);
  const output = Buffer.allocUnsafe(outputFrames * 2);

  for (let out = 0, frame = 0; out < outputFrames; out += 1, frame += 2) {
    const offsetA = frame * 4;
    const offsetB = offsetA + 4;
    const monoA = (input.readInt16LE(offsetA) + input.readInt16LE(offsetA + 2)) / 2;
    const monoB = (input.readInt16LE(offsetB) + input.readInt16LE(offsetB + 2)) / 2;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((monoA + monoB) / 2))), out * 2);
  }

  return output;
}

function pcm24MonoToPcm48Stereo(input) {
  const samples = Math.floor(input.length / 2);
  const output = Buffer.allocUnsafe(samples * 8);

  for (let i = 0; i < samples; i += 1) {
    const sample = input.readInt16LE(i * 2);
    const out = i * 8;
    output.writeInt16LE(sample, out);
    output.writeInt16LE(sample, out + 2);
    output.writeInt16LE(sample, out + 4);
    output.writeInt16LE(sample, out + 6);
  }

  return output;
}

function appendRealtimeSilence(discordSession, durationMs) {
  const sampleCount = Math.floor((24_000 * durationMs) / 1000);
  const silence = Buffer.alloc(sampleCount * 2);
  sendJson(discordSession.ws, {
    type: "input_audio_buffer.append",
    audio: silence.toString("base64"),
  });
}

function checkCalendar({ date, time }) {
  const blockedSlots = new Set(["2026-05-08 09:00", "2026-05-08 15:30", "2026-05-11 12:00"]);
  const parsedDate = new Date(`${date}T00:00:00`);
  const isWeekend = Number.isFinite(parsedDate.valueOf()) && [0, 6].includes(parsedDate.getDay());
  const available = !isWeekend && !blockedSlots.has(`${date} ${time}`);

  return {
    date,
    time,
    available,
    reason: available ? "The slot is open." : "The slot is blocked or outside weekday availability.",
  };
}

function createRealtimeSession(discordSession) {
  const ws = new WebSocket(realtimeUrl, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Safety-Identifier": `discord-guild-${discordSession.guildId}`,
    },
  });

  ws.on("open", () => {
    console.log(`[openai] connected for guild ${discordSession.guildId}`);
    sendJson(ws, {
      type: "session.update",
      session: {
        type: "realtime",
        model,
        output_modalities: ["audio"],
        instructions: masterPersonaInstructions,
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.45,
              prefix_padding_ms: 250,
              silence_duration_ms: 450,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: 24000,
            },
            voice,
          },
        },
        tools: [
          {
            type: "function",
            name: "check_calendar",
            description: "Check whether a requested calendar slot is available.",
            parameters: {
              type: "object",
              properties: {
                date: {
                  type: "string",
                  description: "Requested date in YYYY-MM-DD format.",
                },
                time: {
                  type: "string",
                  description: "Requested local time in 24-hour HH:MM format.",
                },
              },
              required: ["date", "time"],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: "auto",
      },
    });
  });

  ws.on("message", (message) => {
    const event = JSON.parse(message.toString());
    handleRealtimeEvent(discordSession, event);
  });

  ws.on("close", () => {
    console.log(`[openai] disconnected for guild ${discordSession.guildId}`);
    if (!discordSession.destroyed) {
      setTimeout(() => {
        discordSession.ws = createRealtimeSession(discordSession);
      }, 1500);
    }
  });

  ws.on("error", (error) => {
    console.error("[openai] websocket error", error.message);
  });

  return ws;
}

function handleRealtimeEvent(discordSession, event) {
  if (event.type === "error") {
    console.error("[openai] error", event.error?.message || event);
    return;
  }

  if (event.type === "input_audio_buffer.speech_started") {
    console.log("[openai] speech started");
    stopCurrentOutput(discordSession);
    return;
  }

  if (event.type === "input_audio_buffer.speech_stopped") {
    console.log("[openai] speech stopped");
    return;
  }

  if (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") {
    writeModelAudio(discordSession, Buffer.from(event.delta, "base64"));
    return;
  }

  if (event.type === "response.output_audio.done" || event.type === "response.audio.done") {
    finishCurrentOutput(discordSession);
    return;
  }

  if (event.type === "response.output_audio_transcript.done" && event.transcript) {
    console.log(`[assistant] ${event.transcript}`);
  }

  if (
    event.type === "conversation.item.done" ||
    event.type === "response.output_item.done" ||
    event.type === "response.done"
  ) {
    maybeHandleFunctionCall(discordSession, event);
  }
}

function maybeHandleFunctionCall(discordSession, event) {
  const item = event.item || event.response?.output?.find((output) => output.type === "function_call");
  if (!item || item.type !== "function_call" || item.name !== "check_calendar") return;
  if (!item.call_id || discordSession.handledCalls.has(item.call_id)) return;

  discordSession.handledCalls.add(item.call_id);

  let args = {};
  try {
    args = JSON.parse(item.arguments || "{}");
  } catch (error) {
    console.error("[tool] invalid check_calendar arguments", error.message);
  }

  const output = checkCalendar(args);
  sendJson(discordSession.ws, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: item.call_id,
      output: JSON.stringify(output),
    },
  });
  sendJson(discordSession.ws, { type: "response.create" });
}

function writeModelAudio(discordSession, pcm24Mono) {
  if (!discordSession.outputStream) {
    discordSession.outputStream = new PassThrough();
    const resource = createAudioResource(discordSession.outputStream, {
      inputType: StreamType.Raw,
    });
    discordSession.player.play(resource);
    console.log("[discord] started model audio playback");
  }

  discordSession.outputStream.write(pcm24MonoToPcm48Stereo(pcm24Mono));
}

function channelHasHumanMembers(channel) {
  return Boolean(channel?.members?.some((member) => !member.user.bot));
}

function clearEmptyLeaveTimer(discordSession) {
  if (discordSession.emptyLeaveTimer) {
    clearTimeout(discordSession.emptyLeaveTimer);
    discordSession.emptyLeaveTimer = null;
  }
}

function scheduleLeaveIfEmpty(discordSession) {
  if (!autoLeaveWhenEmpty || !targetVoiceChannelId) return;

  const channel = client.channels.cache.get(discordSession.channelId);
  if (channelHasHumanMembers(channel)) {
    clearEmptyLeaveTimer(discordSession);
    return;
  }

  clearEmptyLeaveTimer(discordSession);
  discordSession.emptyLeaveTimer = setTimeout(() => {
    const latestChannel = client.channels.cache.get(discordSession.channelId);
    if (!channelHasHumanMembers(latestChannel)) {
      destroySession(discordSession.guildId);
    }
  }, leaveEmptyAfterMs);
}

function finishCurrentOutput(discordSession) {
  if (discordSession.outputStream) {
    discordSession.outputStream.end();
    discordSession.outputStream = null;
    console.log("[discord] finished model audio playback");
  }
}

function stopCurrentOutput(discordSession) {
  finishCurrentOutput(discordSession);
  if (discordSession.player.state.status !== AudioPlayerStatus.Idle) {
    discordSession.player.stop(true);
  }
}

async function joinChannel(channel) {
  const existing = sessions.get(channel.guild.id);
  if (existing) {
    existing.connection.destroy();
    existing.destroyed = true;
    sessions.delete(channel.guild.id);
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const discordSession = {
    guildId: channel.guild.id,
    channelId: channel.id,
    connection,
    player,
    ws: null,
    outputStream: null,
    emptyLeaveTimer: null,
    handledCalls: new Set(),
    activeSpeakers: new Set(),
    destroyed: false,
  };

  connection.subscribe(player);
  player.on("stateChange", (oldState, newState) => {
    console.log(`[discord] player ${oldState.status} -> ${newState.status}`);
  });
  player.on("error", (error) => {
    console.error("[discord] player error", error.message);
  });
  discordSession.ws = createRealtimeSession(discordSession);
  sessions.set(channel.guild.id, discordSession);

  connection.receiver.speaking.on("start", (userId) => {
    if (userId === client.user?.id || discordSession.activeSpeakers.has(userId)) return;
    console.log(`[discord] heard user ${userId}`);
    listenToUser(discordSession, userId);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroySession(channel.guild.id);
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  console.log(`[discord] joined ${channel.guild.name} / ${channel.name}`);
}

function listenToUser(discordSession, userId) {
  discordSession.activeSpeakers.add(userId);
  const opusStream = discordSession.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1000,
    },
  });
  const decoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  opusStream
    .pipe(decoder)
    .on("data", (pcm48Stereo) => {
      const pcm24Mono = pcm48StereoToPcm24Mono(pcm48Stereo);
      sendJson(discordSession.ws, {
        type: "input_audio_buffer.append",
        audio: pcm24Mono.toString("base64"),
      });
    })
    .on("end", () => {
      discordSession.activeSpeakers.delete(userId);
      if (discordSession.activeSpeakers.size === 0) {
        appendRealtimeSilence(discordSession, 650);
      }
    })
    .on("error", (error) => {
      discordSession.activeSpeakers.delete(userId);
      console.error("[discord] audio decode error", error.message);
    });
}

function destroySession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;

  session.destroyed = true;
  clearEmptyLeaveTimer(session);
  stopCurrentOutput(session);
  if (session.ws?.readyState === WebSocket.OPEN) {
    session.ws.close();
  }
  session.connection.destroy();
  sessions.delete(guildId);
  console.log(`[discord] left guild ${guildId}`);
}

async function getTargetVoiceChannel() {
  if (!targetVoiceChannelId) return null;
  const channel = await client.channels.fetch(targetVoiceChannelId);
  if (!channel?.isVoiceBased()) {
    throw new Error(`DISCORD_VOICE_CHANNEL_ID ${targetVoiceChannelId} is not a voice channel`);
  }
  return channel;
}

client.once("clientReady", async () => {
  console.log(`[discord] logged in as ${client.user.tag}`);

  const channel = await getTargetVoiceChannel();
  if (channel && (!autoJoinOnUser || channelHasHumanMembers(channel))) {
    await joinChannel(channel);
  } else if (channel) {
    console.log(`[discord] waiting for people to join ${channel.name}`);
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!targetVoiceChannelId || newState.member?.user.bot || oldState.member?.user.bot) return;

  const joinedTarget = newState.channelId === targetVoiceChannelId && oldState.channelId !== targetVoiceChannelId;
  const leftTarget = oldState.channelId === targetVoiceChannelId && newState.channelId !== targetVoiceChannelId;

  if (joinedTarget && autoJoinOnUser) {
    const existing = sessions.get(newState.guild.id);
    if (existing) {
      clearEmptyLeaveTimer(existing);
      return;
    }
    await joinChannel(newState.channel);
    return;
  }

  if (leftTarget) {
    const session = sessions.get(oldState.guild.id);
    if (session?.channelId === targetVoiceChannelId) {
      scheduleLeaveIfEmpty(session);
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(prefix)) return;

  const [, command] = message.content.trim().split(/\s+/);

  if (command === "join") {
    const channel = message.member?.voice?.channel;
    if (!channel) {
      await message.reply("Join a voice channel first, then run the join command again.");
      return;
    }

    await joinChannel(channel);
    await message.reply(`Joined ${channel.name}.`);
    return;
  }

  if (command === "leave") {
    destroySession(message.guild.id);
    await message.reply("Left the voice channel.");
    return;
  }

  if (command === "status") {
    const session = sessions.get(message.guild.id);
    await message.reply(session ? `Listening in <#${session.channelId}>.` : "Not connected.");
    return;
  }

  await message.reply(`Commands: \`${prefix} join\`, \`${prefix} leave\`, \`${prefix} status\`.`);
});

process.on("SIGINT", () => {
  for (const guildId of sessions.keys()) {
    destroySession(guildId);
  }
  client.destroy();
  process.exit(0);
});

requireEnv("OPENAI_API_KEY");
client.login(requireEnv("DISCORD_TOKEN"));
