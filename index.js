require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const fs = require("fs");
const path = require("path");

// Use persistent storage on Railway (set DATA_DIR=/data and add a Volume mounted at /data)
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const LOGGED_USERS_FILE = path.join(DATA_DIR, "logged_users.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

function ensureDataDir() {
  if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`  → Created data dir: ${DATA_DIR}`);
    } catch (e) {
      console.error("  → Failed to create data dir:", e.message);
    }
  }
}
ensureDataDir(); // Run at startup so saves work

function loadConfig() {
  const envVal = process.env.AUTOCLAIM_ENABLED;
  if (envVal === "false") return { autoclaimEnabled: false };
  if (envVal === "true") return { autoclaimEnabled: true };
  try {
    const data = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(data);
    return { autoclaimEnabled: parsed.autoclaimEnabled === true };
  } catch (e) {
    return { autoclaimEnabled: false };
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("  → Failed to save config:", e.message);
  }
}

function normalizeUsername(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .replace(/#\d+$/, "")           // Remove #1234 discriminator
    .replace(/\s*\([^)]*\)\s*$/g, "")  // Remove trailing (Discord) or similar
    .replace(/\.+$/, "")
    .trim()
    .toLowerCase();
}

function loadLoggedUsers() {
  try {
    const data = fs.readFileSync(LOGGED_USERS_FILE, "utf8");
    const parsed = JSON.parse(data);
    const ids = new Set(Array.isArray(parsed) ? parsed : (parsed.ids || []));
    const raw = Array.isArray(parsed) ? [] : (parsed.usernames || []);
    const usernames = new Set(raw.map((u) => normalizeUsername(u)).filter(Boolean));
    const claimed = new Set((parsed.claimed || []).map((u) => normalizeUsername(u)).filter(Boolean));
    return { ids, usernames, claimed };
  } catch (e) {
    return { ids: new Set(), usernames: new Set(), claimed: new Set() };
  }
}

function saveLoggedUser(userId, username) {
  try {
    loggedUserData.ids.add(userId);
    const normalized = username ? normalizeUsername(username) : "";
    if (normalized) loggedUserData.usernames.add(normalized);
    fs.writeFileSync(LOGGED_USERS_FILE, JSON.stringify({
      ids: [...loggedUserData.ids],
      usernames: [...loggedUserData.usernames],
      claimed: [...loggedUserData.claimed],
    }));
  } catch (e) {
    console.error("  → Failed to save logged user:", e.message);
  }
}

const token = process.env.DISCORD_TOKEN;
const channelIds = (process.env.CHANNEL_IDS || "").split(",").filter(Boolean);
const roverChannelId = process.env.ROVER_CHANNEL_ID;
const roverAppId = process.env.ROVER_APP_ID;
const webhookUrl = process.env.WEBHOOK_URL;
const claimChannelId = process.env.CLAIM_CHANNEL_ID;
const config = loadConfig();
let autoclaimEnabled = config.autoclaimEnabled;
const targetGroupChatId = process.env.TARGET_GROUP_CHAT_ID;
const autoclaimCommandChannelId = process.env.AUTOCLAIM_COMMAND_CHANNEL_ID || null;
const secondToken = process.env.DISCORD_TOKEN_2;

const pendingChecks = new Map(); // userId -> { message, channelId, ... }
const loggedUserData = loadLoggedUsers(); // { ids, usernames } - persisted
const checkedUsers = new Set([...loggedUserData.ids]); // Includes persisted + session
const userActivity = new Map(); // userId -> timestamp[] (for activity filtering)
const recentWebhooks = new Map(); // userId -> timestamp (prevent duplicate embeds)

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const THIRTY_FIVE_DAYS_MS = 35 * 24 * 60 * 60 * 1000; // Keep ~1 month for novice filter
const ONE_MINUTE_MS = 60 * 1000;
const WEBHOOK_DEBOUNCE_MS = 90 * 1000; // Prevent duplicate webhooks for same user
const MIN_RAP = 200000; // Minimum RAP to send webhook embed
const MIN_RAP_WL = 150000; // For w/l messages: send only if N/A (privated) or above 150k
const NOVICE_MAX_TOTAL_MESSAGES = 50; // Novices must have <50 messages to qualify (unless inactive 30+ days)
const NOVICE_MAX_MESSAGES_IF_ACTIVE_2W = 5; // If active in past 2 weeks, max 3-5 messages in that period
const BYPASS_PHRASES = ["is this good", "dm", "help", "lf", "looking for"]; // Bypass RAP 200k min when message contains these (w/l has its own rules)
const NOVICE_BYPASS_PHRASES = ["help", "support", "who is good at trading", "how is this item doing", "need help", "trading help", "any tips", "advice", "how do i", "what should i"]; // Bypass novice message limit - inactive users seeking trade help

