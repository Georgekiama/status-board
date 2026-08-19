/*
 * Drop-in replacement for the Claude Artifact `window.storage` API.
 * ---------------------------------------------------------------------------
 *
 * status-board.html persists itself with exactly two calls:
 *
 *     const res = await window.storage.get('board-data', true);
 *     data = JSON.parse(res.value);
 *
 *     await window.storage.set('board-data', JSON.stringify(data), true);
 *
 * which only works inside a Claude Artifact. This file provides the same
 * interface — a `{ value: <json string> }` result from get, a JSON string into
 * set — backed by the real API, so integrating the hosted board is a single
 * line added above the board's own script:
 *
 *     <script src="/board-api.js"></script>
 *
 * No UI code changes. The board object is passed through untouched.
 *
 * It also handles the two things the artifact API never had to:
 *
 *  1. A save can fail. The promise rejects (so the board's own catch shows
 *     "Save failed — changes are local to this session only") and a banner
 *     appears, because a load failure is otherwise invisible.
 *
 *  2. A load failure must not destroy the board. status-board.html falls back
 *     to its built-in seedData when get() rejects, and immediately saves it —
 *     which against a live API would overwrite the real board with stale seed
 *     content. So set() refuses to write until a load has actually succeeded.
 *     See LOAD-GUARD below.
 */
