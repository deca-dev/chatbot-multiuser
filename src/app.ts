import express, { Request, Response, NextFunction } from 'express';
import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword } from '@builderbot/bot';
import { MemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_PORT = Number(process.env.PORT ?? 3008);
const API_PORT = BASE_PORT + 1;
const VENDOR_BASE_PORT = BASE_PORT + 100;
const MAX_CONCURRENT_CONNECTIONS = 70;
const PORT_RANGE_START = VENDOR_BASE_PORT;
const PORT_RANGE_END = VENDOR_BASE_PORT + MAX_CONCURRENT_CONNECTIONS;
const usedPorts = new Set<number>();
const VENDORS_FILE = path.join(__dirname, 'registeredVendors', 'vendors.json');


const app = express();
app.use(express.json());

const limiter = rateLimit({
   windowMs: 15 * 60 * 1000,
   max: 100
});

app.use(limiter);

interface Vendor {
   id: string;
   provider: BaileysProvider;
   phoneNumber: string;
   name: string;
   status: 'pending' | 'connected' | 'disconnected';
   qr?: string;
   lastConnection?: Date;
   reconnectAttempts: number;
   port: number;
   assignedNumber?: string;
}

interface ConnectionMetrics {
   totalConnections: number;
   activeConnections: number;
   pendingConnections: number;
   failedConnections: number;
}

const vendors = new Map<string, Vendor>();
const metrics: ConnectionMetrics = {
   totalConnections: 0,
   activeConnections: 0,
   pendingConnections: 0,
   failedConnections: 0
};

const getAvailablePort = (): number => {
   for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
       if (!usedPorts.has(port)) {
           usedPorts.add(port);
           return port;
       }
   }
   throw new Error('No ports available');
};

const updateMetrics = () => {
   metrics.activeConnections = Array.from(vendors.values())
       .filter(v => v.status === 'connected').length;
   metrics.pendingConnections = Array.from(vendors.values())
       .filter(v => v.status === 'pending').length;
};

const cleanupVendor = (id: string) => {
   const vendor = vendors.get(id);
   if (vendor) {
       usedPorts.delete(vendor.port);
       vendors.delete(id);
       metrics.totalConnections--;
       updateMetrics();
   }
};

const saveVendorsToFile = () => {
    const vendorsData = Array.from(vendors.values()).map(v => ({
        id: v.id,
        name: v.name,
        phoneNumber: v.phoneNumber,
        assignedNumber: v.assignedNumber,
        status: v.status,
        lastConnection: v.lastConnection
    }));
 
    if (!fs.existsSync(path.dirname(VENDORS_FILE))) {
        fs.mkdirSync(path.dirname(VENDORS_FILE), { recursive: true });
    }
    fs.writeFileSync(VENDORS_FILE, JSON.stringify(vendorsData, null, 2));
 };
 
 const loadVendorsFromFile = () => {
    try {
        if (!fs.existsSync(VENDORS_FILE)) {
            return [];
        }
        const data = fs.readFileSync(VENDORS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
 };

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

const connectionLimitMiddleware = (req: Request, res: Response, next: NextFunction) => {
   if (vendors.size >= MAX_CONCURRENT_CONNECTIONS) {
       res.status(429).json({ error: 'Maximum connections reached' });
       return;
   }
   next();
};

const findVendorByPhone = (phoneNumber: string) => {
    return Array.from(vendors.values()).find(v => v.assignedNumber === phoneNumber);
};

app.post('/vendors/register', connectionLimitMiddleware, async (req: Request, res: Response) => {
    const { name, phoneNumber } = req.body;
 
    if (!name || !phoneNumber) {
        res.status(400).json({ error: 'Name and phone number are required' });
        return;
    }
 
    const registeredVendors = loadVendorsFromFile();
    const existingVendor = registeredVendors.find(v => v.assignedNumber === phoneNumber);
    
    if (existingVendor && existingVendor.status !== 'disconnected') {
        res.status(400).json({ error: 'Phone number already registered' });
        return;
    }
 
    try {
        const id = uuidv4();
        const vendorPort = getAvailablePort();
        console.log(`Assigned port ${vendorPort} to vendor ${id}`);
        
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
            console.log('QR Generated for vendor:', id);
            const vendor = vendors.get(id);
            if (vendor) {
                vendor.qr = qr;
                vendor.status = 'pending';
                updateMetrics();
                saveVendorsToFile();
            }
        });
 
        provider.on('ready', (assignedPhoneNumber) => {
            const vendor = vendors.get(id);
            if (vendor) {
                vendor.status = 'connected';
                vendor.phoneNumber = assignedPhoneNumber;
                vendor.qr = undefined;
                vendor.lastConnection = new Date();
                vendor.reconnectAttempts = 0;
                updateMetrics();
                saveVendorsToFile();
                
                if (assignedPhoneNumber !== phoneNumber) {
                    console.warn(`Phone number mismatch: Expected ${phoneNumber}, got ${assignedPhoneNumber}`);
                }
            }
        });
 
        provider.on('disconnect', () => {
            const vendor = vendors.get(id);
            if (vendor) {
                vendor.status = 'disconnected';
                updateMetrics();
                saveVendorsToFile();
            }
        });
 
        provider.on('connection.failure', async () => {
            const vendor = vendors.get(id);
            if (vendor) {
                vendor.status = 'disconnected';
                updateMetrics();
                cleanupVendor(id);
                saveVendorsToFile();
            }
        });
 
        vendors.set(id, {
            id,
            name,
            provider,
            phoneNumber: '',
            assignedNumber: phoneNumber,
            status: 'pending',
            reconnectAttempts: 0,
            port: vendorPort
        });
 
        metrics.totalConnections++;
        updateMetrics();
        saveVendorsToFile();
 
        const { httpServer } = await createBot({
            flow: adapterFlow,
            provider: provider,
            database: adapterDB,
        });
 
        httpServer(vendorPort);
        
        res.json({ 
            vendorId: id,
            port: vendorPort,
        });
 
    } catch (error) {
        console.error(`Failed to register vendor:`, error);
        if (error.message === 'No ports available') {
            res.status(503).json({ error: 'No available ports' });
        } else if (error.message === 'Phone number mismatch') {
            res.status(400).json({ error: 'QR scanned with different phone number' });
        } else {
            res.status(500).json({ error: 'Failed to initialize vendor' });
        }
    }
 });

