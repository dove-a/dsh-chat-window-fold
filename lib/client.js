// dsh-chat-window-fold — browser half.
//
// Behavior (frozen spec):
//  - Checkpoints: whenever the session's cumulative event count N reaches a
//    multiple of foldCheckEvery (default 25), one fold check runs. The first
//    two checkpoints (N=25, N=50) are skipped; effective folding starts at
//    N=75. This keeps window-bounded DOM/layout work tiny on low-end
//    machines (window stays below threshold + checkEvery ≈ 75 events).
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
			var eventsRef = react.useRef(null);
			var bottomRef = react.useRef(false);
			var expandingRef = react.useRef(false);
			var hasMoreRef = react.useRef(false);
			var rafRef = react.useRef(0);

			if (hiddenRef.current === null) hiddenRef.current = new Set();

			// Window store subscriptions (standard conversation.input.dock
			// occupant props — used unconditionally, QueueDock-style, so the
			// hook call count is stable across renders).
			var events = useSession(function (s) { return s ? s.events : null; });
			var hasMore = useSession(function (s) { return s ? s.hasMore : false; });

			// ---- fold checkpoints (event-driven) ----------------------------
			react.useEffect(function () {
				if (!Array.isArray(events)) return;
				eventsRef.current = events;
				var last = events[events.length - 1];
				if (!last) return;
				var tail = null;
				if (typeof last === "object" && last !== null && typeof last.event === "object" && last.event !== null && typeof last.event.seq === "number") {
					tail = last.event.seq;
				} else if (typeof last === "object" && last !== null && typeof last.seq === "number") {
					tail = last.seq;
				}
				if (typeof tail !== "number") return;
				var before = countRef.current;
				var now = Math.max(before, tail + 1);
				countRef.current = now;
				if (now <= before) return;
				var checkpoint = nextCheckpoint(before, config.foldCheckEvery);
				if (checkpoint <= now) maybeFold();
			}, [events]);

			// ---- hasMore latch for the scroll handler ------------------------
			react.useEffect(function () {
				hasMoreRef.current = hasMore;
			}, [hasMore]);

			// ---- fold action --------------------------------------------------
			function maybeFold() {
				var scroller = scrollerRef.current;
				if (!scroller) return;
				// Spec gate: loaded window above the threshold…
				var win = eventsRef.current;
				if (!(win && win.length > config.foldThreshold)) return;
				// …visual rows above the threshold (idempotency guard)…
				var column = columnOf(scroller);
				var rows = rowsOf(column);
				if (rows.length <= config.foldThreshold) return;
				// …and the user is at the bottom of the window.
				if (!bottomRef.current) return;
				var keep = rows.slice(rows.length - config.foldThreshold);
				var hidden = hiddenRef.current;
				for (var i = 0; i < rows.length; i++) {
					var row = rows[i];
					if (keep.indexOf(row) !== -1) continue;
					if (row.style.display === "none") continue;
					row.style.display = "none";
					hidden.add(row);
				}
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
				expandingRef.current = true;
				var column = columnOf(scroller);
				var rows = rowsOf(column);
				var anchor = pickAnchor(rows, scroller);
				var anchorKey = anchor ? anchor.dataset.chatAnchorKey : null;
				var anchorTop = anchor ? flowTop(anchor, scroller) : null;
				// Folded pages come back before newer pages load.
				restoreHidden();
				var op = typeof loadOlder === "function" ? loadOlder : null;
				if (!op) {
					expandingRef.current = false;
					return;
				}
				Promise.resolve(op()).then(function () {
					rafRef.current = requestAnimationFrame(function () {
						// Even if React re-rendered the list, restore the anchor
						// row's viewport position so the user's picture does not move.
						if (anchorKey !== null && anchorTop !== null) {
							var current = rowsOf(columnOf(scrollerRef.current));
							var el = findByKey(current, anchorKey);
							if (el) scroller.scrollTop += flowTop(el, scroller) - anchorTop;
						}
						expandingRef.current = false;
					});
				}).catch(function () {
					expandingRef.current = false;
				});
			}

			// ---- scroll tracking + system button + mount ----------------------
			function handleScroll() {
				var scroller = scrollerRef.current;
				if (!scroller) return;
				bottomRef.current = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_EPSILON;
				if (scroller.scrollTop <= TOP_EPSILON && !expandingRef.current && hasMoreRef.current) {
					expandAnchored();
				}
			}

			/** Hide the system "Load earlier" container once it appears. */
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
					if (text === "Load earlier" || text === "加载更早消息" || text === "載入更早訊息") {
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