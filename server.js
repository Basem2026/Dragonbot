const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const db = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // يخدم index.html من نفس المجلد

// ========== المتغيرات العامة ==========
let openTrades = [];
let tradeHistory = [];
let settings = {
  tradeAmount: 9.9,
  tpPercent: 10,
  slPercent: 6,
  trailPercent: 2,
  maxTrades: 5,
  portfolioValue: 5000,
  botOnline: true,
  autoCloseEnabled: true,
  autoCloseTime: '23:59'
};
let watchlist = [];
let signalQueue = [];
let queueSettings = { maxSize: 10, expireMinutes: 15, rejectWhenFull: true };
let sensitivity = { minGain: 3, minVol: 2, topN: 15, cooldown: 2, filterStables: true, notifyOnlyBS: true };

// ========== تحميل البيانات من قاعدة البيانات ==========
function loadOpenTrades() {
  db.all("SELECT * FROM open_trades", [], (err, rows) => {
    if (rows) openTrades = rows;
    broadcastTrades();
  });
}

function loadSettings() {
  db.all("SELECT * FROM settings", [], (err, rows) => {
    if (rows) {
      rows.forEach(row => {
        if (row.key === 'trade_amount') settings.tradeAmount = parseFloat(row.value);
        if (row.key === 'tp_percent') settings.tpPercent = parseFloat(row.value);
        if (row.key === 'sl_percent') settings.slPercent = parseFloat(row.value);
        if (row.key === 'trail_percent') settings.trailPercent = parseFloat(row.value);
        if (row.key === 'max_trades') settings.maxTrades = parseInt(row.value);
        if (row.key === 'bot_online') settings.botOnline = row.value === '1';
      });
    }
  });
}

function loadWatchlist() {
  db.all("SELECT * FROM watchlist", [], (err, rows) => {
    if (rows) watchlist = rows;
    broadcastWatchlist();
  });
}

function broadcastTrades() {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'trades', data: openTrades }));
    }
  });
}

function broadcastWatchlist() {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'watchlist', data: watchlist }));
    }
  });
}

// ========== دوال التداول ==========
async function getPrice(symbol) {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    return parseFloat(res.data.price);
  } catch (err) {
    return null;
  }
}

