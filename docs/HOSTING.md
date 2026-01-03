# Hosting & Testing Guide

This guide will walk you through hosting your Telegram bot and testing it without payments enabled.

## 📋 Implementation Status Review

### ✅ Fully Implemented Features

1. **Telegram Bot Core**
   - Bot initialization with Telegraf
   - Command handlers (`/start`, `/help`, `/subscribe`, `/browse`)
   - Interactive keyboards and inline buttons
   - Error handling and logging

2. **Audio Library System**
   - Category-based audio browsing
   - MP3 file delivery to subscribers
   - Manifest-based content management
   - Access control (subscribers only)

3. **User Management**
   - SQLite database for user state
   - User state tracking (NOT_SUBSCRIBED, ACTIVE_SUBSCRIBER, CANCEL_PENDING, CANCELLED)
   - Automatic user creation on first interaction

4. **Payment Integration (Feature Flag Protected)**
   - GoHighLevel/Stripe checkout flow
   - Webhook handling for subscription events
   - Subscription cancellation with retention offers
   - Payment failure notifications

5. **Webhook System**
   - GHL webhook router with authentication
   - Idempotency handling
   - Rate limiting
   - Signature verification support

### 🔧 Configuration Status

- ✅ Environment variable validation
- ✅ Feature flags (ENABLE_PAYMENTS)
- ✅ Database schema and migrations
- ✅ Audio manifest system

---

## 🚀 Step-by-Step Hosting Guide

### Prerequisites

