// Small file-backed "database" for user accounts.
// Good enough for a single-instance demo/small deployment. Swap this module
// out for a real database (Postgres, MongoDB, etc.) without touching the
// route handlers, as long as the same function signatures are kept.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "users.json");

function ensureDbFile() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, "[]", "utf-8");
  }
}

function readUsers() {
  ensureDbFile();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    console.error("Failed to read user database, starting empty:", err.message);
    return [];
  }
}

function writeUsers(users) {
  ensureDbFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2), "utf-8");
}

function findUserByEmail(email) {
  if (!email) return null;
  const lower = email.toLowerCase();
  return readUsers().find((u) => u.email.toLowerCase() === lower) || null;
}

function findUserById(id) {
  return readUsers().find((u) => u.id === id) || null;
}

function saveUser(user) {
  const users = readUsers();
  users.push(user);
  writeUsers(users);
  return user;
}

function updateUser(id, patch) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...patch };
  writeUsers(users);
  return users[idx];
}

module.exports = {
  readUsers,
  writeUsers,
  findUserByEmail,
  findUserById,
  saveUser,
  updateUser,
};
