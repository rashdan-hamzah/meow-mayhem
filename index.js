const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Create Express app
const app = express();
app.use(cors());

// Create HTTP server
const server = http.createServer(app);

// Create Socket.io server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins in development
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Set port - Render will provide this as an environment variable
const PORT = process.env.PORT || 3000;

// Basic route for checking server status
app.get('/', (req, res) => {
  res.send('Meow Mayhem Socket.io Server is running');
});

// Keep-alive endpoint to prevent sleep
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // Handle player joining a game room
  socket.on('join-game', (roomId) => {
    socket.join(roomId);
    console.log(`Player ${socket.id} joined room ${roomId}`);
    
    // Notify room that player joined
    io.to(roomId).emit('player-joined', socket.id);
  });
  
  // Handle player movement or actions
  socket.on('player-action', (data) => {
    // Broadcast to all other players in the room
    socket.to(data.roomId).emit('player-action', {
      playerId: socket.id,
      action: data.action,
      position: data.position,
      timestamp: Date.now()
    });
  });
  
  // Handle player disconnection
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    // You might want to notify rooms the player was in
  });
});

// Create self-ping to prevent Render from sleeping
const keepAlive = () => {
  setInterval(() => {
    console.log("Pinging self to prevent sleep...");
    fetch(`https://YOUR-APP-NAME.onrender.com/ping`)
      .catch(err => console.error("Failed to ping self:", err));
  }, 840000); // 14 minutes
};

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  keepAlive(); // Start the keep-alive mechanism
});