app.get('/vendors/:id/qr', (req: Request, res: Response) => {
   console.log('QR requested for vendor:', req.params.id);
   const vendor = vendors.get(req.params.id);
   console.log('Vendor found:', !!vendor);
   console.log('QR exists:', !!vendor?.qr);
   
   if (!vendor || !vendor.qr) {
       res.status(404).json({ error: 'QR not found' });
       return;
   }
   
   res.setHeader('Content-Type', 'image/png');
   res.send(Buffer.from(vendor.qr.replace('data:image/png;base64,', ''), 'base64'));
});

app.delete('/vendors/:id', (req: Request, res: Response) => {
   const { id } = req.params;
   cleanupVendor(id);
   res.json({ success: true });
});

app.get('/vendors', (req: Request, res: Response) => {
    const registeredVendors = loadVendorsFromFile();
    res.json(registeredVendors);
});

app.get('/vendors/:id', (req: Request, res: Response) => {
    const registeredVendors = loadVendorsFromFile();
    const vendor = registeredVendors.find(v => v.id === req.params.id);
    if (!vendor) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
    }
    res.json(vendor);
});

app.post('/messages/send', async (req: Request, res: Response) => {
    const { vendorId, targetNumber, message, isGroup = false } = req.body;
    
    const storedVendors = loadVendorsFromFile();
    const storedVendor = storedVendors.find(v => v.id === vendorId);
    const vendor = vendors.get(vendorId);

    if (!storedVendor || !vendor || vendor.status !== 'connected') {
        res.status(404).json({ error: 'Vendor not found or not connected' });
        return;
    }

    try {
        const target = targetNumber + (isGroup ? '@g.us' : '@s.whatsapp.net');
        await vendor.provider.sendText(target, message);
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

app.get('/conversations/:vendorId/:userId', (req: Request, res: Response) => {
   const { vendorId, userId } = req.params;
   const filePath = path.join(__dirname, 'conversations', vendorId, `${userId}.json`);
   
   if (!fs.existsSync(filePath)) {
       res.status(404).json({ error: 'Conversation not found' });
       return;
   }

   const conversation = JSON.parse(fs.readFileSync(filePath, 'utf8'));
   res.json(conversation);
});

app.get('/health', (req: Request, res: Response) => {
   res.json({
       uptime: process.uptime(),
       metrics,
       memoryUsage: process.memoryUsage(),
       vendors: vendors.size,
       portsInUse: Array.from(usedPorts)
   });
});

interface GroupMetadata {
    subject: string;
    participants: { id: string }[];
 }
 
 app.get('/vendors/:id/find-group/:groupName', async (req: Request, res: Response) => {
    const vendor = vendors.get(req.params.id);
    if (!vendor) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
    }

    try {
        const sock = vendor.provider.getInstance() as any;
        const groups = await sock.groupFetchAllParticipating();
        console.log("Groups:", groups);

        const groupsList = Object.entries(groups).map(([id, group]: [string, any]) => ({
            id,
            name: group.subject,
            participants: group.participants?.length || 0
        }));

        const group = groupsList.find(g => g.name?.toLowerCase() === req.params.groupName.toLowerCase());
        
        if (!group) {
            res.status(404).json({ error: 'Group not found' });
            return;
        }
        res.json(group);
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(API_PORT, () => {
   console.log(`REST API running on port ${API_PORT}`);
});

setInterval(() => {
   const disconnectedVendors = Array.from(vendors.values())
       .filter(v => v.status === 'disconnected' && v.reconnectAttempts < 3);
       
   for (const vendor of disconnectedVendors) {
       vendor.reconnectAttempts++;
       vendor.status = 'pending';
       updateMetrics();
   }
}, 5 * 60 * 1000);