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

	/* keys  -- the api_keys table, as Dojo reports it
	 * showing -- which key the open pairing code belongs to; null means the
	 *            key Umbrel derived into the container environment, which is
	 *            not in that table and cannot be revoked.
	 */
	var state = {
		onion: null, endpoint: null, pairing: null, token: null,
		keys: [], showing: null, indexedTip: null
	};

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
		if (indexedBlock !== null && indexedBlock !== undefined) {
			var first = state.indexedTip === null || state.indexedTip === undefined;
			state.indexedTip = indexedBlock;
			// The range hint quotes the tip, so give it one the first time a tip
			// is known rather than waiting for the user to type.
			if (first) blockRange(false);
		}
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

		/* Green only when the Electrum server is actually caught up. A server
		 * that answers but lags the node is still catching up, and wallets
		 * asking it for recent history get stale answers -- so amber, against
		 * the node height when there is one to compare with. Two blocks of
		 * slack, because the two are polled at slightly different moments.
		 */
		if (!accounts) {
			svc("indexer", "idle", "Unknown");
		} else if (indexer.maxHeight === null || indexer.maxHeight === undefined) {
			svc("indexer", "warn", "Starting");
		} else if (nodeBlock !== null && nodeBlock - indexer.maxHeight > 2) {
			svc("indexer", "warn", "Syncing");
		} else {
			svc("indexer", "ok", "Healthy");
		}

		svc("tor", state.onion ? "ok" : "warn", state.onion ? "Healthy" : "Starting");

		/* Soroban, where its health can honestly be derived.
		 *
		 * pushtx/index.js:30-34 awaits sorobanUtil.waitForSorobanRpcApi() before
		 * httpServer.start(), but only when PandoTx push is active. So while push
		 * is on, pushtx answering at all proves Soroban's RPC is up -- that is a
		 * real signal, not an inference about the container.
		 *
		 * With push off nothing waits on Soroban, so pushtx answering proves
		 * nothing about it, and the lamp goes back to reporting configuration:
		 * enabled, health unknown. /support/services only ever says whether the
		 * RPC is configured, which is why this is the only route to a green lamp.
		 */
		if (on(conf.pandoTxPush)) {
			svc("soroban", figures ? "ok" : "warn", figures ? "Healthy" : "Unknown");
		} else {
			svc("soroban", "idle", "Enabled");
		}

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
		/* /support/pairing always answers with keys.auth.strategies.localApiKey
		 * .apiKeys[0] -- the single key from the container's environment -- so a
		 * per-wallet key has to be substituted here. authentication-manager.js
		 * accepts either: it checks the configured keys and the active rows of
		 * api_keys, which is what makes revoking one wallet possible at all.
		 */
		if (state.showing) payload.pairing.apikey = state.showing.apikey;
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
		renderExplorer(payload.explorer);
	}

	/* Which block explorer the paired wallet will open transactions in.
	 *
	 * Three cases, and the middle one is the common one. Your own Mempool needs
	 * Tor switched on in umbrelOS -- not the default -- and Dojo reads the
	 * address at startup, so it takes a restart too. Until both have happened
	 * hooks/pre-start supplies mempool.space's onion instead, which is better
	 * than the clearnet explorer a wallet would otherwise fall back to and
	 * worse than your own. Saying which one is in force is the whole point:
	 * otherwise the better option is invisible.
	 *
	 * Told apart by comparison against the same value hooks/pre-start used,
	 * passed through conf.js, rather than a second copy of the onion here.
	 */
	function renderExplorer(explorer) {
		var note = el("explorer-note");
		var url = explorer && explorer.url;

		if (!url) {
			note.textContent =
				"No block explorer is attached, so your wallet will use whichever one " +
				"it ships with.";
			return;
		}

		if (conf.publicExplorer && url.indexOf(conf.publicExplorer) !== -1) {
			note.textContent =
				"Transactions open in mempool.space over Tor. That is private from " +
				"your network, but mempool.space still sees which transactions you " +
				"look at. To use your own Mempool instead, turn on Tor in umbrelOS " +
				"settings and restart Dojo.";
			return;
		}

		note.textContent =
			"Transactions open in your own Mempool, so nobody else sees which ones " +
			"you look at.";
	}

	/* Next block fees, from the estimator Dojo already runs.
	 *
	 * The same four probabilities the home-screen widget shows, so the two
	 * cannot disagree, and the same honest unknown: getEstimatorFees() throws
	 * until bitcoind's mempool is fully loaded and the route answers 503, which
	 * happens on every restart. A dash beats a stale or invented feerate.
	 */
	/* Low / Medium / High at 10% / 50% / 99%, the levels nextblock.is itself
	 * publishes -- the same algorithm Dojo runs, so the vocabulary matches what
	 * people already know. The home-screen widget shows the same three. */
	var FEE_TARGETS = [["0.1", "low"], ["0.5", "med"], ["0.99", "high"]];

	function renderFees(fees) {
		var known = false;
		FEE_TARGETS.forEach(function (pair) {
			var rate = fees ? fees[pair[0]] : null;
			var ok = typeof rate === "number" && isFinite(rate);
			if (ok) known = true;
			text("fee-" + pair[1], ok ? String(rate) : null);
		});
		// Hide the units along with the figures: "— sat/vB" reads as a unit for a
		// number that is not there.
		el("fees").className = "fees" + (known ? "" : " fees--unknown");
		el("fees-note").textContent = known
			? ""
			: "No estimate yet. Dojo works these out from your node's mempool, which " +
				"takes a minute or two after a restart.";
	}

	/* PandoTx, read-only and deliberately so.
	 *
	 * keys.index.js computes these once at module load from the container's
	 * environment, and nothing in Dojo's API can change them, so a switch here
	 * would be decoration. The real controls are the manifest's `environment:`
	 * entries, which umbrelOS renders in this app's settings and applies by
	 * restarting the app.
	 *
	 * The relay condition mirrors keys.index.js:79-84 rather than guessing:
	 * pandoTxProcessActive needs SOROBAN_ANNOUNCE and NODE_PANDOTX_PROCESS both
	 * on, because processing means announcing an inbound hidden service.
	 */
	function on(value) {
		return String(value || "").toLowerCase() === "on";
	}

	function renderPandoTx() {
		var push = on(conf.pandoTxPush);
		var relay = on(conf.sorobanAnnounce) && on(conf.pandoTxProcess);

		el("pandotx-push-pill").className = "pill pill--" + (push ? "ok" : "off");
		el("pandotx-push-pill").textContent = push ? "On" : "Off";
		el("pandotx-push-note").textContent = push
			? "Transactions you broadcast are handed to a random node on the Soroban " +
				"network, so the node that announces yours is not your own."
			: "Transactions you broadcast are announced by your own node, which links " +
				"them to your connection.";

		el("pandotx-relay-pill").className = "pill pill--" + (relay ? "ok" : "off");
		el("pandotx-relay-pill").textContent = relay ? "On" : "Off";
		el("pandotx-relay-note").textContent = relay
			? "This Dojo also relays other people's transactions, and publishes an " +
				"inbound Soroban address to do it."
			: "This Dojo does not relay other people's transactions. Turning it on " +
				"also publishes an inbound Soroban address.";
	}

	function openPair(on) {
		var panel = el("pair-panel");
		el("pair-toggle").setAttribute("aria-expanded", String(on));
		// showModal gives the backdrop, Esc and the focus trap for free. Guarded
		// because calling it on an already-open dialog throws.
		if (on) {
			if (!panel.open) panel.showModal();
		} else if (panel.open) {
			panel.close();
		}
	}

	/* ------------------------------------------------------------------ tabs */

	/* Three panels behind a fixed bottom bar, matching umbrelOS's own apps.
	 *
	 * Driven by location.hash so a reload keeps the tab and a tab is linkable;
	 * the header and footer sit outside the panels, which is what keeps Pair
	 * wallet reachable from everywhere.
	 */
	var TABS = ["home", "tools", "advanced"];

	function showTab(name, focusTab) {
		if (TABS.indexOf(name) === -1) name = "home";

		TABS.forEach(function (tab) {
			var button = el("tab-" + tab);
			var panel = el("panel-" + tab);
			var selected = tab === name;
			button.setAttribute("aria-selected", String(selected));
			// Only the selected tab is in the tab order; the arrows move between
			// them, which is what a tablist is supposed to do.
			if (selected) button.removeAttribute("tabindex");
			else button.setAttribute("tabindex", "-1");
			panel.hidden = !selected;
		});

		if (focusTab) el("tab-" + name).focus();
		if (location.hash !== "#" + name) {
			// replaceState, not assignment: changing location.hash pushes a history
			// entry, so Back would walk the tabs instead of leaving the app.
			if (history.replaceState) history.replaceState(null, "", "#" + name);
			else location.hash = name;
		}
	}

	function bindTabs() {
		TABS.forEach(function (tab, index) {
			var button = el("tab-" + tab);
			button.addEventListener("click", function () {
				showTab(tab);
			});
			button.addEventListener("keydown", function (event) {
				var step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
				if (!step) return;
				event.preventDefault();
				showTab(TABS[(index + step + TABS.length) % TABS.length], true);
			});
		});
	}

	/* ---------------------------------------------------------- wallet keys */

	/* Per-wallet API keys.
	 *
	 * Dojo has had the whole surface since 1.29 and nothing used it: the
	 * api_keys table (db-scripts/2_update.sql) plus GET /support/apikeys, POST
	 * /support/apikey and PATCH/DELETE /support/apikey/:apikey
	 * (accounts/support-rest-api.js). Until now every wallet we paired received
	 * the one key Umbrel derived into the container environment, so losing a
	 * phone meant re-pairing everything or nothing.
	 *
	 * What makes revocation real rather than cosmetic:
	 * lib/db/mysql-db-wrapper.js getActiveApiKeys() filters on
	 * `active = TRUE AND expiresAt > CURRENT_TIMESTAMP`, and
	 * lib/auth/authentication-manager.js accepts a key only if it is in the
	 * configured list or in that filtered set. So revoking or letting a key
	 * lapse genuinely cuts that wallet off.
	 */

	function node(tag, className, content) {
		var element = document.createElement(tag);
		if (className) element.className = className;
		if (content !== undefined && content !== null) element.textContent = content;
		return element;
	}

	function shortDate(value) {
		if (!value) return null;
		var when = Date.parse(value);
		if (isNaN(when)) return null;
		return new Date(when).toLocaleDateString(undefined, {
			year: "numeric", month: "short", day: "numeric"
		});
	}

	/* Three states, and all three are things the table can actually say.
	 * Deliberately not a "last used" column: api_keys records createdAt and
	 * expiresAt and nothing about use, so any "last seen" here would be
	 * invented.
	 */
	function keyState(key) {
		if (!key.active) return { word: "Revoked", pill: "off" };
		var expires = Date.parse(key.expiresAt);
		if (!isNaN(expires) && expires <= Date.now())
			return { word: "Expired", pill: "warn" };
		return { word: "Authorized", pill: "ok" };
	}

	function armConfirm(card, acts, message, label, run) {
		var line = node("div", "confirm", message);
		var bar = node("div", "wcard-acts");
		var yes = node("button", "btn btn--danger btn--sm", label);
		var no = node("button", "btn btn--ghost btn--sm", "Cancel");
		yes.type = "button";
		no.type = "button";

		acts.hidden = true;
		card.appendChild(line);
		card.appendChild(bar);
		bar.appendChild(yes);
		bar.appendChild(no);

		no.addEventListener("click", function () {
			line.hidden = true;
			bar.hidden = true;
			acts.hidden = false;
		});
		yes.addEventListener("click", function () {
			yes.disabled = true;
			no.disabled = true;
			// A success ends in loadKeys(), which rebuilds the list and throws
			// this card away; only a failure has to put the buttons back.
			run().catch(function (error) {
				notice("wallets-error", error.message, "err");
				yes.disabled = false;
				no.disabled = false;
			});
		});
	}

	function walletCard(key) {
		var status = keyState(key);
		var card = node("div", "wcard");
		var top = node("div", "top");
		top.appendChild(node("span", "nm", key.label || "Unnamed"));
		card.appendChild(top);
		card.appendChild(node("span", "pill pill--" + status.pill, status.word));

		var added = shortDate(key.createdAt);
		var expires = shortDate(key.expiresAt);
		card.appendChild(node(
			"div", "meta",
			(added ? "Added " + added : "") +
				(added && expires ? " · " : "") +
				(expires ? (status.word === "Expired" ? "Expired " : "Expires ") + expires : "")
		));

		if (status.word === "Expired") {
			card.appendChild(node(
				"div", "sub",
				"This wallet has stopped syncing. Pair it again to give it a new key."
			));
		}

		var acts = node("div", "wcard-acts");
		card.appendChild(acts);

		// A revoked or expired key's code would pair a wallet that cannot
		// authenticate, so it is not offered.
		if (status.word === "Authorized") {
			var show = node("button", "btn btn--ghost btn--sm", "Show code");
			show.type = "button";
			show.addEventListener("click", function () {
				showKey(key);
			});
			acts.appendChild(show);

			var revoke = node("button", "btn btn--ghost btn--sm", "Revoke");
			revoke.type = "button";
			revoke.addEventListener("click", function () {
				armConfirm(
					card, acts,
					"Cut " + (key.label || "this wallet") + " off now? It stops syncing " +
						"immediately and the row stays here as a record.",
					"Revoke",
					function () { return revokeKey(key); }
				);
			});
			acts.appendChild(revoke);
		}

		var forget = node("button", "btn btn--ghost btn--sm", "Forget");
		forget.type = "button";
		forget.addEventListener("click", function () {
			armConfirm(
				card, acts,
				"Remove this row for good? The wallet is cut off either way; " +
					"forgetting also loses the record that the key existed.",
				"Forget",
				function () { return forgetKey(key); }
			);
		});
		acts.appendChild(forget);

		return card;
	}

	function renderWallets() {
		var host = el("wallet-rows");
		host.innerHTML = "";

		// Starts at one for the environment key, which is not in the table and
		// never expires. Every card on screen is counted under the word its
		// pill shows, so the summary can never disagree with the cards.
		var tally = { Authorized: 1, Expired: 0, Revoked: 0 };
		state.keys.forEach(function (key) {
			var word = keyState(key).word;
			tally[word] = (tally[word] || 0) + 1;
			host.appendChild(walletCard(key));
		});

		el("wallet-count").textContent = Object.keys(tally)
			.filter(function (word) { return tally[word] > 0; })
			.map(function (word) { return tally[word] + " " + word.toLowerCase(); })
			.join(" \u00b7 ");
	}

	function loadKeys() {
		return supportGet("/apikeys")
			.then(function (body) {
				var list = (body && body.data) || body;
				state.keys = Array.isArray(list) ? list.slice() : [];
				// Oldest first, so a newly minted key lands at the end where the
				// user just asked for it.
				state.keys.sort(function (a, b) { return a.apikeyID - b.apikeyID; });
				notice("wallets-error", null);
				renderWallets();
			})
			.catch(function (error) {
				notice(
					"wallets-error",
					"Could not read this Dojo's wallet keys (" + error.message + ").",
					"err"
				);
			});
	}

	function createKey() {
		var name = el("pair-name").value.trim();
		var days = parseInt(el("pair-expiry").value, 10);
		notice("pair-error", null);

		if (!name) {
			notice(
				"pair-error",
				"Give the wallet a name, so you can tell which key to revoke later.",
				"err"
			);
			el("pair-name").focus();
			return Promise.resolve();
		}
		if (!days) days = 3650;

		var expiresAt = new Date(Date.now() + days * 86400000).toISOString();
		var seen = {};
		state.keys.forEach(function (key) { seen[key.apikeyID] = true; });

		el("pair-create").disabled = true;
		return supportSend("POST", "/apikey", { label: name, expiresAt: expiresAt })
			.then(function () {
				return loadKeys();
			})
			.then(function () {
				/* POST answers {status:"ok"} and nothing else -- createApiKey
				 * generates the key with crypto.randomBytes and never returns it --
				 * so the only way to learn what was minted is to re-read the list.
				 *
				 * Matched on apikeyID rather than label: only `apikey` is UNIQUE in
				 * the table, so two wallets may legitimately share a name and
				 * matching on one would hand over the wrong key.
				 */
				var fresh = null;
				state.keys.forEach(function (key) {
					if (!seen[key.apikeyID] && (!fresh || key.apikeyID > fresh.apikeyID)) {
						fresh = key;
					}
				});
				if (!fresh) {
					throw new Error(
						"the key was created but could not be read back; it is in the " +
							"list below"
					);
				}
				showKey(fresh);
			})
			.catch(function (error) {
				notice("pair-error", error.message, "err");
			})
			.then(function () {
				el("pair-create").disabled = false;
			});
	}

	function revokeKey(key) {
		/* PATCH validates label, expiresAt and active and rejects the request if
		 * any is missing, so a revoke has to send the first two back unchanged
		 * rather than only the field it is changing.
		 */
		return supportSend("PATCH", "/apikey/" + encodeURIComponent(key.apikey), {
			label: key.label,
			expiresAt: key.expiresAt,
			active: false
		}).then(loadKeys);
	}

	function forgetKey(key) {
		return supportSend(
			"DELETE", "/apikey/" + encodeURIComponent(key.apikey)
		).then(loadKeys);
	}

	/* The dialog has two faces: name a wallet, or show a code that already
	 * exists. Both entrances open the first; a row's "Show code" opens the
	 * second directly, minting nothing.
	 */
	function showKey(key) {
		state.showing = key || null;
		el("pair-new").hidden = true;
		el("pair-code").hidden = false;
		el("pair-which").textContent = key
			? "Pairing code for " + (key.label || "this wallet") + "."
			: "The default key. Every wallet paired before per-wallet keys existed " +
				"is using this one, and it cannot be revoked from here.";
		renderPairing();
		openPair(true);
	}

	function showNewKeyForm() {
		el("pair-new").hidden = false;
		el("pair-code").hidden = true;
		notice("pair-error", null);
		el("pair-name").value = "";
		openPair(true);
		el("pair-name").focus();
	}

	/* ----------------------------------------------------------------- wiring */

	function bindCopyAndReveal() {
		document.querySelectorAll("[data-copy]").forEach(function (button) {
			button.addEventListener("click", function () {
				var input = el(button.getAttribute("data-copy"));
				// The pairing payload lives in a <pre>, which has no .value.
				var isField = "value" in input && input.tagName !== "PRE";
				var value = isField ? input.value : input.textContent;
				if (!value || value === "\u2014") return;
				var restore = button.textContent;
				var done = function () {
					button.textContent = "Copied";
					setTimeout(function () {
						button.textContent = restore;
					}, 1500);
				};
				if (navigator.clipboard && window.isSecureContext) {
					navigator.clipboard.writeText(value).then(done);
				} else if (!isField) {
					// No clipboard API and nothing selectable: the user can still
					// select the block by hand, so say nothing rather than lie.
					return;
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
	function authedFetch(url, options, retried) {
		var init = { headers: {} };
		var name;
		if (options) {
			for (name in options) {
				if (Object.prototype.hasOwnProperty.call(options, name) && name !== "headers") {
					init[name] = options[name];
				}
			}
			if (options.headers) {
				for (name in options.headers) {
					if (Object.prototype.hasOwnProperty.call(options.headers, name)) {
						init.headers[name] = options.headers[name];
					}
				}
			}
		}
		init.headers.Authorization = "Bearer " + state.token;

		return fetch(url, init).then(function (response) {
			if (response.status !== 401 || retried) return response;
			/* Safe to replay a write here: a 401 means Dojo refused the request,
			 * not that it applied it and then complained. */
			return login().then(function (token) {
				state.token = token;
				return authedFetch(url, options, true);
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
			authedGet("/pushtx/status/").catch(function () { return null; }),
			// Its own catch: 503 until bitcoind's mempool loads is a normal state,
			// not a reason to declare Dojo unreachable.
			authedGet("/fees/estimator").catch(function () { return null; })
		]).then(function (results) {
			renderFees((results[2] && results[2].data) || results[2]);
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

	// POST, PATCH and DELETE on the apikey routes. They take JSON bodies, unlike
	// /auth/login, which is form-encoded.
	function supportSend(method, path, body) {
		return authedFetch(apiBase + "/" + conf.supportPrefix + path, {
			method: method,
			headers: body ? { "Content-Type": "application/json" } : {},
			body: body ? JSON.stringify(body) : undefined
		}).then(unwrap);
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

	/* ------------------------------------------------------- rescan progress */

	/* One controller per progress panel. The bar is determinate only when
	 * progress() is given a real fraction; stage() puts it back to the
	 * travelling segment. Elapsed time ticks in the meta slot until the job
	 * ends, because "still going after 4 minutes" is information too.
	 */
	function job(prefix) {
		var root = el(prefix + "-job");
		var fill = el(prefix + "-job-fill");
		var started = 0;
		var ticker = null;

		function tick() {
			text(prefix + "-job-meta", duration(Date.now() - started));
		}
		function stop() {
			if (ticker) clearInterval(ticker);
			ticker = null;
		}
		function look(kind, title, detail) {
			root.hidden = false;
			root.className = "job" + (kind ? " job--" + kind : "");
			if (title !== null && title !== undefined) el(prefix + "-job-title").textContent = title;
			if (detail !== null && detail !== undefined) el(prefix + "-job-detail").textContent = detail;
		}

		return {
			start: function (title, detail, since) {
				stop();
				started = since || Date.now();
				fill.style.width = "";
				look("indeterminate", title, detail || "");
				tick();
				ticker = setInterval(tick, 1000);
			},
			stage: function (detail, title) {
				fill.style.width = "";
				look("indeterminate", title, detail);
			},
			progress: function (fraction, detail) {
				look("", null, detail);
				fill.style.width = Math.max(1, Math.min(100, fraction * 100)).toFixed(1) + "%";
			},
			done: function (title, detail) {
				stop();
				var took = Date.now() - started;
				look("done", title, detail);
				text(prefix + "-job-meta", duration(took));
				fill.style.width = "";
			},
			fail: function (title, detail) {
				stop();
				look("failed", title, detail);
				// Directly, not through text(): that renders empty as a dash.
				el(prefix + "-job-meta").textContent = "";
			},
			// The page can no longer see the job. No moving bar and no ticking
			// clock: both would say it is still running, which is not known.
			unknown: function (title, detail) {
				stop();
				look("unknown", title, detail);
				el(prefix + "-job-meta").textContent = "";
			},
			hide: function () {
				stop();
				root.hidden = true;
			}
		};
	}

	function duration(ms) {
		var total = Math.max(0, Math.round(ms / 1000));
		var minutes = Math.floor(total / 60);
		var seconds = total % 60;
		if (minutes >= 60) return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
		return minutes ? minutes + "m " + seconds + "s" : seconds + "s";
	}

	/* A running job survives a reload, so a refresh mid-rescan does not throw
	 * away the progress -- or re-enable the button while Dojo is still busy.
	 * sessionStorage, not localStorage: it belongs to this tab's session, and
	 * it can be absent or throw (private windows), so every touch is guarded
	 * and the page works without it.
	 */
	var JOB_KEY = "dojo-connect-job";

	function saveJob(record) {
		try {
			if (record) sessionStorage.setItem(JOB_KEY, JSON.stringify(record));
			else sessionStorage.removeItem(JOB_KEY);
		} catch (error) { /* no storage: the job simply does not resume */ }
	}

	function loadJob() {
		try {
			var raw = sessionStorage.getItem(JOB_KEY);
			return raw ? JSON.parse(raw) : null;
		} catch (error) {
			return null;
		}
	}

	/* Dojo answers a wallet rescan it cannot do with HTTP 200 and a status
	 * that begins "Error:" (support-rest-api.js). Read as a success, that put
	 * an error message in green. These are the two it sends. */
	function rescanRefusal(status) {
		if (!/^Error:/.test(status || "")) return null;
		if (/not tracking/i.test(status)) {
			return "Dojo is not tracking this wallet, so there is nothing to rescan. " +
				"Add it from the wallet first; Dojo only rescans wallets it already knows.";
		}
		if (/in progress/i.test(status)) return "A rescan of this wallet is already running.";
		return status.replace(/^Error:\s*/, "");
	}

	var rescanJob = null;
	var blocksJob = null;

	/* Wallet rescans. There is no total to measure against -- the scan ends
	 * when it meets a long enough run of unused addresses -- so the bar stays
	 * indeterminate and the detail line reports what Dojo does know: which
	 * stage it is in and how many transactions it has found.
	 */
	var XPUB_POLL_MS = 1000;
	var xpubPoll = null;
	// Bumped whenever polling stops, so a status request still in flight when
	// the rescan finishes cannot paint "Scanning" over the finished panel.
	var xpubGen = 0;

	// true while Dojo reports the rescan running, false once it is not, null
	// when the status could not be read at all.
	function checkXpub(xpub) {
		var gen = xpubGen;
		return authedGet("/xpub/" + encodeURIComponent(xpub) + "/import/status")
			.then(function (body) {
				var status = (body && body.data) || body || {};
				if (!status.import_in_progress) return false;
				if (gen !== xpubGen) return true;
				var hits = number(status.hits || 0);
				if (status.status === "import") {
					rescanJob.stage("Saving " + hits + " transactions to Dojo's database.");
				} else {
					rescanJob.stage("Scanning addresses · " + hits + " transactions found so far.");
				}
				return true;
			})
			.catch(function () { return null; });
	}

	function pollXpub(xpub) {
		stopXpubPoll();
		xpubPoll = setInterval(function () { checkXpub(xpub); }, XPUB_POLL_MS);
		return checkXpub(xpub);
	}

	function stopXpubPoll() {
		if (xpubPoll) clearInterval(xpubPoll);
		xpubPoll = null;
		xpubGen += 1;
	}

	// The answer people actually rescan for: what Dojo now says the wallet holds.
	function finishWithInfo(kind, value) {
		return supportGet("/" + kind + "/" + encodeURIComponent(value) + "/info")
			.then(function (info) {
				rescanJob.done(
					"Rescan complete",
					number(info.n_tx) + " transactions · balance " + sats(info.balance)
				);
			})
			.catch(function () {
				rescanJob.done("Rescan complete", "");
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
			// The address route takes no lookahead arguments.
			path = "/address/" + encodeURIComponent(value) + "/rescan";
		}

		notice("rescan-note", null);
		button.disabled = true;
		rescanJob.start(
			isKey ? "Rescanning wallet" : "Rescanning address",
			isKey ? "Starting…" : "Asking your Electrum server for this address's history."
		);
		if (isKey) {
			saveJob({ kind: "xpub", target: value, started: Date.now() });
			pollXpub(value);
		}

		supportGet(path)
			.then(function (result) {
				stopXpubPoll();
				var refusal = rescanRefusal(result && result.status);
				if (refusal) {
					rescanJob.fail("Rescan did not run", refusal);
					return null;
				}
				rescanJob.stage("Reading the result.", "Rescan finished");
				return finishWithInfo(isKey ? "xpub" : "address", value);
			})
			.catch(function (error) {
				stopXpubPoll();
				rescanJob.fail("Rescan failed", error.message);
			})
			.then(function () {
				if (isKey) saveJob(null);
				button.disabled = false;
			});
	}

	/* A wallet rescan that was running when the page reloaded. The request that
	 * started it is gone, but Dojo's import status still answers, so the panel
	 * can pick up where it was and finish honestly. */
	function resumeXpub(record) {
		var button = el("rescan-run");
		el("rescan-target").value = record.target;
		syncRescanFields();
		button.disabled = true;
		rescanJob.start("Rescanning wallet", "Checking on the rescan that was running…", record.started);

		var finish = function (running) {
			saveJob(null);
			button.disabled = false;
			if (running === false) finishWithInfo("xpub", record.target);
			else rescanJob.hide();
		};
		var watch = function () {
			checkXpub(record.target).then(function (running) {
				if (running === true) setTimeout(watch, XPUB_POLL_MS);
				else finish(running);
			});
		};
		watch();
	}

	/* Block ranges. The tracker sends a `block` event for every block it
	 * processes, rescans included (blockchain-processor.js), and the accounts
	 * service forwards them to websocket clients subscribed with blocks_sub.
	 * So this bar is a real count. Heights are counted as a set rather than
	 * read as "the latest", which stays right even if events arrive out of
	 * order, and anything outside the range -- a new block at the tip while
	 * the rescan runs -- is ignored.
	 */
	var blockSocket = null;

	function watchBlocks(from, to, onBlock, onUnavailable, onOpen) {
		if (typeof WebSocket === "undefined") {
			onUnavailable();
			return;
		}
		// A fresh token, not whatever the page holds: Dojo's access tokens last
		// fifteen minutes, and the socket has no 401 to recover from -- an
		// expired one just gets an error frame and then silence.
		login()
			.then(function (token) {
				state.token = token;
				openBlockSocket(from, to, onBlock, onUnavailable, onOpen);
			})
			.catch(onUnavailable);
	}

	function openBlockSocket(from, to, onBlock, onUnavailable, onOpen) {
		var seen = {};
		var count = 0;
		var given = false;
		var giveUp = function () {
			if (given || count > 0) return;
			given = true;
			closeBlockSocket();
			onUnavailable();
		};
		try {
			var scheme = location.protocol === "https:" ? "wss:" : "ws:";
			blockSocket = new WebSocket(scheme + "//" + location.host + apiBase + "/inv");
		} catch (error) {
			giveUp();
			return;
		}
		var socket = blockSocket;
		socket.onopen = function () {
			socket.send(JSON.stringify({ op: "blocks_sub", at: state.token }));
			if (onOpen) onOpen();
		};
		socket.onmessage = function (event) {
			var message;
			try { message = JSON.parse(event.data); } catch (error) { return; }
			// What notifications-service.js sends when it refuses the token.
			if (message && message.op === "error") {
				giveUp();
				return;
			}
			if (!message || message.op !== "block" || !message.x) return;
			var height = message.x.height;
			if (height < from || height > to || seen[height]) return;
			seen[height] = true;
			count += 1;
			onBlock(count, height);
		};
		socket.onerror = socket.onclose = function () {
			if (blockSocket === socket) blockSocket = null;
			giveUp();
		};
	}

	function closeBlockSocket() {
		var socket = blockSocket;
		blockSocket = null;
		if (socket) {
			socket.onclose = socket.onerror = null;
			try { socket.close(); } catch (error) { /* already gone */ }
		}
	}

	/* What the range will really do. Dojo stops at its own highest block
	 * (blockchain-processor.js clamps to it) and an empty "to" means a single
	 * block (tracker-rest-api.js) -- both said up front, not discovered later.
	 * Returns the effective range, or null with the reason shown. */
	function blockRange(showErrors) {
		var fromText = el("blocks-from").value.trim();
		var toText = el("blocks-to").value.trim();
		var tip = state.indexedTip;
		var span = el("blocks-span");

		if (!fromText) {
			span.textContent = tip !== null && tip !== undefined
				? "Dojo has indexed up to block " + number(tip) + "."
				: "";
			if (showErrors) notice("blocks-note", "Enter the block to start from.");
			return null;
		}
		var from = parseInt(fromText, 10);
		var to = toText ? parseInt(toText, 10) : from;
		if (!(from >= 0) || !(to >= 0)) {
			if (showErrors) notice("blocks-note", "Block heights are whole numbers.");
			return null;
		}
		if (to < from) {
			span.textContent = "";
			if (showErrors) notice("blocks-note", "The last block comes before the first.");
			return null;
		}
		if (tip !== null && tip !== undefined && from > tip) {
			span.textContent = "";
			if (showErrors) {
				notice("blocks-note", "Dojo has only indexed up to block " + number(tip) + ", so there is nothing to rescan from " + number(from) + ".");
			}
			return null;
		}

		var clipped = tip !== null && tip !== undefined && to > tip;
		var end = clipped ? tip : to;
		var total = end - from + 1;
		span.textContent =
			number(total) + (total === 1 ? " block" : " blocks") +
			(toText ? "" : " — leave “to” empty to rescan just this one") +
			(clipped ? ". Dojo stops at its highest block, " + number(tip) + "." : ".");
		return { from: from, to: end, total: total };
	}

	function rescanBlocks() {
		var range = blockRange(true);
		if (!range) return;
		notice("blocks-note", null);

		var button = el("blocks-run");
		var startedAt = Date.now();
		var title = "Rescanning blocks " + number(range.from) +
			(range.total > 1 ? " – " + number(range.to) : "");
		button.disabled = true;
		el("blocks-job-dismiss").hidden = true;
		blocksJob.start(title, "Connecting to Dojo for live progress…", startedAt);
		saveJob({ kind: "blocks", from: range.from, to: range.to, total: range.total, started: startedAt });

		watchBlocks(range.from, range.to, progressFor(range, startedAt), function () {
			blocksJob.stage("Live progress is not available here, so this cannot show how far it has got. Leave the page open until it finishes.");
		}, function () {
			blocksJob.stage("Connected. Waiting for Dojo to reach block " + number(range.from) + "…");
		});

		trackerGet(
			"/rescan?fromHeight=" + encodeURIComponent(range.from) +
				"&toHeight=" + encodeURIComponent(range.to)
		)
			.then(function () {
				closeBlockSocket();
				blocksJob.done(
					"Rescanned " + number(range.total) + (range.total === 1 ? " block" : " blocks"),
					"Blocks " + number(range.from) + (range.total > 1 ? " – " + number(range.to) : "") + "."
				);
			})
			.catch(function (error) {
				closeBlockSocket();
				blocksJob.fail("Rescan failed", error.message);
			})
			.then(function () {
				saveJob(null);
				button.disabled = false;
			});
	}

	function progressFor(range, startedAt) {
		return function (count) {
			var elapsed = (Date.now() - startedAt) / 1000;
			var detail = number(count) + " of " + number(range.total) + " blocks";
			// A rate from two blocks is noise; wait for a few before claiming one.
			if (count >= 5 && elapsed > 2 && count < range.total) {
				var rate = count / elapsed;
				detail += " · " + (rate >= 10 ? Math.round(rate) : rate.toFixed(1)) + " blocks/s" +
					" · about " + duration(((range.total - count) / rate) * 1000) + " left";
			}
			blocksJob.progress(count / range.total, detail);
		};
	}

	/* A block rescan that was running when the page reloaded. The request is
	 * gone and the tracker has no status route, but Dojo's block queue is
	 * strictly sequential (lib/queue.js awaits each block before the next), so
	 * the latest height in range is the true position: the bar can carry on
	 * from where it really is. Completion is that height reaching the end. If
	 * the socket goes quiet the page says so and offers to clear the panel,
	 * rather than guessing it finished.
	 */
	var QUIET_MS = 30000;

	function resumeBlocks(record) {
		var button = el("blocks-run");
		var range = { from: record.from, to: record.to, total: record.total };
		var title = "Rescanning blocks " + number(range.from) +
			(range.total > 1 ? " – " + number(range.to) : "");
		var quiet = null;
		var settle = function () {
			if (quiet) clearTimeout(quiet);
			closeBlockSocket();
			saveJob(null);
			button.disabled = false;
		};
		var unknown = function (detail) {
			settle();
			blocksJob.unknown("Rescan status unknown", detail);
			el("blocks-job-dismiss").hidden = false;
		};
		var arm = function () {
			if (quiet) clearTimeout(quiet);
			quiet = setTimeout(function () {
				unknown("No progress reported for a while. The rescan has probably finished.");
			}, QUIET_MS);
		};

		el("blocks-from").value = String(range.from);
		el("blocks-to").value = String(range.to);
		button.disabled = true;
		el("blocks-job-dismiss").hidden = true;
		blocksJob.start(title, "Picking up the rescan that was running…", record.started);
		arm();

		watchBlocks(range.from, range.to, function (_count, height) {
			var done = height - range.from + 1;
			if (height >= range.to) {
				settle();
				blocksJob.done(
					"Rescanned " + number(range.total) + (range.total === 1 ? " block" : " blocks"),
					"Blocks " + number(range.from) + (range.total > 1 ? " – " + number(range.to) : "") + "."
				);
				return;
			}
			arm();
			blocksJob.progress(done / range.total, number(done) + " of " + number(range.total) + " blocks");
		}, function () {
			unknown("This page reloaded during the rescan and cannot reconnect for live progress. It may still be running.");
		});
	}

	// Gap limit and start index only mean anything for an extended key.
	function syncRescanFields() {
		var isKey = EXT_KEY.test(el("rescan-target").value.trim());
		el("rescan-gap-field").hidden = !isKey;
		el("rescan-start-field").hidden = !isKey;
	}

	function bindTools() {
		el("lookup-btn").addEventListener("click", lookup);
		el("lookup-input").addEventListener("keydown", function (event) {
			if (event.key === "Enter") lookup();
		});

		// Carry the identifier across rather than making the user paste it twice.
		// The rescan now lives further down the same tab, so this scrolls rather
		// than switching -- but it is written through showTab anyway, because the
		// result and the rescan being on one tab is a layout decision and this
		// should not break if they are ever separated.
		el("result-rescan").addEventListener("click", function () {
			showTab("tools");
			el("rescan-target").value = el("lookup-input").value.trim();
			syncRescanFields();
			el("rescan-target").scrollIntoView({ block: "center", behavior: "smooth" });
			el("rescan-target").focus();
		});

		rescanJob = job("rescan");
		blocksJob = job("blocks");

		el("rescan-target").addEventListener("input", syncRescanFields);
		el("rescan-run").addEventListener("click", rescan);

		var restate = function () {
			notice("blocks-note", null);
			blockRange(false);
		};
		el("blocks-from").addEventListener("input", restate);
		el("blocks-to").addEventListener("input", restate);
		el("blocks-run").addEventListener("click", rescanBlocks);
		el("blocks-job-dismiss").addEventListener("click", function () {
			blocksJob.hide();
			el("blocks-job-dismiss").hidden = true;
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
	bindTabs();
	// A hash from a bookmark or a reload wins; anything unrecognised falls to
	// Home rather than showing no panel at all.
	showTab((location.hash || "").replace(/^#/, ""));
	renderPandoTx();

	el("pair-toggle").addEventListener("click", function () {
		// .open, not .hidden -- a dialog's visibility is not the hidden attribute.
		if (el("pair-panel").open) openPair(false);
		else showNewKeyForm();
	});
	el("pair-toggle-2").addEventListener("click", showNewKeyForm);
	el("pair-close").addEventListener("click", function () {
		openPair(false);
	});
	el("pair-create").addEventListener("click", createKey);
	el("pair-name").addEventListener("keydown", function (event) {
		if (event.key === "Enter") createKey();
	});
	// The fallback path: today's payload, on the key every already-paired wallet
	// holds.
	el("legacy-show").addEventListener("click", function () {
		showKey(null);
	});
	// Esc and the backdrop close the dialog without going through openPair, so
	// keep aria-expanded honest however it was dismissed.
	el("pair-panel").addEventListener("close", function () {
		el("pair-toggle").setAttribute("aria-expanded", "false");
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
				refresh(),
				// Its own failure path: an unreadable key list is reported on the
				// wallets card and must not take the rest of the page down with it.
				loadKeys()
			]);
		})
		.then(function (results) {
			state.pairing = results[0];
			renderPairing();
			setInterval(refresh, REFRESH_MS);
			// After login, because both resumes need the token: the wallet one to
			// ask Dojo for import status, the block one to open the socket.
			var running = loadJob();
			if (running && running.kind === "xpub") resumeXpub(running);
			else if (running && running.kind === "blocks") resumeBlocks(running);
		})
		.catch(function (error) {
			unreachable(
				"Could not reach the Dojo API (" + error.message + "). It may still " +
					"be starting up — check the app logs in Umbrel if this persists."
			);
			console.error(error);
		});
})();
