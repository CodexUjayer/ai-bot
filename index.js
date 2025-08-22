// index.js
require('dotenv').config();
const mineflayer = require('mineflayer');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock } = require('mineflayer-pathfinder').goals;
const { GoogleGenerativeAI } = require('@google/generative-ai');

const config = require('./settings.json');
const express = require('express');

const app = express();
app.get('/', (req, res) => {
  res.send('Bot is running with Google Gemini AI 🤖');
});
app.listen(8000, () => {
  console.log('Server started');
});

// --- GOOGLE GEMINI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Fast + Free Tier

async function askGemini(prompt) {
  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error("[Gemini Error]", err);
    return "Sorry, I can't think right now.";
  }
}

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

  // --- REGISTER / LOGIN ---
  function sendRegister(password) {
    return new Promise((resolve) => {
      bot.chat(`/register ${password} ${password}`);
      console.log(`[Auth] Sent /register command.`);
      const listener = (msg) => {
        const message = msg.toString();
        if (message.includes("successfully registered") || message.includes("already registered")) {
          console.log("[INFO] Registration OK.");
          bot.removeListener("messagestr", listener);
          resolve();
        }
      };
      bot.on("messagestr", listener);
    });
  }

  function sendLogin(password) {
    return new Promise((resolve) => {
      bot.chat(`/login ${password}`);
      console.log(`[Auth] Sent /login command.`);
      const listener = (msg) => {
        const message = msg.toString();
        if (message.includes("successfully logged in")) {
          console.log("[INFO] Login successful.");
          bot.removeListener("messagestr", listener);
          resolve();
        }
      };
      bot.on("messagestr", listener);
    });
  }

  // --- ON SPAWN ---
  bot.once('spawn', () => {
    console.log('[AfkBot] Bot joined the server');

    if (config.utils['auto-auth'].enabled) {
      const password = config.utils['auto-auth'].password;
      pendingPromise = pendingPromise
        .then(() => sendRegister(password))
        .then(() => sendLogin(password))
        .catch(err => console.error("[Auth Error]", err));
    }

    if (config.position.enabled) {
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
      console.log(`[AfkBot] Moving to target location (${config.position.x}, ${config.position.y}, ${config.position.z})`);
    }

    if (config.utils['anti-afk'].enabled) {
      bot.setControlState('jump', true);
      if (config.utils['anti-afk'].sneak) bot.setControlState('sneak', true);
    }
  });

  // --- CHAT AI (Gemini) ---
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return; // ignore self
    console.log(`[CHAT] <${username}> ${message}`);

    if (config.utils['gemini-ai']?.enabled) {
      const reply = await askGemini(`Player ${username} said: "${message}". Reply as a helpful Minecraft bot.`);
      if (reply) {
        bot.chat(reply);
        console.log(`[Gemini Reply] ${reply}`);
      }
    }
  });

  // --- EVENTS ---
  bot.on('goal_reached', () => {
    console.log(`[AfkBot] Reached target location at ${bot.entity.position}`);
  });

  bot.on('death', () => {
    console.log(`[AfkBot] Bot died and respawned at ${bot.entity.position}`);
  });

  if (config.utils['auto-reconnect']) {
    bot.on('end', () => {
      console.log("[INFO] Bot disconnected. Reconnecting...");
      setTimeout(createBot, config.utils['auto-recconect-delay']);
    });
  }

  bot.on('kicked', (reason) => {
    console.log(`[AfkBot] Bot kicked: ${reason}`);
  });

  bot.on('error', (err) => {
    console.log(`[ERROR] ${err.message}`);
  });
}

createBot();
