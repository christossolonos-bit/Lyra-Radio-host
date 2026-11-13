// Visitor usernames for the public site: claim a name once, get a private token, and chat only as that name.
// No passwords or emails. Names are unique (case-insensitive). Stored in DATA_DIR/users.json with hashed tokens.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(process.env.DATA_DIR || path.join(here, "..", "data"), "users.json");
const RESERVED = /^(lyra|nova|marcus|juno|solo|patch|james|tiktok|youtube|admin|administrator|moderator|mod|system|server|host|chris|solonaras|christos|viewer|listener|anonymous)$/i;

let users = {}; // nameKey -> { name, tokenHash, created, lastSeen }
try { users = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(users));
  }, 500);
}

const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const keyOf = (name) => name.toLowerCase();

// Letters, numbers, _ . - ; 3 to 20 characters; must start with a letter or number.
export function checkName(name) {
  const n = String(name || "").trim().replace(/^@/, "");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,19}$/u.test(n)) return { error: "Use 3–20 letters, numbers, _ . or -" };
  if (RESERVED.test(n)) return { error: "That name is reserved. Pick another one." };
  if (users[keyOf(n)]) return { error: "That username is taken. Pick another one." };
  return { name: n };
}

// Claim a name -> { name, token } (the token is only ever shown to that browser)
export function claimName(name) {
  const c = checkName(name);
  if (c.error) return c;
  const token = crypto.randomBytes(24).toString("base64url");
  users[keyOf(c.name)] = { name: c.name, tokenHash: hash(token), created: Date.now(), lastSeen: Date.now() };
  save();
  return { name: c.name, token };
}

// Which username does this token belong to? (null if none)
export function nameForToken(token) {
  if (!token) return null;
  const h = hash(token);
  for (const u of Object.values(users)) {
    if (u.tokenHash === h) {
      u.lastSeen = Date.now();
      save();
      return u.name;
    }
  }
  return null;
}
