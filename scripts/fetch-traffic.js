// Copyright (c) 2026 Hijel. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, this software
// is provided "AS IS", WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
// express or implied. The author(s) accept no liability for any damages,
// loss, or consequences arising from the use or misuse of this software.
// See the License for the full terms governing permissions and limitations.

const https = require("https");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.GHTRAFFIC_TOKEN;
if (!TOKEN) {
  console.error("Error: GHTRAFFIC_TOKEN environment variable is not set.");
  process.exit(1);
}

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const DATA_DIR = path.join(__dirname, "..", "data");

// ── HTTP helper ──────────────────────────────────────────────────────────────

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: endpoint,
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "github-traffic-dashboard",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON from ${endpoint}: ${body}`));
          }
        } else {
          reject(
            new Error(`API ${res.statusCode} for ${endpoint}: ${body.slice(0, 200)}`)
          );
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ── Merge helpers ────────────────────────────────────────────────────────────

function mergeDailyData(existing, incoming) {
  const map = new Map();
  for (const entry of existing) {
    map.set(entry.date, entry);
  }
  for (const entry of incoming) {
    const dateKey = entry.timestamp
      ? entry.timestamp.slice(0, 10)
      : entry.date;
    map.set(dateKey, {
      date: dateKey,
      count: entry.count,
      uniques: entry.uniques,
    });
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function mergeReferrers(existing, incoming) {
  const map = new Map();
  for (const entry of existing) {
    map.set(entry.referrer, { ...entry });
  }
  for (const entry of incoming) {
    const current = map.get(entry.referrer);
    if (current) {
      current.count = Math.max(current.count, entry.count);
      current.uniques = Math.max(current.uniques, entry.uniques);
    } else {
      map.set(entry.referrer, { ...entry });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function processRepo(repoFullName) {
  const [owner, repo] = repoFullName.split("/");
  const filename = `${owner}--${repo}.json`;
  const filepath = path.join(DATA_DIR, filename);

  console.log(`\n── ${repoFullName} ──`);

  // Load existing data
  let existing = { data: { views: [], clones: [], referrers: [] } };
  if (fs.existsSync(filepath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filepath, "utf8"));
      if (raw.format === "encrypted") {
        console.log("  ⚠  Encrypted file detected — cannot merge without key. Skipping merge, will overwrite data portion.");
        existing = { data: { views: [], clones: [], referrers: [] } };
      } else {
        existing = raw;
      }
    } catch {
      console.log("  ⚠  Could not parse existing data file. Starting fresh.");
    }
  }

  // Fetch from API
  let repoMeta, views, clones, referrers;
  try {
    [repoMeta, views, clones, referrers] = await Promise.all([
      apiGet(`/repos/${owner}/${repo}`),
      apiGet(`/repos/${owner}/${repo}/traffic/views`),
      apiGet(`/repos/${owner}/${repo}/traffic/clones`),
      apiGet(`/repos/${owner}/${repo}/traffic/popular/referrers`),
    ]);
  } catch (err) {
    console.error(`  ✗  API error for ${repoFullName}: ${err.message}`);
    return;
  }

  console.log(`  Views: ${views.count} total, ${views.uniques} unique (${views.views?.length || 0} days)`);
  console.log(`  Clones: ${clones.count} total, ${clones.uniques} unique (${clones.clones?.length || 0} days)`);
  console.log(`  Referrers: ${referrers.length} sources`);
  console.log(`  Forks: ${repoMeta.forks_count}`);

  // Merge
  const mergedData = {
    format: "plaintext",
    repo: repoFullName,
    updated: new Date().toISOString(),
    forks: repoMeta.forks_count || 0,
    data: {
      views: mergeDailyData(existing.data.views || [], views.views || []),
      clones: mergeDailyData(existing.data.clones || [], clones.clones || []),
      referrers: mergeReferrers(existing.data.referrers || [], referrers || []),
    },
  };

  fs.writeFileSync(filepath, JSON.stringify(mergedData, null, 2), "utf8");
  console.log(`  ✓  Written to ${filename} (${mergedData.data.views.length} view days, ${mergedData.data.clones.length} clone days, ${mergedData.data.referrers.length} referrers)`);
}

async function main() {
  // Read config
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("Error: config.json not found.");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!config.repos || !Array.isArray(config.repos) || config.repos.length === 0) {
    console.error("Error: config.json has no repos listed.");
    process.exit(1);
  }

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log(`Processing ${config.repos.length} repo(s)...`);

  for (const repo of config.repos) {
    await processRepo(repo);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
