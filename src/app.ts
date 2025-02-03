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

// Constants
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_PORT = Number(process.env.PORT ?? 3008);
const API_PORT = BASE_PORT + 1;
const VENDOR_BASE_PORT = BASE_PORT + 100;
const MAX_CONCURRENT_CONNECTIONS = 70;
const PORT_RANGE_START = VENDOR_BASE_PORT;
const PORT_RANGE_END = VENDOR_BASE_PORT + MAX_CONCURRENT_CONNECTIONS;
const VENDORS_FILE = path.join(__dirname, 'registeredVendors', 'vendors.json');

// Express setup
const app = express();
app.use(express.json());
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
}));

// Interfaces
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

interface GroupMetadata {
    subject: string;
    participants: { id: string }[];
}

// State management
const usedPorts = new Set<number>();
const vendors = new Map<string, Vendor>();
const metrics: ConnectionMetrics = {
    totalConnections: 0,
    activeConnections: 0,
    pendingConnections: 0,
    failedConnections: 0
};

// Utility functions
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
        try {
            const port = vendor.port;
            const sock = vendor.provider.getInstance() as any;
            
            // Close socket if exists
            if (sock?.ws?.socket?.terminate) {
                sock.ws.socket.terminate();
            }
 
            vendors.delete(id);
            usedPorts.delete(port);
            metrics.totalConnections--;
            updateMetrics();
            saveVendorsToFile();
 
        } catch (error) {
            console.error('Error cleaning up vendor:', error);
        }
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