function messageHasBypassPhrase(content) {
  const lower = (content || "").toLowerCase();
  return BYPASS_PHRASES.some((p) => lower.includes(p));
}

function messageHasWL(content) {
  return (content || "").toLowerCase().includes("w/l");
}

function messageHasNoviceBypassPhrase(content) {
  const lower = (content || "").toLowerCase();
  return NOVICE_BYPASS_PHRASES.some((p) => lower.includes(p));
}

function recordMessageActivity(userId) {
  const now = Date.now();
  if (!userActivity.has(userId)) userActivity.set(userId, []);
  userActivity.get(userId).push(now);
  const cutoff = now - THIRTY_FIVE_DAYS_MS; // Keep ~1 month for novice filter
  userActivity.set(userId, userActivity.get(userId).filter((t) => t > cutoff));
}

function isNoviceExcludingVerified(member, guild) {
  if (!member || !guild) return false;
  const verifiedRole = guild.roles?.cache?.find((r) => r.name.toLowerCase() === "rover verified");
  const noviceRole = guild.roles?.cache?.find((r) => r.name.toLowerCase() === "novice");
  if (!noviceRole) return false;
  if (verifiedRole && member.roles?.cache?.has(verifiedRole.id)) return false; // Has Verified, not novice
  const memberHighest = member.roles?.highest;
  if (!memberHighest) return true;
  return memberHighest.position <= noviceRole.position; // Novice or lower
}

/** Novice activity requirements: <50 msgs total; inactive 2+ weeks OR if active in 2w then ≤5 msgs; if ≥50 msgs then inactive 30+ days */
function meetsNoviceActivityRequirements(userId) {
  const timestamps = userActivity.get(userId) || [];
  const now = Date.now();
  const totalMessages = timestamps.length;
  const lastMessageTime = timestamps.length ? Math.max(...timestamps) : 0;
  const messagesInLast2Weeks = timestamps.filter((t) => now - t <= TWO_WEEKS_MS).length;
  const inactive2Weeks = lastMessageTime === 0 || now - lastMessageTime > TWO_WEEKS_MS;
  const inactive30Days = lastMessageTime === 0 || now - lastMessageTime > THIRTY_DAYS_MS;

  if (totalMessages >= NOVICE_MAX_TOTAL_MESSAGES) {
    return inactive30Days; // ≥50 msgs: must be inactive 30+ days
  }
  // <50 msgs: must be inactive 2+ weeks, OR if active in 2w then ≤5 msgs
  return inactive2Weeks || messagesInLast2Weeks <= NOVICE_MAX_MESSAGES_IF_ACTIVE_2W;
}

function isTooActive(userId) {
  const timestamps = userActivity.get(userId) || [];
  const now = Date.now();
  const inLastMinute = timestamps.filter((t) => now - t < ONE_MINUTE_MS).length;
  const inLast10Days = timestamps.length;
  return inLastMinute >= 2 || inLast10Days >= 2;
}

const client = new Client({ checkUpdate: false });
const client2 = new Client({ checkUpdate: false }); // Second client for sending messages

client.on("ready", () => {
  ensureDataDir();
  console.log(`Monitoring channels ${channelIds.join(", ")} for messages...`);
  console.log(`Rover channel: ${roverChannelId}`);
  console.log(`Data dir: ${DATA_DIR} (logged users: ${loggedUserData.ids.size})`);
  const cmdWhere = autoclaimCommandChannelId ? `channel ${autoclaimCommandChannelId}` : "group chat";
  console.log(`Autoclaim: ${autoclaimEnabled ? "ON" : "OFF"} (send "r" or "t" in ${cmdWhere} to toggle)\n`);
});