(function () {
  "use strict";

  var DEFAULT_OPTIONS = {
    endpoint: "/api/board",
    /** Bearer token, only if the deployment sets API_TOKEN. */
    token: null,
    /** Show the built-in status banner. */
    banner: true,
    /** Collapse rapid successive saves into one request (ms). 0 disables. */
    debounceMs: 400,
    /** Retry a failed save this many times before giving up. */
    retries: 1,
  };

  /**
   * The board is a single shared document, so every key maps to the same
   * record. The key is accepted and ignored, which keeps the existing calls
   * working whatever the frontend named its slot.
   */
  function createBoardStorage(options) {
    var config = Object.assign({}, DEFAULT_OPTIONS, options || {});
    var fetchImpl = config.fetch || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw new Error("board-api.js needs a fetch implementation");

    /** Latest version we have seen, for reporting and conflict detection. */
    var version = null;
    /**
     * LOAD-GUARD. Until a load succeeds we do not know what the board contains,
     * so a save would be writing over data we never saw. The board's own error
     * path does exactly that (falls back to seedData and saves it), so blocking
     * here is what stops a brief outage from replacing real content with seed
     * content. Cleared as soon as any load succeeds.
     */
    var loadSucceeded = false;
    /** Serialises writes so two saves cannot interleave. */
    var writeChain = Promise.resolve();
    var pendingTimer = null;
    var pendingBoard = null;
    var pendingWaiters = [];

    function headers(extra) {
      var result = { "Content-Type": "application/json" };
      if (config.token) result.Authorization = "Bearer " + config.token;
      return Object.assign(result, extra || {});
    }

    function report(state, detail) {
      if (typeof config.onStatus === "function") {
        try {
          config.onStatus(state, detail);
        } catch (error) {
          /* a status callback must never break a save */
        }
      }
      if (config.banner) showBanner(state, detail);
    }

    /** Turn an error response into something a human can act on. */
    function describeFailure(response, body) {
      if (body && body.error && body.error.message) {
        var message = body.error.message;
        if (body.error.issues && body.error.issues.length) {
          message +=
            " (" +
            body.error.issues
              .slice(0, 3)
              .map(function (issue) {
                return issue.path + ": " + issue.message;
              })
              .join("; ") +
            ")";
        }
        return message;
      }
      if (response.status === 409) return "Somebody else saved the board first. Reload before editing again.";
      if (response.status === 401) return "Not authorised to save the board.";
      if (response.status >= 500) return "The server could not save the board (HTTP " + response.status + ").";
      return "The board could not be saved (HTTP " + response.status + ").";
    }

    async function parseJson(response) {
      try {
        return await response.json();
      } catch (error) {
        return null;
      }
    }

    async function load() {
      report("loading");
      var response;
      try {
        response = await fetchImpl(config.endpoint, {
          method: "GET",
          headers: headers(),
          cache: "no-store",
        });
      } catch (error) {
        report("offline", "Could not reach the server. The board may be out of date.");
        throw error;
      }

      var body = await parseJson(response);
      if (!response.ok) {
        var message = describeFailure(response, body);
        report("error", message);
        throw new Error(message);
      }
      if (!body || typeof body.board !== "object" || body.board === null) {
        var invalid = "The server returned an unexpected response for the board.";
        report("error", invalid);
        throw new Error(invalid);
      }

      version = typeof body.version === "number" ? body.version : null;
      loadSucceeded = true;
      report("loaded", "Loaded version " + version);
      return body.board;
    }

    async function save(boardValue, attempt) {
      report("saving");
      var response;
      try {
        response = await fetchImpl(config.endpoint, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(boardValue),
        });
      } catch (error) {
        if ((attempt || 0) < config.retries) return save(boardValue, (attempt || 0) + 1);
        report("offline", "Not saved — the server is unreachable. Your change is only in this browser.");
        throw error;
      }

      var body = await parseJson(response);
      if (!response.ok) {
        // 4xx means the payload is wrong; retrying it would fail identically.
        var retryable = response.status >= 500 && (attempt || 0) < config.retries;
        if (retryable) return save(boardValue, (attempt || 0) + 1);
        var message = describeFailure(response, body);
        report("error", "Not saved — " + message);
        throw new Error(message);
      }

      version = body && typeof body.version === "number" ? body.version : version;
      var warnings = (body && body.warnings) || [];
      report("saved", warnings.length ? "Saved, with notes: " + warnings.join("; ") : "Saved version " + version);
      return body;
    }

    /** Queue a save, collapsing bursts of edits into one request. */
    function queueSave(boardValue) {
      pendingBoard = boardValue;

      if (!config.debounceMs) {
        writeChain = writeChain.then(
          function () {
            return save(pendingBoard, 0);
          },
          function () {
            return save(pendingBoard, 0);
          },
        );
        return writeChain;
      }

      return new Promise(function (resolve, reject) {
        pendingWaiters.push({ resolve: resolve, reject: reject });
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(function () {
          pendingTimer = null;
          var waiters = pendingWaiters;
          pendingWaiters = [];
          var boardToSave = pendingBoard;

          writeChain = writeChain
            .catch(function () {
              /* a previous failure must not block the next save */
            })
            .then(function () {
              return save(boardToSave, 0);
            })
            .then(
              function (result) {
                waiters.forEach(function (waiter) {
                  waiter.resolve(result);
                });
                return result;
              },
              function (error) {
                waiters.forEach(function (waiter) {
                  waiter.reject(error);
                });
                throw error;
              },
            );
        }, config.debounceMs);
      });
    }

    /**
     * The board sends a JSON string; earlier artifact code sometimes sent the
     * object. Accept either, and unwrap an API envelope if one arrives.
     */
    function toBoardObject(value) {
      var board = value;
      if (typeof board === "string") {
        try {
          board = JSON.parse(board);
        } catch (error) {
          throw new Error("The board could not be saved: it is not valid JSON.");
        }
      }
      if (board && typeof board === "object" && !board.areas && board.board) board = board.board;
      return board;
    }

    return {
      /**
       * Artifact contract: get(key, shared) resolves to { value: <string> }.
       * The board does `JSON.parse(res.value)`, so value must be a string.
       */
      get: function (_key, _shared) {
        return load().then(function (board) {
          return { key: "board", value: JSON.stringify(board), version: version };
        });
      },
      /** Artifact contract: set(key, value, shared), value being a JSON string. */
      set: function (_key, value, _shared) {
        if (!loadSucceeded) {
          // See LOAD-GUARD. Refusing here is what protects the stored board
          // from the frontend's own seed-data fallback.
          var message =
            "Not saved — the board was never loaded successfully, so saving now " +
            "could overwrite the real board. Reload the page.";
          report("error", message);
          return Promise.reject(new Error(message));
        }
        var board;
        try {
          board = toBoardObject(value);
        } catch (error) {
          report("error", "Not saved — " + error.message);
          return Promise.reject(error);
        }
        return queueSave(board);
      },
      /** Deleting the shared board is never what anybody means. */
      delete: function (_key) {
        console.warn("[board-api] storage.delete() is a no-op: the board is shared. Edit it instead.");
        return Promise.resolve();
      },
      keys: function () {
        return Promise.resolve(["board"]);
      },
      /** Escape hatches for anything the UI wants to do explicitly. */
      getVersion: function () {
        return version;
      },
      flush: function () {
        return writeChain;
      },
    };
  }

  /* -------------------------------------------------------------------- */
  /* Status banner — the smallest change that makes save failures visible. */
  /* -------------------------------------------------------------------- */

  var BANNER_ID = "board-api-status";
  var hideTimer = null;

  var BANNER_STYLES = {
    saving: { text: "Saving…", background: "#334155", visible: true, autoHide: 0 },
    saved: { text: "Saved", background: "#166534", visible: true, autoHide: 2000 },
    loading: { text: "Loading…", background: "#334155", visible: true, autoHide: 0 },
    loaded: { text: "", background: "#166534", visible: false, autoHide: 1 },
    offline: { text: "Not saved — server unreachable", background: "#9a3412", visible: true, autoHide: 0 },
    error: { text: "Not saved", background: "#991b1b", visible: true, autoHide: 0 },
  };

  function showBanner(state, detail) {
    if (typeof document === "undefined" || !document.body) return;
    var style = BANNER_STYLES[state];
    if (!style) return;

    var element = document.getElementById(BANNER_ID);
    if (!element) {
      element = document.createElement("div");
      element.id = BANNER_ID;
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      element.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "bottom:16px",
        "right:16px",
        "max-width:min(30rem,calc(100vw - 32px))",
        "padding:10px 14px",
        "border-radius:8px",
        "color:#fff",
        "font:13px/1.45 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
        "box-shadow:0 6px 20px rgba(0,0,0,.28)",
        "transition:opacity .15s ease",
        "pointer-events:none",
        "white-space:pre-wrap",
      ].join(";");
      document.body.appendChild(element);
    }

    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }

    if (!style.visible) {
      element.style.opacity = "0";
      return;
    }

    element.style.background = style.background;
    element.style.opacity = "1";
    element.textContent = detail && state !== "saved" ? style.text + " — " + detail : style.text;

    if (style.autoHide) {
      hideTimer = setTimeout(function () {
        element.style.opacity = "0";
      }, style.autoHide);
    }
  }

  var api = { create: createBoardStorage };

  if (typeof window !== "undefined") {
    window.StatusBoardStorage = api;
    // Replace the artifact-only storage object. Assigned synchronously so an
    // inline script further down the page can use it immediately.
    window.storage = createBoardStorage(window.BOARD_API_OPTIONS || {});
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
