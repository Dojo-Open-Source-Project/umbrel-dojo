/* Connect UI for the Umbrel Dojo app.
 *
 * Every request below is same-origin: nginx (connect.conf) proxies the three
 * Dojo endpoints this page needs to the node container, so the page works
 * whether it was opened over the LAN or through Umbrel's Tor hidden service,
 * and never needs CORS.
 */
(function () {
  "use strict";

  var isTestnet = conf.network === "testnet";
  var apiBase = isTestnet ? "/test/v2" : "/v2";
  var notSet = !conf.dojoHiddenService || conf.dojoHiddenService.indexOf("notyetset") === 0;

  var endpoints = {
    tor: notSet ? null : "http://" + conf.dojoHiddenService + apiBase,
    lan: "http://" + conf.deviceDomainName + ":" + conf.dojoApiPort + apiBase
  };

  var state = { mode: "tor", pairing: null };

  var el = function (id) { return document.getElementById(id); };

  function setPill(cls, text) {
    var pill = el("status-pill");
    pill.className = "pill pill--" + cls;
    pill.textContent = text;
  }

  function renderQr(text) {
    var target = el("qr");
    target.innerHTML = "";
    if (!text) {
      var note = document.createElement("div");
      note.className = "qr-placeholder";
      note.textContent = "Unavailable";
      target.appendChild(note);
      return;
    }
    target.innerHTML = new QRCode({
      content: text,
      join: true,
      container: "svg-viewbox",
      padding: 2,
      color: "#000000",
      background: "#ffffff",
      ecl: "M"
    }).svg();
  }

  function renderPairing() {
    var url = endpoints[state.mode];
    var hint = el("pairing-hint");

    if (state.mode === "tor" && notSet) {
      hint.textContent =
        "This Dojo does not have a Tor address yet. Enable Tor for this app in Umbrel, " +
        "or pair over the local network instead.";
      el("endpoint").value = "";
      el("pairing-json").textContent = "—";
      renderQr(null);
      return;
    }

    hint.textContent = state.mode === "tor"
      ? "Tor works from anywhere and keeps the connection private. Your wallet needs Tor enabled."
      : "Only works while your wallet is on the same network as this Umbrel, and the traffic is not encrypted.";

    el("endpoint").value = url;

    if (!state.pairing) {
      el("pairing-json").textContent = "—";
      renderQr(null);
      return;
    }

    var payload = JSON.parse(JSON.stringify(state.pairing));
    payload.pairing.url = url;
    var json = JSON.stringify(payload);
    el("pairing-json").textContent = JSON.stringify(payload, null, 2);
    renderQr(json);
  }

  function applyStatus(status) {
    el("stat-blocks").textContent = status.blocks == null ? "—" : String(status.blocks);
    el("stat-uptime").textContent = status.uptime || "—";

    var indexer = status.indexer || {};
    el("stat-tip").textContent = indexer.maxHeight == null ? "—" : String(indexer.maxHeight);
    el("stat-indexer").textContent = ({
      local_indexer: "Electrum server",
      local_bitcoind: "Bitcoin Node",
      third_party_explorer: "Third party"
    })[indexer.type] || indexer.type || "—";

    var behind = indexer.maxHeight != null && status.blocks != null
      ? indexer.maxHeight - status.blocks
      : null;

    if (behind !== null && behind > 2) {
      setPill("pending", "Syncing · " + behind + " blocks behind");
    } else {
      setPill("ok", "Running");
    }
  }

  function bindCopyAndReveal() {
    document.querySelectorAll("[data-copy]").forEach(function (button) {
      button.addEventListener("click", function () {
        var input = el(button.getAttribute("data-copy"));
        if (!input.value) return;
        var restore = button.textContent;
        var done = function () {
          button.textContent = "Copied";
          setTimeout(function () { button.textContent = restore; }, 1500);
        };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(input.value).then(done);
        } else {
          var wasHidden = input.type === "password";
          input.type = "text";
          input.select();
          document.execCommand("copy");
          if (wasHidden) input.type = "password";
          done();
        }
      });
    });

    document.querySelectorAll("[data-reveal]").forEach(function (button) {
      button.addEventListener("click", function () {
        var input = el(button.getAttribute("data-reveal"));
        var hidden = input.type === "password";
        input.type = hidden ? "text" : "password";
        button.textContent = hidden ? "Hide" : "Show";
      });
    });
  }

  function bindTabs() {
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (other) {
          var active = other === tab;
          other.classList.toggle("is-active", active);
          other.setAttribute("aria-selected", String(active));
        });
        state.mode = tab.getAttribute("data-target");
        renderPairing();
      });
    });
  }

  function login() {
    return fetch(apiBase + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "apikey=" + encodeURIComponent(conf.adminKey)
    })
      .then(function (response) {
        if (!response.ok) throw new Error("login failed: " + response.status);
        return response.json();
      })
      .then(function (data) { return data.authorizations.access_token; });
  }

  function authedGet(token, path) {
    return fetch(apiBase + path, {
      headers: { Authorization: "Bearer " + token }
    }).then(function (response) {
      if (!response.ok) throw new Error(path + " failed: " + response.status);
      return response.json();
    });
  }

  // Static values are available before Dojo answers, so paint them first.
  el("dojo-version").textContent = conf.dojoVersion || "—";
  el("network-name").textContent = isTestnet ? "testnet" : "mainnet";
  el("admin-key").value = conf.adminKey;
  el("dmt-link").setAttribute("href", "http://" + conf.deviceDomainName + ":" + conf.dojoApiPort + "/admin/");
  bindCopyAndReveal();
  bindTabs();
  if (notSet) {
    state.mode = "lan";
    var lanTab = document.querySelector('.tab[data-target="lan"]');
    if (lanTab) lanTab.click();
  }
  renderPairing();

  login()
    .then(function (token) {
      return Promise.all([
        authedGet(token, "/" + conf.supportPrefix + "/pairing"),
        authedGet(token, "/status/").catch(function () { return null; })
      ]);
    })
    .then(function (results) {
      state.pairing = results[0];
      renderPairing();
      if (results[1]) applyStatus(results[1]);
      else setPill("ok", "Running");
    })
    .catch(function (error) {
      setPill("err", "Not reachable");
      el("pairing-hint").textContent =
        "Could not reach the Dojo API (" + error.message + "). It may still be starting up — " +
        "check the app logs in Umbrel if this persists.";
      console.error(error);
    });
})();
