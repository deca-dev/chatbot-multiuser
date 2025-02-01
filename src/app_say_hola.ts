import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot'
import { BaileysProvider } from '@builderbot/provider-baileys'
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008

/**
 * Function to save conversation history to a JSON file
 * @param {string} userId - The user's unique ID
 * @param {string} message - The message to save
 * @param {string} sender - Either "user" or "bot"
 */
const saveConversation = (userId, message, sender) => {
    const dir = path.join(__dirname, 'conversations'); // Define the directory path
    const userFilePath = path.join(dir, `${userId}.json`); // Create the file path for the user

    // Check if the directory exists, if not, create it
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true }); // Create directory (with subdirectories if needed)
    }

    // Check if the user's conversation file exists
    let conversationData = [];
    if (fs.existsSync(userFilePath)) {
        const fileContent = fs.readFileSync(userFilePath, 'utf8');
        conversationData = JSON.parse(fileContent);
    }

    // Append new message to the conversation
    conversationData.push({
        sender,
        message,
        timestamp: new Date().toISOString(),
    });

    // Save back to the JSON file
    fs.writeFileSync(userFilePath, JSON.stringify(conversationData, null, 2));
};

/**
 * Flow to respond with a static message
 */
const staticResponseFlow = addKeyword<BaileysProvider, MemoryDB>(['.*']) // Match any message
    .addAction(async (ctx, { flowDynamic }) => {
        const userId = ctx.from; // Get the user's phone number
        const userMessage = ctx.body; // Get the user's message

        // Save the user's message to the conversation file
        saveConversation(userId, userMessage, 'user');

        // Respond with a static message
        const botMessage = "Hola, cómo estás?";
        await flowDynamic([{ body: botMessage }]);

        // Save the bot's response to the conversation file
        saveConversation(userId, botMessage, 'bot');
    });

/**
 * Main function to configure and start the bot
 * @async
 * @returns {Promise<void>}
 */
const main = async () => {
    const adapterFlow = createFlow([staticResponseFlow]);

    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
    });

    const adapterDB = new MemoryDB();

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    httpServer(+PORT);
};

main();
