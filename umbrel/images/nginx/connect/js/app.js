/* Connect UI for the Umbrel Dojo app.
 *
 * Every request below is same-origin: nginx (connect.conf) proxies the Dojo
 * endpoints this page needs to the node container, so the page works whether
 * it was opened over the LAN or through Umbrel's Tor hidden service, and never
 * needs CORS.
 *
 * Status comes from two separate Dojo services:
 *   /v2/status/         accounts  -- uptime, websocket clients, indexed block
 *                                   height, indexer state
 *   /v2/pushtx/status/  pushtx    -- the Bitcoin node's own figures, and
 *                                   how many transactions have been broadcast
 * Both require the admin profile, which the JWT below provides.
 */
(function () {
	"use strict";

	var REFRESH_MS = 10000;

	var isTestnet = conf.network === "testnet";
	var apiBase = isTestnet ? "/test/v2" : "/v2";

	/* Extended keys are the only thing with a recognisable prefix, so the
	 * lookup routes on that and treats everything else as an address.
	 * Deliberately not trial-and-error: a bech32 address is alphanumeric and
	 * would sail through validateArgsGetXpubInfo's isAlphanumeric check, so
	 * "try the xpub route and see if it fails" is not reliable. The uppercase
	 * variants (Ypub, Zpub, Vpub, Upub) are the multisig forms.
	 */
	var EXT_KEY = /^(x|y|z|v|t|u)pub/i;

	var state = { onion: null, endpoint: null, pairing: null, token: null };

	// Static: no onion needed, so this is available immediately and stays valid.
	var lanEndpoint =
		"http://" + conf.deviceDomainName + ":" + conf.dojoApiPort + apiBase;

	/* The address cannot come from conf.js alone: exports.sh resolves it before
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

	function number(value) {
		return typeof value === "number" && value >= 0 ? value.toLocaleString() : null;
	}

	function sats(value) {
		if (typeof value !== "number") return null;
		return (value / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") + " BTC";
	}

	/* ---------------------------------------------------------------- status */

	/* A service is a lamp and nothing else. The state is not drawn anywhere,
	 * so it goes on the lamp as its accessible name -- without that a screen
	 * reader gets five dots and no way to tell them apart. */
	function svc(id, kind, state) {
		var node = el("svc-" + id);
		node.className = "dot" + (kind ? " dot--" + kind : "");
		node.setAttribute("aria-label", state);
	}

	function renderStatus(accounts, pushtx) {
		/* The two status endpoints do not answer in the same shape. pushtx goes
		 * through HttpServer.sendOkData, which wraps its payload as
		 * {status, data}; accounts goes through sendRawData and returns the
		 * object bare. Reading pushtx.bitcoind therefore found undefined, the
		 * lamp went red and the node height was lost -- on a Dojo that was
		 * working perfectly.
		 *
		 * Accept either, rather than reaching straight for .data: the two
		 * endpoints already disagree, and tolerating both costs one expression.
		 */
		var figures = (pushtx && pushtx.data) || pushtx;
		var bitcoind = (figures && figures.bitcoind) || null;
		var indexer = (accounts && accounts.indexer) || {};
		var indexedBlock = accounts ? accounts.blocks : null;
		var nodeBlock = bitcoind && bitcoind.blocks >= 0 ? bitcoind.blocks : null;

		/* Three outcomes, not two. A null payload means the pushtx call itself
		 * did not come back -- which is routine rather than alarming: pushtx
		 * waits for Soroban's RPC before it opens port 8081, and Soroban
		 * bootstraps its own Tor first, so nginx answers 502 for the first
		 * half-minute of every start.
		 *
		 * Reporting that as a red "Unavailable" asserts the Bitcoin node is
		 * down, which this page cannot see from here and which is usually
		 * false. "Unknown" is what we actually know. The red is kept for the
		 * case that genuinely earns it: pushtx answered and said up: false.
		 */

		svc(
			"bitcoind",
			bitcoind ? (bitcoind.up ? "ok" : "err") : "warn",
			bitcoind ? (bitcoind.up ? "Healthy" : "Unavailable") : "Unknown"
		);

		if (!accounts) {
			svc("indexer", "idle", "Unknown");
		} else if (indexer.maxHeight === null || indexer.maxHeight === undefined) {
			svc("indexer", "warn", "Starting");
		} else {
			svc("indexer", "ok", "Healthy");
		}

		svc("tor", state.onion ? "ok" : "warn", state.onion ? "Healthy" : "Starting");

		el("tor-alert").hidden = !!state.onion;

		renderChain(accounts, indexedBlock, nodeBlock);
	}

	/* The band. One statement of where the tracker is, the counts under it, and
	 * a progress bar only when there is progress to show.
	 */
	function renderChain(accounts, indexedBlock, nodeBlock) {
		var meter = el("sync-meter");

		text("uptime-note", accounts && accounts.uptime ? "Running for " + accounts.uptime : "Starting up");

		if (indexedBlock === null || indexedBlock === undefined) {
			text("chain-headline", "Starting up");
			text("chain-counts", "Waiting for Dojo to report a block height.");
			meter.hidden = true;
			svc("tracker", "warn", "Starting");
			return;
		}

		if (nodeBlock === null) {
			text("chain-headline", "Block " + number(indexedBlock));
			text("chain-counts", "Indexed by your Dojo.");
			meter.hidden = true;
			svc("tracker", "ok", "Healthy");
			return;
		}

		var behind = nodeBlock - indexedBlock;

		if (behind > 1) {
			var pct = Math.max(0, Math.min(100, (indexedBlock / nodeBlock) * 100));
			text("chain-headline", "Syncing " + pct.toFixed(1) + "%");
			text("chain-counts", number(indexedBlock) + " of " + number(nodeBlock) + " blocks");
			meter.hidden = false;
			el("sync-fill").style.width = Math.max(2, pct) + "%";
			text("sync-pct", number(behind) + " blocks to go");
			svc("tracker", "warn", "Syncing");
		} else {
			text("chain-headline", "At the chain tip");
			text("chain-counts", number(nodeBlock) + " of " + number(nodeBlock) + " blocks");
			meter.hidden = true;
			svc("tracker", "ok", "Healthy");
		}
	}

	function unreachable(detail) {
		text("uptime-note", "Not reachable");
		text("chain-headline", "Not reachable");
		text("chain-counts", detail);
		el("sync-meter").hidden = true;
		// Same reasoning as the bitcoind lamp above: if Dojo's API is not
		// answering, the state of the things behind it is unknown, not known to
		// be bad. The headline already says "Not reachable" in words, which is
		// where the alarm belongs.
		["bitcoind", "indexer", "tracker"].forEach(function (id) {
			svc(id, "warn", "Unknown");
		});
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
	 *
	 * It is also why the Pair wallet button is never disabled while Tor is
	 * still publishing: that is exactly the window in which this is the only
	 * way to pair, so hiding the panel would hide the one path that works.
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
				"own. Until then you can pair over your local network, below.";
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

	function openPair(on) {
		var panel = el("pair-panel");
		panel.hidden = !on;
		el("pair-toggle").setAttribute("aria-expanded", String(on));
		if (on) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
				if (setOnion(value)) {
					renderPairing();
					svc("tor", state.onion ? "ok" : "warn", state.onion ? "Healthy" : "Starting");
					el("tor-alert").hidden = !!state.onion;
				}
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
	 * page reads "Not reachable" while the block height sits frozen at whatever
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
				unreachable("Neither Dojo service answered. It may still be starting.");
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

	function unwrap(response) {
		if (!response.ok) return readError(response);
		return response.json();
	}

	function supportGet(path) {
		return authedFetch(apiBase + "/" + conf.supportPrefix + path).then(unwrap);
	}

	// The tracker is a separate service on its own port; connect.conf proxies
	// its rescan route the same way the main site config proxies /v2/tracker/.
	function trackerGet(path) {
		return authedFetch(apiBase + "/tracker/" + conf.supportPrefix + path).then(unwrap);
	}

	function row(term, value, mono) {
		var wrap = document.createElement("div");
		var dt = document.createElement("dt");
		var dd = document.createElement("dd");
		dt.textContent = term;
		dd.textContent = value === null || value === undefined || value === "" ? "—" : value;
		if (mono) dd.className = "mono";
		wrap.appendChild(dt);
		wrap.appendChild(dd);
		return wrap;
	}

	function pair(counts) {
		if (!counts) return null;
		return counts.external + " receive / " + counts.internal + " change";
	}

	/* One input, one result. The derivation detail fills the space beside the
	 * figures rather than hiding behind a disclosure, and the whole block stays
	 * absent until something has actually been looked up.
	 */
	function lookup() {
		var value = el("lookup-input").value.trim();
		if (!value) return;

		var isKey = EXT_KEY.test(value);
		notice("lookup-error", "Looking up…", "busy");

		supportGet(
			(isKey ? "/xpub/" : "/address/") + encodeURIComponent(value) + "/info"
		)
			.then(function (info) {
				notice("lookup-error", null);
				el("lookup-result").hidden = false;
				text("result-title", info.tracked ? "Tracked by this Dojo" : "Not tracked by this Dojo");
				text("result-said", value);
				text("result-balance", sats(info.balance));
				text("result-ntx", number(info.n_tx));

				var meta = el("result-meta");
				meta.innerHTML = "";
				if (isKey) {
					meta.appendChild(row("Derivation path", info.derivation, true));
					meta.appendChild(row("Addresses derived", pair(info.derived)));
					meta.appendChild(row("First unused", pair(info.unused)));
				} else {
					meta.appendChild(row("Unspent outputs", info.utxo ? number(info.utxo.length) : null));
					meta.appendChild(row("Belongs to", info.xpub, true));
					meta.appendChild(row("Path", info.path, true));
				}
			})
			.catch(function (error) {
				el("lookup-result").hidden = true;
				notice("lookup-error", error.message);
			});
	}

	function rescan() {
		var value = el("rescan-target").value.trim();
		if (!value) return;

		var isKey = EXT_KEY.test(value);
		var button = el("rescan-run");
		var path;

		if (isKey) {
			path =
				"/xpub/" + encodeURIComponent(value) + "/rescan" +
				"?gap=" + encodeURIComponent(el("rescan-gap").value || "0") +
				"&startidx=" + encodeURIComponent(el("rescan-start").value || "0");
		} else {
			// The address route takes no lookahead arguments; the two fields
			// above apply to extended keys only.
			path = "/address/" + encodeURIComponent(value) + "/rescan";
		}

		button.disabled = true;
		notice("rescan-note", "Rescanning. This can take several minutes — leave the page open.", "busy");

		supportGet(path)
			.then(function (result) {
				notice("rescan-note", result.status || "Rescan complete", "ok");
			})
			.catch(function (error) {
				notice("rescan-note", error.message);
			})
			.then(function () {
				button.disabled = false;
			});
	}

	function rescanBlocks() {
		var from = el("blocks-from").value.trim();
		var to = el("blocks-to").value.trim();
		if (!from) {
			notice("blocks-note", "Enter the block to start from.");
			return;
		}

		var button = el("blocks-run");
		button.disabled = true;
		notice("blocks-note", "Rescanning blocks. This can take a long while — leave the page open.", "busy");

		trackerGet(
			"/rescan?fromHeight=" + encodeURIComponent(from) +
				(to ? "&toHeight=" + encodeURIComponent(to) : "")
		)
			.then(function (result) {
				notice("blocks-note", result.status || "Rescan complete", "ok");
			})
			.catch(function (error) {
				notice("blocks-note", error.message);
			})
			.then(function () {
				button.disabled = false;
			});
	}

	function bindTools() {
		el("lookup-btn").addEventListener("click", lookup);
		el("lookup-input").addEventListener("keydown", function (event) {
			if (event.key === "Enter") lookup();
		});

		// Carry the identifier across rather than making the user paste it
		// twice, and open the section so the prefilled field is visible.
		el("result-rescan").addEventListener("click", function () {
			var box = el("maint");
			box.open = true;
			el("rescan-target").value = el("lookup-input").value.trim();
			box.scrollIntoView({ block: "nearest", behavior: "smooth" });
			el("rescan-target").focus();
		});

		el("rescan-run").addEventListener("click", rescan);
		el("blocks-run").addEventListener("click", rescanBlocks);
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

	el("pair-toggle").addEventListener("click", function () {
		openPair(el("pair-panel").hidden);
	});
	el("pair-toggle-2").addEventListener("click", function () {
		openPair(true);
	});

	// conf.js is right whenever exports.sh happened to run after Tor had
	// published, which is every start but the first. /onion corrects it when it
	// was not.
	setOnion(conf.dojoHiddenService);
	renderPairing();
	el("tor-alert").hidden = !!state.onion;

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
			unreachable(
				"Could not reach the Dojo API (" + error.message + "). It may still " +
					"be starting up — check the app logs in Umbrel if this persists."
			);
			console.error(error);
		});
})();