async function executeBuy(symbol) {
  if (!settings.botOnline) return { error: 'Bot is offline' };
  if (openTrades.length >= settings.maxTrades) return { error: 'Max trades reached' };
  
  const price = await getPrice(symbol);
  if (!price) return { error: 'Price fetch failed' };
  
  const quantity = settings.tradeAmount / price;
  const newTrade = {
    id: Date.now(),
    symbol,
    side: 'BUY',
    entry_price: price,
    quantity,
    tp_percent: settings.tpPercent,
    sl_percent: settings.slPercent,
    trail_percent: settings.trailPercent,
    highest_price: price,
    created_at: new Date().toISOString()
  };
  
  db.run(`INSERT INTO open_trades (id, symbol, side, entry_price, quantity, tp_percent, sl_percent, trail_percent, highest_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newTrade.id, symbol, 'BUY', price, quantity, settings.tpPercent, settings.slPercent, settings.trailPercent, price]);
  
  openTrades.push(newTrade);
  broadcastTrades();
  console.log(`✅ Buy: ${symbol} at $${price}`);
  return { success: true };
}

async function closeTrade(tradeId, reason, exitPrice = null) {
  const trade = openTrades.find(t => t.id === tradeId);
  if (!trade) return;
  
  const price = exitPrice || (await getPrice(trade.symbol)) || trade.entry_price;
  const pnl = (price - trade.entry_price) * trade.quantity;
  
  db.run(`DELETE FROM open_trades WHERE id = ?`, [tradeId]);
  db.run(`INSERT INTO trade_history (symbol, side, entry_price, exit_price, quantity, pnl, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [trade.symbol, trade.side, trade.entry_price, price, trade.quantity, pnl, reason]);
  
  openTrades = openTrades.filter(t => t.id !== tradeId);
  broadcastTrades();
  console.log(`🔒 Closed ${trade.symbol}: ${reason} | PnL: $${pnl.toFixed(2)}`);
  
  // معالجة الطابور بعد إغلاق صفقة
  processQueue();
}

async function updatePrices() {
  for (let trade of openTrades) {
    const currentPrice = await getPrice(trade.symbol);
    if (!currentPrice) continue;
    
    if (currentPrice > trade.highest_price) {
      db.run(`UPDATE open_trades SET highest_price = ? WHERE id = ?`, [currentPrice, trade.id]);
      trade.highest_price = currentPrice;
    }
    
    const tpPrice = trade.entry_price * (1 + trade.tp_percent / 100);
    const slPrice = trade.entry_price * (1 - trade.sl_percent / 100);
    const trailStop = trade.highest_price * (1 - trade.trail_percent / 100);
    
    if (currentPrice >= tpPrice) await closeTrade(trade.id, 'TP');
    else if (currentPrice <= slPrice) await closeTrade(trade.id, 'SL');
    else if (trade.trail_percent > 0 && currentPrice <= trailStop && currentPrice > trade.entry_price)
      await closeTrade(trade.id, 'TRAIL');
  }
}

// ========== طابور الإشارات ==========
function scoreSignal(sig) {
  let score = 0;
  const gainer = gainersData?.find(g => g.symbol === sig.symbol);
  if (gainer) {
    score += Math.min(3, parseFloat(gainer.pct) / 5);
    if (gainer.vol >= 10e6) score += 2;
    else if (gainer.vol >= 1e6) score += 1;
  }
  if (watchlist.find(w => w.symbol === sig.symbol)) score += 2;
  score += (sig.receivedAt || 0) / 1e12;
  return parseFloat(score.toFixed(3));
}

function enqueueSignal(symbol, signal, tf, time) {
  const now = Date.now();
  const expiry = now + queueSettings.expireMinutes * 60 * 1000;
  const entry = { symbol, signal, tf, time, receivedAt: now, expiry, score: 0 };
  entry.score = scoreSignal(entry);
  
  if (openTrades.length < settings.maxTrades) {
    executeBuy(symbol);
    return;
  }
  
  if (signalQueue.length >= queueSettings.maxSize) {
    if (queueSettings.rejectWhenFull) {
      console.log(`🚫 Signal rejected: ${symbol} - queue full`);
      return;
    } else {
      signalQueue.sort((a, b) => a.score - b.score);
      signalQueue.shift();
      signalQueue.push(entry);
    }
  } else {
    signalQueue.push(entry);
  }
  
  signalQueue.sort((a, b) => b.score - a.score);
  broadcastQueue();
}

function processQueue() {
  const now = Date.now();
  signalQueue = signalQueue.filter(q => q.expiry > now);
  
  if (signalQueue.length > 0 && openTrades.length < settings.maxTrades) {
    const next = signalQueue.shift();
    console.log(`▶ Processing queued signal: ${next.symbol}`);
    executeBuy(next.symbol);
  }
  broadcastQueue();
}

function broadcastQueue() {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'queue', data: signalQueue }));
    }
  });
}

// ========== جلب الرابحين ==========
let gainersData = [];
async function fetchGainers() {
  try {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
    const gainers = res.data
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.priceChangePercent) > 0)
      .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
      .slice(0, sensitivity.topN)
      .map(t => ({
        symbol: t.symbol,
        pct: parseFloat(t.priceChangePercent).toFixed(2),
        price: parseFloat(t.lastPrice),
        vol: parseFloat(t.quoteVolume)
      }));
    gainersData = gainers;
    broadcastGainers();
  } catch (err) {
    console.error('Failed to fetch gainers:', err.message);
  }
}

function broadcastGainers() {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'gainers', data: gainersData }));
    }
  });
}

