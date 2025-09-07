const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  methods: ["GET", "POST"]
});

const SIZE = 18;
const TURN_TIME = 60;
const RoomStatus = {
  Full: 2,
  ReadyToPlay: 3,
};

const rooms = {};
// { token: { players: [{id, symbol}], currentPlayer, board, timer, timerInterval } }

io.on("connection", (socket) => {
  console.log("⚡ User connected:", socket.id);
  const page = socket.handshake?.query?.page;
  if (page === "home") {
    socket.join("home");
  }
  broadcastRooms();
  socket.on("joinRoom", (token) => {
    if (!rooms[token]) {
      rooms[token] = {
        players: [],
        currentPlayer: null,
        board: createBoard(),
        timer: TURN_TIME,
        timerInterval: null,
        createdDate: new Date().getTime(),
      };
    }
    const room = rooms[token];

    if (room.players.length >= 2) {
      socket.emit("redirectHome");
      return;
    }

    room.players.push({ id: socket.id, symbol: null });
    socket.join(token);
    console.log(`✅ Player joined room ${token}`);

    io.to(token).emit("checkWaitingOtherPlayer", {
      waiting: room.players.length < 2,
    });

    if (room.players.length === 2) {
      resetRoom(token); // reset khi đủ 2 người
    }
    broadcastRooms();
  });

  socket.on("makeMove", ({ row, col }) => {
    const token = findRoomBySocket(socket.id);
    if (!token) return;
    const room = rooms[token];
    if (!room || room.gameOver) return; // Nếu gameOver thì bỏ qua
    const player = room.players.find((p) => p.id === socket.id);

    if (!player || room.currentPlayer !== player.symbol) return;
    if (room.board[row][col] !== null) return;

    room.board[row][col] = player.symbol;

    const winningCells = checkWin(room.board, row, col, player.symbol);
    if (winningCells) {
      io.to(token).emit("updateBoard", {
        row,
        col,
        symbol: player.symbol,
        currentPlayer: room.currentPlayer,
      });

      // Gửi luôn danh sách ô thắng
      io.to(token).emit("gameOver", {
        winner: player.symbol,
        cells: winningCells,
      });

      clearInterval(room.timerInterval);
      room.gameOver = true; // thêm cờ gameOver
      return;
    }

    // đổi lượt
    room.currentPlayer = player.symbol === "X" ? "O" : "X";
    restartTimer(token);

    io.to(token).emit("updateBoard", {
      row,
      col,
      symbol: player.symbol,
      currentPlayer: room.currentPlayer,
    });
  });

  socket.on("passTurn", () => {
    const token = findRoomBySocket(socket.id);
    if (!token) return;
    const room = rooms[token];
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || room.currentPlayer !== player.symbol) return;

    switchTurn(token);
  });

  socket.on("resetRequest", () => {
    const token = findRoomBySocket(socket.id);
    if (!token) return;
    resetRoom(token);
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected:", socket.id);
    const token = findRoomBySocket(socket.id);
    if (!token) return;
    const room = rooms[token];
    room.players = room.players.filter((p) => p.id !== socket.id);

    if (room.players.length < 2) {
      io.to(token).emit("opponentLeft");

      clearInterval(room.timerInterval);
    }
    if (room.players.length === 0) {
      delete rooms[token];
    }
    broadcastRooms();
  });
});

// =================== Helpers ===================
function broadcastRooms() {
  const roomsNow = Object.entries(rooms).map(([id, obj]) => {
    return {
      id,
      status: obj?.players?.length === 2 ? RoomStatus.Full : RoomStatus.ReadyToPlay,
      createdDate: obj.createdDate,
    };
  });
  io.to("home").emit("roomsUpdate", roomsNow);
}

function resetRoom(token) {
  const room = rooms[token];
  if (!room || room.players.length < 2) return;

  room.gameOver = false; // reset trạng thái
  room.board = createBoard();
  room.currentPlayer = Math.random() < 0.5 ? "X" : "O";

  // phân X/O ngẫu nhiên cho người chơi
  const symbols = shuffle(["X", "O"]);
  room.players[0].symbol = symbols[0];
  room.players[1].symbol = symbols[1];

  room.players.forEach((p) => {
    io.to(p.id).emit("joined", { symbol: p.symbol });
  });

  io.to(token).emit("resetGame", { currentPlayer: room.currentPlayer });

  restartTimer(token);
}

function switchTurn(token) {
  const room = rooms[token];
  if (!room) return;
  room.currentPlayer = room.currentPlayer === "X" ? "O" : "X";
  restartTimer(token);
  io.to(token).emit("updateBoard", {
    row: null,
    col: null,
    symbol: null,
    currentPlayer: room.currentPlayer,
  });
}

function restartTimer(token) {
  const room = rooms[token];
  if (!room) return;
  clearInterval(room.timerInterval);
  room.timer = TURN_TIME;
  io.to(token).emit("timer", { time: room.timer });

  room.timerInterval = setInterval(() => {
    room.timer--;
    io.to(token).emit("timer", { time: room.timer });

    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      switchTurn(token);
    }
  }, 1000);
}

function findRoomBySocket(socketId) {
  for (const token in rooms) {
    if (rooms[token].players.some((p) => p.id === socketId)) {
      return token;
    }
  }
  return null;
}

function createBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function checkWin(board, row, col, symbol) {
  // kiểm tra theo 4 hướng
  const directions = [
    [1, 0], // dọc
    [0, 1], // ngang
    [1, 1], // chéo \
    [1, -1], // chéo /
  ];

  for (const [dr, dc] of directions) {
    const line = getLine(board, row, col, symbol, dr, dc);
    if (line.length >= 5) {
      return line; // trả về mảng cell thắng
    }
  }
  return null;
}

function getLine(board, row, col, symbol, dr, dc) {
  const cells = [{ row, col }];
  let r = row + dr,
    c = col + dc;
  while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === symbol) {
    cells.push({ row: r, col: c });
    r += dr;
    c += dc;
  }
  r = row - dr;
  c = col - dc;
  while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === symbol) {
    cells.push({ row: r, col: c });
    r -= dr;
    c -= dc;
  }
  return cells;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

server.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