// File operations
const saveVendorsToFile = () => {
    const vendorsData = Array.from(vendors.values()).map(v => ({
        id: v.id,
        name: v.name,
        phoneNumber: v.phoneNumber,
        assignedNumber: v.assignedNumber,
        status: v.status,
        lastConnection: v.lastConnection,
        port: v.port
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
        console.error('Error loading vendors:', error);
        return [];
    }
};

// Provider setup functions
const setupProvider = (id: string, port: number) => {
    const provider = createProvider(BaileysProvider, {
        groupsIgnore: false,
        readStatus: false,
        options: {
            connectTimeoutMs: 120000,
            keepAliveIntervalMs: 30000,
            reconnectMode: "on-any-fail",
            retryRequestDelayMs: 5000,
            maxRetries: 5
        }
    });

    const incomingMessageFlow = addKeyword<BaileysProvider, MemoryDB>(['.*'])
        .addAction(async (ctx) => {
            saveConversation(id, ctx.from, ctx.body, 'user');
        });

    const adapterDB = new MemoryDB();
    const adapterFlow = createFlow([incomingMessageFlow]);

    return { provider, adapterFlow, adapterDB };
};

const setupProviderEvents = (provider: BaileysProvider, id: string) => {
    let qrRefreshInterval: NodeJS.Timeout;
 
    provider.on('qr', (qr) => {
        const vendor = vendors.get(id);
        if (vendor) {
            vendor.qr = qr;
            vendor.status = 'pending';
            updateMetrics();
            saveVendorsToFile();
        }
 
        if (qrRefreshInterval) {
            clearInterval(qrRefreshInterval);
        }
 
        qrRefreshInterval = setInterval(async () => {
            try {
                cleanupVendor(id);
                const { provider: newProvider, adapterFlow, adapterDB } = setupProvider(id, vendor?.port || getAvailablePort());
                setupProviderEvents(newProvider, id);
 
                vendors.set(id, {
                    ...vendor,
                    provider: newProvider,
                    status: 'pending'
                });
 
                const { httpServer } = await createBot({
                    flow: adapterFlow,
                    provider: newProvider,
                    database: adapterDB,
                });
 
                httpServer(vendor?.port || getAvailablePort());
            } catch (error) {
                console.error('QR refresh error:', error);
            }
        }, 60000);
    });
 
    provider.on('ready', (phoneNumber) => {
        if (qrRefreshInterval) {
            clearInterval(qrRefreshInterval);
        }
        const vendor = vendors.get(id);
        if (vendor) {
            vendor.status = 'connected';
            vendor.phoneNumber = phoneNumber;
            vendor.qr = undefined;
            vendor.lastConnection = new Date();
            vendor.reconnectAttempts = 0;
            updateMetrics();
            saveVendorsToFile();
        }
    });
 
    provider.on('disconnect', () => {
        if (qrRefreshInterval) {
            clearInterval(qrRefreshInterval);
        }
        const vendor = vendors.get(id);
        if (vendor) {
            vendor.status = 'disconnected';
            updateMetrics();
            saveVendorsToFile();
        }
    });
 
    provider.on('connection.failure', () => {
        if (qrRefreshInterval) {
            clearInterval(qrRefreshInterval);
        }
        const vendor = vendors.get(id);
        if (vendor) {
            vendor.status = 'disconnected';
            updateMetrics();
            cleanupVendor(id);
        }
    });
 };

// Initialize existing vendors
const initializeExistingVendors = async () => {
    const storedVendors = loadVendorsFromFile();
    
    for (const storedVendor of storedVendors) {
        if (storedVendor.status === 'connected') {
            try {
                const port = getAvailablePort();
                const { provider, adapterFlow, adapterDB } = setupProvider(storedVendor.id, port);
                setupProviderEvents(provider, storedVendor.id);
 
                const { httpServer } = await createBot({
                    flow: adapterFlow,
                    provider,
                    database: adapterDB,
                });
 
                vendors.set(storedVendor.id, {
                    ...storedVendor,
                    provider,
                    reconnectAttempts: 0,
                    port
                });
 
                httpServer(port);
                console.log(`Restored vendor ${storedVendor.id} on port ${port}`);
            } catch (error) {
                console.error(`Failed to restore vendor ${storedVendor.id}:`, error);
            }
        }
    }
 };
 
 // Route handlers
 app.post('/vendors/register', async (req: Request, res: Response) => {
    if (vendors.size >= MAX_CONCURRENT_CONNECTIONS) {
        res.status(429).json({ error: 'Maximum connections reached' });
        return;
    }
 
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
        const port = getAvailablePort();
        const { provider, adapterFlow, adapterDB } = setupProvider(id, port);
        setupProviderEvents(provider, id);
 
        vendors.set(id, {
            id,
            name,
            provider,
            phoneNumber: '',
            assignedNumber: phoneNumber,
            status: 'pending',
            reconnectAttempts: 0,
            port
        });
 
        metrics.totalConnections++;
        updateMetrics();
        saveVendorsToFile();
 
        const { httpServer } = await createBot({
            flow: adapterFlow,
            provider,
            database: adapterDB,
        });
 
        httpServer(port);
        const baseUrl = `http://localhost:`;
       res.json({ 
           vendorId: id, 
           port,
           qrUrl: `${baseUrl}${port}`
       });
    } catch (error) {
        console.error(`Failed to register vendor:`, error);
        res.status(500).json({ error: 'Failed to initialize vendor' });
    }
 });
 
 app.get('/vendors/:id/qr', (req: Request, res: Response) => {
    const vendor = vendors.get(req.params.id);
    if (!vendor || !vendor.qr) {
        res.status(404).json({ error: 'QR not found' });
        return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.send(Buffer.from(vendor.qr.replace('data:image/png;base64,', ''), 'base64'));
 });

// Delete vendor
app.delete('/vendors/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const vendor = vendors.get(id);
 
    if (!vendor) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
    }
 
    try {
        cleanupVendor(id);
        saveVendorsToFile();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete vendor' });
    }
 });
 
 // Update vendor
 app.put('/vendors/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, phoneNumber } = req.body;
    const vendor = vendors.get(id);
 
    if (!vendor) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
    }
 
    if (phoneNumber && phoneNumber !== vendor.assignedNumber) {
        res.status(400).json({ error: 'Phone number cannot be updated' });
        return;
    }
 
    try {
        vendors.set(id, {
            ...vendor,
            name: name || vendor.name,
        });
 
        saveVendorsToFile();
        res.json({ 
            success: true, 
            vendor: {
                id: vendor.id,
                name: name || vendor.name,
                phoneNumber: vendor.phoneNumber,
                status: vendor.status,
                lastConnection: vendor.lastConnection
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update vendor' });
    }
 });
 
 app.post('/messages/send', async (req: Request, res: Response) => {
    const { vendorId, targetNumber, message, isGroup = false } = req.body;
    const vendor = vendors.get(vendorId);
 
    if (!vendor || vendor.status !== 'connected') {
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

 app.get('/vendors/', (req: Request, res: Response) => {
    try {
        // Get in-memory vendors
        const activeVendors = Array.from(vendors.values()).map(v => ({
            id: v.id,
            name: v.name,
            phoneNumber: v.phoneNumber,
            assignedNumber: v.assignedNumber,
            status: v.status,
            lastConnection: v.lastConnection,
            port: v.port
        }));
 
        // Get stored vendors
        const storedVendors = loadVendorsFromFile();
 
        // Merge both lists, prioritizing in-memory data
        const allVendors = [...storedVendors];
        activeVendors.forEach(active => {
            const index = allVendors.findIndex(stored => stored.id === active.id);
            if (index >= 0) {
                allVendors[index] = active;
            } else {
                allVendors.push(active);
            }
        });
 
        res.json(allVendors);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch vendors' });
    }
 });
 
 app.get('/vendors/:id/find-group/:groupName', async (req: Request, res: Response) => {
    const vendor = vendors.get(req.params.id);
    if (!vendor) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
    }
 
    try {
        const sock = vendor.provider.getInstance() as any;
        const groups = await sock.groupFetchAllParticipating();
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
        res.status(500).json({ error: error.message });
    }
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
 
 // Start server
 app.listen(API_PORT, () => {
    console.log(`REST API running on port ${API_PORT}`);
    initializeExistingVendors().catch(console.error);
 });
 
 // Periodic cleanup
 setInterval(() => {
    const disconnectedVendors = Array.from(vendors.values())
        .filter(v => v.status === 'disconnected' && v.reconnectAttempts < 3);
    
    for (const vendor of disconnectedVendors) {
        vendor.reconnectAttempts++;
        vendor.status = 'pending';
        updateMetrics();
        saveVendorsToFile();
    }
 }, 5 * 60 * 1000);