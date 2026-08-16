// dsh-chat-window-fold — browser half.
//
// Behavior (frozen spec):
//  - Checkpoints: whenever the session's cumulative event count N reaches a
//    multiple of foldCheckEvery (default 25), one fold check runs. The first
//    two checkpoints (N=25, N=50) are skipped; effective folding starts at
//    N=75. This keeps window-bounded DOM/layout work tiny on low-end
//    machines (window stays below threshold + checkEvery ≈ 75 events).
//    N is read from the session snapshot's chat.order length — the window's
//    routed-row sequence, which grows monotonically as turns/steps complete
//    (empirically verified: session snapshots expose window data only under
//    s.chat = {order, nodes, timeline}; there is no s.events field).
//  - Fold: at a checkpoint, when the viewport sits at the bottom of the
//    conversation scroller and the loaded window has more than
//    foldThreshold (default 50) rows, everything except the recent
//    foldThreshold rows is hidden. Idempotent: with nothing left to hide a
//    checkpoint no-ops.
//  - Expand: when the user scrolls to the very top (scrollTop <= 4px) and
//    more history exists (hasMore), up to 50 earlier messages are appended
//    via loadOlder. The viewport stays in place (anchor row key + relative
//    offset restored after render). Repeatedly scrolling to the top expands
//    again until hasMore is false. Previously folded rows are restored
//    first, so the folded pages come back before newer pages load.
//  - The system "Load earlier" button is hidden while the plugin runs.
//  - All state is per-session (the component lives in the session-scoped
//    conversation.input.dock slot), so multiple DSH sessions never affect
//    each other. The registered dock renders null — no visible UI.
//
// GUI-context safety contract (code-audited):
//  - The plugin NEVER writes the session snapshot (s.chat.order/nodes/
//    timeline, running, hasMore, loadingOlder) and never calls host APIs.
//    ChatView and ConversationRoot read those stores; this plugin only
//    reads them (useSession selectors) and only touches DOM row styles.
//  - Folding uses `display: none` on row elements — rows stay in the DOM,
//    so React's keyed list reconciliation never rebuilds them, querySelect
//    -or access by data-chat-anchor-key keeps working, and a full restore
//    is a style flip. Removing rows from the DOM would be undone by the
//    next React render (the keys are still in the store) and break both
//    fold and system anchoring. Folded rows are therefore only excluded
//    from layout/paint/scroll-height — the layout/rendering cost sink.
//  - The only scroll writes are: (1) the fold re-anchor to the new bottom
//    (viewer was at the bottom; viewport content is the same trailing
//    rows) and (2) the anchored expand correction after loadOlder (anchor
//    row returns to its viewport position; the spec requires this).
//  - The MutationObserver only hides the system paging container, and the
//    scroll listener is passive and read-only. Both are disposed with the
//    session scope.
//
// Where real token compression happens: model-context assembly lives on
// the host (agent session -> provider request windowing), not in the
// browser. This plugin intentionally does not touch events/persistence —
// delete-then-restore through loadOlder would corrupt window semantics.
// Its job is render-layer windowing: bounded layout/paint cost and a
// short visible window, per the frozen spec.
//
// The browser row is a plain script module for the dsh module loader
// (window.__ModuleLoader__.load) and only depends on `react`.

