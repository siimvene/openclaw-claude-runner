/**
 * Discord Context Overlay
 *
 * Watches for bot messages and appends a context fill embed
 * by querying the bridge sessions API. Runs as a standalone
 * process alongside the gateway.
 *
 * Usage:
 *   node --import tsx src/discord-context-overlay.ts
 *
 * Environment:
 *   DISCORD_TOKEN     — bot token (required)
 *   DISCORD_BOT_ID    — bot user ID (auto-detected if omitted)
 *   BRIDGE_URL        — bridge base URL (default: http://127.0.0.1:7779/v1)
 *   MIN_FILL_DISPLAY  — minimum fill % to show embed (default: 0)
 */

import { Client, EmbedBuilder, GatewayIntentBits, Events, type Message } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BRIDGE_URL = (process.env.BRIDGE_URL ?? "http://127.0.0.1:7779/v1").replace(/\/+$/, "");
const MIN_FILL_DISPLAY = parseInt(process.env.MIN_FILL_DISPLAY ?? "0", 10);

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}

interface SessionInfo {
  session_id: string;
  turn_count: number;
  context: {
    fill_percent: number;
    fill_percent_display: string;
    context_window: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
  } | null;
  needs_compaction: boolean;
}

async function fetchAllSessions(): Promise<SessionInfo[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/sessions`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { sessions: SessionInfo[] };
    return data.sessions ?? [];
  } catch {
    return [];
  }
}

function findMostRecentSession(sessions: SessionInfo[]): SessionInfo | null {
  if (sessions.length === 0) return null;
  // Return the session with the highest turn count (most active)
  return sessions.reduce((best, s) =>
    (s.turn_count > best.turn_count) ? s : best
  , sessions[0]);
}

function buildContextEmbed(info: SessionInfo): EmbedBuilder | null {
  const fillPct = info.context?.fill_percent;
  if (fillPct == null) return null;

  const fillRounded = Math.round(fillPct * 100);
  if (fillRounded < MIN_FILL_DISPLAY) return null;

  const turn = info.turn_count ?? 0;

  // Color coding: green < 50%, yellow 50-74%, red 75%+
  let color: number;
  if (fillRounded >= 75) {
    color = 0xed4245; // red
  } else if (fillRounded >= 50) {
    color = 0xfee75c; // yellow
  } else {
    color = 0x57f287; // green
  }

  // Visual fill bar (10 segments)
  const filled = Math.round(fillRounded / 10);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);

  const parts = [`${bar} ${fillRounded}%`, `Turn ${turn}`];

  const totalTokens = info.context?.total_tokens;
  const contextWindow = info.context?.context_window;
  if (totalTokens != null && contextWindow != null) {
    const tokensK = (totalTokens / 1000).toFixed(1);
    const windowK = (contextWindow / 1000).toFixed(0);
    parts.push(`${tokensK}k / ${windowK}k tokens`);
  }

  if (info.needs_compaction) {
    parts.push("\u26a0 compacting soon");
  }

  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: parts.join(" \u00b7 ") });
}

// ── Main ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let botId: string | undefined = process.env.DISCORD_BOT_ID;

client.on(Events.ClientReady, () => {
  botId = client.user?.id;
  console.log(`[context-overlay] Connected as ${client.user?.tag} (${botId})`);
});

// Track messages we've already processed to avoid double-edits
const processed = new Set<string>();
const PROCESSED_MAX = 500;

client.on(Events.MessageCreate, async (message: Message) => {
  // Only process bot's own messages
  if (!botId || message.author.id !== botId) return;

  // Skip if already has embeds (already processed or system embed)
  if (message.embeds.length > 0) return;

  // Skip if already processed
  if (processed.has(message.id)) return;
  processed.add(message.id);

  // Trim processed set
  if (processed.size > PROCESSED_MAX) {
    const first = processed.values().next().value;
    if (first) processed.delete(first);
  }

  // Wait a moment for the bridge to finish processing and update session
  await new Promise((r) => setTimeout(r, 1500));

  const sessions = await fetchAllSessions();
  const session = findMostRecentSession(sessions);
  if (!session) return;

  const embed = buildContextEmbed(session);
  if (!embed) return;

  try {
    await message.edit({ content: message.content, embeds: [embed] });
  } catch (err) {
    // Message may have been deleted or we lack permissions
    console.error(`[context-overlay] Failed to edit message ${message.id}:`, err);
  }
});

// Also handle message updates (bot edits its own message during streaming)
client.on(Events.MessageUpdate, async (_old, message) => {
  if (!botId || message.author?.id !== botId) return;
  if (!message.content) return;

  // Skip if already has embeds
  if (message.embeds && message.embeds.length > 0) return;

  // Skip if already processed
  if (processed.has(message.id)) return;

  // Don't process updates too eagerly — only after content stabilizes
  // We rely on MessageCreate for the final version
});

client.login(DISCORD_TOKEN);

// Graceful shutdown
process.on("SIGINT", () => { client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { client.destroy(); process.exit(0); });
