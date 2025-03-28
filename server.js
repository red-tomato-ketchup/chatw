require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
    }
});

// MongoDB Connection with enhanced error handling
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://chatapp:<db_password>@chat-w.nhzeg.mongodb.net/chat-app?retryWrites=true&w=majority&appName=chat-w'
  .replace('<db_password>', process.env.DB_PASSWORD);

mongoose.connect(MONGODB_URI, {
    retryWrites: true,
    w: 'majority',
    appName: 'chat-w',
    socketTimeoutMS: 30000,
    connectTimeoutMS: 30000
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});

// Schemas with enhanced validation
const messageSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, default: () => crypto.randomUUID() },
    username: { 
        type: String, 
        required: true,
        validate: {
            validator: function(v) {
                return v && v.length >= 3 && v.length <= 20;
            },
            message: 'Username must be between 3-20 characters'
        }
    },
    message: { 
        type: String,
        validate: {
            validator: function(v) {
                return !this.file || v; // Either message or file must exist
            },
            message: 'Message cannot be empty unless file is attached'
        }
    },
    file: {
        name: String,
        type: String,
        size: Number,
        data: String
    },
    timestamp: { type: Date, default: Date.now, index: true },
    status: { 
        type: String, 
        enum: ['sending', 'sent', 'delivered', 'read', 'failed'], 
        default: 'sending' 
    }
}, { timestamps: true });

const userSchema = new mongoose.Schema({
    username: { 
        type: String, 
        required: true, 
        unique: true,
        index: true
    },
    socketId: { type: String, index: true },
    online: { type: Boolean, default: false, index: true },
    lastSeen: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);
const User = mongoose.model('User', userSchema);

// Middleware with enhanced security
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'DENY');
    }
});
app.use(express.json({ limit: '10mb' }));

// Routes with error handling
app.get('/', (req, res, next) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } catch (err) {
        next(err);
    }
});

// Connection tracking
const activeConnections = new Map();

