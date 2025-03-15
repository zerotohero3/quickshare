// server.js - Servidor WebSocket para o QuickShare

const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const cron = require("node-cron");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configuração do multer
const storage = multer.memoryStorage(); // Armazena o arquivo na memória
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB em bytes
const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, "public")));

// Rota principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = {};
const roomsLastActivity = {};
const roomMessages = {};
const roomFiles = {};
// Definir tempo de expiração de salas inativas (em ms) - 48 horas
const ROOM_EXPIRY_TIME = 48 * 60 * 60 * 1000;
const MESSAGE_HISTORY_LIMIT = 100;

// Adicionar no início do arquivo, após as outras constantes
const FILE_EXPIRY_TIME = 7 * 24 * 60 * 60 * 1000; // 7 dias em ms
const fileTimestamps = {};

// Configuração do WebSocket
io.on("connection", (socket) => {
  console.log("Novo cliente conectado:", socket.id);

  socket.on("client-log", (data) => {
    const { type, message } = data;
    // Registrar logs do cliente no servidor
    if (type === "error") {
      console.error(`[Cliente ${socket.id}] ${message}`);
    } else if (type === "warn") {
      console.warn(`[Cliente ${socket.id}] ${message}`);
    } else {
      console.log(`[Cliente ${socket.id}] ${message}`);
    }
  });

  function updateRoomActivity(roomId) {
    if (roomId && rooms[roomId]) {
      roomsLastActivity[roomId] = Date.now();
    }
  }

  // Criar nova sala
  socket.on("create-room", () => {
    const roomId = uuidv4().substring(0, 6);

    rooms[roomId] = {
      creator: socket.id,
      peers: [socket.id],
      createdAt: Date.now(),
    };

    // Inicializar histórico vazio para a sala
    roomMessages[roomId] = [];
    roomFiles[roomId] = [];

    roomsLastActivity[roomId] = Date.now();

    socket.join(roomId);
    socket.emit("room-created", { roomId });

    console.log(`Sala criada: ${roomId}`);
  });

  // Entrar em uma sala existente
  socket.on("join-room", (data) => {
    const roomId = data.roomId;

    if (rooms[roomId]) {
      socket.join(roomId);

      // Adicionar à lista de pares se não estiver já
      if (!rooms[roomId].peers.includes(socket.id)) {
        rooms[roomId].peers.push(socket.id);
      }

      // Atualizar atividade da sala
      updateRoomActivity(roomId);

      // Notificar o cliente
      socket.emit("room-joined", { roomId });

      if (roomMessages[roomId] && roomMessages[roomId].length > 0) {
        socket.emit("message-history", { messages: roomMessages[roomId] });
      }

      if (roomFiles[roomId] && roomFiles[roomId].length > 0) {
        const now = Date.now();

        // Filtrar para remover quaisquer arquivos que não existam mais no sistema
        const validFiles = roomFiles[roomId].filter((file) => {
          const fileName = file.name;
          // Verificar se o arquivo ainda tem um timestamp (não foi removido manualmente)
          return fileTimestamps[fileName] !== undefined;
        });

        // Atualizar a lista de arquivos da sala para remover os que não existem mais
        roomFiles[roomId] = validFiles;

        // Criar a versão com informações de expiração para enviar ao cliente
        const filesWithExpiryStatus = validFiles.map((file) => {
          const fileName = file.name;
          const isExpired = now - fileTimestamps[fileName] > FILE_EXPIRY_TIME;

          return {
            ...file,
            isExpired: isExpired,
          };
        });

        socket.emit("file-history", { files: filesWithExpiryStatus });
      }

      // Notificar outros pares na sala
      for (const peerId of rooms[roomId].peers) {
        if (peerId !== socket.id) {
          io.to(peerId).emit("new-peer", { peerId: socket.id });
          socket.emit("new-peer", { peerId });
        }
      }

      console.log(`Cliente ${socket.id} entrou na sala ${roomId}`);
    } else {
      // Enviar mensagem de erro se a sala não existir
      socket.emit("error", {
        message:
          "Código da sala inválido ou inexistente. Verifique e tente novamente.",
      });
    }
  });

  // Lidar com desconexão do cliente
  socket.on("disconnect", () => {
    console.log("Cliente desconectado:", socket.id);

    // Encontrar salas onde o usuário estava
    for (const roomId in rooms) {
      const room = rooms[roomId];

      // Remover o socket da lista de pares
      const peerIndex = room.peers.indexOf(socket.id);
      if (peerIndex !== -1) {
        room.peers.splice(peerIndex, 1);

        // Notificar outros peers na sala sobre a desconexão
        socket.to(roomId).emit("peer-disconnect", { peerId: socket.id });

        // Atualizar timestamps da última atividade
        updateRoomActivity(roomId);

        console.log(`Cliente ${socket.id} removido da sala ${roomId}`);

        // Nota: NÃO removo a sala mesmo se ficar vazia
        // A sala será limpa pelo processo de manutenção periódica
      }
    }
  });

  socket.on("send-message", (data) => {
    const { roomId, message, timestamp, id } = data;

    if (rooms[roomId]) {
      // Atualizar atividade da sala
      updateRoomActivity(roomId);

      // Criar objeto de mensagem
      const messageObj = {
        id: id,
        text: message,
        sender: socket.id,
        timestamp: timestamp || Date.now(),
        persistentUserId: data.persistentUserId,
      };

      // Adicionar ao histórico de mensagens da sala
      if (roomMessages[roomId]) {
        roomMessages[roomId].push(messageObj);
        // Limitar o tamanho do histórico
        if (roomMessages[roomId].length > MESSAGE_HISTORY_LIMIT) {
          roomMessages[roomId].shift(); // Remove a mensagem mais antiga
        }
      }

      // Emitir a mensagem para todos os usuários na sala (incluindo o remetente)
      io.to(roomId).emit("receive-message", messageObj);

      console.log(
        `Mensagem enviada por ${socket.id} na sala ${roomId}:`,
        messageObj
      );
    }
  });

  // Troca de sinalização WebRTC
  socket.on("offer", (data) => {
    updateRoomActivity(data.roomId);
    io.to(data.peerId).emit("offer", {
      offer: data.offer,
      peerId: socket.id,
    });
  });

  socket.on("answer", (data) => {
    updateRoomActivity(data.roomId);
    io.to(data.peerId).emit("answer", {
      answer: data.answer,
      peerId: socket.id,
    });
  });

  socket.on("ice-candidate", (data) => {
    updateRoomActivity(data.roomId);
    io.to(data.peerId).emit("ice-candidate", {
      candidate: data.candidate,
      peerId: socket.id,
    });
  });

  // Manipulador para registrar um arquivo compartilhado
  socket.on("file-shared", (data) => {
    const { roomId, fileInfo } = data;

    if (rooms[roomId]) {
      // Certificar-se de que o fileInfo inclua a URL e outros dados necessários
      const completeFileInfo = {
        ...fileInfo,
        url: `/download/${fileInfo.name}`,
        uploadedAt: Date.now(),
        expiresAt: Date.now() + FILE_EXPIRY_TIME,
      };

      // Adicionar arquivo ao histórico da sala
      if (!roomFiles[roomId]) {
        roomFiles[roomId] = [];
      }
      roomFiles[roomId].push(completeFileInfo);

      // Registrar o timestamp do arquivo
      fileTimestamps[fileInfo.name] = Date.now();

      // Notificar todos os clientes na sala (incluindo o remetente)
      io.to(roomId).emit("new-file-record", completeFileInfo);

      console.log(`Arquivo '${fileInfo.name}' compartilhado na sala ${roomId}`);
    }
  });

  // Adicionar tratamento para a remoção de arquivos - dentro do evento connection do socket
  socket.on("file-remove-request", (data) => {
    const { roomId, fileId, fileName } = data;
    console.log(
      `Recebido pedido para remover arquivo: ${fileName} (${fileId}) da sala ${roomId}`
    );

    // Verificar se a sala existe
    if (roomFiles[roomId]) {
      // Encontrar e remover o arquivo do registro da sala
      const fileIndex = roomFiles[roomId].findIndex(
        (file) => file.id === fileId
      );

      if (fileIndex !== -1) {
        console.log(`Arquivo encontrado no índice ${fileIndex}, removendo...`);

        // Remover do array de arquivos da sala
        roomFiles[roomId].splice(fileIndex, 1);
        console.log(
          `Arquivo removido do histórico da sala. Total de arquivos restantes: ${roomFiles[roomId].length}`
        );

        // Tentar remover o arquivo do sistema de arquivos
        const filePath = path.join(uploadsDir, fileName);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error(`Erro ao remover arquivo ${fileName}:`, err);
          } else {
            console.log(`Arquivo removido do sistema de arquivos: ${fileName}`);

            // Remover permanentemente do registro de timestamps para que não apareça mais
            delete fileTimestamps[fileName];
            console.log(
              `Timestamp do arquivo removido. O arquivo não aparecerá mais no histórico.`
            );

            // Notificar todos os clientes na sala sobre o arquivo removido
            io.to(roomId).emit("file-removed", { fileId, fileName });
          }
        });
      } else {
        console.log(`Arquivo ${fileId} não encontrado na sala ${roomId}`);
      }
    } else {
      console.log(`Sala ${roomId} não encontrada ou não tem lista de arquivos`);
    }
  });
});

