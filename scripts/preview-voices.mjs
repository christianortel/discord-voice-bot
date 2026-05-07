import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

loadEnv();

const voices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];

const input =
  process.argv.slice(2).join(" ") ||
  "Yo, it's Jalillapop. Word to my motha, if this voice ain't it, we switch this shit up. Say less.";

const instructions =
  "Speak like a tough, sarcastic Black New York Discord voice bot. Keep it natural, conversational, and not theatrical.";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required. Put it in .env or your shell environment.");
}

const outputDir = resolve("voice-previews");
await mkdir(outputDir, { recursive: true });

for (const voice of voices) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input,
      instructions,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`Failed ${voice}: ${response.status} ${detail}`);
    continue;
  }

  const filePath = resolve(outputDir, `${voice}.mp3`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
  console.log(`Wrote ${filePath}`);
}

console.log(`\nPreview text: ${input}`);
console.log("Disclosure: these previews are AI-generated voices, not human recordings.");

async function loadEnv() {
  if (!existsSync(".env")) return;

  const env = await readFile(".env", "utf8");
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = (match[2] || "").replace(/^["']|["']$/g, "");
  }
}
