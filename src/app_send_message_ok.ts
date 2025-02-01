import express, { Request, Response } from 'express';
import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword } from '@builderbot/bot';
import { MemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_PORT = Number(process.env.PORT ?? 3008);
const API_PORT = BASE_PORT + 1;
const VENDOR_BASE_PORT = BASE_PORT + 100; // Starting from 3108

const app = express();
app.use(express.json());

interface Vendor {
   id: string;
   provider: BaileysProvider;
   phoneNumber: string;
   name: string;
   status: 'pending' | 'connected' | 'disconnected';
   qr?: string;
}

const vendors = new Map<string, Vendor>();

const saveConversation = (vendorId: string, userId: string, message: string, sender: 'user' | 'bot') => {
   const dir = path.join(__dirname, 'conversations', vendorId);
   const userFilePath = path.join(dir, `${userId}.json`);

   if (!fs.existsSync(dir)) {
       fs.mkdirSync(dir, { recursive: true });
   }

   let conversationData = [];
   if (fs.existsSync(userFilePath)) {
       const fileContent = fs.readFileSync(userFilePath, 'utf8');
       conversationData = JSON.parse(fileContent);
   }

   conversationData.push({
       sender,
       message,
       vendorNumber: sender === 'bot' ? vendors.get(vendorId)?.phoneNumber : undefined,
       timestamp: new Date().toISOString(),
   });

   fs.writeFileSync(userFilePath, JSON.stringify(conversationData, null, 2));
};

app.post('/vendors/register', async (req: Request, res: Response) => {
   const { name } = req.body;
   const id = uuidv4();
   const vendorPort = VENDOR_BASE_PORT + vendors.size;
   
   const provider = createProvider(BaileysProvider, {
       groupsIgnore: false,
       readStatus: false,
   });

   const incomingMessageFlow = addKeyword<BaileysProvider, MemoryDB>(['.*'])
       .addAction(async (ctx) => {
           saveConversation(id, ctx.from, ctx.body, 'user');
       });

   const adapterDB = new MemoryDB();
   const adapterFlow = createFlow([incomingMessageFlow]);

   provider.on('qr', (qr) => {
       const vendor = vendors.get(id);
       if (vendor) {
           vendor.qr = qr;
           vendor.status = 'pending';
       }
   });

   provider.on('ready', (phoneNumber) => {
       const vendor = vendors.get(id);
       if (vendor) {
           vendor.status = 'connected';
           vendor.phoneNumber = phoneNumber;
           vendor.qr = undefined;
       }
   });

   vendors.set(id, {
       id,
       name,
       provider,
       phoneNumber: '',
       status: 'pending'
   });

   const { httpServer } = await createBot({
       flow: adapterFlow,
       provider: provider,
       database: adapterDB,
   });

   httpServer(vendorPort); // Each vendor gets their own port

   res.json({ 
       vendorId: id,
       port: vendorPort
   });
});

app.get('/vendors/:id/qr', (req, res) => {
    const vendor = vendors.get(req.params.id);
    if (!vendor || !vendor.qr) {
        res.status(404).json({ error: 'QR not found' });
        return;
    }
    res.json({ qr: vendor.qr });
});

app.get('/vendors', (req: Request, res: Response) => {
   const vendorList = Array.from(vendors.values()).map(v => ({
       id: v.id,
       name: v.name,
       phoneNumber: v.phoneNumber,
       status: v.status
   }));
   res.json(vendorList);
});

app.post('/messages/send', async (req, res) => {
    const { vendorId, targetNumber, message } = req.body;
    
    const vendor = vendors.get(vendorId);
    if (!vendor) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
    }
    if (vendor.status !== 'connected') {
        res.status(400).json({ error: 'Vendor not connected' });
        return;
    }

    try {
        await vendor.provider.sendText(targetNumber + '@s.whatsapp.net', message);
        saveConversation(vendorId, targetNumber, message, 'bot');
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.post('/messages/broadcast', async (req: Request, res: Response) => {
   const { targetNumber, message } = req.body;
   
   const results = [];
   for (const [id, vendor] of vendors) {
       if (vendor.status === 'connected') {
           try {
               await vendor.provider.sendText(targetNumber + '@s.whatsapp.net', message);
               saveConversation(id, targetNumber, message, 'bot');
               results.push({ vendorId: id, success: true });
           } catch (error) {
               results.push({ vendorId: id, success: false, error: error.message });
           }
       }
   }

   res.json({ results });
});

app.get('/conversations/:vendorId/:userId', (req, res) => {
    const { vendorId, userId } = req.params;
    const filePath = path.join(__dirname, 'conversations', vendorId, `${userId}.json`);
    
    if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
    }

    const conversation = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(conversation);
});

app.listen(API_PORT, () => {
   console.log(`REST API running on port ${API_PORT}`);
});