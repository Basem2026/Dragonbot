# 🐉 DRAGON v8 Trading Bot

منصة تداول آلية متكاملة مع واجهة عربية

## 🚀 المميزات
- واجهة تحكم عربية كاملة
- تداول آلي مع TP/SL/Trailing Stop
- استقبال إشارات TradingView عبر Webhook
- طابور إشارات ذكي مع نظام أولويات
- تحديثات لحظية عبر WebSocket
- قاعدة بيانات SQLite

## 📦 التثبيت والتشغيل

\`\`\`bash
npm install
npm start
\`\`\`

ثم افتح: `http://localhost:3000`

## 🌐 النشر على Render

1. ارفع الكود إلى GitHub
2. أنشئ Web Service جديد على Render
3. Build Command: `npm install`
4. Start Command: `node server.js`

## 📡 Webhook URL

\`\`\`
https://your-domain.onrender.com/api/webhook
\`\`\`

## 📝 مثال JSON للإشارة

\`\`\`json
{
  "ticker": "BTCUSDT",
  "signal": "BUY",
  "tf": "5m",
  "time": "14:32"
}
\`\`\`