// ========== API Routes ==========
app.get('/api/trades', (req, res) => res.json(openTrades));
app.get('/api/history', (req, res) => db.all("SELECT * FROM trade_history ORDER BY closed_at DESC LIMIT 100", [], (err, rows) => res.json(rows || [])));
app.get('/api/settings', (req, res) => res.json(settings));
app.post('/api/settings', (req, res) => {
  Object.assign(settings, req.body);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('trade_amount', ?)", [settings.tradeAmount]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('tp_percent', ?)", [settings.tpPercent]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('sl_percent', ?)", [settings.slPercent]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('trail_percent', ?)", [settings.trailPercent]);
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('max_trades', ?)", [settings.maxTrades]);
  res.json({ success: true });
});
app.post('/api/sensitivity', (req, res) => {
  Object.assign(sensitivity, req.body);
  res.json({ success: true });
});
app.get('/api/sensitivity', (req, res) => res.json(sensitivity));
app.post('/api/toggle-bot', (req, res) => { settings.botOnline = !settings.botOnline; res.json({ botOnline: settings.botOnline }); });
app.post('/api/close-all', async (req, res) => {
  for (let trade of openTrades) await closeTrade(trade.id, 'CLOSE_ALL');
  res.json({ success: true });
});
app.get('/api/gainers', (req, res) => res.json(gainersData));
app.post('/api/webhook', async (req, res) => {
  const { ticker, signal, tf, time } = req.body;
  if (!ticker) return res.json({ error: 'Missing ticker' });
  const symbol = ticker.toUpperCase();
  const watchlistItem = watchlist.find(w => w.symbol === symbol);
  if (!watchlistItem || !watchlistItem.active) {
    return res.json({ error: 'Symbol not active in watchlist' });
  }
  if (signal === 'BUY' || signal === 'BUY+') {
    enqueueSignal(symbol, signal, tf || '5m', time);
    res.json({ success: true, message: 'Signal queued' });
  } else if (signal === 'SELL') {
    const trade = openTrades.find(t => t.symbol === symbol);
    if (trade) await closeTrade(trade.id, 'WEBHOOK_SELL');
    res.json({ success: true });
  } else {
    res.json({ error: 'Unknown signal' });
  }
});
app.get('/api/watchlist', (req, res) => res.json(watchlist));
app.post('/api/watchlist', (req, res) => {
  const { symbol, tf, active } = req.body;
  db.run("INSERT OR REPLACE INTO watchlist (symbol, tf, active) VALUES (?, ?, ?)", 
    [symbol, tf || '5m', active ? 1 : 0]);
  loadWatchlist();
  res.json({ success: true });
});
app.delete('/api/watchlist/:symbol', (req, res) => {
  db.run("DELETE FROM watchlist WHERE symbol = ?", [req.params.symbol]);
  loadWatchlist();
  res.json({ success: true });
});

// ========== WebSocket ==========
wss.on('connection', (ws) => {
  console.log('✅ Client connected');
  ws.send(JSON.stringify({ type: 'trades', data: openTrades }));
  ws.send(JSON.stringify({ type: 'watchlist', data: watchlist }));
  ws.send(JSON.stringify({ type: 'gainers', data: gainersData }));
  ws.send(JSON.stringify({ type: 'settings', data: settings }));
});

// ========== مؤقتات ==========
setInterval(() => updatePrices(), 5000);
setInterval(() => fetchGainers(), 60000);
setInterval(() => {
  const now = Date.now();
  signalQueue = signalQueue.filter(q => q.expiry > now);
  broadcastQueue();
}, 10000);

// ========== التشغيل ==========
loadOpenTrades();
loadSettings();
loadWatchlist();
fetchGainers();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 DRAGON v8 Server running on http://localhost:${PORT}`);
  console.log(`📍 Webhook: http://localhost:${PORT}/api/webhook`);
});
