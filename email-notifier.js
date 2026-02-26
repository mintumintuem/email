#!/usr/bin/env node
/**
 * Email Reply Notifier - Sends Discord embed when Instantly.ai receives an email reply
 *
 * Run: node email-notifier.js
 * Set EMAIL_NOTIFIER_WEBHOOK in .env (or use default)
 * Configure Instantly.ai webhook to POST to your server URL (e.g. https://your-app.railway.app/webhook/email-reply)
 *
 * For local testing: use ngrok to expose localhost
 */

require("dotenv").config();
const http = require("http");

const PORT = process.env.PORT || process.env.EMAIL_NOTIFIER_PORT || 3847;
const WEBHOOK_URL = process.env.EMAIL_NOTIFIER_WEBHOOK || "https://discord.com/api/webhooks/1476525457930453086/4A81E_Uf58mpkp3TQCPBbLmiTOq7WMkD4YyneBhCGd_fQTUIgheyrRTRGi1yXm7wrN8K";

function sendDiscordEmbed(data) {
  const { lead_email, campaign_name, unibox_url } = data;
  const embed = {
    title: "Reply received",
    description: [
      `**Lead:** ${lead_email || "Unknown"}`,
      `**Campaign:** ${campaign_name ? `"${campaign_name}"` : "N/A"}`,
      unibox_url ? `[View in Unibox](${unibox_url})` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    color: 0x5865f2,
    timestamp: new Date().toISOString(),
  };

  return fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "inbox",
      embeds: [embed],
    }),
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (!url.pathname.match(/^\/webhook\/?/)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  // Instantly.ai format: event_type, lead_email, campaign_name, unibox_url
  if (data.event_type && data.event_type !== "reply_received") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, skipped: "not a reply event" }));
    return;
  }

  const payload = {
    lead_email: data.lead_email || data.lead?.email,
    campaign_name: data.campaign_name || data.campaign,
    unibox_url: data.unibox_url || data.unibox,
  };

  if (!payload.lead_email) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing lead_email" }));
    return;
  }

  try {
    const r = await sendDiscordEmbed(payload);
    if (r.ok || r.status === 204) {
      console.log(`[Email Notifier] Posted reply from ${payload.lead_email}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      console.error("[Email Notifier] Discord webhook failed:", r.status);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Discord webhook failed" }));
    }
  } catch (e) {
    console.error("[Email Notifier] Error:", e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Email Notifier listening on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`Configure Instantly.ai to POST to this URL when replies are received.\n`);
});
