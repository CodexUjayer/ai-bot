const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock, GoalFollow } } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const config = require('./settings.json');
const express = require('express');
const dotenv = require('dotenv');
const http = require('http');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');

dotenv.config();

// --- Google AI Setup ---
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- Express Setup ---
const app = express();
const port = process.env.PORT || 8000;
const server = http.createServer(app);

app.get('/', (req, res) => {
  res.send(`
    <h1>🤖 SoulToken SMP Bot Dashboard</h1>
    <p>Status: Running</p>
    <p><a href="/viewer" target="_blank">👀 View Bot Vision</a></p>
  `);
});

server.listen(port, () => console.log(`[Dashboard] Running on port ${port}`));

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
  bot.loadPlugin(pvp);

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

    mineflayerViewer(bot, { httpServer: server, firstPerson: true });
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

    if (config.position.enabled) {
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
    }

    if (config.utils['anti-afk'].enabled) {
      bot.setControlState('jump', true);
      if (config.utils['anti-afk'].sneak) bot.setControlState('sneak', true);
    }

    bot.chat("🤖 Gemini ready for battle!");
    autoEquipBestGear();
  });

  // --- AI Chat Handler ---
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    if (message.toLowerCase().startsWith('@gemini')) {
      const userPrompt = message.replace(/^@gemini\s*/i, '');
      bot.chat(`⏳ @${username} Thinking...`);
      try {
        const result = await model.generateContent(
          `You are the AI guide for SoulToken SMP. Only give Minecraft-related answers in 1-2 sentences. User asked: ${userPrompt}`
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

  // --- PvP Command Handler ---
  bot.on('whisper', (username, message) => {
    if (username === 'KingSoulified' || username === 'Server') {
      if (message.startsWith('@gemini-kill')) {
        const args = message.split(' ');
        if (args.length < 2) {
          bot.whisper(username, '⚠️ You must provide a player name!');
          return;
        }

        const targetName = args[1];
        const target = bot.players[targetName]?.entity;

        if (!target) {
          bot.whisper(username, `❌ Could not find ${targetName}.`);
          return;
        }

        bot.whisper(username, `🔪 Hunting down ${targetName}...`);
        bot.pvp.attack(target);
        autoEquipBestGear();
      }
    }
  });

  // --- PvP Movement + Eating ---
  bot.on('physicTick', () => {
    if (bot.pvp.target) {
      const target = bot.pvp.target;
      if (target && target.position) {
        bot.pathfinder.setGoal(new GoalFollow(target, 1), true);
      }
    }

    if (bot.health < 10) eatFood();
  });

  // --- Auto Equip ---
  function autoEquipBestGear() {
    if (!bot.inventory) return;

    const swords = bot.inventory.items().filter(item => item.name.includes('sword'));
    if (swords.length > 0) {
      const bestSword = swords.sort((a, b) => b.attackDamage - a.attackDamage)[0];
      bot.equip(bestSword, 'hand').catch(() => {});
    }

    const armorSlots = {
      head: 'helmet',
      torso: 'chestplate',
      legs: 'leggings',
      feet: 'boots'
    };

    for (const slot in armorSlots) {
      const keyword = armorSlots[slot];
      const items = bot.inventory.items().filter(i => i.name.includes(keyword));
      if (items.length > 0) {
        const bestArmor = items.sort((a, b) => b.defense - a.defense)[0];
        bot.equip(bestArmor, slot).catch(() => {});
      }
    }
  }

  // --- Eat Food ---
  function eatFood() {
    const food = bot.inventory.items().find(item =>
      item.name.includes('apple') || item.name.includes('bread') || item.name.includes('steak')
    );
    if (food) {
      bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
    }
  }

  // --- Events ---
  bot.on('goal_reached', () => console.log(`[AfkBot] Reached target: ${bot.entity.position}`));
  bot.on('death', () => console.log(`[AfkBot] Died, respawned at: ${bot.entity.position}`));

  if (config.utils['auto-reconnect']) {
    bot.on('end', () => setTimeout(() => createBot(), config.utils['auto-recconect-delay']));
  }

  bot.on('kicked', (reason) => console.log(`[AfkBot] Kicked: ${reason}`));
  bot.on('error', (err) => console.log(`[ERROR] ${err.message}`));
}

createBot();
