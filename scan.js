const { Client } = require("discord.js-selfbot-v13");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ============ CONFIG ============
// Optional: Discord token for "username in server" check. Leave empty to skip.
const rolimonsToken = "";
const generalServerToken = "";
// General channel where we check if user is in server (channel 1455856045334200417)
const generalChannelId = "1455856045334200417";
// Webhook for scan.js embed output
const scanWebhookUrl = "https://discord.com/api/webhooks/1467343179878502553/qUDWcJePfWoXD5xRclwuuWtRapOIQiR211NZzK6rfWQarwHRPVEg9nSvjTmXuFESN3wO";

const MIN_VALUE = 200000;
const MAX_RANK = 299; // Skip rank 300 and lower (worse)
const MAX_TRADE_ADS = 1500; // Skip if Trade Ads Created > 1500 (via rolibadges)
const MIN_OWNED_DAYS = 60; // Must have owned items for 2+ months (60 days). When API returns no dates, we skip this check.
const MIN_ITEM_OWNED_DAYS = 180; // For item page scan: owned 6+ months
const RECENTLY_ONLINE_DAYS = 7; // For item scan: online within 7 days
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // Scan every 5 minutes

const LOGGED_FILE = path.join(__dirname, "scan_logged.json");
const SCAN_ITEMS_FILE = path.join(__dirname, "scan_items.json");
// Webhook posts to channel 1467342495615815792 (set webhook in Discord channel)
const DEBUG = true; // Set false to reduce console output

