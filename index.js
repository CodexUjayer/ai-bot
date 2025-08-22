const mineflayer = require('mineflayer');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock } = require('mineflayer-pathfinder').goals;
const config = require('./settings.json');
const express = require('express');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');

dotenv.config();

// --- Google AI Setup ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- Express Setup ---
const app = express();
const port = process.env.PORT || 8000;

app.get('/', (req, res) => {
  res.send(`
    <h1>🤖 SoulToken SMP Bot Dashboard</h1>
    <p>Status: Running</p>
    <p><a href="/viewer" target="_blank">👀 View Bot Vision</a></p>
  `);
});

app.listen(port, () => console.log(`[Dashboard] Running on port ${port}`));

// --- Bot Creation ---
function createBot() {
  const bot = mineflayer.createBot({
    username: config['bot-account']['username'],
    password: config['bot-account']['password'],
    auth: config['bot-account']['type'],
    host: config.server.ip,
    port: config.server.port,
    version: config.server.version,
  });

  bot.loadPlugin(pathfinder);
  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  bot.settings.colorsEnabled = false;

  let pendingPromise = Promise.resolve();

  // --- Auth functions ---
  function sendRegister(password) {
    return new Promise((resolve, reject) => {
      bot.chat(`/register ${password} ${password}`);
      console.log(`[Auth] Sent /register`);
      const listener = (msg) => {
        const message = msg.toString();
        if (message.includes('successfully registered') || message.includes('already registered')) {
          bot.removeListener('messagestr', listener);
          resolve();
        } else if (message.includes('Invalid command')) {
          bot.removeListener('messagestr', listener);
          reject(`Registration failed. Msg: ${message}`);
        }
      };
      bot.on('messagestr', listener);
    });
  }

  function sendLogin(password) {
    return new Promise((resolve, reject) => {
      bot.chat(`/login ${password}`);
      console.log(`[Auth] Sent /login`);
      const listener = (msg) => {
        const message = msg.toString();
        if (message.includes('successfully logged in')) {
          bot.removeListener('messagestr', listener);
          resolve();
        } else if (message.includes('Invalid password') || message.includes('not registered')) {
          bot.removeListener('messagestr', listener);
          reject(`Login failed. Msg: ${message}`);
        }
      };
      bot.on('messagestr', listener);
    });
  }

  // --- Spawn handler ---
  bot.once('spawn', () => {
    console.log('[AfkBot] Bot joined the server');

    // Attach viewer to existing Express app
    mineflayerViewer(bot, { httpServer: app, firstPerson: true });
    console.log(`[Viewer] Bot vision available at http://localhost:${port}/viewer`);

    if (config.utils['auto-auth'].enabled) {
      const password = config.utils['auto-auth'].password;
      pendingPromise = pendingPromise
        .then(() => sendRegister(password))
        .then(() => sendLogin(password))
        .catch(error => console.error('[ERROR]', error));
    }

    if (config.utils['chat-messages'].enabled) {
      const messages = config.utils['chat-messages']['messages'];
      if (config.utils['chat-messages'].repeat) {
        const delay = config.utils['chat-messages']['repeat-delay'];
        let i = 0;
        setInterval(() => {
          bot.chat(`${messages[i]}`);
          i = (i + 1) % messages.length;
        }, delay * 1000);
      } else {
        messages.forEach(msg => bot.chat(msg));
      }
    }

    const pos = config.position;
    if (config.position.enabled) {
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
    }

    if (config.utils['anti-afk'].enabled) {
      bot.setControlState('jump', true);
      if (config.utils['anti-afk'].sneak) bot.setControlState('sneak', true);
    }
  });

  // --- AI Chat Handler ---
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    if (message.toLowerCase().startsWith('@gemini')) {
      const userPrompt = message.replace(/^@gemini\s*/i, '');
      bot.chat(`⏳ @${username} Thinking...`);
      try {
        const result = await model.generateContent(
          `You are the AI guide for SoulToken SMP, a survival multiplayer server with economy, shops, PvP zones, and land claims. Only give Minecraft-related answers about SoulToken SMP. Reply in 1-2 sentences. User asked: ${userPrompt}`
        );
        let aiResponse = result.response.text();
        if (aiResponse.length > 100) aiResponse = aiResponse.substring(0, 97) + "...";
        bot.chat(`@${username} ${aiResponse}`);
      } catch (err) {
        console.error('[AI ERROR]', err);
        bot.chat(`@${username} ❌ AI error, try later.`);
      }
    }
  });

  // --- Events ---
  bot.on('goal_reached', () =>
    console.log(`[AfkBot] Reached target: ${bot.entity.position}`)
  );

  bot.on('death', () =>
    console.log(`[AfkBot] Died, respawned at: ${bot.entity.position}`)
  );

  if (config.utils['auto-reconnect']) {
    bot.on('end', () => {
      setTimeout(() => createBot(), config.utils['auto-recconect-delay']);
    });
  }

  bot.on('kicked', (reason) =>
    console.log(`[AfkBot] Kicked: ${reason}`)
  );

  bot.on('error', (err) =>
    console.log(`[ERROR] ${err.message}`)
  );
}

createBot();