async function fetchRobloxRAP(robloxUserId) {
  try {
    console.log(`  → Fetching inventory for Roblox user ${robloxUserId}...`);
    
    // Fetch user's inventory from Roblox API
    const inventoryUrl = `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100`;
    const res = await fetch(inventoryUrl);
    
    if (!res.ok) {
      console.log(`  → Roblox API returned status: ${res.status}`);
      return { rap: null };
    }
    
    const inventoryData = await res.json();
    
    if (!inventoryData.data || !Array.isArray(inventoryData.data)) {
      console.log(`  → No inventory data found`);
      return { rap: null };
    }
    
    let totalRAP = 0;
    let itemCount = 0;
    
    // Calculate total RAP from all collectible items
    for (const item of inventoryData.data) {
      if (item.recentAveragePrice != null && item.recentAveragePrice > 0) {
        totalRAP += item.recentAveragePrice;
        itemCount++;
      }
    }
    
    // Handle pagination if there are more items
    let nextCursor = inventoryData.nextPageCursor;
    while (nextCursor) {
      const nextUrl = `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100&cursor=${nextCursor}`;
      const nextRes = await fetch(nextUrl);
      
      if (!nextRes.ok) break;
      
      const nextData = await nextRes.json();
      
      if (!nextData.data) break;
      
      for (const item of nextData.data) {
        if (item.recentAveragePrice != null && item.recentAveragePrice > 0) {
          totalRAP += item.recentAveragePrice;
          itemCount++;
        }
      }
      
      nextCursor = nextData.nextPageCursor;
    }
    
    console.log(`  → Found ${itemCount} collectibles with total RAP: ${totalRAP}`);
    
    return { rap: totalRAP > 0 ? totalRAP : null };
  } catch (e) {
    console.error("  → Roblox API error:", e.message);
    return { rap: null };
  }
}

