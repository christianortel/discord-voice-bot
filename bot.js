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
const autoLeaveWhenEmpty = process.env.AUTO_LEAVE_WHEN_EMPTY === "true";
const leaveEmptyAfterMs = Number(process.env.LEAVE_EMPTY_AFTER_MS || 120_000);

const masterPersonaInstructions = `
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
  if (newState.id === client.user?.id || oldState.id === client.user?.id) {
    const session = sessions.get(newState.guild.id || oldState.guild.id);
    if (!session) return;

    if (newState.channelId) {
      session.channelId = newState.channelId;
      clearEmptyLeaveTimer(session);
      console.log(`[discord] bot moved to ${newState.channel?.name || newState.channelId}`);
    } else {
      destroySession(newState.guild.id || oldState.guild.id);
    }
    return;
  }

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
