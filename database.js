const Database = require('better-sqlite3');
const db = new Database('./clones.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS clone_keys (
        key TEXT PRIMARY KEY,
        uses INTEGER DEFAULT 1,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS access_users (
        user_id TEXT PRIMARY KEY,
        unlimited INTEGER DEFAULT 1
    );
`);

module.exports = {
    generateKey: () => {
        const key = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        db.prepare('INSERT INTO clone_keys (key) VALUES (?)').run(key);
        return key;
    },
    revokeKey: (key) => {
        db.prepare('UPDATE clone_keys SET active = 0 WHERE key = ?').run(key);
    },
    validateKey: (key) => {
        const row = db.prepare('SELECT * FROM clone_keys WHERE key = ? AND active = 1').get(key);
        return row !== undefined;
    },
    addAccess: (userId) => {
        db.prepare('INSERT OR REPLACE INTO access_users (user_id) VALUES (?)').run(userId);
    },
    hasAccess: (userId) => {
        const row = db.prepare('SELECT * FROM access_users WHERE user_id = ?').get(userId);
        return row !== undefined;
    }
};