// Socket.io Events with comprehensive error handling
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    activeConnections.set(socket.id, { connectedAt: new Date() });

    // Enhanced load history with pagination support
    socket.on('loadHistory', async ({ limit = 100, skip = 0 } = {}, callback) => {
        try {
            const messages = await Message.find()
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            
            if (typeof callback === 'function') {
                callback({ success: true, messages: messages.reverse() });
            } else {
                socket.emit('messageHistory', messages.reverse());
            }
        } catch (err) {
            console.error('Error loading messages:', err);
            if (typeof callback === 'function') {
                callback({ success: false, error: 'Failed to load messages' });
            }
        }
    });

    // Robust username validation
    socket.on('validateUsername', async (username, callback) => {
        try {
            if (!username || username.length < 3 || username.length > 20) {
                return callback({ 
                    valid: false, 
                    reason: 'Username must be 3-20 characters' 
                });
            }

            const existingUser = await User.findOne({ username });
            const isOnline = existingUser?.online;
            
            callback({ 
                valid: true, 
                exists: !!existingUser,
                online: isOnline,
                canTakeOver: isOnline // Client can decide to force login
            });
        } catch (err) {
            console.error('Username validation error:', err);
            callback({ valid: false, reason: 'Server error' });
        }
    });

    // Comprehensive login handler
    socket.on('login', async ({ username, force = false }, callback) => {
        try {
            // Validate input
            if (!username || typeof username !== 'string') {
                throw new Error('Invalid username format');
            }

            username = username.trim();
            if (username.length < 3 || username.length > 20) {
                throw new Error('Username must be 3-20 characters');
            }

            // Check existing session
            const existingUser = await User.findOne({ username, online: true });
            if (existingUser) {
                if (!force) {
                    return callback({ 
                        success: false, 
                        error: 'User already online',
                        canForce: true
                    });
                }

                // Force logout existing session
                if (existingUser.socketId && io.sockets.sockets.get(existingUser.socketId)) {
                    io.to(existingUser.socketId).emit('forcedLogout', {
                        reason: 'Logged in from another device',
                        newDevice: socket.handshake.address
                    });
                    io.sockets.sockets.get(existingUser.socketId)?.disconnect();
                }
            }

            // Update user record
            const user = await User.findOneAndUpdate(
                { username },
                { 
                    socketId: socket.id,
                    online: true,
                    lastSeen: new Date() 
                },
                { 
                    upsert: true, 
                    new: true,
                    setDefaultsOnInsert: true 
                }
            );

            // Update socket reference
            socket.username = username;
            activeConnections.set(socket.id, { 
                ...activeConnections.get(socket.id),
                username,
                loggedInAt: new Date() 
            });

            // Notify all clients
            const onlineUsers = await User.find({ online: true }).lean();
            io.emit('presenceUpdate', {
                type: 'login',
                username,
                onlineUsers: onlineUsers.map(u => u.username),
                timestamp: new Date()
            });

            callback({ success: true, username });
            console.log(`User ${username} logged in (socket: ${socket.id})`);
        } catch (err) {
            console.error('Login error:', err);
            callback({ 
                success: false, 
                error: err.message || 'Login failed' 
            });
        }
    });

    // Message handling with delivery receipts
    socket.on('sendMessage', async (data, callback) => {
        try {
            // Validate input
            if (!data || !data.username || (!data.message && !data.file)) {
                throw new Error('Invalid message data');
            }

            if (data.message && data.message.length > 2000) {
                throw new Error('Message too long (max 2000 chars)');
            }

            // Create message document
            const messageData = {
                username: data.username,
                message: data.message,
                file: data.file,
                status: 'sending'
            };

            const message = new Message(messageData);
            await message.save();

            // Broadcast with temporary ID
            const broadcastData = {
                id: message.id,
                username: message.username,
                message: message.message,
                file: message.file,
                timestamp: message.timestamp,
                status: message.status
            };

            io.emit('newMessage', broadcastData);

            // Confirm delivery
            callback({ 
                success: true, 
                id: message.id,
                timestamp: message.timestamp 
            });

            // Update status to 'sent' after delivery confirmation
            await Message.updateOne(
                { id: message.id },
                { status: 'sent' }
            );
            io.emit('messageStatus', { 
                id: message.id, 
                status: 'sent' 
            });

            console.log(`Message sent by ${data.username} (ID: ${message.id})`);
        } catch (err) {
            console.error('Message send error:', err);
            callback({ 
                success: false, 
                error: err.message || 'Failed to send message' 
            });
        }
    });

    // File upload handler with validation
    socket.on('uploadFile', async (fileData, callback) => {
        try {
            // Validate file data
            if (!fileData || !fileData.username || !fileData.file) {
                throw new Error('Invalid file data');
            }

            if (fileData.file.size > 5 * 1024 * 1024) {
                throw new Error('File size exceeds 5MB limit');
            }

            // Create message with file
            const message = new Message({
                username: fileData.username,
                file: fileData.file,
                status: 'sending'
            });

            await message.save();

            // Broadcast file message
            io.emit('newFileMessage', {
                id: message.id,
                username: message.username,
                file: message.file,
                timestamp: message.timestamp,
                status: message.status
            });

            callback({ 
                success: true, 
                id: message.id,
                timestamp: message.timestamp 
            });

            // Update status after delivery
            await Message.updateOne(
                { id: message.id },
                { status: 'sent' }
            );
            io.emit('messageStatus', { 
                id: message.id, 
                status: 'sent' 
            });

            console.log(`File uploaded by ${fileData.username} (ID: ${message.id})`);
        } catch (err) {
            console.error('File upload error:', err);
            callback({ 
                success: false, 
                error: err.message || 'Failed to upload file' 
            });
        }
    });

    // Enhanced disconnection handler
    socket.on('disconnect', async (reason) => {
        const connectionData = activeConnections.get(socket.id);
        activeConnections.delete(socket.id);

        if (connectionData?.username) {
            try {
                await User.findOneAndUpdate(
                    { username: connectionData.username },
                    { 
                        online: false,
                        lastSeen: new Date() 
                    }
                );

                const onlineUsers = await User.find({ online: true }).lean();
                io.emit('presenceUpdate', {
                    type: 'logout',
                    username: connectionData.username,
                    onlineUsers: onlineUsers.map(u => u.username),
                    timestamp: new Date(),
                    reason
                });

                console.log(`User ${connectionData.username} disconnected (Reason: ${reason})`);
            } catch (err) {
                console.error('Disconnect update error:', err);
            }
        }
    });

    // Heartbeat/ping monitoring
    let missedPings = 0;
    const pingInterval = setInterval(() => {
        if (missedPings > 2) {
            clearInterval(pingInterval);
            socket.disconnect(true);
            return;
        }
        missedPings++;
        socket.emit('ping');
    }, 30000);

    socket.on('pong', () => {
        missedPings = 0;
    });

    // Cleanup on socket close
    socket.on('close', () => {
        clearInterval(pingInterval);
    });
});

// Global error handler
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

// Server startup
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    
    // Periodic cleanup
    setInterval(async () => {
        try {
            // Cleanup stale connections
            const threshold = new Date(Date.now() - 60000);
            const staleUsers = await User.find({ 
                online: true,
                lastSeen: { $lt: threshold }
            });
            
            for (const user of staleUsers) {
                await User.updateOne(
                    { _id: user._id },
                    { online: false }
                );
            }
            
            if (staleUsers.length > 0) {
                const onlineUsers = await User.find({ online: true }).lean();
                io.emit('presenceUpdate', {
                    type: 'cleanup',
                    affectedUsers: staleUsers.map(u => u.username),
                    onlineUsers: onlineUsers.map(u => u.username),
                    timestamp: new Date()
                });
                
                console.log(`Cleaned up ${staleUsers.length} stale connections`);
            }
        } catch (err) {
            console.error('Cleanup error:', err);
        }
    }, 300000); // Every 5 minutes
});
