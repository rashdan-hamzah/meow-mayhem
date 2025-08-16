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

// Configuration
const CONFIG = {
  treatRespawnMs: 1600,
  dogeEveryMs: 9000,
  dogeSpeed: 2.0,
  dogeEatTimeMs: 1000,
  roombas: 2,
  laserCount: 5,
  weatherDuration: 8000,
  weatherCooldown: 5000,
  secretSauceInterval: 30000,
  secretSauceDuration: 8000,
  boundsPadding: 8,
  powerUpChance: 0.004,
  maxPowerUps: 3
};

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
  socket.on('create-room', (data) => {
    // Generate a unique 6-character room code
    const roomCode = generateRoomCode();
    
    // Create room data structure
    rooms[roomCode] = {
      players: {},
      treats: [],
      roombas: [],
      lasers: [],
      powerUps: [],
      doge: null,
      weather: null,
      secretSauce: {
        active: false,
        countdown: 30
      },
      gameState: 'waiting', // waiting, playing, ended
      host: socket.id,
      lastGameStateUpdate: Date.now(),
      settings: {
        targetScore: 30,
        maxPlayers: 2, // Enforced 2-player limit
        canvasWidth: 1200, 
        canvasHeight: 800
      }
    };
    
    // Join the room you created
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    // Add player to room data
    const playerName = data?.playerName || `Player ${Object.keys(rooms[roomCode].players).length + 1}`;
    const skinIndex = data?.skinIndex || 0;
    
    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: playerName,
      skinIndex: skinIndex,
      position: { x: 0, y: 0 },
      score: 0,
      isHost: true
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
    
    // CRITICAL FIX: Hard limit to 2 players total
    const currentPlayerCount = Object.keys(rooms[roomCode].players).length;
    if (currentPlayerCount >= 2) {
      socket.emit('join-error', { message: 'Room is full (2 player maximum)' });
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
      score: 0,
      isHost: false
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
    const gameState = generateInitialGameState(rooms[roomCode].settings);
    rooms[roomCode].gameState = 'playing';
    rooms[roomCode].treats = gameState.treats;
    rooms[roomCode].roombas = gameState.roombas;
    rooms[roomCode].lasers = gameState.lasers;
    rooms[roomCode].nextTreatAt = Date.now() + CONFIG.treatRespawnMs;
    rooms[roomCode].nextDogeAt = Date.now() + CONFIG.dogeEveryMs;
    rooms[roomCode].nextWeatherEvent = Date.now() + 5000;
    rooms[roomCode].nextSecretSauce = Date.now() + CONFIG.secretSauceInterval;
    rooms[roomCode].secretSauce = {
      active: false,
      countdown: 30
    };
    
    // Start game loop for this room
    startGameLoop(roomCode);
    
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
  
  // Handle player actions
  socket.on('player-action', (data) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    
    // Add player ID to the data
    const actionData = {
      id: socket.id,
      ...data
    };
    
    // Process specific actions
    switch (data.action) {
      case 'meow':
        // Broadcast meow action to other players
        socket.to(roomCode).emit('player-action', actionData);
        break;
        
      case 'collect-treat':
        // Remove collected treat
        if (data.treatId && rooms[roomCode].treats) {
          rooms[roomCode].treats = rooms[roomCode].treats.filter(t => t.id !== data.treatId);
          
          // Update player score
          if (data.score !== undefined) {
            rooms[roomCode].players[socket.id].score = data.score;
          }
          
          // Broadcast to other players
          socket.to(roomCode).emit('player-action', actionData);
        }
        break;
        
      case 'powerup':
        // Handle powerup collection
        if (data.powerUpId && rooms[roomCode].powerUps) {
          rooms[roomCode].powerUps = rooms[roomCode].powerUps.filter(p => p.id !== data.powerUpId);
          
          // Broadcast to other players
          socket.to(roomCode).emit('player-action', actionData);
        }
        break;
        
      case 'game-end':
        // Handle game end
        if (data.winner) {
          rooms[roomCode].gameState = 'ended';
          rooms[roomCode].winner = data.winner;
          
          // Broadcast to other players
          socket.to(roomCode).emit('player-action', actionData);
        }
        break;
    }
  });
  
  // Handle request for treat spawning
  socket.on('request-treat', () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode] || rooms[roomCode].gameState !== 'playing') return;
    
    // Only spawn if below the limit
    if (rooms[roomCode].treats.length < 6) {
      const treat = generateTreat(rooms[roomCode].settings);
      rooms[roomCode].treats.push(treat);
      
      // Broadcast to all players in the room
      io.to(roomCode).emit('treat-spawned', treat);
    }
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
        rooms[roomCode].players[newHostId].isHost = true;
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

function generateInitialGameState(settings) {
  const width = settings?.canvasWidth || 1200;
  const height = settings?.canvasHeight || 800;
  
  // Create treats, roombas, etc.
  return {
    treats: Array(6).fill().map(() => generateTreat(settings)),
    roombas: Array(CONFIG.roombas).fill().map(() => generateRoomba(settings)),
    lasers: Array(CONFIG.laserCount).fill().map(() => generateLaser(settings)),
    powerUps: [],
    doge: null,
    weather: null,
    secretSauce: {
      active: false,
      countdown: 30
    },
    players: {}
  };
}

function generateTreat(settings) {
  const width = settings?.canvasWidth || 1200;
  const height = settings?.canvasHeight || 800;
  const boundsPadding = CONFIG.boundsPadding;
  
  return {
    id: Math.random().toString(36).substring(2, 15),
    x: Math.random() * (width - boundsPadding * 2) + boundsPadding,
    y: Math.random() * (height - boundsPadding * 2 - 40) + boundsPadding + 40,
    vx: 0,
    vy: 0
  };
}

function generateRoomba(settings) {
  const width = settings?.canvasWidth || 1200;
  const height = settings?.canvasHeight || 800;
  
  return {
    id: Math.random().toString(36).substring(2, 15),
    x: Math.random() * (width - 120) + 60,
    y: Math.random() * (height - 150) + 80,
    vx: Math.random() * 2.8 - 1.4,
    vy: Math.random() * 2.8 - 1.4
  };
}

function generateLaser(settings) {
  const width = settings?.canvasWidth || 1200;
  const height = settings?.canvasHeight || 800;
  
  return {
    id: Math.random().toString(36).substring(2, 15),
    x: Math.random() * (width - 80) + 40,
    y: Math.random() * (height - 130) + 90,
    t: Math.floor(Math.random() * 120),
    targetX: Math.random() * (width - 80) + 40,
    targetY: Math.random() * (height - 80) + 40,
    speed: Math.random() * 1.4 + 2.8
  };
}

function generateDoge(settings) {
  const width = settings?.canvasWidth || 1200;
  const height = settings?.canvasHeight || 800;
  
  const side = Math.random() < 0.5 ? 'L' : 'R';
  
  return {
    id: Math.random().toString(36).substring(2, 15),
    x: side === 'L' ? -60 : width + 60,
    y: Math.random() * (height - 180) + 90,
    vx: side === 'L' ? (Math.random() * 0.5 + 2.0) : -(Math.random() * 0.5 + 2.0),
    vy: 0,
    ttl: 15000,
    eating: null
  };
}

function generatePowerUp(settings) {
  const width = settings?.canvasWidth || 1200;
  const height = settings?.canvasHeight || 800;
  const boundsPadding = CONFIG.boundsPadding * 2;
  
  // Random power-up type (0-4)
  const typeIndex = Math.floor(Math.random() * 5);
  const types = ["Speed Boost", "Shield", "Giant Mode", "Super Meow", "Treat Magnet"];
  
  return {
    id: Math.random().toString(36).substring(2, 15),
    x: Math.random() * (width - boundsPadding * 2) + boundsPadding,
    y: Math.random() * (height - boundsPadding * 2 - 40) + boundsPadding + 40,
    type: types[typeIndex]
  };
}

function generateWeatherEvent() {
  const events = ["Night Mode", "Slippery Floor", "Tornado", "Super Speed"];
  const randomEvent = events[Math.floor(Math.random() * events.length)];
  
  return {
    name: randomEvent,
    duration: CONFIG.weatherDuration
  };
}

// Game loop for a specific room
function startGameLoop(roomCode) {
  // Only start if room exists and is in playing state
  if (!rooms[roomCode] || rooms[roomCode].gameState !== 'playing') return;
  
  // Set up interval for game updates - 20 updates per second
  const intervalId = setInterval(() => {
    // Check if room still exists
    if (!rooms[roomCode] || rooms[roomCode].gameState !== 'playing') {
      clearInterval(intervalId);
      return;
    }
    
    updateGameState(roomCode);
    
    // Send game state to all clients in the room
    const gameState = {
      treats: rooms[roomCode].treats,
      roombas: rooms[roomCode].roombas,
      doge: rooms[roomCode].doge,
      lasers: rooms[roomCode].lasers,
      weather: rooms[roomCode].weather,
      powerUps: rooms[roomCode].powerUps,
      secretSauce: rooms[roomCode].secretSauce
    };
    
    io.to(roomCode).emit('game-state-update', gameState);
    
  }, 50); // 50ms = 20 updates per second
  
  // Store interval ID to be able to clear it later
  rooms[roomCode].gameLoopIntervalId = intervalId;
}

// Update the game state for a specific room
function updateGameState(roomCode) {
  if (!rooms[roomCode]) return;
  
  const room = rooms[roomCode];
  const settings = room.settings;
  const now = Date.now();
  const width = settings.canvasWidth;
  const height = settings.canvasHeight;
  
  // Update treats
  room.treats.forEach(treat => {
    if (treat.vx !== 0 || treat.vy !== 0) {
      treat.x += treat.vx;
      treat.y += treat.vy;
      treat.vx *= 0.95;
      treat.vy *= 0.95;
      
      // Stop very small movements
      if (Math.abs(treat.vx) < 0.1) treat.vx = 0;
      if (Math.abs(treat.vy) < 0.1) treat.vy = 0;
      
      // Keep treats in bounds
      const boundsPadding = CONFIG.boundsPadding;
      if (treat.x < boundsPadding) { treat.x = boundsPadding; treat.vx *= -0.5; }
      if (treat.x > width - boundsPadding) { treat.x = width - boundsPadding; treat.vx *= -0.5; }
      if (treat.y < boundsPadding + 40) { treat.y = boundsPadding + 40; treat.vy *= -0.5; }
      if (treat.y > height - boundsPadding) { treat.y = height - boundsPadding; treat.vy *= -0.5; }
    }
  });
  
  // Spawn new treats if needed
  if (now >= room.nextTreatAt && room.treats.length < 6) {
    room.nextTreatAt = now + CONFIG.treatRespawnMs;
    const treat = generateTreat(settings);
    room.treats.push(treat);
  }
  
  // Update roombas
  room.roombas.forEach(roomba => {
    roomba.x += roomba.vx;
    roomba.y += roomba.vy;
    
    // Bounce off edges
    if (roomba.x < 40 || roomba.x > width - 40) roomba.vx *= -1;
    if (roomba.y < 70 || roomba.y > height - 40) roomba.vy *= -1;
  });
  
  // Update lasers
  room.lasers.forEach(laser => {
    laser.t += 1;
    
    // Retarget sometimes (different timing for each laser)
    if (laser.t % 120 === 0) {
      laser.targetX = Math.random() * (width - 80) + 40;
      laser.targetY = Math.random() * (height - 80) + 40;
    }
    
    const dx = laser.targetX - laser.x;
    const dy = laser.targetY - laser.y;
    const d = Math.hypot(dx, dy) || 1;
    laser.x += (dx/d) * laser.speed;
    laser.y += (dy/d) * laser.speed;
  });
  
  // Update doge
  if (!room.doge && now >= room.nextDogeAt) {
    room.nextDogeAt = now + CONFIG.dogeEveryMs;
    room.doge = generateDoge(settings);
  }
  
  if (room.doge) {
    // If doge is eating a player, check if done
    if (room.doge.eating) {
      const eatingDuration = now - room.doge.eatingStartTime;
      
      if (eatingDuration >= CONFIG.dogeEatTimeMs) {
        room.doge.eating = null;
      }
    } 
    // If not eating, find closest player to chase
    else {
      // Find closest player
      let closestDist = Infinity;
      let closestPlayer = null;
      
      for (const id in room.players) {
        const player = room.players[id];
        if (!player.position) continue;
        
        const dx = player.position.x - room.doge.x;
        const dy = player.position.y - room.doge.y;
        const d = Math.hypot(dx, dy);
        
        if (d < closestDist) {
          closestDist = d;
          closestPlayer = player;
        }
      }
      
      // Chase closest player
      if (closestPlayer) {
        const dx = closestPlayer.position.x - room.doge.x;
        const dy = closestPlayer.position.y - room.doge.y;
        const d = Math.hypot(dx, dy) || 1;
        room.doge.vx = (dx/d) * CONFIG.dogeSpeed;
        room.doge.vy = (dy/d) * CONFIG.dogeSpeed;
        
        // In secret sauce mode, doge moves faster
        if (room.secretSauce.active) {
          room.doge.vx *= 1.5;
          room.doge.vy *= 1.5;
        }
        
        // Check if doge catches a player
        for (const id in room.players) {
          const player = room.players[id];
          if (!player.position) continue;
          
          const playerR = 25; // Player radius
          const dx = player.position.x - room.doge.x;
          const dy = player.position.y - room.doge.y;
          const d = Math.hypot(dx, dy);
          
          if (d <= playerR + 26) { // Player radius + doge radius
            // Start eating player
            room.doge.eating = player.id;
            room.doge.eatingStartTime = now;
            
            // Set respawn point
            room.doge.respawnX = Math.random() * (width - 200) + 100;
            room.doge.respawnY = Math.random() * (height - 200) + 100;
            
            break;
          }
        }
      }
    }
    
    // Update doge position if not eating
    if (!room.doge.eating) {
      room.doge.x += room.doge.vx;
      room.doge.y += room.doge.vy;
    }
    
    // Update TTL
    room.doge.ttl -= 50; // 50ms per update
    
    // Despawn if TTL expired or out of bounds
    if (room.doge.ttl <= 0 || room.doge.x < -80 || room.doge.x > width + 80 || 
        room.doge.y < -80 || room.doge.y > height + 80) {
      room.doge = null;
    }
  }
  
  // Update power-ups
  if (Math.random() < CONFIG.powerUpChance && room.powerUps.length < CONFIG.maxPowerUps) {
    room.powerUps.push(generatePowerUp(settings));
  }
  
  // Update weather events
  if (!room.weather && now >= room.nextWeatherEvent) {
    room.weather = generateWeatherEvent();
    room.nextWeatherEvent = now + room.weather.duration + CONFIG.weatherCooldown;
  }
  
  if (room.weather && now >= room.nextWeatherEvent - CONFIG.weatherCooldown) {
    room.weather = null;
  }
  
  // Update secret sauce mode
  if (!room.secretSauce.active) {
    const secondsLeft = Math.ceil((room.nextSecretSauce - now) / 1000);
    room.secretSauce.countdown = secondsLeft;
    
    if (now >= room.nextSecretSauce) {
      // Activate secret sauce mode
      room.secretSauce.active = true;
      
      // Spawn additional chaos
      for (let i = 0; i < 3; i++) {
        room.powerUps.push(generatePowerUp(settings));
      }
      if (Math.random() < 0.5 && !room.doge) {
        room.doge = generateDoge(settings);
      }
      for (let i = 0; i < 3 && room.treats.length < 12; i++) {
        room.treats.push(generateTreat(settings));
      }
    }
  } else {
    // Check if secret sauce mode should end
    if (now >= room.nextSecretSauce + CONFIG.secretSauceDuration) {
      room.secretSauce.active = false;
      room.nextSecretSauce = now + CONFIG.secretSauceInterval;
    }
  }
}

// Create self-ping to prevent Render from sleeping
const keepAlive = () => {
  setInterval(() => {
    console.log("Pinging self to prevent sleep...");
    fetch(`https://meow-mayhem-server.onrender.com/ping`)
      .catch(err => console.error("Failed to ping self:", err));
  }, 840000); // 14 minutes
};

// Clean up stale rooms periodically
setInterval(() => {
  const now = Date.now();
  for (const roomCode in rooms) {
    // Remove rooms that have been inactive for more than 3 hours
    if (rooms[roomCode].lastActivity && now - rooms[roomCode].lastActivity > 10800000) {
      // Clear any game loops
      if (rooms[roomCode].gameLoopIntervalId) {
        clearInterval(rooms[roomCode].gameLoopIntervalId);
      }
      delete rooms[roomCode];
      console.log(`Removed stale room: ${roomCode}`);
    }
  }
}, 1800000); // 30 minutes

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  keepAlive(); // Start the keep-alive mechanism
});
