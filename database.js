const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // الصفقات المفتوحة
  db.run(`CREATE TABLE IF NOT EXISTS open_trades (
    id INTEGER PRIMARY KEY,
    symbol TEXT,
    side TEXT,
    entry_price REAL,
    quantity REAL,
    tp_percent REAL,
    sl_percent REAL,
    trail_percent REAL,
    highest_price REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // سجل التداول
  db.run(`CREATE TABLE IF NOT EXISTS trade_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT,
    side TEXT,
    entry_price REAL,
    exit_price REAL,
    quantity REAL,
    pnl REAL,
    reason TEXT,
    closed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // الإعدادات
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // قائمة المراقبة
  db.run(`CREATE TABLE IF NOT EXISTS watchlist (
    symbol TEXT PRIMARY KEY,
    tf TEXT,
    active INTEGER DEFAULT 0
  )`);

  // الإعدادات الافتراضية
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('trade_amount', '9.9')");
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('tp_percent', '10')");
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('sl_percent', '6')");
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('trail_percent', '2')");
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('max_trades', '5')");
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('bot_online', '1')");
});

module.exports = db;