window.__ModuleLoader__.load({
	id: "dsh-chat-window-fold",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ---- constants -----------------------------------------------------
		/** scrollTop tolerance for the "bottom" detection. */
		var BOTTOM_EPSILON = 4;
		/** scrollTop tolerance for the "very top" detection. */
		var TOP_EPSILON = 4;
		/** First effective checkpoint: N=25 and N=50 checks are skipped. */
		var FIRST_CHECKPOINT = 75;
		/** Hard clamp so a misconfigured row cannot explode the DOM scan. */
		var MAX_THRESHOLD = 2000;
		/**
		 * Official paging-button labels, dictionary-aligned (ui-conversation:
		 * `"chat.loadOlder"` = "Load earlier" / "加载更早"; older builds also
		 * shipped the traditional variant). Matched as a PREFIX.
		 */
		var OLDER_BUTTON_TEXTS = ["Load earlier", "加载更早", "載入更早"];
		/** Latch release if the loader never settles (ms). */
		var EXPAND_TIMEOUT_MS = 8000;

		// ---- config --------------------------------------------------------
		/** Normalize row config with defaults; defense-in-depth against loader differences. */
		function readConfig(cfg) {
			var threshold = Number(cfg && cfg.foldThreshold);
			var every = Number(cfg && cfg.foldCheckEvery);
			return {
				foldThreshold: Number.isFinite(threshold) && threshold >= 10 && threshold <= MAX_THRESHOLD ? Math.round(threshold) : 50,
				foldCheckEvery: Number.isFinite(every) && every >= 5 && every <= 500 ? Math.round(every) : 25
			};
		}

		/** Next checkpoint strictly after n (1-based cumulative event count). */
		function nextCheckpoint(n, every) {
			var c = Math.ceil((n + 1) / every) * every;
			return c < FIRST_CHECKPOINT ? FIRST_CHECKPOINT : c;
		}

		// ---- DOM helpers ----------------------------------------------------
		/** The conversation scroller (ConversationRoot scroll body). */
		function scrollerOf(mount) {
			return mount ? mount.closest("[data-conversation-scroll]") : null;
		}
		/** The chat flow column inside a scroller. */
		function columnOf(scroller) {
			return scroller ? scroller.querySelector("[data-chat-flow]") : null;
		}
		/** All rendered chat rows (each carries data-chat-anchor-key). */
		function rowsOf(column) {
			return column ? Array.prototype.slice.call(column.querySelectorAll("[data-chat-anchor-key]")) : [];
		}
		/** Row by anchor key, avoiding selector-escaping pitfalls. */
		function findByKey(rows, key) {
			for (var i = 0; i < rows.length; i++) {
				if (rows[i].dataset.chatAnchorKey === key) return rows[i];
			}
			return null;
		}
		/** Flow-top of a row relative to the scroller (viewport independent). */
		function flowTop(row, scroller) {
			return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
		}
		/** Pick a stable visible row as the expand anchor (pagingAnchor-lite). */
		function pickAnchor(rows, scroller) {
			if (rows.length === 0) return null;
			try {
				var viewport = scroller.getBoundingClientRect();
				var seat = scroller.querySelector("[data-composer-seat]");
				var visibleBottom = seat ? seat.getBoundingClientRect().top : viewport.bottom;
				if (typeof document.elementsFromPoint === "function" && visibleBottom > viewport.top) {
					var content = (columnOf(scroller) || scroller).getBoundingClientRect();
					var left = Math.max(viewport.left, content.left);
					var right = Math.min(viewport.right, content.right);
					var x = left + Math.max(0, right - left) / 2;
					var height = visibleBottom - viewport.top;
					var offsets = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)];
					for (var i = 0; i < offsets.length; i++) {
						var at = document.elementsFromPoint(x, viewport.top + offsets[i]);
						for (var j = 0; j < at.length; j++) {
							var el = at[j];
							if (!(el instanceof HTMLElement)) continue;
							var row = el.closest("[data-chat-anchor-key]");
							if (row !== null && scroller.contains(row)) return row;
						}
					}
				}
			} catch (e) {
				// fall through to the layout scan
			}
			var fallback = null;
			for (var k = 0; k < rows.length; k++) {
				var rect = rows[k].getBoundingClientRect();
				if (rect.bottom > viewport.top && rect.top < visibleBottom) {
					fallback = rows[k];
					break;
				}
			}
			return fallback || rows[0] || null;
		}

		// ---- WindowFoldDock -------------------------------------------------
		/**
		 * Session-scoped (conversation.input.dock) mount point. Renders an
		 * invisible element so its ancestor chain yields the conversation
		 * scroller; all behavior runs in effects below. Standard slot props
		 * provide sessionId and useSession; the plugin inject provides
		 * config and loadOlder bound to this session.
		 */
		function WindowFoldDock(props) {
			var sessionId = props.sessionId;
			var useSession = props.useSession;
			var loadOlder = props.loadOlder;
			var config = props.config;

			var mountRef = react.useRef(null);
			var scrollerRef = react.useRef(null);
			var hiddenRef = react.useRef(null);
			var countRef = react.useRef(0);
			var orderRef = react.useRef(null);
			var bottomRef = react.useRef(false);
			var expandingRef = react.useRef(false);
			var hasMoreRef = react.useRef(false);
			var rafRef = react.useRef(0);

			if (hiddenRef.current === null) hiddenRef.current = new Set();

			// Window view sequence (standard conversation.input.dock occupant
			// props; used unconditionally, QueueDock-style, so the hook call
			// count is stable across renders).
			//
			// s.chat.order is the routed row-key sequence of the loaded window:
			// its length grows monotonically as turns/steps complete and newer
			// pages load, and it is exactly the "session event count" the
			// checkpoint system keys on.
			var order = useSession(function (s) {
				return s && s.chat ? s.chat.order : null;
			});
			var hasMore = useSession(function (s) {
				return s ? s.hasMore : false;
			});

			// ---- fold checkpoints (window-growth driven) --------------------
			react.useEffect(function () {
				if (!Array.isArray(order)) return;
				orderRef.current = order;
				var before = countRef.current;
				var now = Math.max(before, order.length);
				countRef.current = now;
				if (now <= before) return;
				var checkpoint = nextCheckpoint(before, config.foldCheckEvery);
				if (checkpoint > now) return;
				// Strict checkpoint rhythm: the fold check runs only here, once
				// per crossed checkpoint (every foldCheckEvery events, i.e. when
				// the model has produced new output). maybeFold itself applies
				// the bottom gate; when the viewport is not at the bottom the
				// checkpoint is SKIPPED — no deferred replay on later scrolls.
				// The one exception is the post-mount probe below, which only
				// initializes the bottom latch for sessions that open at the
				// bottom (programmatic scroll restores fire no scroll event).
				maybeFold();
			}, [order]);

			// ---- hasMore latch for the scroll handler ------------------------
			react.useEffect(function () {
				hasMoreRef.current = hasMore;
			}, [hasMore]);

			// ---- fold action --------------------------------------------------
			function maybeFold() {
				var scroller = scrollerRef.current;
				if (!scroller) return;
				// Spec gate: loaded window above the threshold (window rows =
				// rendered rows; the same sequence the checkpoint counts)…
				var column = columnOf(scroller);
				var rows = rowsOf(column);
				if (rows.length <= config.foldThreshold) return;
				// …and the user is at the bottom of the window. When not at the
				// bottom the checkpoint is skipped (strict rhythm: the next
				// check happens foldCheckEvery events later).
				if (!bottomRef.current) return;
				var keep = rows.slice(rows.length - config.foldThreshold);
				var hidden = hiddenRef.current;
				var folded = 0;
				for (var i = 0; i < rows.length; i++) {
					var row = rows[i];
					if (keep.indexOf(row) !== -1) continue;
					if (row.style.display === "none") continue;
					row.style.display = "none";
					hidden.add(row);
					folded++;
				}
				if (folded === 0) return;
				// Re-anchor the viewport to the new bottom. Hiding the upper rows
				// shrinks scrollHeight; leaving scrollTop where it was either
				// strands the viewport mid-window (so later checkpoints stop
				// folding — the fold pipeline would stall) or relies on the
				// browser clamping. The viewport content itself is unchanged:
				// the pre-fold bottom viewport and the post-fold bottom viewport
				// show the same trailing rows.
				scroller.scrollTop = scroller.scrollHeight;
				// Programmatic scrollTop assignment fires no scroll event, so
				// keep the latch truthful for the next checkpoint.
				bottomRef.current = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_EPSILON;
			}

			// ---- anchored expand (top-scroll driven) --------------------------
			function restoreHidden() {
				var scroller = scrollerRef.current;
				var column = scroller ? columnOf(scroller) : null;
				var hidden = hiddenRef.current;
				hidden.forEach(function (row) {
					if (column && column.contains(row)) row.style.display = "";
				});
				hidden.clear();
			}

			function expandAnchored() {
				var scroller = scrollerRef.current;
				if (!scroller || expandingRef.current) return;
				var op = typeof loadOlder === "function" ? loadOlder : null;
				if (!op) return;
				expandingRef.current = true;
				var column = columnOf(scroller);
				var rows = rowsOf(column);
				var anchor = pickAnchor(rows, scroller);
				var anchorKey = anchor ? anchor.dataset.chatAnchorKey : null;
				var anchorTop = anchor ? flowTop(anchor, scroller) : null;
				// Folded pages come back before newer pages load.
				restoreHidden();
				// Height sample AFTER restoreHidden: post-load growth equals the
				// prepended content height (all of it sits above the viewport),
				// which is the fallback anchor when the row anchor is unusable.
				var beforeHeight = scroller.scrollHeight;
				var settled = false;
				function release() {
					if (settled) return;
					settled = true;
					expandingRef.current = false;
				}
				// Defer the loadOlder call into a microtask: a synchronous throw
				// from the loader then becomes a rejection (caught below) instead
				// of escaping through Promise.resolve(op()) and leaving
				// expandingRef latched forever — a latched expandingRef makes
				// every later top-scroll a silent no-op (observed: "top-scroll
				// stops loading until the tab is switched away and back").
				var pending = Promise.resolve().then(op);
				// Timeout latch: if the loader never settles, release the latch
				// so the user can try again (the window manager dedupes by seq).
				var timeout = new Promise(function (resolve) {
					setTimeout(resolve, EXPAND_TIMEOUT_MS);
				});
				Promise.race([pending, timeout]).then(function () {
					rafRef.current = requestAnimationFrame(function () {
						var live = scrollerRef.current;
						if (live) {
							var corrected = false;
							// Preferred: restore the anchor row's viewport position.
							if (anchorKey !== null && anchorTop !== null) {
								var current = rowsOf(columnOf(live));
								var el = findByKey(current, anchorKey);
								if (el) {
									live.scrollTop += flowTop(el, live) - anchorTop;
									corrected = true;
								}
							}
							// Fallback: shift by the prepended height. All new rows
							// sit above the viewport, so this preserves the picture
							// even when the anchor row is gone or never resolved,
							// and lifts scrollTop off the top so the top-scroll
							// trigger does not fire again on the next wheel tick.
							if (!corrected) {
								var grown = live.scrollHeight - beforeHeight;
								if (grown > 0) live.scrollTop += grown;
							}
						}
						release();
					});
				}).catch(function () {
					release();
				});
			}

			// ---- scroll tracking + system button + mount ----------------------
			/**
			 * Measure the bottom latch only — O(1) reads of cached layout
			 * values (no reflow). The latch is consumed by maybeFold at
			 * checkpoint time; this handler never folds by itself, so scroll
			 * activity cannot trigger extra fold passes.
			 */
			function refreshBottom() {
				var scroller = scrollerRef.current;
				if (!scroller) return;
				bottomRef.current = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_EPSILON;
			}

			function handleScroll() {
				var scroller = scrollerRef.current;
				if (!scroller) return;
				refreshBottom();
				if (scroller.scrollTop <= TOP_EPSILON && !expandingRef.current && hasMoreRef.current) {
					expandAnchored();
				}
			}

			/**
			 * Hide the system "Load earlier" (older) container once it appears.
			 *
			 * The official paging container is a direct child of [data-chat-flow]
			 * with the CSS-module class `…_older` (ui-conversation sources:
			 * `"older": "Md3f7G_older"`, rendered as
			 * `<div class={older}><button>{t("chat.loadOlder")}</button></div>`).
			 * That is the primary matcher.
			 *
			 * Fallback (text-based, dictionary-aligned — official dictionaries:
			 * `"chat.loadOlder": "Load earlier"` / `"加载更早"`; earlier builds
			 * also shipped `"載入更早"`): only direct-child buttons are scanned
			 * and only containers whose button text PREFIX-matches one of them
			 * are hidden. Button text is a prefix check so wrapped/ellipsized
			 * labels still match.
			 *
			 * Anti-misfire guard: a container whose button text mentions
			 * "token"/"压缩"/"compact" is NEVER hidden — the conversation
			 * renders context-compaction disclosures inside message rows and a
			 * "压缩当前会话上下文" fixture action exists elsewhere; those are
			 * out of scope for this plugin and must stay visible. Combined with
			 * the direct-child scan, this hides only the paging container.
			 */
			function hideOlderButton() {
				var scroller = scrollerRef.current;
				if (!scroller) return;
				var column = columnOf(scroller);
				if (!column) return;
				var children = column.children;
				for (var i = 0; i < children.length; i++) {
					var child = children[i];
					if (!(child instanceof HTMLElement)) continue;
					var cls = child.className;
					if (typeof cls === "string" && /_older$/.test(cls)) {
						child.style.display = "none";
						return;
					}
					// Fallback: direct child container holding a paging button.
					var btn = child.querySelector(":scope > button");
					if (!btn) continue;
					var text = (btn.textContent || "").trim();
					if (/token|压缩|compact/i.test(text)) continue;
					if (text.indexOf(OLDER_BUTTON_TEXTS[0]) === 0 || text.indexOf(OLDER_BUTTON_TEXTS[1]) === 0 || text.indexOf(OLDER_BUTTON_TEXTS[2]) === 0) {
						child.style.display = "none";
						return;
					}
				}
			}

			react.useEffect(function () {
				var mount = mountRef.current;
				if (!mount) return;
				var scroller = scrollerOf(mount);
				scrollerRef.current = scroller;
				if (scroller) {
					scroller.addEventListener("scroll", handleScroll, { passive: true });
					hideOlderButton();
				}
				var observer = new MutationObserver(hideOlderButton);
				observer.observe(scroller || document.documentElement, { subtree: true, childList: true });
				// Post-layout probe: initialize the bottom latch once React has
				// settled the restored scroll position (programmatic restores
				// emit no scroll event — without this a session opened at the
				// bottom reads an uninitialized false latch and the initial
				// checkpoint would never fold). When the session does open at
				// the bottom, run one fold pass: this is the initial-checkpoint
				// execution (the window already crosses checkpoint 75), not a
				// scroll-triggered deferral — strict rhythm applies afterwards.
				rafRef.current = requestAnimationFrame(function () {
					refreshBottom();
					if (bottomRef.current) maybeFold();
				});
				return function () {
					observer.disconnect();
					if (scroller) scroller.removeEventListener("scroll", handleScroll);
					if (rafRef.current) cancelAnimationFrame(rafRef.current);
					rafRef.current = 0;
				};
			}, [sessionId]);

			return react.createElement("div", {
				ref: mountRef,
				"data-window-fold-mount": "",
				style: { display: "none" }
			});
		}

		// ---- plugin entry -----------------------------------------------------
		var INJECT = ["slots", "sessions"];

		function apply(ctx, config) {
			var config = readConfig(config);
			var sessions = ctx.get("sessions");
			if (sessions === void 0) return;
			ctx.slots.inject("conversation.input.dock", function () {
				ctx.slots.register({
					name: "conversation.input.dock",
					id: "window-fold",
					order: 90,
					inject: function (sessionId) {
						return {
							config: config,
							loadOlder: function () {
								var binding = sessions.binding(sessionId);
								if (binding === void 0) return Promise.resolve();
								// eslint-disable-next-line promise/prefer-await-to-then
								return Promise.resolve(binding.session.loadOlder());
							}
						};
					}
				}, WindowFoldDock);
			});
		}

		exports.apply = apply;
		exports.inject = INJECT;
		return module.exports;
	}
});