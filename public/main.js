window.removeFile = function (fileId, fileName) {
  // Redirecionar para a função interna
  const event = new CustomEvent("remove-file", {
    detail: { fileId, fileName },
  });
  document.dispatchEvent(event);
};

const isProduction =
  window.location.hostname !== "localhost" &&
  window.location.hostname !== "127.0.0.1";

if (isProduction) {
  const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };

  console.log = function () {
    if (window.socket && window.socket.connected) {
      window.socket.emit("client-log", {
        type: "info",
        message: Array.from(arguments).join(" "),
      });
    }
  };

  console.error = function () {
    if (window.socket && window.socket.connected) {
      window.socket.emit("client-log", {
        type: "error",
        message: Array.from(arguments).join(" "),
      });
    }
  };

  console.warn = function () {
    if (window.socket && window.socket.connected) {
      window.socket.emit("client-log", {
        type: "warn",
        message: Array.from(arguments).join(" "),
      });
    }
  };
}

const appLog = {
  info: function (message) {
    if (window.socket && window.socket.connected) {
      window.socket.emit("client-log", { type: "info", message });
    }
    if (!isProduction) {
      console.log(message);
    }
  },
  error: function (message) {
    if (window.socket && window.socket.connected) {
      window.socket.emit("client-log", { type: "error", message });
    }
    if (!isProduction) {
      console.error(message);
    }
  },
  warn: function (message) {
    if (window.socket && window.socket.connected) {
      window.socket.emit("client-log", { type: "warn", message });
    }
    if (!isProduction) {
      console.warn(message);
    }
  },
};

