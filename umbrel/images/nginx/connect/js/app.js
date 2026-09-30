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

	var state = { onion: null, endpoint: null, pairing: null, token: null };

	// Static: no onion needed, so this is available immediately and stays valid.
	var lanEndpoint =
		"http://" + conf.deviceDomainName + ":" + conf.dojoApiPort + apiBase;

	/* Tor is the only pairing address offered. A wallet stores one URL, so a
	 * LAN-paired wallet would simply stop working the moment it left the house
	 * -- silently, and long after the mistake was made.
	 *
	 * The address cannot come from conf.js alone: exports.sh resolves it before
	 * any container exists, so on a first install it is always notyetset.onion
	 * and the container's environment can never be updated. nginx serves the
	 * real file at /onion, which pollOnion() picks up, so the page fills itself
	 * in as soon as Tor publishes -- no restart, no reload.
	 */
	function setOnion(value) {
		var onion = (value || "").trim();
		if (!onion || onion.indexOf("notyetset") === 0) onion = null;
		if (onion === state.onion) return false;

		state.onion = onion;
		state.endpoint = onion ? "http://" + onion + apiBase : null;
		return true;
	}

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

		dot("dot-bitcoind", bitcoind ? (bitcoind.up ? "ok" : "err") : "idle");
		dot("dot-tracker", accounts ? "ok" : "err");
		dot(
			"dot-indexer",
			accounts ? (indexer.maxHeight === null || indexer.maxHeight === undefined ? "warn" : "ok") : "idle"
		);
		dot("dot-tor", state.onion ? "ok" : "warn");

		renderSync(indexedBlock, nodeBlock);
	}

	function renderSync(indexedBlock, nodeBlock) {
		var meter = el("sync-meter");

		if (indexedBlock === null || indexedBlock === undefined) {
			text("sync-height", null);
			el("sync-note").textContent = "Waiting for Dojo\u2026";
			meter.hidden = true;
			return;
		}

		if (nodeBlock === null) {
			text("sync-height", "Block " + number(indexedBlock));
			el("sync-note").textContent = "Indexed by your Dojo.";
			meter.hidden = true;
			setPill("ok", "Running");
			return;
		}

		var behind = nodeBlock - indexedBlock;

		if (behind > 1) {
			text("sync-height", number(behind) + " blocks behind");
			meter.hidden = false;
			el("sync-fill").style.width =
				Math.max(2, Math.min(100, (indexedBlock / nodeBlock) * 100)) + "%";
			el("sync-note").textContent =
				"Catching up \u2014 block " + number(indexedBlock) + " of " + number(nodeBlock) + ".";
			setPill("pending", "Syncing");
		} else {
			text("sync-height", "At the chain tip");
			meter.hidden = true;
			el("sync-note").textContent = "Block " + number(nodeBlock) + ".";
			setPill("ok", "Running");
		}
	}

	/* --------------------------------------------------------------- pairing */

	function renderQr(id, payload) {
		var target = el(id);
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

	/* The Maintenance Tool is served over the hidden service too: torrc points
	 * the onion at nginx:8080, which serves the same site config as the
	 * published API port, so /admin/ resolves there already.
	 *
	 * Like the pairing address this cannot be built at load time -- the onion
	 * arrives asynchronously -- so the link stays disabled until it does.
	 * An anchor has no real disabled state; dropping href is what actually
	 * stops it navigating, and the attribute drives .btn[disabled] styling.
	 */
	function renderDmt() {
		var link = el("dmt-link");
		var note = el("dmt-note");

		if (!state.onion) {
			link.removeAttribute("href");
			link.setAttribute("disabled", "");
			link.setAttribute("aria-disabled", "true");
			note.textContent =
				"Available once Tor has published this Dojo's address.";
			return;
		}

		link.setAttribute("href", "http://" + state.onion + "/admin/");
		link.removeAttribute("disabled");
		link.removeAttribute("aria-disabled");
		note.textContent =
			"Opens over Tor, so it needs Tor Browser — an .onion address will not " +
			"load in an ordinary browser.";
	}

	/* Build the payload the wallet scans: the server's response with our own
	 * endpoint injected, since /support/pairing does not supply a URL.
	 */
	function payloadFor(url) {
		if (!state.pairing || !url) return null;
		var payload = JSON.parse(JSON.stringify(state.pairing));
		payload.pairing.url = url;
		return payload;
	}

	/* The local-network endpoint is static -- it needs no onion -- so it is the
	 * one thing that still works during a cold first boot. It is deliberately
	 * behind a closed <details>: a wallet stores a single address, so pairing
	 * this way produces a wallet that works at home and quietly stops working
	 * anywhere else. Offered, not suggested.
	 */
	function renderLanPairing() {
		var payload = payloadFor(lanEndpoint);
		el("endpoint-lan").value = lanEndpoint;
		renderQr("qr-lan", payload && JSON.stringify(payload));
	}

	function renderPairing() {
		var url = state.endpoint;
		var hint = el("pairing-hint");

		renderDmt();
		renderLanPairing();

		if (!url) {
			hint.textContent =
				"Tor is still publishing this Dojo's address. This usually takes " +
				"under a minute on a first start; the code will appear here on its " +
				"own, so there is nothing to do but wait.";
			el("endpoint").value = "";
			el("pairing-json").textContent = "—";
			renderQr("qr", null);
			return;
		}

		hint.textContent =
			"This is your Dojo's Tor address. It works from anywhere, not just at " +
			"home, and keeps the connection private. Your wallet needs Tor enabled.";

		el("endpoint").value = url;

		var payload = payloadFor(url);
		if (!payload) {
			el("pairing-json").textContent = "—";
			renderQr("qr", null);
			return;
		}

		el("pairing-json").textContent = JSON.stringify(payload, null, 2);
		renderQr("qr", JSON.stringify(payload));
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

	/* Served by nginx straight off the Tor volume. 404 means Tor has not
	 * published yet, which is a normal first-boot state, not an error.
	 */
	function pollOnion() {
		return fetch("/onion", { cache: "no-store" })
			.then(function (response) {
				return response.ok ? response.text() : "";
			})
			.catch(function () {
				return "";
			})
			.then(function (value) {
				if (setOnion(value)) renderPairing();
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

	/* Dojo's admin access token is short-lived -- NODE_JWT_ACCESS_EXPIRES, 15
	 * minutes in our compose -- and the page authenticates once at load. Without
	 * renewal, leaving the tab open past that quietly breaks everything: both
	 * status calls 401, refresh() sees two failures and bails out early, so the
	 * pill reads "Not reachable" while the block height sits frozen at whatever
	 * it last saw, looking current. Only a reload recovers it.
	 *
	 * We hold the admin key, so re-authenticating costs nothing and is
	 * invisible. Retry once only: a 401 immediately after a fresh login is a
	 * real authorization failure, not an expiry, and retrying it would loop.
	 */
	function authedFetch(url, retried) {
		return fetch(url, {
			headers: { Authorization: "Bearer " + state.token }
		}).then(function (response) {
			if (response.status !== 401 || retried) return response;
			return login().then(function (token) {
				state.token = token;
				return authedFetch(url, true);
			});
		});
	}

	function authedGet(path) {
		return authedFetch(apiBase + path).then(function (response) {
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


	/* ----------------------------------------------------------------- tools */

	function notice(id, message, kind) {
		var node = el(id);
		if (!message) {
			node.hidden = true;
			return;
		}
		node.hidden = false;
		node.className = "notice" + (kind ? " notice--" + kind : "");
		node.textContent = message;
	}

	// Dojo answers errors with a JSON body rather than a plain status, so read
	// the body before deciding what to tell the user.
	function readError(response) {
		return response
			.json()
			.catch(function () {
				return null;
			})
			.then(function (body) {
				var detail = body && (body.error || body.message || body.status);
				if (typeof detail === "object") detail = JSON.stringify(detail);
				throw new Error(detail || "request failed (" + response.status + ")");
			});
	}

	function supportGet(path) {
		return authedFetch(apiBase + "/" + conf.supportPrefix + path).then(
			function (response) {
				if (!response.ok) return readError(response);
				return response.json();
			}
		);
	}

	function sats(value) {
		if (typeof value !== "number") return null;
		return (value / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") + " BTC";
	}

	function lookupXpub() {
		var xpub = el("xpub-input").value.trim();
		if (!xpub) return;
		notice("xpub-error", "Looking up\u2026", "busy");

		supportGet("/xpub/" + encodeURIComponent(xpub) + "/info")
			.then(function (info) {
				notice("xpub-error", null);
				el("xpub-result").hidden = false;
				text("xpub-tracked", info.tracked ? "Yes" : "No — this Dojo has never seen it");
				text("xpub-balance", sats(info.balance));
				text("xpub-ntx", number(info.n_tx));
				text("xpub-derivation", info.derivation);
				text(
					"xpub-derived",
					info.derived ? info.derived.external + " receive / " + info.derived.internal + " change" : null
				);
				text(
					"xpub-unused",
					info.unused ? info.unused.external + " receive / " + info.unused.internal + " change" : null
				);
			})
			.catch(function (error) {
				el("xpub-result").hidden = true;
				notice("xpub-error", error.message);
			});
	}

	function rescanXpub() {
		var xpub = el("xpub-input").value.trim();
		if (!xpub) return;
		var gap = el("rescan-gap").value || "0";
		var start = el("rescan-start").value || "0";
		var button = el("xpub-rescan");

		button.disabled = true;
		notice("rescan-note", "Rescanning. This can take several minutes — leave the page open.", "busy");

		supportGet(
			"/xpub/" + encodeURIComponent(xpub) + "/rescan?gap=" + encodeURIComponent(gap) +
				"&startidx=" + encodeURIComponent(start)
		)
			.then(function (result) {
				notice("rescan-note", result.status || "Rescan complete", "ok");
				lookupXpub();
			})
			.catch(function (error) {
				notice("rescan-note", error.message);
			})
			.then(function () {
				button.disabled = false;
			});
	}

	function lookupAddress() {
		var address = el("addr-input").value.trim();
		if (!address) return;
		notice("addr-error", "Looking up\u2026", "busy");

		supportGet("/address/" + encodeURIComponent(address) + "/info")
			.then(function (info) {
				notice("addr-error", null);
				el("addr-result").hidden = false;
				text("addr-tracked", info.tracked ? "Yes" : "No — not tracked by this Dojo");
				text("addr-balance", sats(info.balance));
				text("addr-ntx", number(info.n_tx));
				text("addr-utxo", info.utxo ? number(info.utxo.length) : null);
				text("addr-xpub", info.xpub || "—");
				text("addr-path", info.path || "—");
			})
			.catch(function (error) {
				el("addr-result").hidden = true;
				notice("addr-error", error.message);
			});
	}

	function bindTools() {
		el("xpub-lookup").addEventListener("click", lookupXpub);
		el("xpub-rescan").addEventListener("click", rescanXpub);
		el("addr-lookup").addEventListener("click", lookupAddress);

		[["xpub-input", lookupXpub], ["addr-input", lookupAddress]].forEach(function (pair) {
			el(pair[0]).addEventListener("keydown", function (event) {
				if (event.key === "Enter") pair[1]();
			});
		});
	}

	/* ------------------------------------------------------------------- init */

	el("dojo-version").textContent = conf.dojoVersion || "—";
	// conf.chain is the chain the Bitcoin Node is actually on. Dojo collapses
	// testnet3, testnet4 and signet into one "testnet", so prefer the real name
	// here -- otherwise a signet user is told they are on testnet.
	el("network-name").textContent =
		conf.chain || (isTestnet ? "testnet" : "mainnet");
	el("admin-key").value = conf.adminKey;
	bindCopyAndReveal();
	bindTools();

	// conf.js is right whenever exports.sh happened to run after Tor had
	// published, which is every start but the first. /onion corrects it when it
	// was not.
	setOnion(conf.dojoHiddenService);
	renderPairing();

	// Polled on its own timer rather than inside refresh(): refresh() only
	// starts once login() resolves, and login() is precisely what fails while
	// the node is still booting -- the same cold start during which Tor has not
	// published yet. Stops itself once the address is in.
	if (!state.onion) {
		var onionTimer = setInterval(function () {
			pollOnion().then(function () {
				if (state.onion) clearInterval(onionTimer);
			});
		}, REFRESH_MS);
		pollOnion().then(function () {
			if (state.onion) clearInterval(onionTimer);
		});
	}

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