- Node.js 18+ installed
- A Telegram account
- Internet connection
- (Optional) A domain name (we'll use ngrok as a workaround)

---

## Step 1: Create Your Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow the prompts:
   - Choose a name for your bot (e.g., "My Audio Bot")
   - Choose a username (must end in `bot`, e.g., "my_audio_bot")
4. **Copy the bot token** - it looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
5. Save this token - you'll need it in Step 3

---

## Step 2: Install Dependencies

Open a terminal in your project directory and run:

```bash
cd "C:\Users\Arjun\Desktop\telegram"
npm install
```

This will install all required packages (Telegraf, Express, SQLite, etc.)

---

## Step 3: Configure Environment Variables

1. Copy the example environment file:
   ```bash
   copy env.example .env
   ```

2. Open `.env` in a text editor and fill in:

   ```env
   BOT_TOKEN=YOUR_BOT_TOKEN_FROM_STEP_1
   PORT=3000
   DB_PATH=./data/bot.sqlite
   
   # IMPORTANT: Set to false to test without payments
   ENABLE_PAYMENTS=false
   
   # These are NOT required when ENABLE_PAYMENTS=false
   # GHL_CHECKOUT_URL_TEMPLATE=
   # MANAGE_SUBSCRIPTION_URL=
   # RETENTION_COUPON_CODE=
   
   # Webhook auth - NOT required when ENABLE_PAYMENTS=false
   # For testing, you can set a simple token
   WEBHOOK_TOKEN=test-token-123
   ```

3. **Replace `YOUR_BOT_TOKEN_FROM_STEP_1`** with the actual token from Step 1

---

## Step 4: Add Test Audio Files (Optional)

1. Create an MP3 file or download a test audio file
2. Place it in `audio/files/` directory
3. Update `audio/manifest.json` to reference your file:

   ```json
   {
     "categories": [
       { "id": "test", "title": "Test Category" }
     ],
     "items": [
       {
         "id": "test-audio",
         "title": "Test Audio",
         "categoryId": "test",
         "filePath": "your-file.mp3",
         "description": "A test audio file"
       }
     ]
   }
   ```

---

## Step 5: Build the Project

Compile TypeScript to JavaScript:

```bash
npm run build
```

This creates the `dist/` folder with compiled JavaScript.

---

## Step 6: Test Locally (Without Public URL)

You can test the bot locally first:

1. Start the bot:
   ```bash
   npm start
   ```

2. You should see:
   ```
   SQLite ready
   Audio library loaded
   Telegram bot launched
   HTTP server listening on port 3000
   ```

3. Open Telegram and search for your bot (by the username you created)
4. Send `/start` to your bot
5. You should see a welcome message with buttons

**Note:** The bot will work for basic commands, but webhooks from external services (like GHL) won't work without a public URL.

---

## Step 7: Expose Your Bot to the Internet (No Domain Required)

Since you don't have a domain, we'll use **ngrok** (free tunnel service):

### Option A: Using ngrok (Recommended for Testing)

1. **Download ngrok:**
   - Visit https://ngrok.com/download
   - Download for Windows
   - Extract `ngrok.exe` to a folder (e.g., `C:\ngrok\`)

2. **Sign up for free ngrok account:**
   - Go to https://dashboard.ngrok.com/signup
   - Create a free account
   - Copy your authtoken from the dashboard

3. **Configure ngrok:**
   ```bash
   ngrok config add-authtoken YOUR_AUTHTOKEN
   ```

4. **Start your bot** (in one terminal):
   ```bash
   npm start
   ```

5. **Start ngrok tunnel** (in another terminal):
   ```bash
   ngrok http 3000
   ```

6. **Copy the HTTPS URL** from ngrok output:
   ```
   Forwarding  https://abc123.ngrok-free.app -> http://localhost:3000
   ```
   Your webhook URL will be: `https://abc123.ngrok-free.app/webhooks/ghl`

7. **Important:** The free ngrok URL changes every time you restart ngrok. For production, consider:
   - ngrok paid plan (static domain)
   - Railway.app (free tier with custom domain)
   - Render.com (free tier)
   - Fly.io (free tier)

### Option B: Using Cloudflare Tunnel (Free, More Stable)

1. **Install cloudflared:**
   - Download from: https://github.com/cloudflare/cloudflared/releases
   - Extract to a folder

2. **Run tunnel:**
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

3. Copy the HTTPS URL provided

### Option C: Deploy to a Free Hosting Service

**Railway.app (Recommended):**
1. Sign up at https://railway.app
2. Create new project → Deploy from GitHub repo
3. Add environment variables in Railway dashboard
4. Railway provides a free `.railway.app` domain

**Render.com:**
1. Sign up at https://render.com
2. Create new Web Service
3. Connect your GitHub repo
4. Render provides a free `.onrender.com` domain

---

## Step 8: Configure Webhook (If Using Payments)

**Skip this step if `ENABLE_PAYMENTS=false`**

If you enable payments later, configure your GHL webhook:

1. In your GoHighLevel dashboard, go to Webhooks settings
2. Add webhook URL: `https://YOUR_NGROK_URL/webhooks/ghl?token=test-token-123`
3. Set webhook events: `subscription.created`, `subscription.updated`, `subscription.cancelled`, `payment.failed`

---

## Step 9: Test Your Bot

### Basic Testing (Payments Disabled)

1. **Start the bot:**
   ```bash
   npm start
   ```

2. **Open Telegram** and find your bot

3. **Send `/start`** - You should see:
   - Welcome message
   - Menu with "💳 Subscribe" and "ℹ️ Help" buttons

4. **Click "💳 Subscribe"** - Since payments are disabled:
   - Bot should immediately grant access
   - Message: "✅ Access granted! (Payments disabled - testing mode)"

5. **Click "🎧 Browse Audio Library"** - You should see:
   - Category selection (if you added audio files)
   - Or a message if no audio is configured

6. **Test commands:**
   - `/help` - Shows help text
   - `/browse` - Browse audio library
   - `/subscribe` - Subscribe (grants access immediately in test mode)

### Testing Audio Delivery

1. Make sure you have audio files in `audio/files/`
2. Update `audio/manifest.json` correctly
3. Click "🎧 Browse Audio Library"
4. Select a category
5. Select an audio item
6. The bot should send the MP3 file

---

## Step 10: Monitor and Debug

### Check Logs

The bot logs important events. Watch the terminal for:
- User interactions
- Webhook events (if payments enabled)
- Errors

### Health Check

Test the HTTP server:
```bash
curl http://localhost:3000/healthz
```

Should return: `{"ok":true}`

### Database

The SQLite database is created at `./data/bot.sqlite`. You can inspect it using:
- DB Browser for SQLite (GUI tool)
- Or SQLite CLI: `sqlite3 data/bot.sqlite`

---

## 🔄 Enabling Payments Later

When you're ready to enable payments:

1. **Update `.env`:**
   ```env
   ENABLE_PAYMENTS=true
   GHL_CHECKOUT_URL_TEMPLATE=https://your-ghl-checkout?telegram_user_id={telegram_user_id}
   MANAGE_SUBSCRIPTION_URL=https://your-customer-portal
   RETENTION_COUPON_CODE=YOUR_COUPON
   GHL_WEBHOOK_SECRET=your-secret
   # OR
   WEBHOOK_TOKEN=your-token
   ```

2. **Restart the bot:**
   ```bash
   npm start
   ```

3. **Configure GHL webhook** to point to your public URL

---

## 🐛 Troubleshooting

### Bot doesn't respond
- ✅ Check `BOT_TOKEN` is correct
- ✅ Check bot is running (`npm start`)
- ✅ Check Telegram connection (firewall/network)

### "Invalid environment variables" error
- ✅ Check `.env` file exists
- ✅ Check `BOT_TOKEN` is set
- ✅ If `ENABLE_PAYMENTS=true`, all payment vars must be set

### Audio files not found
- ✅ Check file exists in `audio/files/`
- ✅ Check `filePath` in `manifest.json` matches filename
- ✅ Check file permissions

### Webhook not working
- ✅ Check ngrok/cloudflared is running
- ✅ Check webhook URL is HTTPS (not HTTP)
- ✅ Check `WEBHOOK_TOKEN` matches in GHL config
- ✅ Check bot logs for webhook errors

### Database errors
- ✅ Check `DB_PATH` directory exists
- ✅ Check write permissions on database directory

---

## 📝 Next Steps

1. **Add more audio content** - Update `audio/manifest.json` and add files
2. **Customize bot messages** - Edit text in `src/bot/menus.ts` and flow files
3. **Set up monitoring** - Consider adding error tracking (Sentry, etc.)
4. **Deploy to production** - Use Railway, Render, or similar service
5. **Enable payments** - When ready, set `ENABLE_PAYMENTS=true` and configure GHL

---

## 🎯 Quick Reference

### Start Bot
```bash
npm start
```

### Development Mode (Auto-reload)
```bash
npm run dev
```

### Build
```bash
npm run build
```

### Health Check
```bash
curl http://localhost:3000/healthz
```

### Webhook URL Format
```
https://YOUR_DOMAIN/webhooks/ghl?token=YOUR_TOKEN
```

---

## 📚 Additional Resources

- [Telegram Bot API Docs](https://core.telegram.org/bots/api)
- [Telegraf Documentation](https://telegraf.js.org/)
- [ngrok Documentation](https://ngrok.com/docs)
- [Railway Documentation](https://docs.railway.app)

---

**Need Help?** Check the other docs:
- `docs/SETUP.md` - Basic setup
- `docs/ARCHITECTURE.md` - System architecture
- `docs/GHL.md` - GoHighLevel integration
- `docs/ADMIN.md` - Admin operations
