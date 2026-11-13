// Lyra's memory of viewers, kept on this computer in data/viewers.json.
// She saves a fact by ending a reply with [[remember: Name | short fact]] (no extra request).
// Only small, friendly things: never addresses, phone numbers, full names or anything sensitive (see persona.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(process.env.DATA_DIR || path.join(here, "..", "data"), "viewers.json"); // DATA_DIR = a Railway volume
const NEW_VISIT_HOURS = 3; // back after this long = a new visit
const MAX_FACTS = 8;

let viewers = {};
try { viewers = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(viewers, null, 1));
  }, 1000);
}

const keyOf = (name) => String(name).trim().replace(/^@/, "").toLowerCase();
const day = (t) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

// Someone wrote in chat.
export function noteVisit(name) {
  const k = keyOf(name);
  if (!k || k === "viewer") return;
  const now = Date.now();
  const v = (viewers[k] ||= { name: String(name).replace(/^@/, ""), firstSeen: now, lastSeen: 0, visits: 0, messages: 0, facts: [] });
  if (now - v.lastSeen > NEW_VISIT_HOURS * 3600_000) v.visits++;
  v.lastSeen = now;
  v.messages++;
  save();
}

// What Lyra knows about these people, for her cue.
export function aboutViewers(names) {
  const lines = [];
  for (const name of new Set(names)) {
    const v = viewers[keyOf(name)];
    if (!v) continue;
    if (v.visits <= 1 && !v.facts.length) lines.push(`${name}: first time you've met them.`);
    else {
      const facts = v.facts.length ? ` You remember: ${v.facts.join("; ")}.` : "";
      lines.push(`${name}: a regular (visit ${v.visits}, first came ${day(v.firstSeen)}).${facts}`);
    }
  }
  return lines.length ? ` What you remember about them:\n${lines.join("\n")}` : "";
}

// Pull [[remember: Name | fact]] tags out of a reply and save them.
export function rememberFrom(text) {
  for (const m of String(text).matchAll(/\[\[\s*remember\s*:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]\]/gi)) saveFact(m[1], m[2]);
}

export function saveFact(name, fact) {
  const v = viewers[keyOf(name)];
  const f = String(fact).trim().slice(0, 120);
  if (!v || !f || v.facts.some((x) => x.toLowerCase() === f.toLowerCase())) return;
  v.facts = [...v.facts, f].slice(-MAX_FACTS);
  console.log(`[memory] ${v.name}: ${f}`);
  save();
}
