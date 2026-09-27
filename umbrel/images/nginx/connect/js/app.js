/* Connect UI for the Umbrel Dojo app.
 *
 * Every request below is same-origin: nginx (connect.conf) proxies the Dojo
 * endpoints this page needs to the node container, so the page works whether
 * it was opened over the LAN or through Umbrel's Tor hidden service, and never
 * needs CORS.
 *
 * Status comes from two separate Dojo services:
 *   /v2/status/         accounts  -- uptime, memory, websocket clients,
 *                                   indexed block height, indexer state
 *   /v2/pushtx/status/  pushtx    -- the Bitcoin node's own figures, and
 *                                   how many transactions have been broadcast
 * Both require the admin profile, which the JWT below provides.
 */
(function () {
	"use strict";

	var REFRESH_MS = 10000;

	var isTestnet = conf.network === "testnet";
	var apiBase = isTestnet ? "/test/v2" : "/v2";
	var notSet =
		!conf.dojoHiddenService || conf.dojoHiddenService.indexOf("notyetset") === 0;

	var endpoints = {
		tor: notSet ? null : "http://" + conf.dojoHiddenService + apiBase,
		lan: "http://" + conf.deviceDomainName + ":" + conf.dojoApiPort + apiBase
	};

	var state = { mode: "tor", pairing: null, token: null };

	function el(id) {
		return document.getElementById(id);
	}

	function text(id, value) {
		el(id).textContent = value === null || value === undefined || value === "" ? "—" : value;
	}

	function dot(id, kind) {
		el(id).className = "dot dot--" + kind;
	}

	function setPill(kind, label) {
		var pill = el("status-pill");
		pill.className = "pill pill--" + kind;
		pill.textContent = label;
	}

	function number(value) {
		return typeof value === "number" && value >= 0 ? value.toLocaleString() : null;
	}

	/* Bitcoin Core reports its version as a single integer, 290000 = 29.0.0. */
	function coreVersion(value) {
		if (typeof value !== "number" || value <= 0) return null;
		var major = Math.floor(value / 10000);
		var minor = Math.floor(value / 100) % 100;
		var patch = value % 100;
		return major + "." + minor + (patch ? "." + patch : "");
	}

	/* relayfee is BTC per kvB; wallets think in sat/vB. */
	function relayFee(value) {
		if (typeof value !== "number" || value <= 0) return null;
		var satPerVbyte = (value * 1e8) / 1000;
		return satPerVbyte.toFixed(satPerVbyte < 1 ? 2 : 1) + " sat/vB";
	}

	var INDEXER_LABELS = {
		local_indexer: "Electrum server",
		local_bitcoind: "Bitcoin node",
		third_party_explorer: "Third party"
	};

	/* ---------------------------------------------------------------- status */

	function renderStatus(accounts, pushtx) {
		var bitcoind = (pushtx && pushtx.bitcoind) || null;
		var indexer = (accounts && accounts.indexer) || {};
		var indexedBlock = accounts ? accounts.blocks : null;
		var nodeBlock = bitcoind && bitcoind.blocks >= 0 ? bitcoind.blocks : null;

		// Bitcoin node
		if (bitcoind && bitcoind.up) {
			dot("dot-bitcoind", "ok");
			text("btc-version", coreVersion(bitcoind.version));
			text("btc-peers", number(bitcoind.conn));
			text("btc-network", bitcoind.testnet ? "testnet" : "mainnet");
			text("btc-relayfee", relayFee(bitcoind.relayfee));
		} else {
			dot("dot-bitcoind", pushtx ? "err" : "idle");
		}

		// Tracker
		text("trk-block", number(indexedBlock));
		text("trk-node-block", number(nodeBlock));
		text("trk-uptime", accounts && accounts.uptime);
		text("trk-memory", accounts && accounts.memory);
		dot("dot-tracker", accounts ? "ok" : "idle");

		// Electrum server
		text("idx-type", INDEXER_LABELS[indexer.type] || indexer.type);
		text("idx-tip", number(indexer.maxHeight));
		if (accounts) {
			var indexerUp = indexer.maxHeight !== null && indexer.maxHeight !== undefined;
			dot("dot-indexer", indexerUp ? "ok" : "warn");
			el("idx-note").hidden = indexerUp;
			if (!indexerUp) {
				el("idx-note").textContent =
					"Not reachable. Wallet imports and rescans need it; everything else keeps working.";
			}
		}

		// Activity
		if (accounts && accounts.ws) text("act-clients", number(accounts.ws.clients));
		if (pushtx && pushtx.push) {
			text("act-pushed", number(pushtx.push.count));
			text("act-amount", pushtx.push.amount ? pushtx.push.amount + " BTC" : "0 BTC");
			dot("dot-activity", "ok");
		}

		renderSync(indexedBlock, nodeBlock);
	}

	function renderSync(indexedBlock, nodeBlock) {
		var meter = el("sync-meter");

		if (indexedBlock === null || indexedBlock === undefined) {
			text("sync-height", null);
			el("sync-note").textContent = "Waiting for Dojo…";
			meter.hidden = true;
			return;
		}

		text("sync-height", "Block " + number(indexedBlock));

		if (nodeBlock === null) {
			text("sync-detail", null);
			el("sync-note").textContent = "Indexed by your Dojo.";
			meter.hidden = true;
			setPill("ok", "Running");
			return;
		}

		var behind = nodeBlock - indexedBlock;
		text("sync-detail", "node at " + number(nodeBlock));

		if (behind > 1) {
			meter.hidden = false;
			el("sync-fill").style.width =
				Math.max(2, Math.min(100, (indexedBlock / nodeBlock) * 100)) + "%";
			el("sync-note").textContent =
				behind.toLocaleString() + " block" + (behind === 1 ? "" : "s") + " behind your node.";
			setPill("pending", "Syncing");
		} else {
			meter.hidden = true;
			el("sync-note").textContent = "Up to date with your node.";
			setPill("ok", "Running");
		}
	}

	/* --------------------------------------------------------------- pairing */

	function renderQr(payload) {
		var target = el("qr");
		target.innerHTML = "";
		if (!payload) {
			var note = document.createElement("div");
			note.className = "qr-placeholder";
			note.textContent = "Unavailable";
			target.appendChild(note);
			return;
		}
		target.innerHTML = new QRCode({
			content: payload,
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
				"This Dojo does not have a Tor address yet. Enable Tor for this app in " +
				"Umbrel, or pair over the local network instead.";
			el("endpoint").value = "";
			el("pairing-json").textContent = "—";
			renderQr(null);
			return;
		}

		hint.textContent =
			state.mode === "tor"
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
		el("pairing-json").textContent = JSON.stringify(payload, null, 2);
		renderQr(JSON.stringify(payload));
	}

	/* ----------------------------------------------------------------- wiring */

	function bindCopyAndReveal() {
		document.querySelectorAll("[data-copy]").forEach(function (button) {
			button.addEventListener("click", function () {
				var input = el(button.getAttribute("data-copy"));
				if (!input.value) return;
				var restore = button.textContent;
				var done = function () {
					button.textContent = "Copied";
					setTimeout(function () {
						button.textContent = restore;
					}, 1500);
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
			.then(function (data) {
				return data.authorizations.access_token;
			});
	}

	function authedGet(path) {
		return fetch(apiBase + path, {
			headers: { Authorization: "Bearer " + state.token }
		}).then(function (response) {
			if (!response.ok) throw new Error(path + " failed: " + response.status);
			return response.json();
		});
	}

	// A failure here is usually a service still starting, so keep the last
	// good values on screen rather than blanking the page.
	function refresh() {
		return Promise.all([
			authedGet("/status/").catch(function () { return null; }),
			authedGet("/pushtx/status/").catch(function () { return null; })
		]).then(function (results) {
			if (!results[0] && !results[1]) {
				setPill("err", "Not reachable");
				return;
			}
			renderStatus(results[0], results[1]);
		});
	}

	/* ------------------------------------------------------------------- init */

	el("dojo-version").textContent = conf.dojoVersion || "—";
	el("network-name").textContent = isTestnet ? "testnet" : "mainnet";
	el("admin-key").value = conf.adminKey;
	el("dmt-link").setAttribute(
		"href",
		"http://" + conf.deviceDomainName + ":" + conf.dojoApiPort + "/admin/"
	);
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
			state.token = token;
			return Promise.all([
				authedGet("/" + conf.supportPrefix + "/pairing"),
				refresh()
			]);
		})
		.then(function (results) {
			state.pairing = results[0];
			renderPairing();
			setInterval(refresh, REFRESH_MS);
		})
		.catch(function (error) {
			setPill("err", "Not reachable");
			el("sync-note").textContent =
				"Could not reach the Dojo API (" + error.message + "). It may still be " +
				"starting up — check the app logs in Umbrel if this persists.";
			console.error(error);
		});
})();