// Limpeza periódica de salas inativas
function cleanupInactiveRooms() {
  const now = Date.now();

  for (const roomId in rooms) {
    const lastActivity = roomsLastActivity[roomId] || 0;
    const timeSinceLastActivity = now - lastActivity;

    if (timeSinceLastActivity > ROOM_EXPIRY_TIME) {
      console.log(
        `Removendo sala inativa: ${roomId} (inativa por ${Math.round(
          timeSinceLastActivity / 3600000
        )} horas)`
      );

      // Remover sala e seu histórico
      delete rooms[roomId];
      delete roomsLastActivity[roomId];
      delete roomMessages[roomId];
      delete roomFiles[roomId];
    }
  }
}

// Executar limpeza a cada hora
setInterval(cleanupInactiveRooms, 60 * 60 * 1000);

// Registrar as estatísticas das salas periodicamente para monitoramento
setInterval(() => {
  console.log(`Estatísticas: ${Object.keys(rooms).length} salas ativas`);
}, 6 * 60 * 60 * 1000); // A cada 6 horas

app.post("/upload", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "Arquivo muito grande",
          message: "O tamanho máximo permitido é 50MB",
        });
      }
      return res
        .status(500)
        .json({ error: "Erro no upload", message: err.message });
    }

    const fileName = req.file.originalname; // Nome original do arquivo
    const fileData = req.file.buffer; // Buffer do arquivo
    const filePath = path.join(uploadsDir, fileName);

    fileTimestamps[fileName] = Date.now();

    fs.writeFile(filePath, fileData, (err) => {
      if (err) {
        return res
          .status(500)
          .json({ error: "Erro ao salvar o arquivo", message: err.message });
      }

      // Retornar a URL para download e o timestamp de expiração
      res.json({
        url: `/download/${fileName}`,
        expiresAt: fileTimestamps[fileName] + FILE_EXPIRY_TIME,
      });
    });
  });
});

