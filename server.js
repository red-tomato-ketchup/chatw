require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

// MongoDB Connection
const MONGODB_URI = 'mongodb+srv://chatapp:<db_password>@chat-w.nhzeg.mongodb.net/chat-app?retryWrites=true&w=majority&appName=chat-w'
  .replace('<db_password>', process.env.DB_PASSWORD);

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Message Schema
const messageSchema = new mongoose.Schema({
  username: String,
  message: String,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

const onlineUsers = new Map();
const typingUsers = new Set();

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html', (err) => {
        if (err) res.status(500).send('Error loading chat app');
    });
});

io.on('connection', (socket) => {
    console.log('a user connected');

    // Load last 100 messages from DB
    Message.find()
      .sort({ timestamp: -1 })
      .limit(100)
      .then(messages => {
          socket.emit('messageHistory', messages.reverse());
      });

    socket.on('userOnline', (username) => {
        onlineUsers.set(username, new Date());
        socket.username = username;
        io.emit('updateOnlineUsers', Array.from(onlineUsers));
    });

    socket.on('message', async (data) => {
        if (!data.username || !data.message) return;
        
        try {
            // Save to database
            const newMessage = new Message({
                username: data.username,
                message: data.message
            });
            
            await newMessage.save();
            
            // Broadcast with timestamp
            io.emit('message', {
                username: data.username,
                message: data.message,
                timestamp: newMessage.timestamp
            });
            
            typingUsers.delete(data.username);
            io.emit('updateTypingUsers', Array.from(typingUsers));
        } catch (err) {
            console.error('Error saving message:', err);
        }
    });

    socket.on('typing', (username) => {
        typingUsers.add(username);
        io.emit('updateTypingUsers', Array.from(typingUsers));
    });

    socket.on('stopTyping', (username) => {
        typingUsers.delete(username);
        io.emit('updateTypingUsers', Array.from(typingUsers));
    });

    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.set(socket.username, new Date());
            typingUsers.delete(socket.username);
            io.emit('updateOnlineUsers', Array.from(onlineUsers));
            io.emit('updateTypingUsers', Array.from(typingUsers));
        }
        console.log('user disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
