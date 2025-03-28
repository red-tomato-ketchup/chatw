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
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
        skipMiddlewares: true,
    }
});

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://chatapp:<db_password>@chat-w.nhzeg.mongodb.net/chat-app?retryWrites=true&w=majority&appName=chat-w'
  .replace('<db_password>', process.env.DB_PASSWORD);

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Schemas
const messageSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    message: { type: String },
    file: {
        name: String,
        type: String,
        size: Number,
        data: String
    },
    timestamp: { type: Date, default: Date.now },
    status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' }
});

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    socketId: { type: String },
    online: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);
const User = mongoose.model('User', userSchema);

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io Events
io.on('connection', async (socket) => {
    console.log('New connection:', socket.id);

    // Load last 100 messages from DB
    socket.on('loadHistory', async () => {
        try {
            const messages = await Message.find()
                .sort({ timestamp: -1 })
                .limit(100)
                .lean();
            socket.emit('messageHistory', messages.reverse());
        } catch (err) {
            console.error('Error loading messages:', err);
        }
    });

    // Username validation
    socket.on('checkUsername', async (username, callback) => {
        try {
            const user = await User.findOne({ username });
            if (user && user.online) {
                // User is already online, force logout the previous session
                if (user.socketId && io.sockets.sockets.get(user.socketId)) {
                    io.to(user.socketId).emit('forceLogout', 'Logged in from another device');
                }
                callback({ available: false, message: 'User already online' });
            } else {
                callback({ available: true });
            }
        } catch (err) {
            console.error('Username check error:', err);
            callback({ available: false, message: 'Server error' });
        }
    });

    // User comes online
    socket.on('userOnline', async (username) => {
        try {
            // Check if user is already online from another device
            const existingUser = await User.findOne({ username, online: true });
            
            if (existingUser && existingUser.socketId !== socket.id) {
                // Force logout the previous session
                if (io.sockets.sockets.get(existingUser.socketId)) {
                    io.to(existingUser.socketId).emit('forceLogout', 'Logged in from another device');
                    io.sockets.sockets.get(existingUser.socketId)?.disconnect();
                }
            }

            // Create or update user
            await User.findOneAndUpdate(
                { username },
                { 
                    username, 
                    socketId: socket.id,
                    online: true, 
                    lastSeen: new Date() 
                },
                { upsert: true, new: true }
            );

            socket.username = username;
            
            // Get all online users
            const onlineUsers = await User.find({ online: true });
            io.emit('updateOnlineUsers', onlineUsers.map(user => user.username));
            
            console.log(`${username} is online (socket: ${socket.id})`);
        } catch (err) {
            console.error('Error setting user online:', err);
        }
    });

    // Text message handling
    socket.on('message', async (data, callback) => {
        try {
            if (!data.username || (!data.message && !data.file)) {
                throw new Error('Invalid message data');
            }

            const messageData = {
                id: data.id || crypto.randomUUID(),
                username: data.username,
                message: data.message,
                file: data.file,
                timestamp: new Date(data.timestamp || Date.now())
            };

            // Save to database
            const newMessage = new Message(messageData);
            await newMessage.save();

            // Broadcast with timestamp
            io.emit('message', {
                ...messageData,
                timestamp: newMessage.timestamp
            });

            // Remove from typing users
            typingUsers.delete(data.username);
            io.emit('updateTypingUsers', Array.from(typingUsers));

            callback({ success: true, id: messageData.id });
        } catch (err) {
            console.error('Error saving message:', err);
            callback({ success: false, error: err.message });
        }
    });

    // File message handling
    socket.on('fileMessage', async (data, callback) => {
        try {
            if (!data.username || !data.file) {
                throw new Error('Invalid file data');
            }

            // Validate file size (5MB max)
            if (data.file.size > 5 * 1024 * 1024) {
                throw new Error('File size exceeds 5MB limit');
            }

            const messageData = {
                id: data.id || crypto.randomUUID(),
                username: data.username,
                file: data.file,
                timestamp: new Date(data.timestamp || Date.now())
            };

            // Save to database
            const newMessage = new Message(messageData);
            await newMessage.save();

            // Broadcast
            io.emit('fileMessage', {
                ...messageData,
                timestamp: newMessage.timestamp
            });

            callback({ success: true, id: messageData.id });
        } catch (err) {
            console.error('Error saving file message:', err);
            callback({ success: false, error: err.message });
        }
    });

    // Message status updates
    socket.on('messageStatus', async (data) => {
        try {
            await Message.updateOne(
                { id: data.messageId },
                { status: data.status }
            );
            io.emit('messageStatusUpdate', data);
        } catch (err) {
            console.error('Error updating message status:', err);
        }
    });

    // Message deletion
    socket.on('deleteMessage', async (messageId) => {
        try {
            await Message.deleteOne({ id: messageId });
            io.emit('messageDeleted', messageId);
        } catch (err) {
            console.error('Error deleting message:', err);
        }
    });

    // Typing indicators
    socket.on('typing', (username) => {
        typingUsers.add(username);
        io.emit('updateTypingUsers', Array.from(typingUsers));
    });

    socket.on('stopTyping', (username) => {
        typingUsers.delete(username);
        io.emit('updateTypingUsers', Array.from(typingUsers));
    });

    // Disconnection handling
    socket.on('disconnect', async () => {
        if (socket.username) {
            try {
                await User.findOneAndUpdate(
                    { username: socket.username },
                    { 
                        online: false,
                        lastSeen: new Date() 
                    }
                );
                
                // Get updated online users list
                const onlineUsers = await User.find({ online: true });
                io.emit('updateOnlineUsers', onlineUsers.map(user => user.username));
                
                console.log(`${socket.username} disconnected`);
            } catch (err) {
                console.error('Error updating user last seen:', err);
            }
        }
    });
});

// Error handling
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