// Adicionar uma função para limpar arquivos antigos - após outras funções
function cleanupExpiredFiles() {
  const now = Date.now();
  console.log("Verificando e limpando arquivos expirados...");

  let expiredCount = 0;
  let removedCount = 0;
  let totalFiles = Object.keys(fileTimestamps).length;

  // Se não houver arquivos para verificar, encerre
  if (totalFiles === 0) {
    return;
  }

  for (const fileName in fileTimestamps) {
    const fileAge = now - fileTimestamps[fileName];

    // Verificar se o arquivo expirou
    if (fileAge > FILE_EXPIRY_TIME) {
      expiredCount++;
      const filePath = path.join(uploadsDir, fileName);

      // Procurar em quais salas o arquivo está disponível
      const affectedRooms = [];
      const fileEntries = [];

      Object.keys(roomFiles).forEach((roomId) => {
        const fileIndex = roomFiles[roomId].findIndex(
          (file) => file.name === fileName
        );
        if (fileIndex !== -1) {
          affectedRooms.push(roomId);
          fileEntries.push({
            roomId,
            fileId: roomFiles[roomId][fileIndex].id,
          });
        }
      });

      // Tentar remover o arquivo
      fs.unlink(filePath, (err) => {
        if (err && err.code !== "ENOENT") {
          console.error(`Erro ao remover arquivo expirado ${fileName}:`, err);
        } else {
          removedCount++;
          console.log(`Arquivo expirado removido fisicamente: ${fileName}`);

          // Notificar todas as salas afetadas sobre a remoção completa
          fileEntries.forEach((entry) => {
            io.to(entry.roomId).emit("file-removed", {
              fileId: entry.fileId,
              fileName,
              reason: "expired",
            });

            // Remover o arquivo da lista de arquivos da sala
            roomFiles[entry.roomId] = roomFiles[entry.roomId].filter(
              (file) => file.name !== fileName
            );
          });

          // Remover do registro de timestamps
          delete fileTimestamps[fileName];
        }
      });
    }
  }

  if (expiredCount > 0) {
    console.log(
      `Limpeza completa: ${expiredCount} arquivos expirados encontrados, ${removedCount} removidos`
    );
  }
}

// Executar limpeza de arquivos a cada 60 minutos
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 60 em ms
setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL);

// Rota para download do arquivo
app.get("/download/:fileName", (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.join(uploadsDir, fileName);

  res.download(filePath, fileName, (err) => {
    if (err) {
      console.error("Erro ao enviar o arquivo:", err);
      res.status(500).send("Erro ao enviar o arquivo.");
    }
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;

// Mecanismo anti-hibernação apenas em produção
if (process.env.NODE_ENV === "production") {
  console.log("Configurando mecanismo anti-hibernação...");

  // URL do aplicativo
  const appUrl = process.env.APP_URL || `https://quickshare-txmd.onrender.com`;
  console.log(`URL para ping anti-hibernação: ${appUrl}`);

  // Agendar uma solicitação a cada 3 minutos
  cron.schedule("*/3 * * * *", async () => {
    try {
      const response = await axios.get(appUrl);
      console.log(
        `[Anti-Hibernação] Ping realizado com sucesso: ${response.status}`
      );
    } catch (error) {
      console.error(
        `[Anti-Hibernação] Erro ao realizar ping: ${error.message}`
      );
    }
  });

  console.log(
    "Mecanismo anti-hibernação configurado para ambiente de produção."
  );
}

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
