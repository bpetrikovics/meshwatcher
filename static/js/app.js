// Application configuration — consumed by all mixin files at runtime.
const CONFIG = {
  DEFAULT_MAP_CENTER: [47.5, 19.0],
  DEFAULT_ZOOM: 8,
  MOVEMENT: {
    MAX_POSITION_AGE_HOURS: 1,
  },
  API: {
    DEFAULT_LIMIT: 1000,
    MAX_LIMIT: 5000,
    DEFAULT_INCLUDES: ["positions", "info"],
    DEFAULT_FILTERS: {
      has_position: true,
      active: false,
    },
    MAP_INIT_DELAY: 200, // ms delay before loading nodes
  },
  PANEL_SIZES: {
    left: { default: 300, min: 200, max: 500 },
    right: { default: 350, min: 250, max: 600 },
    rightSheet: { default: 320, min: 160, max: 700 },
    bottom: { default: 300, min: 100, max: 400 },
  },
  Z_INDEX: {
    dropdown: 1000,
    sticky: 1020,
    fixed: 1030,
    modalBackdrop: 1040,
    modal: 1050,
    popover: 1060,
    tooltip: 1070,
  },
};

// Alpine.js component factory.
// Spreads domain mixins; owns state + orchestration methods only.
function meshApp() {
  return {
    // --- spread domain mixins ---
    ...realtimeMixin(),
    ...mapMixin(),
    ...nodesMixin(),
    ...nodeDetailMixin(),

    // ---- state ----

    // Map instance
    map: null,

    // Map state
    isZooming: false,

    // Node management
    nodes: {},
    nodeLayer: null,
    nodeSearchQuery: "",
    nodeRoleFilters: {
      client: false,
      router: false,
      tracker: false,
      sensor: false,
    },
    networkLayer: null,
    traceLayer: null,

    pendingNodePositionUpdates: {},

    // Performance caching
    cachedRoles: null,
    needsRoleUpdate: true,

    // Socket.IO events
    eventsSocket: null,
    eventsSocketHasConnectedOnce: false,
    markerFlashTimers: {},

    packetsSocket: null,
    packetsSocketConnected: false,
    rawLogPauseWhenScrolledUp: true,
    rawLogHideDuplicates: false,
    rawLogPaused: false,
    rawLogBufferedCount: 0,
    rawLogStatusText: "",
    rawLogMaxRows: 500,
    rawLogRing: [],
    rawLogPending: [],
    rawLogFlushScheduled: false,
    rawLogScrollHandler: null,
    rawLogScrollAttachAttempts: 0,

    // Node selection state for precision circle
    selectedNodeId: null,
    selectedNodePrecisionCircle: null,
    selectedNodeHistory: [],
    selectedNodeHistoryLayer: null,
    selectedNodeHistoryRenderState: {
      token: 0,
      lastRenderedLength: 0,
      rendering: false,
    },
    selectedNodeHistoryRequestSeq: 0,
    positionHistoryEnabled: false,
    positionHistoryRangeHours: 24,
    telemetryWindow: 24,

    // Canvas renderer shared across history point markers (avoids N SVG elements)
    historyCanvasRenderer: null,

    // Chart fetch concurrency limiting (avoid burst /metrics/series requests)
    chartFetchMaxConcurrent: 4,
    chartFetchInFlight: 0,
    chartFetchWaiters: [],

    // Refresh state
    refreshingNodeId: null,

    zoomStartedWithOpenPopup: false,

    // Version tracking for auto-refresh
    storedVersion: null,

    // Websocket connection status
    socketConnected: false,

    wsIndicatorLastPulseAtMs: 0,
    wsIndicatorPulseTimer: null,

    modal: {
      visible: false,
      title: "",
      content: "",
      onConfirm: () => {},
    },
    loading: {
      nodes: false,
      pagination: false,
    },
    resizing: {
      active: false,
      panel: null,
      startX: 0,
      startY: 0,
      startWidth: 0,
      startHeight: 0,
    },
    panels: {
      left: {
        visible: false,
        width: CONFIG.PANEL_SIZES.left.default,
        minWidth: CONFIG.PANEL_SIZES.left.min,
        maxWidth: CONFIG.PANEL_SIZES.left.max,
      },
      right: {
        visible: false,
        width: CONFIG.PANEL_SIZES.right.default,
        minWidth: CONFIG.PANEL_SIZES.right.min,
        maxWidth: CONFIG.PANEL_SIZES.right.max,
        height: CONFIG.PANEL_SIZES.rightSheet.default,
        minHeight: CONFIG.PANEL_SIZES.rightSheet.min,
        maxHeight: CONFIG.PANEL_SIZES.rightSheet.max,
      },
      bottom: {
        visible: false,
        height: CONFIG.PANEL_SIZES.bottom.default,
        minHeight: CONFIG.PANEL_SIZES.bottom.min,
        maxHeight: CONFIG.PANEL_SIZES.bottom.max,
      },
    },
    selectedNodeDetailsHtml: "",
    clusteringRadius: 5,
    clusteringUpdateTimeout: null,
    mouseMoveHandler: null,
    mouseUpHandler: null,
    touchMoveHandler: null,
    touchEndHandler: null,
    resizeHandler: null,
    initialized: false,

    // ---- orchestration methods ----

    // Get cached unique roles
    getUniqueRoles() {
      if (this.needsRoleUpdate || this.cachedRoles === null) {
        this.cachedRoles = new Set(
          Object.values(this.nodes)
            .map((node) => node.role)
            .filter(
              (role) => role !== null && role !== undefined && role !== "",
            ),
        );
        this.needsRoleUpdate = false;
      }
      return this.cachedRoles;
    },

    // Invalidate role cache when nodes change
    invalidateRoleCache() {
      this.needsRoleUpdate = true;
    },

    // Initialize application
    init() {
      if (this.initialized) {
        console.log("App already initialized, skipping...");
        return;
      }
      this.initialized = true;
      console.log("Initializing app...");

      const config = window.APP_CONFIG || {};
      this.clusteringRadius = config.CLUSTERING_RADIUS ?? 5;

      // Store initial version for comparison on reconnects
      this.storedVersion = config.GIT_COMMIT || null;

      this.initializeEventsSocket();

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          this.initMap();
          this.setupEventListeners();
          this.initializeCommitDisplay();
          this.setupPageUnloadHandlers();
          console.log("App initialized after DOM ready");
        });
      } else {
        this.initMap();
        this.setupEventListeners();
        this.initializeCommitDisplay();
        this.setupPageUnloadHandlers();
        console.log("App initialized immediately");
      }
    },

    // Setup global event listeners
    setupEventListeners() {
      // Map container can change size when browser window is resized
      this.resizeHandler = () => {
        if (this.map && this.map._container && this.map._loaded) {
          try {
            this.map.invalidateSize();
          } catch (error) {
            console.warn("Map resize failed:", error);
          }
        }
      };
      window.addEventListener("resize", this.resizeHandler);

      // Mouse move events update panel dimensions during resize operations
      this.mouseMoveHandler = (e) => {
        if (this.resizing && this.resizing.active) {
          this.handleResize(e);
        }
      };
      document.addEventListener("mousemove", this.mouseMoveHandler);

      this.touchMoveHandler = (e) => {
        if (this.resizing && this.resizing.active) {
          this.handleResize(e);
        }
      };
      document.addEventListener("touchmove", this.touchMoveHandler, {
        passive: false,
      });

      // Mouse up can occur anywhere on document, not just on resize handle
      this.mouseUpHandler = () => {
        if (this.resizing && this.resizing.active) {
          this.stopResize();
        }
      };
      document.addEventListener("mouseup", this.mouseUpHandler);

      this.touchEndHandler = () => {
        if (this.resizing && this.resizing.active) {
          this.stopResize();
        }
      };
      document.addEventListener("touchend", this.touchEndHandler);
      document.addEventListener("touchcancel", this.touchEndHandler);
    },

    // Cleanup event listeners and map resources
    cleanup() {
      console.log("Cleaning up app resources...");

      if (this.resizeHandler) {
        window.removeEventListener("resize", this.resizeHandler);
        this.resizeHandler = null;
      }

      if (this.mouseMoveHandler) {
        document.removeEventListener("mousemove", this.mouseMoveHandler);
        this.mouseMoveHandler = null;
      }
      if (this.mouseUpHandler) {
        document.removeEventListener("mouseup", this.mouseUpHandler);
        this.mouseUpHandler = null;
      }
      if (this.touchMoveHandler) {
        document.removeEventListener("touchmove", this.touchMoveHandler);
        this.touchMoveHandler = null;
      }
      if (this.touchEndHandler) {
        document.removeEventListener("touchend", this.touchEndHandler);
        document.removeEventListener("touchcancel", this.touchEndHandler);
        this.touchEndHandler = null;
      }

      if (this.map) {
        if (this.nodeLayer) {
          this.nodeLayer.clearLayers();
          this.map.removeLayer(this.nodeLayer);
        }
        if (this.networkLayer) {
          this.networkLayer.clearLayers();
          this.map.removeLayer(this.networkLayer);
        }
        if (this.traceLayer) {
          this.traceLayer.clearLayers();
          this.map.removeLayer(this.traceLayer);
        }

        this.map.remove();
        this.map = null;
      }

      if (this.eventsSocket) {
        try {
          this.eventsSocket.disconnect();
        } catch (error) {}
        this.eventsSocket = null;
      }

      this.rawLogStop();

      Object.values(this.markerFlashTimers).forEach((t) => {
        try {
          clearTimeout(t);
        } catch (e) {}
      });
      this.markerFlashTimers = {};

      if (this.wsIndicatorPulseTimer) {
        try {
          clearTimeout(this.wsIndicatorPulseTimer);
        } catch (e) {}
        this.wsIndicatorPulseTimer = null;
      }

      this.nodes = {};

      this.modal.visible = false;
      this.modal.title = "";
      this.modal.content = "";
      this.modal.onConfirm = () => {};

      this.resizing.active = false;
      this.resizing.panel = null;

      console.log("App cleanup completed");
    },

    // Setup page unload handlers for proper cleanup
    setupPageUnloadHandlers() {
      const handlePageUnload = () => { this.cleanup(); };
      const handleBeforeUnload = () => { this.cleanup(); };

      window.addEventListener("beforeunload", handleBeforeUnload);
      window.addEventListener("unload", handlePageUnload);

      const handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          // Optional: cleanup when tab becomes hidden
          // this.cleanup();
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      this._cleanupHandlers = {
        handlePageUnload,
        handleBeforeUnload,
        handleVisibilityChange,
      };
    },

    // Toggle panel visibility
    togglePanel(panelName) {
      this.panels[panelName].visible = !this.panels[panelName].visible;

      if (panelName === "bottom") {
        if (this.panels.bottom.visible) {
          this.rawLogStart();
        } else {
          this.rawLogStop();
        }
      }

      if (this.map) {
        this.map.invalidateSize();
      }
    },

    rawLogStart() {
      this.rawLogStatusText = "";
      this.rawLogScrollAttachAttempts = 0;
      this.rawLogEnsureScrollHandler();
      this.rawLogEnsurePacketsSocket();
    },

    rawLogStop() {
      this.rawLogTeardownScrollHandler();
      this.rawLogDisconnectPacketsSocket();
      this.rawLogPaused = false;
      this.rawLogBufferedCount = 0;
      this.rawLogPending = [];
      this.rawLogFlushScheduled = false;
      this.rawLogStatusText = "";
      this.rawLogScrollAttachAttempts = 0;
    },

    rawLogEnsurePacketsSocket() {
      const config = window.APP_CONFIG || {};
      const namespace = config.SOCKET_NAMESPACE_PACKETS || "/packets";

      if (this.packetsSocket && this.packetsSocket.connected) {
        return;
      }

      if (typeof io === "undefined") {
        this.rawLogStatusText = "Socket.IO missing";
        return;
      }

      try {
        console.log("Connecting to raw packet data");
        this.packetsSocket = io(namespace);
      } catch (e) {
        this.rawLogStatusText = "Connect failed";
        return;
      }

      this.packetsSocket.on("connect", () => {
        this.packetsSocketConnected = true;
        this.rawLogStatusText = "live";
        try {
          this.packetsSocket.emit("subscribe_packets");
        } catch (e) {}
      });

      this.packetsSocket.on("disconnect", () => {
        this.packetsSocketConnected = false;
        this.rawLogStatusText = "offline";
      });

      this.packetsSocket.on("packets", (packet) => {
        this.rawLogOnPacket(packet);
      });
    },

    rawLogDisconnectPacketsSocket() {
      if (!this.packetsSocket) return;
      try {
        this.packetsSocket.off("packets");
        this.packetsSocket.off("connect");
        this.packetsSocket.off("disconnect");
      } catch (e) {}

      try {
        this.packetsSocket.emit("unsubscribe_packets");
      } catch (e) {}

      try {
        console.log("Disconnecting from raw packet data");
        this.packetsSocket.disconnect();
      } catch (e) {}

      this.packetsSocket = null;
      this.packetsSocketConnected = false;
    },

    rawLogEnsureScrollHandler() {
      if (this.rawLogScrollHandler) return;

      this.rawLogScrollHandler = () => {
        if (!this.rawLogPauseWhenScrolledUp) {
          this.rawLogPaused = false;
          this.rawLogBufferedCount = 0;
          this.rawLogPending = [];
          return;
        }

        const el = document.getElementById("raw-log");
        if (!el) return;

        const thresholdPx = 20;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const atBottom = distanceFromBottom <= thresholdPx;

        if (atBottom && this.rawLogPaused) {
          return;
        }

        if (!atBottom) {
          this.rawLogPaused = true;
        }
      };

      const el = document.getElementById("raw-log");
      if (el) {
        el.addEventListener("scroll", this.rawLogScrollHandler, { passive: true });
        return;
      }

      const maxAttempts = 10;
      if (this.rawLogScrollAttachAttempts >= maxAttempts) {
        return;
      }
      this.rawLogScrollAttachAttempts += 1;
      requestAnimationFrame(() => this.rawLogEnsureScrollHandler());
    },

    rawLogTeardownScrollHandler() {
      const el = document.getElementById("raw-log");
      if (el && this.rawLogScrollHandler) {
        try {
          el.removeEventListener("scroll", this.rawLogScrollHandler);
        } catch (e) {}
      }
      this.rawLogScrollHandler = null;
    },

    rawLogOnPacket(packet) {
      if (!packet || typeof packet !== "object") return;

      this.rawLogRing.push(packet);
      if (this.rawLogRing.length > this.rawLogMaxRows) {
        this.rawLogRing.splice(0, this.rawLogRing.length - this.rawLogMaxRows);
      }

      if (this.rawLogPaused && this.rawLogPauseWhenScrolledUp) {
        this.rawLogPending.push(packet);
        this.rawLogBufferedCount = this.rawLogPending.length;
        return;
      }

      this.rawLogAppendPackets([packet]);
    },

    rawLogAppendPackets(packets) {
      if (!Array.isArray(packets) || !packets.length) return;
      const el = document.getElementById("raw-log");
      if (!el) return;

      if (this.rawLogFlushScheduled) {
        this.rawLogPending.push(...packets);
        this.rawLogBufferedCount = this.rawLogPending.length;
        return;
      }

      const toRender = packets;
      this.rawLogFlushScheduled = true;
      requestAnimationFrame(() => {
        try {
          const frag = document.createDocumentFragment();
          for (const p of toRender) {
            if (this.rawLogHideDuplicates && p.is_duplicate === true) continue;
            frag.appendChild(this.rawLogRenderLine(p));
          }

          el.appendChild(frag);
          while (el.children.length > this.rawLogMaxRows) {
            el.removeChild(el.firstChild);
          }
          el.scrollTop = el.scrollHeight;
        } finally {
          this.rawLogFlushScheduled = false;
          if (this.rawLogPending.length) {
            const more = this.rawLogPending.splice(0, this.rawLogPending.length);
            this.rawLogBufferedCount = 0;
            if (!this.rawLogPaused) {
              this.rawLogAppendPackets(more);
            } else {
              this.rawLogPending.push(...more);
              this.rawLogBufferedCount = this.rawLogPending.length;
            }
          }
        }
      });
    },

    rawLogRenderLine(p) {
      const row = document.createElement("div");
      row.className = "raw-log-row";

      const portClassMap = {
        NODEINFO_APP: "port-nodeinfo",
        TRACEROUTE_APP: "port-traceroute",
        TEXT_MESSAGE_APP: "port-textmsg",
        POSITION_APP: "port-position",
        ROUTING_APP: "port-routing",
        TELEMETRY_APP: "port-telemetry",
      };
      const portClass = portClassMap[p?.decoded?.portnum];
      if (portClass) row.classList.add(portClass);

      const safe = (v) => (v === null || v === undefined || v === "" ? "N/A" : String(v));

      const toHex = (n, digits) => {
        if (n === null || n === undefined) return null;
        const num = +n;
        if (!num && num !== 0) return null;
        try {
          return (BigInt(num)).toString(16).padStart(digits, "0");
        } catch (e) {
          return null;
        }
      };

      const formatTimestamp = (timeValue) => {
        if (!timeValue && timeValue !== 0) return "N/A";
        try {
          let date;
          if (typeof timeValue === "number") {
            date = new Date(timeValue * 1000);
          } else if (typeof timeValue === "string") {
            // Backend uses UTC (`datetime.now(timezone.utc)`), but JSON may serialize
            // datetimes without an explicit timezone. Normalize to UTC and then
            // render using browser local time.
            let s = timeValue.trim();

            // Convert "YYYY-MM-DD HH:MM:SS" -> ISO "YYYY-MM-DDTHH:MM:SS"
            if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
              s = s.replace(" ", "T");
            }

            const hasTimezone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
            if (!hasTimezone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
              s = `${s}Z`;
            }

            date = new Date(s);
          } else {
            return "Invalid";
          }

          if (Number.isNaN(date.getTime())) return "Invalid";
          return date.toLocaleString();
        } catch (e) {
          return "Invalid";
        }
      };

      const getNodeDisplayName = (nodeObj) => nodeObj?.name || nodeObj?.short_name || nodeObj?.long_name;

      const formatNodeWithName = (idText, nameText) => (nameText ? `${idText} (${nameText})` : idText);

      const fromHex = p?.from_ !== undefined ? toHex(p.from_, 8) : null;
      const fromId = fromHex ? `!${fromHex}` : "N/A";

      const toHexId = p?.to !== undefined ? toHex(p.to, 8) : null;
      const toId = p?.to === 4294967295 ? "BROADCAST" : (toHexId ? `!${toHexId}` : "N/A");
      const uplinkId = safe(p?.uplink);

      const fromDisplay = formatNodeWithName(fromId, getNodeDisplayName(p?.from_node));
      const toDisplay = toId === "BROADCAST" ? "BROADCAST" : formatNodeWithName(toId, getNodeDisplayName(p?.to_node));
      const uplinkDisplay = formatNodeWithName(uplinkId, getNodeDisplayName(p?.uplink_node));

      const processed = {
        received: formatTimestamp(p?.created_at),
        id_: safe(p?.id_),
        fromDisplay: safe(fromDisplay),
        toDisplay: safe(toDisplay),
        channel_name: safe(p?.channel_name),
        portnum: safe(p?.decoded?.portnum),
        relay_node: p?.relay_node !== null && p?.relay_node !== undefined ? (toHex(p.relay_node, 2) || "N/A") : "N/A",
        uplinkDisplay: safe(uplinkDisplay),
        next_hop: p?.next_hop !== null && p?.next_hop !== undefined ? (toHex(p.next_hop, 2) || "N/A") : "N/A",
      };

      const fields = [
        { label: "Received", value: processed.received },
        { label: "Message ID", value: processed.id_ },
        { label: "From", value: processed.fromDisplay, nodeId: p?.from_node?.id },
        { label: "To", value: processed.toDisplay, nodeId: p?.to_node?.id },
        { label: "Channel", value: processed.channel_name },
        { label: "Port", value: processed.portnum },
        { label: "Relay", value: processed.relay_node },
        { label: "MQTT Uplink", value: processed.uplinkDisplay, nodeId: p?.uplink_node?.id },
        { label: "Next Hop", value: processed.next_hop },
      ];

      const canLinkToNodeId = (nodeId) => {
        if (!nodeId || typeof nodeId !== "string") return false;
        if (!/^![0-9a-fA-F]{8}$/.test(nodeId)) return false;
        return !!this.nodes?.[nodeId];
      };

      for (const f of fields) {
        const cell = document.createElement("div");
        cell.className = "raw-log-cell";

        if (canLinkToNodeId(f.nodeId)) {
          const link = document.createElement("span");
          link.className = "raw-log-node-link";
          link.textContent = safe(f.value);
          link.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
              this.flyToNode(f.nodeId);
            } catch (err) {}
          });
          cell.appendChild(link);
        } else {
          cell.textContent = safe(f.value);
        }
        row.appendChild(cell);
      }

      const dupCell = document.createElement("div");
      dupCell.className = "raw-log-cell raw-log-right";
      if (p?.is_duplicate === true) {
        const badge = document.createElement("span");
        badge.className = "raw-log-dup";
        badge.textContent = "dup";
        dupCell.appendChild(badge);
      }
      row.appendChild(dupCell);
      return row;
    },

    rawLogClear() {
      const el = document.getElementById("raw-log");
      if (el) el.innerHTML = "";
      this.rawLogRing = [];
      this.rawLogPending = [];
      this.rawLogBufferedCount = 0;
      this.rawLogPaused = false;
    },

    rawLogResume() {
      const el = document.getElementById("raw-log");
      if (!el) return;

      this.rawLogPaused = false;
      const buffered = this.rawLogPending.splice(0, this.rawLogPending.length);
      this.rawLogBufferedCount = 0;
      if (buffered.length) {
        this.rawLogAppendPackets(buffered);
      } else {
        el.scrollTop = el.scrollHeight;
      }
    },

    rawLogRerender() {
      const el = document.getElementById("raw-log");
      if (!el) return;
      el.innerHTML = "";
      this.rawLogPaused = false;
      this.rawLogBufferedCount = 0;
      this.rawLogPending = [];
      this.rawLogAppendPackets(this.rawLogRing);
    },

    startResize(panelName, event) {
      if (!this.panels[panelName]) {
        console.warn(`Invalid panel: ${panelName}`);
        return;
      }

      if (panelName === "right") {
        const isMobile = window.matchMedia
          ? window.matchMedia("(max-width: 768px)").matches
          : window.innerWidth <= 768;
        if (!isMobile) return;
      }

      if (this.resizing.active) {
        console.warn("Resize already in progress");
        return;
      }

      const touch = event.touches?.[0] || event;
      if (!touch || typeof touch.clientX === "undefined") {
        console.warn("Invalid event coordinates");
        return;
      }

      this.resizing.active = true;
      this.resizing.panel = panelName;
      this.resizing.startX = touch.clientX;
      this.resizing.startY = touch.clientY;

      const panel = this.panels[panelName];
      this.resizing.startWidth =
        panel.width || CONFIG.PANEL_SIZES[panelName]?.default || 300;
      this.resizing.startHeight =
        panel.height || CONFIG.PANEL_SIZES[panelName]?.default || 200;

      document.body.style.userSelect = "none";
      document.body.style.cursor = this.getResizeCursor(panelName);

      if (event.preventDefault) {
        event.preventDefault();
      }
    },

    // Handle panel resizing
    handleResize(event) {
      if (!this.resizing || !this.resizing.active) return;

      const touch = event.touches?.[0] || event;
      if (!touch || typeof touch.clientX === "undefined") return;

      const panel = this.panels[this.resizing.panel];

      const isMobile = window.matchMedia
        ? window.matchMedia("(max-width: 768px)").matches
        : window.innerWidth <= 768;

      if (this.resizing.panel === "left") {
        const newWidth =
          this.resizing.startWidth + (touch.clientX - this.resizing.startX);
        panel.width = Math.max(panel.minWidth, Math.min(panel.maxWidth, newWidth));
      } else if (this.resizing.panel === "right") {
        if (isMobile) {
          const newHeight =
            this.resizing.startHeight - (touch.clientY - this.resizing.startY);
          panel.height = Math.max(panel.minHeight, Math.min(panel.maxHeight, newHeight));
        }
      } else if (this.resizing.panel === "bottom") {
        const newHeight =
          this.resizing.startHeight - (touch.clientY - this.resizing.startY);
        panel.height = Math.max(panel.minHeight, Math.min(panel.maxHeight, newHeight));
      }

      if (this.map && this.map._container && this.map._loaded) {
        try {
          this.map.invalidateSize();
        } catch (error) {
          console.warn("Map resize during panel resize failed:", error);
        }
      }

      if (event.preventDefault) {
        event.preventDefault();
      }
    },

    // Stop resizing
    stopResize() {
      if (!this.resizing) return;
      this.resizing.active = false;
      this.resizing.panel = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    },

    // Get resize cursor for panel
    getResizeCursor(panelName) {
      switch (panelName) {
        case "left":
          return "col-resize";
        case "right": {
          const isMobile = window.matchMedia
            ? window.matchMedia("(max-width: 768px)").matches
            : window.innerWidth <= 768;
          return isMobile ? "row-resize" : "default";
        }
        case "bottom":
          return "row-resize";
        default:
          return "default";
      }
    },

    // Show error message
    showError(errorType) {
      const errorMessages = {
        MAP_LOAD_FAILED:
          "Map library failed to load. Please check your internet connection and refresh the page.",
        MAP_INIT_FAILED: "Map initialization failed. Please refresh the page.",
        NODE_LOAD_FAILED: "Failed to load node data. Please refresh the page.",
        MODAL_FAILED: "Failed to open modal. Please try again.",
      };

      const message = errorMessages[errorType] || "An unexpected error occurred.";
      console.error(`${errorType}: ${message}`);

      if (errorMessages[errorType]) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "error-message";
        errorDiv.innerHTML = `
                    ${message}
                    <span class="close-btn" onclick="this.parentElement.remove()">×</span>
                `;
        document.body.appendChild(errorDiv);

        setTimeout(() => {
          if (errorDiv.parentNode) {
            errorDiv.parentNode.removeChild(errorDiv);
          }
        }, 5000);
      }
    },

    // Get modal configuration
    getModalConfig(type, data) {
      const configs = {
        "node-details": () => ({
          title: `Node ${sanitizeHtml(data.id)}`,
          content: `
                            <div class="space-y-2">
                                <div><strong>ID:</strong> ${sanitizeHtml(data.id)}</div>
                                <div><strong>Long Name:</strong> ${sanitizeHtml(data.long_name || data.name || "N/A")}</div>
                                <div><strong>Short Name:</strong> ${sanitizeHtml(data.short_name || "N/A")}</div>
                                <div><strong>Status:</strong> <span class="${data.online ? "text-green-600" : "text-red-600"}">${data.online ? "Online" : "Offline"}</span></div>
                                <div><strong>Last packet:</strong> ${sanitizeHtml(data.lastSeen)}</div>
                            </div>
                        `,
          onConfirm: () => this.closeModal(),
        }),
      };

      return configs[type]?.() || this.getDefaultModalConfig();
    },

    // Get default modal configuration
    getDefaultModalConfig() {
      return {
        title: "Unknown Modal",
        content: "<p>This modal type is not recognized.</p>",
        onConfirm: () => this.closeModal(),
      };
    },

    // Show modal
    showModal(type, data = {}) {
      try {
        document.body.classList.add("modal-open");
        const modalConfig = this.getModalConfig(type, data);
        Object.assign(this.modal, modalConfig);
        this.modal.visible = true;
      } catch (error) {
        console.error("Failed to show modal:", error);
        this.showError("MODAL_FAILED");
      }
    },

    // Close modal
    closeModal() {
      try {
        document.body.classList.remove("modal-open");
        this.modal.visible = false;
        this.modal.title = "";
        this.modal.content = "";
        this.modal.onConfirm = () => {};
      } catch (error) {
        console.error("Failed to close modal:", error);
      }
    },

    // Initialize commit display
    initializeCommitDisplay() {
      const commitElement = document.getElementById("commit-sha");
      if (!commitElement) return;

      if (!window.APP_CONFIG || typeof window.APP_CONFIG.GIT_COMMIT !== "string") {
        commitElement.textContent = "unknown version";
        return;
      }

      const gitCommit = window.APP_CONFIG.GIT_COMMIT.trim();
      if (!gitCommit) {
        commitElement.textContent = "unknown version";
        return;
      }

      const SHORT_SHA_LENGTH = 7;
      const isGitSha = /^[a-fA-F0-9]+$/.test(gitCommit);

      if (isGitSha) {
        const shortCommit =
          gitCommit.length >= SHORT_SHA_LENGTH
            ? gitCommit.substring(0, SHORT_SHA_LENGTH)
            : gitCommit;
        commitElement.textContent = shortCommit;
        commitElement.title = `Full commit: ${gitCommit}`;
      } else {
        commitElement.textContent =
          gitCommit === "(unknown version)" ? "unknown version" : gitCommit;
        commitElement.title = gitCommit;
      }
    },

    forceCleanup() {
      console.log("Force cleaning up app resources...");

      if (this._cleanupHandlers) {
        window.removeEventListener("beforeunload", this._cleanupHandlers.handleBeforeUnload);
        window.removeEventListener("unload", this._cleanupHandlers.handlePageUnload);
        document.removeEventListener("visibilitychange", this._cleanupHandlers.handleVisibilityChange);
        this._cleanupHandlers = null;
      }

      this.deselectNode();
      this.cleanup();
    },

  };
}

window.meshApp = meshApp;