async function sendWebhook(data) {
  const { robloxUserId, discordUser, discordUserId, rap, message, channelId, messageId, avatarUrl } = data;
  const roliUrl = `https://www.rolimons.com/player/${robloxUserId}`;
  const jumpUrl = `https://discord.com/channels/@me/${channelId}/${messageId}`;

  // Clean up Discord username by removing #0
  const cleanDiscordUser = discordUser ? discordUser.replace(/#0$/, '') : "Unknown";
  const rapDisplay = rap != null ? rap.toLocaleString() : "N/A";

  const embed = {
    description: `**${cleanDiscordUser}** • RAP: **${rapDisplay}**\n${message || "(no message)"}\n\n[Jump to Message](${jumpUrl}) • [Rolimons](${roliUrl})`,
    color: 0x00ff00,
    thumbnail: { url: avatarUrl || "https://via.placeholder.com/150" },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (res.ok || res.status === 204) {
      const cleanName = normalizeUsername(discordUser);
      saveLoggedUser(discordUserId, cleanName || undefined);
      console.log("  → Webhook sent");
      if (autoclaimEnabled) {
        try {
          // Add to claimed and send to group chat directly (avoid wrong-embed matching)
          if (!loggedUserData.claimed.has(cleanName)) {
            loggedUserData.claimed.add(cleanName);
            fs.writeFileSync(LOGGED_USERS_FILE, JSON.stringify({
              ids: [...loggedUserData.ids],
              usernames: [...loggedUserData.usernames],
              claimed: [...loggedUserData.claimed],
            }));
            const targetCh = await client2.channels.fetch(targetGroupChatId).catch(() => null);
            if (targetCh) {
              await targetCh.send(discordUser);
              console.log(`  → Auto-claimed and sent "${discordUser}" to group chat`);
            }
          }
          // Still send "c" for channel compatibility
          const ch = await client2.channels.fetch(claimChannelId).catch(() => null);
          if (ch) { await ch.send("c"); console.log("  → Auto-sent c"); }
        } catch (_) {}
      }
    } else {
      console.error("  → Webhook failed:", res.status);
    }
  } catch (e) {
    console.error("  → Webhook error:", e.message);
  }
}

function isVerifiedOrNoviceOrLower(member, guild) {
  const noviceRole = guild?.roles?.cache?.find((r) => r.name.toLowerCase() === "novice");
  const verifiedRole = guild?.roles?.cache?.find((r) => r.name.toLowerCase() === "rover verified");
  const cutoffRole = [noviceRole, verifiedRole].filter(Boolean).sort((a, b) => b.position - a.position)[0];
  if (!cutoffRole) return true;
  const memberHighest = member?.roles?.highest;
  if (!memberHighest) return true;
  return memberHighest.position <= cutoffRole.position;
}

client.on("messageCreate", async (message) => {
  const channelId = message.channel?.id;
  const authorId = message.author?.id;

  // Handle Rover's embed response
  if (channelId === roverChannelId && authorId === roverAppId && message.embeds?.length) {
    const embed = message.embeds[0];
    let discordUser = embed.title || null;
    if (!discordUser && embed.description) {
      const m = embed.description.match(/\*\*([^*]+)\*\*/);
      if (m) discordUser = m[1];
    }
    if (!discordUser && embed.fields) {
      for (const f of embed.fields) {
        if (f.name?.toLowerCase().includes("discord")) { discordUser = f.value; break; }
      }
    }
    const cleanUsername = normalizeUsername(discordUser);
    if (cleanUsername && loggedUserData.usernames.has(cleanUsername)) {
      console.log(`  → Skipped (username "${discordUser}" already logged)`);
      return;
    }
    const pendingUserId = [...pendingChecks.keys()][0];
    if (pendingUserId && loggedUserData.ids.has(pendingUserId)) {
      pendingChecks.delete(pendingUserId);
      console.log(`  → Skipped (pending user ${pendingUserId} already logged)`);
      return;
    }

    let robloxUserId = null;
    for (const field of embed.fields || []) {
      const name = (field.name || "").toLowerCase();
      const value = (field.value || "").trim();
      if (name.includes("roblox") && (name.includes("user id") || name.includes("id"))) {
        robloxUserId = value;
        break;
      }
    }
    if (!robloxUserId) {
      console.log("  → No Roblox User ID found in embed, skipping");
      return;
    }

    // Match this embed to the correct pending check by Discord username (Rover can respond out of order)
    let discordUserId = null;
    let pending = null;
    for (const [userId, data] of pendingChecks.entries()) {
      const storedUsername = normalizeUsername(data.discordUsername || "");
      const storedDisplay = normalizeUsername(data.displayName || "");
      if (cleanUsername && (storedUsername === cleanUsername || storedDisplay === cleanUsername || cleanUsername === storedUsername || cleanUsername === storedDisplay)) {
        discordUserId = userId;
        pending = data;
        break;
      }
    }
    if (!pending && pendingChecks.size > 0) {
      const first = pendingChecks.entries().next();
      if (!first.done) {
        const [firstId, firstData] = first.value;
        discordUserId = firstId;
        pending = firstData;
        console.log(`  → No username match for "${discordUser}" - using first pending as fallback`);
      }
    }
    if (!pending) {
      console.log("  → No pending check found for this embed");
      return;
    }
    pendingChecks.delete(discordUserId);

    // Try to get avatar from embed thumbnail or image
    const avatarUrl = embed.thumbnail?.url || embed.image?.url;

    console.log(`  → Roblox ID: ${robloxUserId}, Discord: ${discordUser || discordUserId}`);

    // Fetch RAP from Roblox API
    const { rap } = await fetchRobloxRAP(robloxUserId);

    // RAP check: 200k default; bypass phrases relax it; w/l has special rules (N/A or ≥150k only)
    const rapNum = rap != null ? Number(rap) : NaN;
    const hasBypassPhrase = messageHasBypassPhrase(pending.message);
    const hasWL = messageHasWL(pending.message);

    if (hasWL) {
      // w/l: only send if N/A (privated) or above 150k; not already logged is checked below
      if (!Number.isNaN(rapNum) && rapNum < MIN_RAP_WL) {
        console.log(`  → Skipped (w/l: RAP ${rapNum.toLocaleString()} < ${MIN_RAP_WL.toLocaleString()})`);
        return;
      }
    } else if (!hasBypassPhrase) {
      if (Number.isNaN(rapNum) || rapNum < MIN_RAP) {
        console.log(`  → Skipped (RAP ${rap ?? "N/A"} < ${MIN_RAP.toLocaleString()})`);
        return;
      }
    }

    // Skip if user is too active (multiple msgs/min or talked multiple times in 10 days)
    if (isTooActive(discordUserId)) {
      console.log(`  → Skipped (too active in Rolimons)`);
      return;
    }

    // Skip if we've already logged this user before (persists across restarts)
    const discordIdStr = String(discordUserId);
    if (loggedUserData.ids.has(discordIdStr)) {
      console.log(`  → Skipped (already logged before)`);
      return;
    }

    // Novice filter: skip novice users who don't meet activity requirements
    // Bypass if message is about needing trade help (help, support, etc.)
    try {
      const channel = await client.channels.fetch(pending.channelId).catch(() => null);
      const guild = channel?.guild;
      const member = guild ? await guild.members.fetch(discordUserId).catch(() => null) : null;
      if (isNoviceExcludingVerified(member, guild)) {
        if (!messageHasNoviceBypassPhrase(pending.message)) {
          if (!meetsNoviceActivityRequirements(discordUserId)) {
            const timestamps = userActivity.get(discordUserId) || [];
            const now = Date.now();
            const in2w = timestamps.filter((t) => now - t <= TWO_WEEKS_MS).length;
            console.log(`  → Skipped (novice doesn't meet activity: ${timestamps.length} total msgs, ${in2w} in past 2w)`);
            return;
          }
        }
      }
    } catch (e) {
      console.error("  → Novice check error:", e.message);
    }

    // Debounce: prevent duplicate webhooks for same user (set before async sendWebhook)
    const now = Date.now();
    if (recentWebhooks.has(discordIdStr) && now - recentWebhooks.get(discordIdStr) < WEBHOOK_DEBOUNCE_MS) {
      console.log(`  → Skipped (duplicate, sent for ${discordUser} recently)`);
      return;
    }
    recentWebhooks.set(discordIdStr, now);

    // Send webhook (use rapNum when valid, else null for display)
    await sendWebhook({
      robloxUserId,
      discordUser,
      discordUserId: discordIdStr,
      rap: Number.isNaN(rapNum) ? null : rapNum,
      message: pending.message,
      channelId: pending.channelId,
      messageId: pending.messageId,
      avatarUrl,
    });
    return;
  }

  // Handle user messages in monitored channels
  if (!channelIds.includes(channelId)) return;
  const userId = authorId;
  if (!userId) return;

  // Track message activity for activity filtering
  if (!message.author?.bot) {
    recordMessageActivity(userId);
  }

  const userIdStr = String(userId);
  if (checkedUsers.has(userIdStr) || loggedUserData.ids.has(userIdStr)) {
    return;
  }

  const content = message.content || "";

  const member = message.member ?? (await message.guild?.members?.fetch(userId).catch(() => null));
  if (member && message.guild && !isVerifiedOrNoviceOrLower(member, message.guild)) {
    console.log(`User ID: ${userId} (skipped - role higher than Rover Verified/Novice)`);
    return;
  }

  // Novice activity filter: skip novices who don't meet activity requirements (reduces traffic)
  if (member && message.guild && isNoviceExcludingVerified(member, message.guild)) {
    if (!messageHasNoviceBypassPhrase(content)) {
      if (!meetsNoviceActivityRequirements(userIdStr)) {
        const timestamps = userActivity.get(userIdStr) || [];
        const now = Date.now();
        const in2w = timestamps.filter((t) => now - t <= TWO_WEEKS_MS).length;
        console.log(`User ID: ${userId} (skipped - novice doesn't meet activity: ${timestamps.length} total msgs, ${in2w} in past 2w)`);
        return;
      }
    }
  }

  console.log("User ID:", userId);
  
  // Mark user as checked
  checkedUsers.add(userIdStr);

  // Store message info for later embed parsing (include username to match Rover's embed)
  const authorUsername = message.author?.username || message.author?.globalName || "";
  const displayName = message.member?.displayName || message.author?.globalName || authorUsername;
  pendingChecks.set(userIdStr, {
    message: content,
    channelId: message.channel.id,
    messageId: message.id,
    discordUsername: authorUsername,
    displayName: displayName,
    guildId: message.guild?.id,
  });

  try {
    const roverChannel = await client.channels.fetch(roverChannelId);
    await roverChannel.sendSlash(roverAppId, "whois discord", userId);
    console.log(`  → Sent /whois to Rover`);
  } catch (e) {
    console.error("  → Slash failed:", e.message);
    pendingChecks.delete(userIdStr);
  }
});


// Client2: monitors noti channel, sends "c" on autoclaim, sends username to group chat (token has access to noti + group chat)
client2.on("messageCreate", async (message) => {
  const channelId = message.channel?.id;
  const content = (message.content || "").trim().toLowerCase();

  // Toggle autoclaim via commands: r = on, t = off (in command channel)
  const commandChannelId = autoclaimCommandChannelId || targetGroupChatId;
  if (channelId === commandChannelId && message.author?.id !== client2.user?.id) {
    if (content === "r") {
      autoclaimEnabled = true;
      config.autoclaimEnabled = true;
      saveConfig(config);
      await message.channel.send("Autoclaim is now **ON**.").catch(() => {});
      console.log("[Autoclaim] Turned ON");
      return;
    }
    if (content === "t") {
      autoclaimEnabled = false;
      config.autoclaimEnabled = false;
      saveConfig(config);
      await message.channel.send("Autoclaim is now **OFF**.").catch(() => {});
      console.log("[Autoclaim] Turned OFF");
      return;
    }
  }

  if (channelId !== claimChannelId || !/^c\s*$/i.test(content)) return;
  try {
    const msgs = await message.channel.messages.fetch({ limit: 20 }).catch(() => null);
    let sourceMsg = null;
    for (const [, m] of msgs || []) {
      if (m.id === message.id) continue;
      if (m.embeds?.length) {
        const emb = m.embeds[0];
        if (emb.description?.match(/\*\*[^*]+\*\*/) || emb.title || emb.fields?.some((f) => (f.name || "").toLowerCase().includes("discord"))) {
          sourceMsg = m;
          break;
        }
      }
    }
    if (!sourceMsg) return;
    let discordUser = null;
    const emb = sourceMsg.embeds[0];
    const match = emb.description?.match(/\*\*([^*]+)\*\*/);
    if (match) discordUser = match[1];
    else if (emb.title) discordUser = emb.title;
    else for (const f of emb.fields || []) { if ((f.name || "").toLowerCase().includes("discord")) { discordUser = f.value?.trim(); break; } }
    if (!discordUser) return;
    const cleanName = normalizeUsername(discordUser);
    if (loggedUserData.claimed.has(cleanName)) {
      console.log(`[C] Skipped "${discordUser}" - already claimed`);
      return;
    }
    // Only claim users we've sent webhooks for (in usernames)
    if (!loggedUserData.usernames.has(cleanName)) {
      console.log(`[C] Skipped "${discordUser}" - not in our logged users (wrong embed or not qualified)`);
      return;
    }
    loggedUserData.claimed.add(cleanName);
    fs.writeFileSync(LOGGED_USERS_FILE, JSON.stringify({ ids: [...loggedUserData.ids], usernames: [...loggedUserData.usernames], claimed: [...loggedUserData.claimed] }));
    const targetChannel = await client2.channels.fetch(targetGroupChatId).catch(() => null);
    if (targetChannel) { await targetChannel.send(discordUser); console.log(`[C] Sent "${discordUser}" to group chat`); }
  } catch (e) { console.error(`[C] Error:`, e.message); }
});

// Login both clients
client.login(token).catch((e) => {
  console.error("Client 1 login failed:", e.message);
  process.exit(1);
});

client2.login(secondToken).catch((e) => {
  console.error("Client 2 login failed:", e.message);
  process.exit(1);
});