// ============ PERSISTENCE ============
function loadLogged() {
  try {
    const data = fs.readFileSync(LOGGED_FILE, "utf8");
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

function saveLogged(robloxId) {
  try {
    loggedRobloxIds.add(robloxId);
    fs.writeFileSync(LOGGED_FILE, JSON.stringify([...loggedRobloxIds]));
  } catch (e) {
    console.error("  → Failed to save:", e.message);
  }
}

function loadScanItems() {
  try {
    const data = fs.readFileSync(SCAN_ITEMS_FILE, "utf8");
    const arr = JSON.parse(data);
    return Array.isArray(arr) ? arr.filter((id) => id != null && String(id).trim() !== "") : [];
  } catch {
    return [];
  }
}

const loggedRobloxIds = loadLogged();
if (DEBUG) console.log(`[Scan] Already logged: ${loggedRobloxIds.size} Roblox IDs (skipped in scan)`);
const discordToken = (generalServerToken || rolimonsToken || "").trim();
let discordReady = false;
const client = discordToken ? new Client({ checkUpdate: false }) : null;

// Browser-like User-Agent to reduce Rolimons API blocks (they may block bot UA)
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ============ HTTP HELPER (fallback when fetch fails) ============
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function fetchUrl(url, opts = {}) {
  const headers = { "User-Agent": USER_AGENT, ...opts.headers };
  if (typeof fetch !== "undefined") {
    try {
      const res = await fetch(url, { headers, ...opts });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      // fetch failed (network, etc.) - try https fallback
      return httpsGet(url);
    }
  }
  return httpsGet(url);
}

// ============ ROLIMONS API ============
const TRADE_ADS_RETRY_MS = 30000; // Wait 30s on 429 before retry
const TRADE_ADS_MAX_ATTEMPTS = 3;

async function fetchTradeAds() {
  const url = "https://api.rolimons.com/tradeads/v1/getrecentads";
  for (let attempt = 0; attempt < TRADE_ADS_MAX_ATTEMPTS; attempt++) {
    try {
      const text = await fetchUrl(url);
      const json = JSON.parse(text);
      if (!json.success || !Array.isArray(json.trade_ads)) return [];
      return [...new Set(json.trade_ads.map((ad) => ad[2]))];
    } catch (e) {
      const is429 = (e.message || "").includes("429");
      if (is429 && attempt < TRADE_ADS_MAX_ATTEMPTS - 1) {
        console.log(`[Scan] Trade ads rate limited (429) - waiting ${TRADE_ADS_RETRY_MS / 1000}s before retry (attempt ${attempt + 1}/${TRADE_ADS_MAX_ATTEMPTS})...`);
        await new Promise((r) => setTimeout(r, TRADE_ADS_RETRY_MS));
      } else {
        const detail = e.cause ? ` (${e.cause.message || e.cause.code})` : "";
        console.error("  → Trade ads fetch error:", e.message, detail);
        return [];
      }
    }
  }
  return [];
}

const PLAYERINFO_DELAY_MS = 2500; // Delay between player info requests to avoid blocks
const RATE_LIMIT_BACKOFF_MS = 15000; // Wait 15s on 429 before retry
const MAX_PLAYERINFO_ATTEMPTS = 4; // Retry up to 4 times (handles rate limits)
let lastPlayerInfoFetch = 0;

async function fetchPlayerInfo(robloxUserId) {
  const delay = Math.max(0, PLAYERINFO_DELAY_MS - (Date.now() - lastPlayerInfoFetch));
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  const endpoints = [
    `https://api.rolimons.com/players/v1/playerinfo/${robloxUserId}`,
    `https://www.rolimons.com/playerapi/player/${robloxUserId}`,
  ];

  let lastError = null;
  for (let attempt = 0; attempt < MAX_PLAYERINFO_ATTEMPTS; attempt++) {
    let got429 = false;
    for (const url of endpoints) {
      try {
        lastPlayerInfoFetch = Date.now();
        const text = await fetchUrl(url);
        const json = JSON.parse(text);
        if (!json.success && json.success !== undefined) continue;
        const badges = json.rolibadges || {};
        let maxTradeAdsBadge = 0;
        for (const key of Object.keys(badges)) {
          const m = key.match(/^create_(\d+)_trade_ads$/);
          if (m) maxTradeAdsBadge = Math.max(maxTradeAdsBadge, parseInt(m[1], 10));
        }
        return {
          name: json.name,
          value: json.value ?? 0,
          rap: json.rap ?? 0,
          rank: json.rank,
          lastOnline: json.last_online,
          lastLocation: json.last_location || "Offline",
          tradeAdsCreatedMin: maxTradeAdsBadge || null,
        };
      } catch (e) {
        lastError = e;
        const is429 = (e.message || "").includes("429");
        if (DEBUG && attempt < 2) console.log(`[Scan] PlayerInfo ${robloxUserId} fail:`, e.message);
        if (is429) {
          got429 = true;
          break; // Don't hammer second endpoint; back off first
        }
      }
    }
    if (attempt < MAX_PLAYERINFO_ATTEMPTS - 1) {
      const backoff = got429 ? RATE_LIMIT_BACKOFF_MS : 5000;
      if (DEBUG && got429) console.log(`[Scan] Rate limited (429) - waiting ${backoff / 1000}s before retry...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  return null;
}

// ============ ROBLOX BIO CHECK ============
async function fetchRobloxBio(robloxUserId) {
  try {
    const text = await fetchUrl(`https://users.roblox.com/v1/users/${robloxUserId}`);
    const json = JSON.parse(text);
    return (json.description || "").trim();
  } catch (e) {
    return "";
  }
}

// ============ DISCORD MEMBER SEARCH ============
async function isUserInServer(robloxUsername) {
  if (!client || !discordReady) return false;
  try {
    const channel = await client.channels.fetch(generalChannelId);
    const guild = channel.guild;
    if (!guild) return false;
    await guild.members.fetch();
    const search = robloxUsername.toLowerCase().replace(/\s/g, "");
    const found = guild.members.cache.some((m) => {
      const un = (m.user?.username || "").toLowerCase().replace(/\s/g, "");
      const gn = (m.user?.globalName || "").toLowerCase().replace(/\s/g, "");
      const dn = (m.displayName || "").toLowerCase().replace(/\s/g, "");
      return un === search || gn === search || dn === search || un.includes(search) || search.includes(un);
    });
    return found;
  } catch (e) {
    console.error("  → Member search error:", e.message);
    return false;
  }
}

async function getOldestOwnedDays(robloxUserId) {
  try {
    let oldestTs = null;
    let url = `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100`;
    let sampleKeys = null;
    while (url) {
      const text = await fetchUrl(url);
      const json = JSON.parse(text);
      if (!json.data?.length) break;
      for (const item of json.data) {
        if (DEBUG && !sampleKeys) sampleKeys = Object.keys(item);
        const ts = item.created || item.updated || item.acquiredAt || item.updatedAt || item.addTime;
        if (ts) {
          const parsed = typeof ts === "string" ? new Date(ts).getTime() / 1000 : ts;
          if (!oldestTs || parsed < oldestTs) oldestTs = parsed;
        }
      }
      url = json.nextPageCursor ? `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100&cursor=${json.nextPageCursor}` : null;
    }
    if (!oldestTs && DEBUG && sampleKeys && !loggedNoDateWarning) {
      console.log(`[Scan] Roblox inventory API has no date fields (${sampleKeys.join(", ")}) - skipping owned-days filter`);
      loggedNoDateWarning = true;
    }
    if (!oldestTs) return null;
    return Math.floor((Date.now() / 1000 - oldestTs) / 86400);
  } catch (e) {
    if (DEBUG) console.log(`[Scan] getOldestOwnedDays error for ${robloxUserId}:`, e.message);
    return null;
  }
}

async function getOwnedItemDays(robloxUserId, assetId) {
  const targetId = String(assetId);
  try {
    let url = `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100`;
    while (url) {
      const text = await fetchUrl(url);
      const json = JSON.parse(text);
      if (!json.data?.length) break;
      for (const item of json.data) {
        const aid = String(item.assetId || item.id || "");
        if (aid !== targetId) continue;
        const ts = item.created || item.updated || item.acquiredAt || item.addTime;
        if (!ts) return null;
        const parsed = typeof ts === "string" ? new Date(ts).getTime() / 1000 : ts;
        return Math.floor((Date.now() / 1000 - parsed) / 86400);
      }
      url = json.nextPageCursor ? `https://inventory.roblox.com/v1/users/${robloxUserId}/assets/collectibles?sortOrder=Asc&limit=100&cursor=${json.nextPageCursor}` : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function formatOwnedDays(days) {
  if (days == null) return "Unknown";
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

const DISCORD_HINT_KEYWORDS = ["discord", "dm", "dms", "@", "blue app", "dc"];
let itemNameCache = {};
let loggedNoDateWarning = false;

async function getItemName(itemId) {
  const key = String(itemId);
  if (itemNameCache[key]) return itemNameCache[key];
  try {
    const text = await fetchUrl("https://www.rolimons.com/itemapi/itemdetails");
    const json = JSON.parse(text);
    if (json.items && json.items[key]) {
      const name = json.items[key][0];
      itemNameCache[key] = name || key;
      return itemNameCache[key];
    }
  } catch (_) {}
  itemNameCache[key] = key;
  return key;
}

function mightHintDiscord(bio) {
  if (!bio || typeof bio !== "string") return false;
  const lower = bio.toLowerCase();
  return DISCORD_HINT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ============ SEND EMBED VIA WEBHOOK ============
async function sendScanEmbed(data) {
  const { robloxUserId, robloxUsername, value, rap, oldestOwnedDays, avatarUrl, source, itemId, itemName } = data;
  const roliUrl = `https://www.rolimons.com/player/${robloxUserId}`;
  const sourceLabel = source === "item_page" ? "Item Page Scan" : "Trade Ad Scan";
  const ownedLabel = source === "item_page" ? "Item Owned:" : "Oldest Owned:";

  let desc = `**${robloxUsername || robloxUserId}**\nValue: **${(value || 0).toLocaleString()}** • RAP: **${(rap || 0).toLocaleString()}**\n${ownedLabel} **${formatOwnedDays(oldestOwnedDays)}**\n**Source:** ${sourceLabel}`;
  if (itemId && itemName) desc += `\n**Item:** [${itemName}](https://www.rolimons.com/item/${itemId})`;
  desc += `\n\n[Rolimons Profile](${roliUrl})`;

  const embed = {
    title: source === "item_page" ? "Item Page Trader" : "Trade Ads Trader",
    description: desc,
    color: 0x00ff00,
    thumbnail: { url: avatarUrl || `https://roblox-avatar.eryn.io/${robloxUserId}` },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(scanWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (res.ok || res.status === 204) {
      console.log("  → Embed sent via webhook");
    } else {
      console.error("  → Webhook failed:", res.status);
    }
  } catch (e) {
    console.error("  → Webhook error:", e.message);
  }
}

// ============ SCAN LOGIC ============
// Log when ALL are true: 200k+ value, from Rolimons trade ads, owned items 2+ months, AND at least ONE of:
// - Bio contains "blue app" OR - Bio contains @ mention OR - Username matches a server member
async function runScan() {
  console.log("\n[Scan] Fetching trade ads...");
  const creatorIds = await fetchTradeAds();
  console.log(`[Scan] Found ${creatorIds.length} unique creators`);
  if (creatorIds.length === 0) {
    console.log("[Scan] No creators - check trade ads API (fetch may be failing)");
    return;
  }

  const stats = { alreadyLogged: 0, noPlayerInfo: 0, lowValue: 0, badRank: 0, ownedDays: 0, noDiscord: 0, tradeAds: 0, logged: 0 };

  for (const robloxUserId of creatorIds) {
    const idKey = String(robloxUserId);
    if (loggedRobloxIds.has(idKey)) {
      stats.alreadyLogged++;
      continue;
    }

    const info = await fetchPlayerInfo(robloxUserId);
    if (!info) {
      stats.noPlayerInfo++;
      if (DEBUG && stats.noPlayerInfo <= 2) console.log(`[Scan] Skip ${idKey}: no player info (Rolimons API may block)`);
      continue;
    }

    if (info.value < MIN_VALUE) {
      stats.lowValue++;
      if (DEBUG && stats.lowValue <= 2) console.log(`[Scan] Skip ${info.name}: value ${info.value?.toLocaleString()} < ${MIN_VALUE.toLocaleString()}`);
      continue;
    }
    if (info.rank != null && info.rank > MAX_RANK) {
      stats.badRank++;
      continue;
    }
    const minTradeAds = info.tradeAdsCreatedMin ?? 0;
    if (minTradeAds >= 1000) {
      stats.tradeAds++;
      if (DEBUG && stats.tradeAds <= 3) console.log(`[Scan] Skip ${info.name}: trade ads badge ${minTradeAds}+ (over ${MAX_TRADE_ADS} threshold)`);
      continue;
    }

    const oldestOwnedDays = await getOldestOwnedDays(robloxUserId);
    if (oldestOwnedDays != null && oldestOwnedDays < MIN_OWNED_DAYS) {
      stats.ownedDays++;
      if (DEBUG && stats.ownedDays <= 3) console.log(`[Scan] Skip ${info.name}: owned ${oldestOwnedDays} days < ${MIN_OWNED_DAYS}`);
      continue;
    }

    const bio = await fetchRobloxBio(robloxUserId) || "";
    const hasBlueApp = bio.toLowerCase().includes("blue app");
    const hasMention = /@\S+/.test(bio);
    const hintsDiscord = mightHintDiscord(bio);
    let inServer = discordReady ? await isUserInServer(info.name) : false;

    const meetsContactCriteria = hasBlueApp || hasMention || inServer || hintsDiscord;
    if (!meetsContactCriteria) {
      stats.noDiscord++;
      if (DEBUG && stats.noDiscord <= 3) console.log(`[Scan] Skip ${info.name}: no blue app, @, server match, or discord hint`);
      continue;
    }

    stats.logged++;
    loggedRobloxIds.add(idKey);
    saveLogged(idKey);

    console.log(`[Scan] ✓ LOGGING: ${info.name} (${idKey}) - blueApp: ${hasBlueApp}, @: ${hasMention}, inServer: ${inServer}, hints: ${hintsDiscord}`);

    const avatarUrl = `https://roblox-avatar.eryn.io/${robloxUserId}`;

    await sendScanEmbed({
      robloxUserId: idKey,
      robloxUsername: info.name,
      value: info.value,
      rap: info.rap,
      oldestOwnedDays,
      avatarUrl,
      source: "trade_ad",
    });

    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`\n[Scan] Trade ad summary: ${stats.logged} logged | skipped: ${stats.alreadyLogged} already, ${stats.noPlayerInfo} no info, ${stats.lowValue} low value, ${stats.badRank} bad rank, ${stats.tradeAds} tradeAds>${MAX_TRADE_ADS}, ${stats.ownedDays} owned<60d, ${stats.noDiscord} no discord\n`);

  await runItemPageScan(creatorIds);
}

// Rolimons last_online: can be Unix timestamp (when) or seconds-ago (small number). Returns true if online within RECENTLY_ONLINE_DAYS.
function isRecentlyOnline(lastOnline) {
  if (lastOnline == null || lastOnline === undefined) return false;
  const now = Math.floor(Date.now() / 1000);
  const maxSecondsAgo = RECENTLY_ONLINE_DAYS * 24 * 60 * 60;
  // If small number (< 1yr in sec), treat as "seconds since last online"
  if (lastOnline < 31536000) {
    return lastOnline <= maxSecondsAgo;
  }
  // Otherwise treat as Unix timestamp
  return lastOnline >= now - maxSecondsAgo;
}

async function runItemPageScan(tradeAdCreatorIds) {
  const itemIds = loadScanItems();
  if (itemIds.length === 0) return;

  for (const itemId of itemIds) {
    const idStr = String(itemId);
    console.log(`\n[Scan] Item page scan for item ${idStr} (require: online within ${RECENTLY_ONLINE_DAYS}d, owned ${MIN_ITEM_OWNED_DAYS}+ days)...`);

    for (const robloxUserId of tradeAdCreatorIds) {
      const idKey = String(robloxUserId);
      if (loggedRobloxIds.has(idKey)) continue;

      const info = await fetchPlayerInfo(robloxUserId);
      if (!info) continue;

      if (info.value < MIN_VALUE) continue;
      if (info.rank != null && info.rank > MAX_RANK) continue;
      if ((info.tradeAdsCreatedMin ?? 0) >= 1000) continue;

      if (!isRecentlyOnline(info.lastOnline)) {
        if (DEBUG) console.log(`[Scan] Skip ${info.name}: not online within ${RECENTLY_ONLINE_DAYS} days`);
        continue;
      }

      const ownedDays = await getOwnedItemDays(robloxUserId, itemId);
      if (ownedDays == null) {
        if (DEBUG) console.log(`[Scan] Skip ${info.name}: no ownership date for item ${idStr} (Roblox API has no dates)`);
        continue;
      }
      if (ownedDays < MIN_ITEM_OWNED_DAYS) {
        if (DEBUG) console.log(`[Scan] Skip ${info.name}: owned item ${ownedDays} days < ${MIN_ITEM_OWNED_DAYS}`);
        continue;
      }

      const bio = (await fetchRobloxBio(robloxUserId)) || "";
      const hasBlueApp = bio.toLowerCase().includes("blue app");
      const hasMention = /@\S+/.test(bio);
      const hintsDiscord = mightHintDiscord(bio);
      let inServer = discordReady ? await isUserInServer(info.name) : false;

      const meetsCriteria = hasBlueApp || hasMention || inServer || hintsDiscord;
      if (!meetsCriteria) continue;

      loggedRobloxIds.add(idKey);
      saveLogged(idKey);

      console.log(`[Scan] Item page logging: ${info.name} (${idKey}) - item ${idStr} owned ${ownedDays} days`);

      const avatarUrl = `https://roblox-avatar.eryn.io/${robloxUserId}`;

      const itemName = await getItemName(itemId);

      await sendScanEmbed({
        robloxUserId: idKey,
        robloxUsername: info.name,
        value: info.value,
        rap: info.rap,
        oldestOwnedDays: ownedDays,
        avatarUrl,
        source: "item_page",
        itemId: idStr,
        itemName,
      });

      await new Promise((r) => setTimeout(r, 1500));
    }

    await sendItemScanDone(itemId);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function sendItemScanDone(itemId) {
  const itemUrl = `https://www.rolimons.com/item/${itemId}`;
  const payload = {
    content: `✅ **Done scanning item ${itemId}**\nRemove from \`scan_items.json\` and add the next item to scan.\n[View Item](${itemUrl})`,
  };
  try {
    const res = await fetch(scanWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok || res.status === 204) {
      console.log(`  → Sent "done" message for item ${itemId}`);
    } else {
      console.error("  → Webhook failed:", res.status);
    }
  } catch (e) {
    console.error("  → Webhook error:", e.message);
  }
}

// ============ START ============
function startScanLoop() {
  runScan();
  setInterval(runScan, SCAN_INTERVAL_MS);
}

if (discordToken && client) {
  client.on("ready", () => {
    discordReady = true;
    console.log("[Scan] Discord ready. Scanning...");
    startScanLoop();
  });
  client.login(discordToken).catch((e) => {
    console.error("[Scan] Discord login failed:", e.message, "- running without server member check");
    startScanLoop();
  });
} else {
  console.log("[Scan] No Discord token - running without server member check");
  startScanLoop();
}
