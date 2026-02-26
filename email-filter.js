#!/usr/bin/env node
/**
 * Email Filter - Find emails that haven't replied yet
 * 
 * - random_5k.txt: Full list of emailed users (Rolimons export)
 * - already claimed.txt: Reply log (Lead: email format)
 * 
 * Output: emails_not_replied.txt - Emails to send follow-ups to
 */

const fs = require("fs");
const path = require("path");

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const LEAD_REGEX = /Lead:\s*([^\s\n]+@[^\s\n]+)/gi;

function extractEmails(text) {
  const emails = new Set();
  let match;
  const re = new RegExp(EMAIL_REGEX.source, "gi");
  while ((match = re.exec(text)) !== null) {
    emails.add(match[0].trim().toLowerCase());
  }
  return emails;
}

function extractLeadEmails(text) {
  const emails = new Set();
  let match;
  while ((match = LEAD_REGEX.exec(text)) !== null) {
    emails.add(match[1].trim().toLowerCase());
  }
  return emails;
}

function main() {
  const baseDir = path.join(__dirname);
  const random5kPath = path.join(process.env.USERPROFILE || "", "Downloads", "random_5k.txt");
  const alreadyClaimedPath = path.join(process.env.USERPROFILE || "", "OneDrive", "Documents", "already claimed.txt");
  const outputPath = path.join(baseDir, "emails_not_replied.txt");

  // Allow custom paths via args
  const args = process.argv.slice(2);
  const randomPath = args[0] || random5kPath;
  const claimedPath = args[1] || alreadyClaimedPath;

  console.log("Reading files...");
  console.log("  Full list:", randomPath);
  console.log("  Reply log:", claimedPath);

  let fullListText, replyLogText;
  try {
    fullListText = fs.readFileSync(randomPath, "utf8");
  } catch (e) {
    console.error("Failed to read full list:", e.message);
    process.exit(1);
  }
  try {
    replyLogText = fs.readFileSync(claimedPath, "utf8");
  } catch (e) {
    console.error("Failed to read reply log:", e.message);
    process.exit(1);
  }

  const allEmails = extractEmails(fullListText);
  const repliedEmails = extractLeadEmails(replyLogText);

  const notReplied = [...allEmails].filter((e) => !repliedEmails.has(e)).sort();

  fs.writeFileSync(outputPath, notReplied.join("\n"), "utf8");

  // Also create CSV for Instantly.ai import (email column)
  const csvPath = path.join(baseDir, "emails_not_replied.csv");
  fs.writeFileSync(csvPath, "email\n" + notReplied.join("\n"), "utf8");

  console.log("\nDone!");
  console.log("  Total in full list:", allEmails.size);
  console.log("  Already replied:", repliedEmails.size);
  console.log("  Not replied (output):", notReplied.length);
  console.log("  Output files:", outputPath, "+", csvPath);
}

main();