document.addEventListener("DOMContentLoaded", () => {
  // Implementação de UUID v4 para o cliente
  function uuidv4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        var r = (Math.random() * 16) | 0,
          v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }
    );
  }

  // Criar ou recuperar um ID de usuário persistente
  function getUserId() {
    let userId = localStorage.getItem("quickShareUserId");
    if (!userId) {
      userId = "user_" + uuidv4();
      localStorage.setItem("quickShareUserId", userId);
    }
    return userId;
  }

  // ID de usuário persistente
  const persistentUserId = getUserId();

  // Elementos DOM
  const createRoomBtn = document.getElementById("createRoom");
  const joinRoomBtn = document.getElementById("joinRoom");
  const roomInput = document.getElementById("roomInput");
  const sendMessageBtn = document.getElementById("sendMessage");
  const step1 = document.getElementById("step1");
  const step2 = document.getElementById("step2");
  const roomIdSpan = document.getElementById("roomId");
  const fileInput = document.getElementById("fileInput");
  const progressBar = document.getElementById("progressBar");
  const statusDiv = document.getElementById("status");
  const filesList = document.getElementById("filesList");
  const filesContainer = document.getElementById("filesContainer");
  const chat = document.getElementById("chat");

  // Variáveis globais
  let socket;
  let roomId;
  let peerConnections = {};
  let dataChannels = {};
  let fileChunks = {};
  let currentFile = {};

  // Configuração WebRTC
  const configuration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB em bytes

  // Função para gerar QR Code
  function generateQRCode(roomId) {
    const qrCodeElement = document.getElementById("qrCode");
    if (!qrCodeElement) return;

    qrCodeElement.innerHTML = "";

    // Criar URL completa para a sala
    const roomUrl = `${window.location.origin}?room=${roomId}`;

    // Gerar QR Code usando toDataURL em vez de toCanvas
    QRCode.toDataURL(
      roomUrl,
      {
        width: 80,
        margin: 1,
        color: {
          dark: "#6441a5",
          light: "#ffffff",
        },
      },
      function (error, url) {
        if (error) {
          appLog.error(error);
          return;
        }

        // Criar uma imagem com o QR code
        const img = document.createElement("img");
        img.src = url;
        img.alt = "QR Code para entrar na sala";
        img.style.width = "80px";
        img.style.height = "80px";

        qrCodeElement.appendChild(img);
      }
    );
  }

  // Verificar se há um parâmetro de sala na URL
  function checkRoomParam() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get("room");

    if (roomParam) {
      // Preencher o campo de entrada com o código da sala
      roomInput.value = roomParam;

      // Entrar na sala automaticamente após um pequeno delay
      setTimeout(() => {
        joinRoomBtn.click();
      }, 500);
    }
  }

  // Iniciar conexão WebSocket
  function initSocket() {
    socket = io.connect(window.location.origin);

    socket.on("connect", () => {
      // console.log("Conectado ao servidor WebSocket");
    });

    socket.on("error", (data) => {
      Swal.fire({
        icon: "error",
        title: "Erro!",
        text: data.message,
        background: "#0a0e17",
        color: "#ffffff",
        confirmButtonColor: "#6441a5",
      });
    });

    socket.on("room-created", (data) => {
      roomId = data.roomId;
      roomIdSpan.textContent = roomId;
      step1.style.display = "none";
      step2.style.display = "block";

      // Gerar QR Code
      generateQRCode(roomId);

      // Salvar no localStorage e configurar botão de sair
      saveRoomToLocalStorage(roomId);
      setupLeaveButton();
    });

    socket.on("room-joined", (data) => {
      roomId = data.roomId;
      roomIdSpan.textContent = roomId;
      step1.style.display = "none";
      step2.style.display = "block";

      // Gerar QR Code
      generateQRCode(roomId);

      // Salvar no localStorage e configurar botão de sair
      saveRoomToLocalStorage(roomId);
      setupLeaveButton();
    });

    socket.on("new-peer", (data) => {
      appLog.info("Novo par conectado:", data.peerId);
      const isInitiator = socket.id < data.peerId;
      createPeerConnection(data.peerId, !isInitiator);

      if (isInitiator) {
        const pc = peerConnections[data.peerId];
        if (pc && pc.signalingState === "stable") {
          // console.log("Iniciando negociação como iniciador");
          pc.onnegotiationneeded();
        }
      }
    });

    socket.on("ice-candidate", (data) => {
      const candidate = new RTCIceCandidate(data.candidate);
      const pc = peerConnections[data.peerId];
      if (!pc) return;

      if (!pc.remoteDescription || !pc.remoteDescription.type) {
        // console.warn("Remote description not set yet. Queueing ICE candidate.");
        if (!pc.queuedCandidates) {
          pc.queuedCandidates = [];
        }
        pc.queuedCandidates.push(candidate);
      } else {
        pc.addIceCandidate(candidate).catch((e) =>
          appLog.error("Erro ao adicionar ICE candidate:", e)
        );
      }
    });

    socket.on("offer", async (data) => {
      let pc = peerConnections[data.peerId];
      if (!pc) {
        pc = createPeerConnection(data.peerId, true);
      }

      try {
        const offerCollision = pc.signalingState !== "stable";

        if (offerCollision && !pc.polite) {
          return;
        }

        if (offerCollision) {
          await Promise.all([
            pc.setLocalDescription({ type: "rollback" }),
            pc.setRemoteDescription(new RTCSessionDescription(data.offer)),
          ]);
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        }

        if (pc.remoteDescription) {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          socket.emit("answer", {
            roomId,
            peerId: data.peerId,
            answer: pc.localDescription,
          });

          if (pc.queuedCandidates && pc.queuedCandidates.length) {
            for (const candidate of pc.queuedCandidates) {
              await pc
                .addIceCandidate(candidate)
                .catch((e) =>
                  console.error(
                    "Erro ao adicionar ICE candidate from queue:",
                    e
                  )
                );
            }
            pc.queuedCandidates = [];
          }
        }
      } catch (err) {
        appLog.error("Erro ao processar oferta:", err);
      }
    });

    socket.on("answer", async (data) => {
      try {
        const pc = peerConnections[data.peerId];
        if (!pc) return;

        appLog.info(
          `Recebida resposta de ${data.peerId}, estado: ${pc.signalingState}`
        );

        // Verificar se a conexão está em um estado apropriado para receber uma resposta
        if (pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));

          // Processar candidatos ICE enfileirados, se houver
          if (pc.queuedCandidates && pc.queuedCandidates.length) {
            appLog.info(
              `Processando ${pc.queuedCandidates.length} candidatos ICE após resposta`
            );
            for (const candidate of pc.queuedCandidates) {
              await pc
                .addIceCandidate(candidate)
                .catch((e) =>
                  console.error(
                    "Erro ao adicionar ICE candidate from queue:",
                    e
                  )
                );
            }
            pc.queuedCandidates = [];
          }
        } else {
          appLog.warn(
            `Não é possível definir resposta no estado: ${pc.signalingState}`
          );
        }
      } catch (e) {
        appLog.error("Erro ao processar resposta:", e);
      }
    });

    socket.on("peer-disconnect", (data) => {
      if (peerConnections[data.peerId]) {
        peerConnections[data.peerId].close();
        delete peerConnections[data.peerId];
        delete dataChannels[data.peerId];
      }
    });

    socket.on("receive-message", (messageObj) => {
      // Verificar se a mensagem foi enviada por este usuário (evitar duplicação)
      if (messageObj.sender !== socket.id) {
        addMessageToChat(messageObj);
      }
    });

    socket.on("message-history", (data) => {
      appLog.info("Recebido histórico de mensagens:", data.messages);

      // Limpar mensagens existentes para evitar duplicação
      chat.innerHTML = "";

      // Adicionar cada mensagem do histórico ao chat
      if (data.messages && data.messages.length > 0) {
        data.messages.forEach((msg) => {
          addMessageToChat(msg);
        });

        // Rolar para a última mensagem
        chat.scrollTop = chat.scrollHeight;
      }
    });

    socket.on("file-history", (data) => {
      appLog.info("Recebido histórico de arquivos:", data.files);

      // Adicionar cada arquivo do histórico à lista
      if (data.files && data.files.length > 0) {
        data.files.forEach((fileInfo) => {
          addFileToList(fileInfo);
        });
      }
    });

    socket.on("new-file-record", (fileRecord) => {
      appLog.info("Novo arquivo compartilhado: " + JSON.stringify(fileRecord));

      // Verificar se o arquivo foi compartilhado por este usuário (evitar duplicação)
      if (fileRecord.sharedBy !== socket.id) {
        addFileToList(fileRecord);
      }
    });

    socket.on("file-expired", (data) => {
      handleFileExpired(data.fileName);
    });

    // Adicionar listener para quando um arquivo é removido por outros usuários
    socket.on("file-removed", (data) => {
      const { fileId, fileName } = data;
      appLog.info(
        `Recebido evento file-removed para arquivo: ${fileName} (${fileId})`
      );

      // Encontrar o elemento do arquivo
      const fileElement = document.getElementById(`file-${fileId}`);
      if (fileElement) {
        // Verificar se a remoção foi iniciada localmente
        // Se já estiver marcado como sendo removido, não mostra notificação
        const isLocalRemoval = fileElement.classList.contains("file-removing");

        // Adicionar animação se ainda não foi aplicada
        if (!isLocalRemoval) {
          fileElement.classList.add("file-removing");

          // Mostrar notificação sobre a remoção apenas para ações de outros usuários
          showNotification(
            `O arquivo "${fileName}" foi removido por outro usuário`
          );
        }

        // Remover após a animação
        setTimeout(() => {
          fileElement.remove();

          // Verificar se a lista está vazia
          checkEmptyFilesList();
        }, 500);
      }
    });
  }

  function createPeerConnection(peerId, polite) {
    const pc = new RTCPeerConnection(configuration);

    // Definir flags para negociação perfeita
    pc.polite = polite || false; // Se true, este peer aceita ofertas mesmo em caso de colisão
    pc.makingOffer = false;
    pc.ignoreOffer = false;
    pc.queuedCandidates = []; // Inicializar array para candidatos ICE enfileirados
    pc.isConnected = false; // Flag para rastrear se a conexão foi estabelecida

    // Configurar canal de dados
    try {
      const dataChannel = pc.createDataChannel("fileTransfer", {
        ordered: true,
      });
      configureDataChannel(dataChannel, peerId);
    } catch (e) {
      appLog.warn("Erro ao criar canal de dados:", e);
    }

    pc.ondatachannel = (event) => {
      configureDataChannel(event.channel, peerId);
    };

    // Monitorar estado da conexão
    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === "connected" ||
        pc.iceConnectionState === "completed"
      ) {
        pc.isConnected = true;
        appLog.info(`Conexão estabelecida com ${peerId}`);

        if (pc.queuedCandidates && pc.queuedCandidates.length) {
          for (const candidate of pc.queuedCandidates) {
            pc.addIceCandidate(candidate).catch((e) =>
              appLog.error("Erro ao adicionar ICE candidate from queue:", e)
            );
          }
          pc.queuedCandidates = [];
        }
      }
    };

    // Tratamento dos ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", {
          roomId,
          peerId,
          candidate: event.candidate,
        });
      }
    };

    // Evento de negociação
    pc.onnegotiationneeded = async () => {
      try {
        pc.makingOffer = true;

        if (pc.signalingState === "stable") {
          // console.log(`Criando oferta para ${peerId}`);
          const offer = await pc.createOffer();
          if (pc.signalingState === "stable") {
            await pc.setLocalDescription(offer);
            socket.emit("offer", {
              roomId,
              peerId,
              offer: pc.localDescription,
            });
          }
        } else {
          // console.warn(
          //   `Não é possível criar oferta no estado: ${pc.signalingState}`
          // );
        }
      } catch (err) {
        appLog.error("Erro na negociação:", err);
      } finally {
        pc.makingOffer = false;
      }
    };

    peerConnections[peerId] = pc;
    return pc;
  }

  // Configurar canal de dados
  function configureDataChannel(channel, peerId) {
    dataChannels[peerId] = channel;

    channel.onopen = () => {
      appLog.info(`Canal de dados aberto com ${peerId}`);
    };

    channel.onclose = () => {
      appLog.info(`Canal de dados fechado com ${peerId}`);
    };

    channel.onerror = (error) => {
      appLog.error(`Erro no canal de dados com ${peerId}:`, error);
    };

    channel.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "file-info") {
        // Iniciar recebimento de um novo arquivo
        fileChunks[message.fileId] = [];
        currentFile[message.fileId] = {
          name: message.fileName,
          type: message.fileType,
          size: message.fileSize,
          receivedSize: 0,
        };

        addFileToList(
          message.fileId,
          message.fileName,
          message.fileSize,
          "recebendo"
        );
      } else if (message.type === "file-chunk") {
        // Receber um chunk do arquivo
        const fileId = message.fileId;
        const chunk = new Uint8Array(message.chunk);

        fileChunks[fileId].push(chunk);
        currentFile[fileId].receivedSize += chunk.length;

        // Atualizar progresso
        const progress =
          (currentFile[fileId].receivedSize / currentFile[fileId].size) * 100;
        updateFileProgress(fileId, progress);
      } else if (message.type === "file-complete") {
        // Arquivo completo recebido
        const fileId = message.fileId;

        // Concatenar chunks
        const chunksArray = fileChunks[fileId];
        const totalLength = chunksArray.reduce(
          (acc, val) => acc + val.length,
          0
        );
        const fileData = new Uint8Array(totalLength);

        let offset = 0;
        for (const chunk of chunksArray) {
          fileData.set(chunk, offset);
          offset += chunk.length;
        }

        // Criar blob e link para download
        const blob = new Blob([fileData], {
          type: currentFile[fileId].type,
        });
        updateFileForDownload(fileId, blob, currentFile[fileId].name);

        // Limpar dados
        delete fileChunks[fileId];
        delete currentFile[fileId];
      }
    };
  }

  // Enviar arquivo
  function sendFile(file, fileId) {
    // Adicionar arquivo à lista com status "enviando"
    const fileInfo = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      timestamp: Date.now(),
    };

    addFileToList(fileInfo, "enviando");

    // Enviar informações do arquivo para todos os pares conectados
    for (const peerId in dataChannels) {
      const channel = dataChannels[peerId];

      if (channel.readyState === "open") {
        // Informações do arquivo
        channel.send(
          JSON.stringify({
            type: "file-info",
            fileId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
          })
        );

        // Ler e enviar o arquivo em chunks
        const chunkSize = 16384; // 16KB
        const reader = new FileReader();
        let offset = 0;

        reader.onload = (event) => {
          if (channel.readyState === "open") {
            const chunk = new Uint8Array(event.target.result);

            channel.send(
              JSON.stringify({
                type: "file-chunk",
                fileId,
                chunk: Array.from(chunk),
              })
            );

            offset += chunk.length;
            const progress = (offset / file.size) * 100;
            updateFileProgress(fileId, progress);

            if (offset < file.size) {
              readSlice(offset);
            } else {
              channel.send(
                JSON.stringify({
                  type: "file-complete",
                  fileId,
                })
              );

              const blob = new Blob([file], { type: file.type });
              updateFileForDownload(fileId, blob, file.name);
            }
          }
        };

        const readSlice = (o) => {
          const slice = file.slice(o, o + chunkSize);
          reader.readAsArrayBuffer(slice);
        };

        readSlice(0);
      }
    }
  }

  // Adicionar arquivo à lista
  function addFileToList(fileInfo, status) {
    appLog.info("Adicionando arquivo à lista: " + JSON.stringify(fileInfo));

    // Se o fileInfo não tem id ou nome, não processar
    if (!fileInfo || !fileInfo.id || !fileInfo.name) {
      appLog.error(
        "Tentativa de adicionar arquivo inválido: " + JSON.stringify(fileInfo)
      );
      return;
    }

    // Verificar se o arquivo já está na lista (evitar duplicação)
    if (document.getElementById(`file-${fileInfo.id}`)) {
      appLog.info(`Arquivo ${fileInfo.id} já existe na lista, ignorando.`);
      return;
    }

    // Garantir que o container de arquivos esteja visível
    filesList.style.display = "block";

    // Remover estado vazio se existir
    const emptyState = document.getElementById("emptyState");
    if (emptyState) {
      emptyState.style.display = "none";
    }

    const fileElement = document.createElement("div");
    fileElement.id = `file-${fileInfo.id}`;
    fileElement.className = "file-item";

    // Adicionar o botão de remoção apenas para arquivos não expirados
    const isComplete = status === "complete" || fileInfo.url;
    const progressHtml =
      status === "uploading"
        ? `<div class="progress-container">
           <div class="progress">
             <div class="progress-bar" style="width: 0%" id="progress-${fileInfo.id}"></div>
           </div>
         </div>`
        : `<div class="progress-container"></div>`;

    // Data de upload formatada
    const date = new Date(fileInfo.uploadedAt || Date.now());
    const dateString = date.toLocaleDateString();
    const timeString = date.toLocaleTimeString();

    fileElement.innerHTML = `
      <div class="file-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512">
          <path d="M0 64C0 28.7 28.7 0 64 0H224V128c0 17.7 14.3 32 32 32H384V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V64zm384 64H256V0L384 128z"/>
        </svg>
      </div>
      <div class="file-details">
        <div class="file-name">${fileInfo.name}</div>
        <div class="file-meta">
          <span class="file-size">${formatBytes(fileInfo.size)}</span>
          <span class="file-date">${dateString} ${timeString}</span>
        </div>
        ${progressHtml}
      </div>
      <div class="file-actions" id="buttons-${fileInfo.id}">
        ${
          isComplete && fileInfo.url
            ? `
          <a href="${fileInfo.url}" class="download-btn" target="_blank" download>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
              <path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32V274.7l-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7V32zM64 352c-35.3 0-64 28.7-64 64v32c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V416c0-35.3-28.7-64-64-64H346.5l-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352H64zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/>
            </svg>
          </a>
          <button class="remove-btn" onclick="removeFile('${fileInfo.id}', '${fileInfo.name}')">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512">
              <path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"/>
            </svg>
          </button>
        `
            : ""
        }
      </div>
    `;

    filesContainer.appendChild(fileElement);
    filesContainer.style.display = "block";

    filesList.style.display = "block";

    fileElement.setAttribute("data-filename", fileInfo.name);

    // Verificar se o arquivo está expirado
    if (
      fileInfo.isExpired ||
      (fileInfo.expiresAt && fileInfo.expiresAt < Date.now())
    ) {
      // Marcar como expirado
      fileElement.classList.add("file-expired");

      // Riscar o nome do arquivo
      const fileName = fileElement.querySelector(".file-name");
      if (fileName) {
        fileName.classList.add("file-name-expired");
      }

      // Substituir o ícone por um de expirado
      const fileIcon = fileElement.querySelector(".file-icon");
      if (fileIcon) {
        fileIcon.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
            <path d="M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/>
          </svg>
        `;
      }

      // Atualizar o container de progresso
      const progressContainer = fileElement.querySelector(
        ".progress-container"
      );
      if (progressContainer) {
        progressContainer.innerHTML = ""; // Container vazio, sem texto de expiração
      }

      // Desabilitar o botão de download
      const downloadBtn = fileElement.querySelector(".download-btn");
      if (downloadBtn) {
        downloadBtn.classList.add("disabled");
        downloadBtn.setAttribute("disabled", "disabled");
        downloadBtn.style.pointerEvents = "none";
        downloadBtn.title = "Arquivo expirado";
      }
    } else if (fileInfo.expiresAt) {
      // Continuar com o código existente para arquivos não expirados...
      const progressContainer = fileElement.querySelector(
        ".progress-container"
      );
      if (progressContainer) {
        progressContainer.innerHTML += `
          <span class="file-countdown" data-expires="${fileInfo.expiresAt}">
            Expira em: ${formatRemainingTime(fileInfo.expiresAt)}
          </span>`;

        // Iniciar o contador para este arquivo
        startFileCountdown(fileInfo.id, fileInfo.expiresAt);
      }
    }

    return fileElement;
  }

  // Atualizar progresso do arquivo
  function updateFileProgress(fileId, progress) {
    const progressElement = document.getElementById(`progress-${fileId}`);
    if (progressElement) {
      progressElement.style.width = `${progress}%`;

      // Adicionar classe de animação durante o carregamento
      if (progress < 100) {
        progressElement.classList.add("loading");
        progressElement.classList.remove("complete");
      } else {
        progressElement.classList.remove("loading");
        progressElement.classList.add("complete");

        // Encontrar e atualizar o texto de progresso
        const progressText = progressElement.parentElement.nextElementSibling;
        if (progressText && progressText.classList.contains("progress-text")) {
          progressText.textContent = "Finalizado!";

          // Atualizar o container inteiro se necessário
          setTimeout(() => {
            const fileElement = document.getElementById(`file-${fileId}`);
            if (fileElement) {
              const progressContainer = fileElement.querySelector(
                ".progress-container"
              );
              if (progressContainer) {
                progressContainer.innerHTML = `<span class="status-complete">Pronto para download</span>`;
              }
            }
          }, 1000); // Aguarda 1 segundo antes de atualizar para "Pronto para download"
        }
      }
    }
  }

  // Atualizar arquivo para download
  function updateFileForDownload(fileId, blob, fileName) {
    // Verificar se os parâmetros são válidos
    if (!fileId || !blob || !fileName) {
      appLog.error("Parâmetros inválidos para updateFileForDownload:", {
        fileId,
        blob,
        fileName,
      });
      return;
    }

    // Atualizar progresso para 100%
    updateFileProgress(fileId, 100);

    const fileUrl = URL.createObjectURL(blob);

    // Criar registro do arquivo para persistência
    const fileInfo = {
      id: fileId,
      name: fileName,
      size: blob.size,
      url: fileUrl,
      timestamp: Date.now(),
    };

    let fileElement = document.getElementById(`file-${fileId}`);

    // Se não existir, criar um novo
    if (!fileElement) {
      fileElement = addFileToList(fileInfo, "complete");
    } else {
      // Detectar se é dispositivo móvel
      const isMobile = /Mobi|Android/i.test(navigator.userAgent);

      // Atualizar o botão de download
      const buttonsContainer = document.getElementById(`buttons-${fileId}`);
      if (buttonsContainer) {
        if (isMobile) {
          buttonsContainer.innerHTML = `
            <a href="javascript:void(0)" onclick="window.open('${fileUrl}', '_blank')" class="download-btn">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                <path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32V274.7l-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7V32zM64 352c-35.3 0-64 28.7-64 64v32c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V416c0-35.3-28.7-64-64-64H346.5l-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352H64zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/>
              </svg>
            </a>
            <button class="remove-btn" onclick="removeFile('${fileId}', '${fileName}')">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512">
                <path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"/>
              </svg>
            </button>
          `;
        } else {
          buttonsContainer.innerHTML = `
            <a href="${fileUrl}" class="download-btn" target="_blank" download>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
                <path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32V274.7l-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7V32zM64 352c-35.3 0-64 28.7-64 64v32c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V416c0-35.3-28.7-64-64-64H346.5l-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352H64zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/>
              </svg>
            </a>
            <button class="remove-btn" onclick="removeFile('${fileId}', '${fileName}')">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512">
                <path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"/>
              </svg>
            </button>
          `;
        }
      }

      // Atualizar informações do status
      const fileElement = document.getElementById(`file-${fileId}`);
      if (fileElement) {
        const progressContainer = fileElement.querySelector(
          ".progress-container"
        );
        if (progressContainer) {
          progressContainer.innerHTML = `<span class="status-complete">Pronto para download</span>`;

          // Iniciar o contador em segundo plano
          startHiddenCountdown(fileId, fileInfo.expiresAt);
        }
      }
    }

    const formData = new FormData();
    formData.append("file", blob, fileName);

    // Modifique a parte do fetch para lidar com o erro de tamanho
    fetch("/upload", {
      method: "POST",
      body: formData,
    })
      .then((response) => {
        if (!response.ok) {
          return response.json().then((data) => {
            throw new Error(data.message || "Erro ao fazer upload do arquivo");
          });
        }
        return response.json();
      })
      .then((data) => {
        if (data && data.url) {
          appLog.info(
            `Arquivo ${fileName} enviado com sucesso para ${data.url}`
          );

          // Notificar o servidor sobre o arquivo
          socket.emit("file-shared", {
            roomId: roomId,
            fileInfo: {
              id: fileId,
              name: fileName,
              size: blob.size,
              url: data.url,
              timestamp: Date.now(),
              expiresAt: data.expiresAt, // Novo campo com timestamp de expiração
            },
          });

          // Chamar a função que finaliza a configuração do elemento
          handleFileUploadComplete(fileId, data.url, fileName, data.expiresAt);
        }
      })
      .catch((error) => {
        appLog.error("Erro ao fazer upload do arquivo:", error);

        // Mostrar erro ao usuário
        Swal.fire({
          icon: "error",
          title: "Erro no upload",
          text: error.message || "Não foi possível fazer o upload do arquivo.",
          background: "#0a0e17",
          color: "#ffffff",
          confirmButtonColor: "#6441a5",
        });

        // Atualizar o elemento do arquivo para mostrar o erro
        const fileElement = document.getElementById(`file-${fileId}`);
        if (fileElement) {
          const progressContainer = fileElement.querySelector(
            ".progress-container"
          );
          if (progressContainer) {
            progressContainer.innerHTML = `<span class="status-error">Erro no upload</span>`;
          }
        }
      });
  }

  // Formatar tamanho do arquivo
  function formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    statusDiv.style.display = "block";

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 5000);
  }

  // Função para converter URLs em links clicáveis
  function formatMessageWithLinks(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, function (url) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
    });
  }

  // Eventos
  createRoomBtn.addEventListener("click", () => {
    if (socket) {
      socket.emit("create-room");
    } else {
      alert("Erro: Socket não está conectado.");
    }
  });

  sendMessageBtn.addEventListener("click", () => {
    const messageInput = document.getElementById("message");
    const text = messageInput.value.trim();

    // Verificar se o campo de mensagem está vazio
    if (!text) {
      Swal.fire({
        icon: "warning",
        title: "Atenção!",
        text: "Por favor, digite uma mensagem antes de enviar.",
        confirmButtonColor: "#6441a5",
        background: "#0a0e17",
        color: "#ffffff",
      });
      return;
    }

    // Criar timestamp e messageId para a mensagem
    const timestamp = Date.now();
    const messageId = uuidv4();

    // Criar objeto de mensagem completo com ID persistente
    const messageObj = {
      sender: socket.id,
      text: text,
      timestamp: timestamp,
      id: messageId,
      persistentUserId: persistentUserId, // Adicionar ID persistente
    };

    // Enviar mensagem com ID persistente
    socket.emit("send-message", {
      roomId: roomId,
      message: text,
      timestamp: timestamp,
      id: messageId,
      persistentUserId: persistentUserId, // Adicionar ID persistente
    });

    // Adicionar a mensagem ao chat local
    addMessageToChat(messageObj);

    // Limpar o campo de mensagem
    messageInput.value = "";

    // Focar no campo para digitar nova mensagem
    messageInput.focus();
  });

  joinRoomBtn.addEventListener("click", () => {
    const roomCode = roomInput.value.trim();
    if (roomCode) {
      socket.emit("join-room", { roomId: roomCode });
    } else {
      Swal.fire({
        icon: "warning",
        title: "Atenção!",
        text: "Por favor, digite o código da sala antes de entrar.",
        background: "#0a0e17",
        color: "#ffffff",
        confirmButtonColor: "#6441a5",
      });
    }
  });

  fileInput.addEventListener("change", (e) => {
    const files = e.target.files;
    if (!files.length) return;

    [...files].forEach((file) => {
      // Verificar o tamanho do arquivo
      if (file.size > MAX_FILE_SIZE) {
        Swal.fire({
          icon: "error",
          title: "Arquivo muito grande",
          text: `O arquivo "${file.name}" excede o limite de 50MB permitido.`,
          background: "#0a0e17",
          color: "#ffffff",
          confirmButtonColor: "#6441a5",
        });
        return; // Não continuar com este arquivo
      }

      // Criar um ID único para o arquivo
      const fileId = uuidv4();

      // Processar e enviar o arquivo
      sendFile(file, fileId);

      // Iniciar a barra de progresso em 10% só pelo inicio do processo
      updateFileProgress(fileId, 10);

      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append("file", file);

      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          const progress = 10 + (event.loaded / event.total) * 80;
          updateFileProgress(fileId, progress);
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status === 200) {
          try {
            const response = JSON.parse(xhr.responseText);
            if (response && response.url) {
              updateFileProgress(fileId, 95);

              socket.emit("file-shared", {
                roomId: roomId,
                fileInfo: {
                  id: fileId,
                  name: file.name,
                  size: file.size,
                  url: response.url,
                  timestamp: Date.now(),
                  expiresAt: response.expiresAt,
                },
              });

              // Finalizar completamente após um pequeno atraso
              setTimeout(() => {
                handleFileUploadComplete(
                  fileId,
                  response.url,
                  file.name,
                  response.expiresAt
                );
              }, 500);
            }
          } catch (error) {
            appLog.error("Erro ao processar resposta do upload:", error);
          }
        }
      });

      // Abrir e enviar a requisição
      xhr.open("POST", "/upload");
      xhr.send(formData);
    });

    // Limpar a seleção de arquivos
    fileInput.value = "";
  });

  // Permite entrar na sala com a tecla Enter
  document.getElementById("roomInput").addEventListener("keyup", function (e) {
    if (e.key === "Enter") {
      document.getElementById("joinRoom").click();
    }
  });

  // Permite enviar mensagem com a tecla Enter
  document.getElementById("message").addEventListener("keyup", function (e) {
    if (e.key === "Enter") {
      document.getElementById("sendMessage").click();
    }
  });

  // Iniciar Socket
  initSocket();

  // Verificar parâmetros na URL e localStorage
  // Prioridade: parâmetros URL > localStorage
  checkRoomParam();
  // Se não houver parâmetro de URL, verificar localStorage
  if (!new URLSearchParams(window.location.search).get("room")) {
    checkLocalStorageRoom();
  }

  // Depois das funções checkRoomParam e initSocket, adicionaremos funções de persistência
  function checkLocalStorageRoom() {
    const savedRoom = localStorage.getItem("quickShareRoomId");
    if (savedRoom) {
      // Preencher o campo com o código salvo
      roomInput.value = savedRoom;

      // Entrar na sala automaticamente após um pequeno delay
      setTimeout(() => {
        joinRoomBtn.click();
      }, 500);
    }
  }

  function saveRoomToLocalStorage(roomCode) {
    localStorage.setItem("quickShareRoomId", roomCode);
  }

  function removeRoomFromLocalStorage() {
    localStorage.removeItem("quickShareRoomId");
  }

  // Adicionar botão de sair na função que mostra a sala (após entrar ou criar)
  function setupLeaveButton() {
    // Verificar se o botão já existe para não duplicar
    if (!document.getElementById("leaveRoomBtn")) {
      const leaveRoomBtn = document.createElement("button");
      leaveRoomBtn.id = "leaveRoomBtn";
      leaveRoomBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path d="M5 11H13V13H5V16L0 12L5 8V11ZM3.99939 16H6.99939V18H16.9994C17.5517 18 17.9994 17.5523 17.9994 17V7C17.9994 6.44772 17.5517 6 16.9994 6H6.99939V8H3.99939V5C3.99939 3.89543 4.89482 3 5.99939 3H17.9994C19.104 3 19.9994 3.89543 19.9994 5V19C19.9994 20.1046 19.104 21 17.9994 21H5.99939C4.89482 21 3.99939 20.1046 3.99939 19V16Z"/>
        </svg>
        <span>Sair</span>
      `;

      // Adicionar o botão após o título da sala
      const roomInfo = document.querySelector(".room-info");
      roomInfo.appendChild(leaveRoomBtn);

      // Adicionar evento de clique
      leaveRoomBtn.addEventListener("click", () => {
        removeRoomFromLocalStorage();

        // Mostrar alerta de confirmação
        Swal.fire({
          icon: "success",
          title: "Você saiu da sala",
          text: "A sala foi removida do seu dispositivo.",
          background: "#0a0e17",
          color: "#ffffff",
          confirmButtonColor: "#6441a5",
          timer: 3000,
          timerProgressBar: true,
        }).then(() => {
          // Redirecionar para a página inicial
          window.location.href = window.location.origin;
        });
      });
    }
  }

  // Função para adicionar mensagem ao chat
  function addMessageToChat(message) {
    appLog.info("Adicionando mensagem ao chat:", message);

    // Garantir que o container do chat esteja visível
    document.querySelector(".card-chat").style.display = "block";

    // Usar o ID persistente em vez do socket.id para determinar se a mensagem é sua
    const isMyMessage =
      message.persistentUserId === persistentUserId ||
      message.sender === socket.id;

    const messageElement = document.createElement("div");
    messageElement.className = isMyMessage
      ? "message message-sent"
      : "message message-received";

    // Formatar data/hora
    const messageDate = new Date(message.timestamp);
    const timeString = messageDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Processar links no texto
    const messageText = formatMessageWithLinks(message.text);

    messageElement.innerHTML = `
      <div class="message-content">
        <div class="message-text">${messageText}</div>
        <div class="message-time">${timeString}</div>
      </div>
    `;

    chat.appendChild(messageElement);
    chat.scrollTop = chat.scrollHeight;
  }

  // Adicione esta função antes do final do arquivo
  function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  function handleFileUploadComplete(fileId, fileUrl, fileName, expiresAt) {
    appLog.info(`Upload completo para arquivo: ${fileName} (${fileId})`);

    // Atualizar progresso para 100%
    updateFileProgress(fileId, 100);

    // Atualizar os botões
    const buttonsContainer = document.getElementById(`buttons-${fileId}`);
    if (buttonsContainer) {
      const isMobile = /Mobi|Android/i.test(navigator.userAgent);

      if (isMobile) {
        buttonsContainer.innerHTML = `
          <a href="javascript:void(0)" onclick="window.open('${fileUrl}', '_blank')" class="download-btn">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
              <path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32V274.7l-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7V32zM64 352c-35.3 0-64 28.7-64 64v32c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V416c0-35.3-28.7-64-64-64H346.5l-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352H64zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/>
            </svg>
          </a>
          <button class="remove-btn" onclick="removeFile('${fileId}', '${fileName}')">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512">
              <path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"/>
            </svg>
          </button>
        `;
      } else {
        buttonsContainer.innerHTML = `
          <a href="${fileUrl}" class="download-btn" target="_blank" download>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
              <path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32V274.7l-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7V32zM64 352c-35.3 0-64 28.7-64 64v32c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V416c0-35.3-28.7-64-64-64H346.5l-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352H64zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z"/>
            </svg>
          </a>
          <button class="remove-btn" onclick="removeFile('${fileId}', '${fileName}')">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512">
              <path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"/>
            </svg>
          </button>
        `;
      }
    }

    // Atualizar informações do status
    const fileElement = document.getElementById(`file-${fileId}`);
    if (fileElement) {
      const progressContainer = fileElement.querySelector(
        ".progress-container"
      );
      if (progressContainer) {
        progressContainer.innerHTML = `<span class="status-complete">Pronto para download</span>`;

        // Iniciar o contador em segundo plano, sem mostrar na interface
        startHiddenCountdown(fileId, expiresAt);
      }
    }
  }

  // Adicionar função de formatação do tempo restante
  function formatRemainingTime(expiresAt) {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) return "Expirado";

    const minutes = Math.floor(remainingMs / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  // Adicionar função para iniciar contador regressivo para um arquivo
  function startFileCountdown(fileId, expiresAt) {
    const countdownInterval = setInterval(() => {
      const remainingTime = expiresAt - Date.now();

      if (remainingTime <= 0) {
        clearInterval(countdownInterval);

        // Simular evento de expiração para este arquivo específico
        const fileElement = document.getElementById(`file-${fileId}`);
        if (fileElement) {
          const fileName = fileElement.getAttribute("data-filename");
          if (fileName) {
            handleFileExpired(fileName);
          }
        }
      }
    }, 1000);
  }

  // Adicionar função para centralizar o tratamento de arquivos expirados
  function handleFileExpired(fileName) {
    appLog.info(`Arquivo expirado: ${fileName}`);

    const fileElements = document.querySelectorAll(
      `.file-item[data-filename="${fileName}"]`
    );

    fileElements.forEach((element) => {
      // Marcar como expirado
      element.classList.add("file-expired");

      // Riscar o nome do arquivo
      const fileNameElement = element.querySelector(".file-name");
      if (fileNameElement) {
        fileNameElement.classList.add("file-name-expired");
      }

      // Substituir o ícone
      const fileIcon = element.querySelector(".file-icon");
      if (fileIcon) {
        fileIcon.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
            <path d="M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/>
          </svg>
        `;
      }

      // Limpar o container de progresso (sem adicionar a mensagem de expiração)
      const progressContainer = element.querySelector(".progress-container");
      if (progressContainer) {
        progressContainer.innerHTML = ""; // Container vazio, sem texto de expiração
      }

      // Desabilitar download
      const downloadBtn = element.querySelector(".download-btn");
      if (downloadBtn) {
        downloadBtn.classList.add("disabled");
        downloadBtn.setAttribute("disabled", "disabled");
        downloadBtn.style.pointerEvents = "none";
        downloadBtn.title = "Arquivo expirado";
      }
    });
  }

  // Adicionar uma função para contador oculto
  function startHiddenCountdown(fileId, expiresAt) {
    const countdownInterval = setInterval(() => {
      const remainingTime = expiresAt - Date.now();

      if (remainingTime <= 0) {
        clearInterval(countdownInterval);

        // Simular evento de expiração para este arquivo específico
        const fileElement = document.getElementById(`file-${fileId}`);
        if (fileElement) {
          const fileName = fileElement.getAttribute("data-filename");
          if (fileName) {
            handleFileExpired(fileName);
          }
        }
      }
    }, 1000);
  }

  // Adicionar função para remover arquivo
  function removeFileInternal(fileId, fileName) {
    appLog.info(`Removendo arquivo: ${fileName} (${fileId})`);

    const fileElement = document.getElementById(`file-${fileId}`);
    if (fileElement) {
      // Adicionar classe de animação
      fileElement.classList.add("file-removing");

      // Remover após a animação terminar
      setTimeout(() => {
        // Remover completamente o elemento da DOM
        if (fileElement.parentNode) {
          fileElement.parentNode.removeChild(fileElement);
        }

        // Verificar se a lista está vazia usando a função centralizada
        checkEmptyFilesList();
      }, 500); // Tempo correspondente à duração da animação CSS
    }

    socket.emit("file-remove-request", {
      roomId: roomId,
      fileId: fileId,
      fileName: fileName,
    });

    // Notificar o usuário com uma mensagem de sucesso (verde)
    showNotification("Arquivo removido com sucesso", true);
  }

  // Adicionar ouvinte para o evento personalizado
  document.addEventListener("remove-file", (e) => {
    const { fileId, fileName } = e.detail;
    removeFileInternal(fileId, fileName);
  });

  // Função auxiliar para verificar se a lista está vazia
  function checkEmptyFilesList() {
    const filesContainer = document.getElementById("filesContainer");
    const filesList = document.getElementById("filesList");
    const emptyState = document.getElementById("emptyState");

    if (filesContainer && filesList && emptyState) {
      // Contar apenas arquivos visíveis (não sendo removidos e não expirados)
      const visibleFiles = filesContainer.querySelectorAll(
        ".file-item:not(.file-removing):not(.file-expired)"
      );

      appLog.info(
        `Verificando lista de arquivos: ${visibleFiles.length} arquivos visíveis`
      );

      if (visibleFiles.length === 0) {
        // Mostrar mensagem de "nenhum arquivo"
        emptyState.style.display = "flex";
        // Ocultar a lista de arquivos
        filesList.style.display = "none";
      } else {
        // Ocultar mensagem de "nenhum arquivo"
        emptyState.style.display = "none";
        // Mostrar a lista de arquivos
        filesList.style.display = "block";
      }
    }
  }

  // Adicionar função para mostrar notificação
  function showNotification(message, isSuccess = false) {
    const Toast = Swal.mixin({
      toast: true,
      position: "bottom-end",
      showConfirmButton: false,
      timer: 3000,
      timerProgressBar: true,
      background: "#0a0e17",
      color: "#ffffff",
      iconColor: isSuccess ? "#28a745" : "#6441a5", // Verde para sucesso, roxo para informação
    });

    Toast.fire({
      icon: isSuccess ? "success" : "info",
      title: message,
    });
  }
});
