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

// Enhanced room management system
const rooms = {};

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // ====== SIMPLE ROOM JOINING (LEGACY) ======
  // Handle player joining a game room (simple version)
  socket.on('join-game', (roomId) => {
    socket.join(roomId);
    console.log(`Player ${socket.id} joined room ${roomId}`);
    
    // Notify room that player joined
    io.to(roomId).emit('player-joined', socket.id);
  });
  
  // Handle player movement or actions (simple version)
  socket.on('player-action', (data) => {
    // Broadcast to all other players in the room
    if (data.roomId) {
      socket.to(data.roomId).emit('player-action', {
        playerId: socket.id,
        action: data.action,
        position: data.position,
        timestamp: Date.now()
      });
    }
  });
  
  // ====== ENHANCED ROOM MANAGEMENT ======
  // Create a new game room
  socket.on('create-room', () => {
    // Generate a unique 6-character room code
    const roomCode = generateRoomCode();
    
    // Create room data structure
    rooms[roomCode] = {
      players: {},
      treats: [],
      roombas: [],
      gameState: 'waiting', // waiting, playing, ended
      host: socket.id,
      settings: {
        targetScore: 30,
        maxPlayers: 5
      }
    };
    
    // Join the room you created
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    // Add player to room data
    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: `Player ${Object.keys(rooms[roomCode].players).length + 1}`,
      skinIndex: 0,
      position: { x: 0, y: 0 },
      score: 0
    };
    
    // Send room code to creator
    socket.emit('room-created', {
      roomCode: roomCode,
      playerId: socket.id,
      isHost: true
    });
    
    console.log(`Room ${roomCode} created by ${socket.id}`);
  });
  
  // Join an existing room
  socket.on('join-room', (data) => {
    const { roomCode, playerName, skinIndex } = data;
    
    // Check if room exists
    if (!rooms[roomCode]) {
      socket.emit('join-error', { message: 'Room not found' });
      return;
    }
    
    // Check if game is in progress
    if (rooms[roomCode].gameState === 'playing') {
      socket.emit('join-error', { message: 'Game already in progress' });
      return;
    }
    
    // Check if room is full
    if (Object.keys(rooms[roomCode].players).length >= rooms[roomCode].settings.maxPlayers) {
      socket.emit('join-error', { message: 'Room is full' });
      return;
    }
    
    // Join the room
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    // Add player to room data
    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: playerName || `Player ${Object.keys(rooms[roomCode].players).length + 1}`,
      skinIndex: skinIndex || 0,
      position: { x: 0, y: 0 },
      score: 0
    };
    
    // Tell everyone about the new player
    io.to(roomCode).emit('player-joined', {
      id: socket.id,
      name: rooms[roomCode].players[socket.id].name,
      skinIndex: rooms[roomCode].players[socket.id].skinIndex
    });
    
    // Send room info to the new player
    socket.emit('room-joined', {
      roomCode: roomCode,
      playerId: socket.id,
      isHost: socket.id === rooms[roomCode].host,
      players: rooms[roomCode].players,
      settings: rooms[roomCode].settings
    });
    
    console.log(`Player ${socket.id} joined room ${roomCode}`);
  });
  
  // Start the game (host only)
  socket.on('start-game', () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    
    // Only host can start
    if (socket.id !== rooms[roomCode].host) return;
    
    // Generate initial game state (treats, roombas, etc.)
    const gameState = generateInitialGameState();
    rooms[roomCode].gameState = 'playing';
    rooms[roomCode].treats = gameState.treats;
    rooms[roomCode].roombas = gameState.roombas;
    
    // Notify all players in room
    io.to(roomCode).emit('game-started', gameState);
    
    console.log(`Game started in room ${roomCode}`);
  });
  
  // Player updates (position, actions, etc.)
  socket.on('player-update', (data) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    
    // Update player data in room
    if (rooms[roomCode].players[socket.id]) {
      // Update position
      if (data.position) {
        rooms[roomCode].players[socket.id].position = data.position;
      }
      
      // Update score
      if (data.score !== undefined) {
        rooms[roomCode].players[socket.id].score = data.score;
      }
    }
    
    // Broadcast to other players in same room
    socket.to(roomCode).emit('player-updated', {
      id: socket.id,
      ...data
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    
    if (roomCode && rooms[roomCode]) {
      // Remove player from room
      if (rooms[roomCode].players[socket.id]) {
        delete rooms[roomCode].players[socket.id];
        
        // Notify others that player left
        socket.to(roomCode).emit('player-left', socket.id);
      }
      
      // If room is empty, delete it
      if (Object.keys(rooms[roomCode].players).length === 0) {
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted (empty)`);
      }
      // If host left, assign new host
      else if (socket.id === rooms[roomCode].host) {
        const newHostId = Object.keys(rooms[roomCode].players)[0];
        rooms[roomCode].host = newHostId;
        io.to(roomCode).emit('new-host', newHostId);
      }
    }
    
    console.log('User disconnected:', socket.id);
  });
});

// Helper functions
function generateRoomCode() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  
  // Make sure code is unique
  if (rooms[result]) return generateRoomCode();
  return result;
}

function generateInitialGameState() {
  // Create treats, roombas, etc.
  return {
    treats: Array(6).fill().map(() => generateTreat()),
    roombas: Array(2).fill().map(() => generateRoomba()),
    // Other initial game state
  };
}

function generateTreat() {
  return {
    id: Math.random().toString(36).substring(2, 15),
    x: Math.random() * 800 + 100,
    y: Math.random() * 500 + 100,
  };
}

function generateRoomba() {
  return {
    id: Math.random().toString(36).substring(2, 15),
    x: Math.random() * 800 + 100,
    y: Math.random() * 500 + 100,
    vx: Math.random() * 2 - 1,
    vy: Math.random() * 2 - 1
  };
}

// Create self-ping to prevent Render from sleeping
const keepAlive = () => {
  setInterval(() => {
    console.log("Pinging self to prevent sleep...");
    fetch(`https://meow-mayhem-server.onrender.com/ping`)
      .catch(err => console.error("Failed to ping self:", err));
  }, 840000); // 14 minutes
};

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  keepAlive(); // Start the keep-alive mechanism
});
