// Application configuration
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
    bottom: { default: 200, min: 100, max: 400 },
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

function meshApp() {
  return {
    // HTML sanitization to prevent XSS
    sanitizeHtml(str) {
      if (str === null || str === undefined) return "";
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    },

    isNodeMoving(position) {
      if (!position) return false;

      const speedKmph = this.getGroundSpeedKmph(position);
      const hasSpeed = speedKmph !== null && speedKmph > 0;
      const hasHeading =
        position.heading !== null && position.heading !== undefined;
      const ageHours = position.position_age_hours_ago;
      const isRecent =
        ageHours !== null &&
        ageHours !== undefined &&
        ageHours <= CONFIG.MOVEMENT.MAX_POSITION_AGE_HOURS;

      return hasSpeed && hasHeading && isRecent;
    },

    resyncMapLayersAfterZoom() {
      if (!this.map || !this.map._loaded) return;

      const run = () => {
        try {
          if (this.nodeLayer && typeof this.nodeLayer.refreshClusters === "function") {
            this.nodeLayer.refreshClusters();
          }
        } catch (error) {
          console.warn("Cluster refresh failed after zoom:", error);
        }

        try {
          Object.values(this.nodes).forEach((node) => {
            const marker = node?.marker;
            if (!marker) return;
            if (typeof marker.update === "function") {
              marker.update();
            }
            if (typeof marker.redraw === "function") {
              marker.redraw();
            }
          });
        } catch (error) {
          console.warn("Marker refresh failed after zoom:", error);
        }

        try {
          if (this.selectedNodeHistoryLayer) {
            this.selectedNodeHistoryLayer.eachLayer((layer) => {
              if (typeof layer.update === "function") {
                layer.update();
              }
              if (typeof layer.redraw === "function") {
                layer.redraw();
              }
            });
          }
        } catch (error) {
          console.warn("History layer refresh failed after zoom:", error);
        }

        if (
          this.selectedNodeId &&
          this.selectedNodeHistory?.length &&
          !this.selectedNodeHistoryLayer
        ) {
          this.renderNodeHistory();
        }
      };

      try {
        requestAnimationFrame(() => requestAnimationFrame(run));
      } catch (error) {
        run();
      }
    },

    // Map instance
    map: null,

    // Map state
    isZooming: false,

    // Node management
    nodes: {},
    nodeLayer: null,
    nodeSearchQuery: "",
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
    telemetryWindow: 24,  // Default to 24 hours

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

    // Convert degrees to compass direction
    getCompassDirection(degrees) {
      const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
      const index = Math.round(degrees / 45) % 8;
      return directions[index];
    },

    // Invalidate role cache when nodes change
    invalidateRoleCache() {
      this.needsRoleUpdate = true;
    },
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
    // Clustering control
    clusteringRadius: 5, // Default value, will be updated from config
    clusteringUpdateTimeout: null,
    mouseMoveHandler: null,
    mouseUpHandler: null,
    touchMoveHandler: null,
    touchEndHandler: null,

    // Initialize application
    init() {
      if (this.initialized) {
        console.log("App already initialized, skipping...");
        return;
      }
      this.initialized = true;
      console.log("Initializing app...");

      // Initialize clustering radius from config
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

    initializeEventsSocket() {
      const config = window.APP_CONFIG || {};
      const namespace = config.SOCKET_NAMESPACE_EVENTS || "/events";

      if (this.eventsSocket && this.eventsSocket.connected) {
        console.log("Events socket already connected");
        return; // Already connected
      }
      try {
        if (typeof io === "undefined") {
          console.warn("Socket.IO client not loaded; realtime events disabled");
          return;
        }
        this.eventsSocket = io(namespace);
        this.eventsSocket.on("connect", () => {
          console.log("Connected to events socket", namespace);
          this.socketConnected = true;
          if (this.eventsSocketHasConnectedOnce) {
            this.reloadNodes();
          }
          this.eventsSocketHasConnectedOnce = true;
        });
        this.eventsSocket.on("disconnect", () => {
          console.log("Disconnected from events socket");
          this.socketConnected = false;
        });
        this.eventsSocket.on("event", (evt) => {
          this.pulseWebsocketIndicator();
          this.handleRealtimeEvent(evt);

          // Handle version events for auto-refresh
          if (evt.type === "version" && evt.payload && evt.payload.git_commit) {
            this.handleVersionEvent(evt.payload.git_commit);
          }
        });
      } catch (error) {
        console.error("Failed to initialize events socket:", error);
      }
    },

    pulseWebsocketIndicator() {
      const config = window.APP_CONFIG || {};
      if (!config.EVENT_ANIMATIONS_ENABLED) return;

      const now = Date.now();
      const throttleMs = 200;
      if (now - this.wsIndicatorLastPulseAtMs < throttleMs) return;
      this.wsIndicatorLastPulseAtMs = now;

      const dot = document.getElementById("ws-indicator-dot");
      if (!dot) return;

      if (this.wsIndicatorPulseTimer) {
        try {
          clearTimeout(this.wsIndicatorPulseTimer);
        } catch (e) {}
        this.wsIndicatorPulseTimer = null;
      }

      try {
        dot.classList.remove("ws-indicator-pulse");
      } catch (e) {
        return;
      }

      try {
        requestAnimationFrame(() => {
          try {
            dot.classList.add("ws-indicator-pulse");
          } catch (e) {}
        });
      } catch (error) {
        try {
          dot.classList.add("ws-indicator-pulse");
        } catch (e) {}
      }

      this.wsIndicatorPulseTimer = setTimeout(() => {
        try {
          dot.classList.remove("ws-indicator-pulse");
        } catch (e) {}
        this.wsIndicatorPulseTimer = null;
      }, 300);
    },

    async reloadNodes() {
      console.warn("reloadNodes() called");
      if (!this.map || !this.map._loaded || !this.nodeLayer) return;
      if (this.loading.nodes) return;

      const existingCenter = this.map.getCenter?.();
      const existingZoom = this.map.getZoom?.();

      Object.values(this.markerFlashTimers).forEach((t) => {
        try {
          clearTimeout(t);
        } catch (e) {}
      });
      this.markerFlashTimers = {};

      try {
        this.nodeLayer.clearLayers();
      } catch (error) {}

      this.clearSelectedNodeHistoryLayer();

      this.nodes = {};
      this.invalidateRoleCache();

      try {
        await this.loadNodes({ fitBounds: false });
      } finally {
        if (existingCenter && existingZoom != null) {
          try {
            this.map.setView(existingCenter, existingZoom, { animate: false });
          } catch (error) {}
        }
      }
    },

    handleVersionEvent(receivedVersion) {
      console.log("Version event received:", receivedVersion, "stored:", this.storedVersion);

      // Only check version on reconnects (not initial connection)
      if (this.eventsSocketHasConnectedOnce && this.storedVersion !== null) {
        if (receivedVersion !== this.storedVersion) {
          console.log("Version mismatch detected, refreshing page...");
          location.reload();
        } else {
          console.log("Version matches, no refresh needed");
        }
      }

      // Update stored version for next comparison
      this.storedVersion = receivedVersion;
    },

    handleRealtimeEvent(evt) {
      if (!evt || typeof evt !== "object") return;
      const nodeId = evt.id;
      if (!nodeId) return;

      if (!this.nodes[nodeId]) {
        this.nodes[nodeId] = { id: nodeId, role: "CLIENT" };
      }
      this.nodes[nodeId].info = {
        ...(this.nodes[nodeId].info || {}),
        status: "currently_active",
        last_seen_hours_ago: 0,
      };
      if (this.nodes[nodeId].marker) {
        this.refreshNodeMarker(nodeId);
      }

      const type = evt.type;
      try {
        if (type === "position") {
          const position = evt.payload?.position;
          if (
            !position ||
            position.latitude == null ||
            position.longitude == null
          )
            return;

          if (!this.nodes[nodeId] || !this.nodes[nodeId].marker) {
            const nodeData = evt.payload?.node || {};

            const placeholderNode = {
              id: nodeId,
              position: position,
              info: {
                ...(this.nodes[nodeId].info || {}),
                status: "currently_active",
                last_seen_hours_ago: 0,
              },
              role: nodeData.role || "CLIENT",
              last_channel: nodeData.last_channel,
              last_channel_name: nodeData.last_channel_name,
            };
            this.addNodeToMap(placeholderNode);
          } else {
            this.updateNodePosition(nodeId, position);
            // Update existing node with latest channel info if available
            const nodeData = evt.payload?.node;
            if (nodeData && this.nodes[nodeId]) {
              if (nodeData.last_channel !== undefined) {
                this.nodes[nodeId].last_channel = nodeData.last_channel;
              }
              if (nodeData.last_channel_name !== undefined) {
                this.nodes[nodeId].last_channel_name =
                  nodeData.last_channel_name;
              }
            }

            // Append to history if this node is selected
            this.appendRealtimePosition(nodeId, position);
          }

          this.flashNodeMarker(nodeId);
          return;
        }

        if (type === "nodeinfo") {
          const nodeinfo = evt.payload?.nodeinfo;
          if (!nodeinfo || typeof nodeinfo !== "object") return;

          if (!this.nodes[nodeId]) {
            this.nodes[nodeId] = { id: nodeId, role: "CLIENT" };
          }

          const node = this.nodes[nodeId];
          if (nodeinfo.short_name !== undefined)
            node.short_name = nodeinfo.short_name;
          if (nodeinfo.long_name !== undefined)
            node.long_name = nodeinfo.long_name;
          if (nodeinfo.hw_model !== undefined)
            node.hw_model = nodeinfo.hw_model;
          if (nodeinfo.role !== undefined && nodeinfo.role !== null)
            node.role = nodeinfo.role;
          if (nodeinfo.is_unmessagable !== undefined)
            node.info = {
              ...(node.info || {}),
              is_unmessagable: nodeinfo.is_unmessagable,
            };

          this.invalidateRoleCache();
          if (node.marker) {
            this.refreshNodeMarker(nodeId);
            this.flashNodeMarker(nodeId);
          }
        }
      } catch (error) {
        console.error("Failed to handle realtime event:", error);
      }
    },

    refreshNodeMarker(nodeId) {
      const node = this.nodes[nodeId];
      if (!node || !node.marker) return;

      const shouldShowDirection = this.isNodeMoving(node.position);

      // Use the same helper method for consistency
      this.updateNodeIcon(node, shouldShowDirection);

      try {
        if (typeof node.marker.getPopup === "function" && node.marker.getPopup()) {
          node.marker.setPopupContent(this.createNodePopup(node));
        }
      } catch (error) {}
    },

    // Find the cluster marker that contains a specific node using official MarkerCluster API
    findClusterForNode(nodeId) {
      const nodeMarker = this.nodes[nodeId]?.marker;
      if (!nodeMarker || !this.nodeLayer) return null;

      // Check if the node marker is currently visible (not clustered)
      if (nodeMarker.getElement()) return null;

      // Use official MarkerCluster API to find the containing cluster
      try {
        // Method 1: getVisibleParent() - finds the visible parent cluster
        if (typeof this.nodeLayer.getVisibleParent === "function") {
          const parentCluster = this.nodeLayer.getVisibleParent(nodeMarker);
          if (parentCluster) return parentCluster;
        }

        // Method 2: _groupOrZoom() - internal method to find grouping
        if (typeof this.nodeLayer._groupOrZoom === "function") {
          const result = this.nodeLayer._groupOrZoom(nodeMarker);
          if (result && result._childCount) return result;
        }
      } catch (error) {
        console.warn("Error finding cluster:", error);
      }

      return null;
    },

    flashIndividualMarker(iconEl, nodeId) {
      const config = window.APP_CONFIG || {};
      const flashMs = config.EVENT_FLASH_MS || 2000;

      const wrapper = iconEl.querySelector(".node-icon");
      if (!wrapper) return;

      wrapper.classList.add("flash");
      if (this.markerFlashTimers[nodeId]) {
        clearTimeout(this.markerFlashTimers[nodeId]);
      }
      this.markerFlashTimers[nodeId] = setTimeout(() => {
        try {
          wrapper.classList.remove("flash");
        } catch (e) {}
        delete this.markerFlashTimers[nodeId];
      }, flashMs);
    },

    flashClusterMarker(cluster, nodeId) {
      const config = window.APP_CONFIG || {};
      const flashMs = config.EVENT_FLASH_MS || 2000;

      const iconEl = cluster.getElement?.();
      if (!iconEl) return;

      // Try different selectors to find the cluster icon
      const wrapper = iconEl.querySelector(".cluster-icon") || iconEl;

      wrapper.classList.add("cluster-flash");

      if (this.markerFlashTimers[nodeId]) {
        clearTimeout(this.markerFlashTimers[nodeId]);
      }
      this.markerFlashTimers[nodeId] = setTimeout(() => {
        try {
          wrapper.classList.remove("cluster-flash");
        } catch (e) {}
        delete this.markerFlashTimers[nodeId];
      }, flashMs);
    },

    flashNodeMarker(nodeId) {
      const node = this.nodes[nodeId];
      if (!node || !node.marker) return;

      // Try individual marker flash first
      const iconEl = node.marker.getElement?.();
      if (iconEl) {
        this.flashIndividualMarker(iconEl, nodeId);
        return;
      }

      // Node is clustered - find and flash cluster
      const cluster = this.findClusterForNode(nodeId);
      if (cluster) {
        this.flashClusterMarker(cluster, nodeId);
      }
    },

    // Initialize Leaflet map
    initMap(retryCount = 0) {
      try {
        const retryText = retryCount > 0 ? ` (attempt ${retryCount + 1})` : "";
        console.log("Initializing map..." + retryText);

        const mapContainer = document.getElementById("map");
        if (!mapContainer) {
          console.error("Map container not found - DOM may not be ready");
          if (retryCount < 5) {
            setTimeout(() => this.initMap(retryCount + 1), 100);
          } else {
            console.error("Map initialization failed after 5 attempts");
            this.showError("Map container not found. Please refresh the page.");
          }
          return;
        }

        if (this.map) {
          console.log("Map already initialized, skipping...");
          return;
        }

        if (typeof L === "undefined") {
          throw new Error("LEAFLET_NOT_LOADED");
        }

        this.map = L.map("map", {
          center: CONFIG.DEFAULT_MAP_CENTER,
          zoom: CONFIG.DEFAULT_ZOOM,
          scrollWheelZoom: true,
        });

        this.map._loaded = true;

        // Leaflet Popup has a bug where _animateZoom can be called after popup is removed
        // This causes "Cannot read properties of null (reading '_map')" errors during zoom
        // Patching prevents crashes when popups are closed during zoom animations
        const originalPopupInit = L.Popup.prototype._animateZoom;
        if (originalPopupInit) {
          L.Popup.prototype._animateZoom = function () {
            if (!this._map) return;
            return originalPopupInit.call(this);
          };
        }

        const originalMarkerAnimateZoom = L.Marker.prototype._animateZoom;
        if (originalMarkerAnimateZoom) {
          L.Marker.prototype._animateZoom = function (opt) {
            if (!this._map) return;
            return originalMarkerAnimateZoom.call(this, opt);
          };
        }

        const originalTooltipAnimateZoom = L.Tooltip?.prototype?._animateZoom;
        if (originalTooltipAnimateZoom) {
          L.Tooltip.prototype._animateZoom = function (opt) {
            if (!this._map) return;
            return originalTooltipAnimateZoom.call(this, opt);
          };
        }

        const originalPopupAnimateZoom = L.Popup?.prototype?._animateZoom;
        if (originalPopupAnimateZoom) {
          L.Popup.prototype._animateZoom = function (opt) {
            if (!this._map) return;
            return originalPopupAnimateZoom.call(this, opt);
          };
        }

        const originalTooltipUpdatePosition = L.Tooltip?.prototype?._updatePosition;
        if (originalTooltipUpdatePosition) {
          L.Tooltip.prototype._updatePosition = function () {
            if (!this._map) return;
            return originalTooltipUpdatePosition.call(this);
          };
        }

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: " OpenStreetMap contributors",
          maxZoom: 18,
        }).addTo(this.map);

        // Initialize layers
        this.initializeNodeLayer();
        this.networkLayer = L.layerGroup().addTo(this.map);
        this.traceLayer = L.layerGroup().addTo(this.map);

        // Add zoom event handlers
        this.map.on("zoomstart", () => {
          this.isZooming = true;

          this.zoomStartedWithOpenPopup = !!this.map?._popup;

          // Close popups during zoom to prevent "Cannot read properties of null" errors
          // Leaflet popups can crash if they try to update while the map is zooming
          this.map.closePopup();
        });

        this.map.on("zoomend", () => {
          this.isZooming = false;

          this.zoomStartedWithOpenPopup = false;
          this.resyncMapLayersAfterZoom();

          const queued = this.pendingNodePositionUpdates;
          this.pendingNodePositionUpdates = {};
          Object.entries(queued).forEach(([nodeId, position]) => {
            try {
              this.updateNodePosition(nodeId, position);
            } catch (error) {
              console.warn("Failed to apply queued node position update:", error);
            }
          });
          // Prevent popup creation during zoom animations
          // Popups created during zoom can have incorrect positioning
        });

        // Handle map clicks to deselect node and remove precision circle/history
        this.map.on("click", (e) => {
          const target = e?.originalEvent?.target;
          if (!(target instanceof Element)) {
            this.deselectNode();
            this.panels.right.visible = false;
            return;
          }

          // Check if click was on a marker or its popup
          const markerElement = target.closest(".leaflet-marker-icon, .leaflet-popup");
          if (!markerElement) {
            this.deselectNode();
            this.panels.right.visible = false;
          }
        });

        // disable legend for now
        // this.addStatusLegend();

        console.log("Map initialized successfully");

        setTimeout(() => {
          this.loadNodes();
        }, CONFIG.API.MAP_INIT_DELAY);
        // Delay node loading to ensure map is fully rendered
        // Loading nodes too early can cause positioning issues and performance problems
      } catch (error) {
        console.error("Failed to initialize map:", error);

        if (error.message === "LEAFLET_NOT_LOADED" && retryCount < 2) {
          console.warn("Leaflet not loaded, will retry...");
          setTimeout(() => this.initMap(retryCount + 1), 500);
        } else {
          this.showError("MAP_LOAD_FAILED");
        }
      }
    },

    // Initialize node layer with clustering
    initializeNodeLayer() {
      const config = window.APP_CONFIG || {};
      const clusteringRadius = config.CLUSTERING_RADIUS ?? 0;

      this.nodeLayer = L.markerClusterGroup({
        maxClusterRadius: clusteringRadius, // 0 = spiderfying only, >0 = clustering
        spiderfyOnMaxZoom: true,
        zoomToBoundsOnClick: true,
        iconCreateFunction: this.createClusterIcon.bind(this),
        spiderfyDistanceMultiplier: 1.2,
        maxSpiderfySizeMultiplier: 1.5,
      });

      this.nodeLayer.addTo(this.map);
    },

    // Update clustering radius from slider
    updateClusteringRadius() {
      // Clear any pending update
      if (this.clusteringUpdateTimeout) {
        clearTimeout(this.clusteringUpdateTimeout);
      }

      // Debounce updates to avoid excessive recreation during dragging
      this.clusteringUpdateTimeout = setTimeout(() => {
        this.recreateNodeLayer();
      }, 100);
    },

    // Recreate node layer with new clustering radius
    recreateNodeLayer() {
      if (!this.map || !this.nodeLayer) return;

      const oldLayer = this.nodeLayer;

      const currentMarkers = [];
      oldLayer.eachLayer((layer) => {
        currentMarkers.push(layer);
      });

      const newLayer = L.markerClusterGroup({
        maxClusterRadius: parseInt(this.clusteringRadius),
        spiderfyOnMaxZoom: true,
        zoomToBoundsOnClick: true,
        iconCreateFunction: this.createClusterIcon.bind(this),
        spiderfyDistanceMultiplier: 1.2,
        maxSpiderfySizeMultiplier: 1.5,
      });

      currentMarkers.forEach((marker) => {
        try {
          oldLayer.removeLayer(marker);
        } catch (error) {}
        newLayer.addLayer(marker);
      });

      this.map.addLayer(newLayer);
      this.map.removeLayer(oldLayer);
      this.nodeLayer = newLayer;

      try {
        if (typeof this.nodeLayer.refreshClusters === "function") {
          this.nodeLayer.refreshClusters();
        }
      } catch (error) {
        console.warn("Cluster refresh failed:", error);
      }

      try {
        this.map.invalidateSize();
      } catch (error) {
        console.warn("Map invalidateSize failed:", error);
      }

      try {
        requestAnimationFrame(() => {
          if (this.map) {
            this.map.invalidateSize();
          }
        });
      } catch (error) {
        console.warn("Deferred map invalidateSize failed:", error);
      }
    },

    // Create custom cluster icons
    createClusterIcon(cluster) {
      const count = cluster.getChildCount();
      const size = 35; // Same size as individual node icons

      return L.divIcon({
        html: `<div class="cluster-icon" style="width: ${size}px; height: ${size}px; font-size: 12px;">${count}</div>`,
        className: "custom-cluster-marker",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    },

    // Setup global event listeners
    setupEventListeners() {
      // Handle window resize to keep map properly sized
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

      // Track mouse movement for panel resizing functionality
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

      // Handle mouse up to end resize operations
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

    // Cleanup event listeners
    cleanup() {
      console.log("Cleaning up app resources...");

      // Remove window event listeners
      if (this.resizeHandler) {
        window.removeEventListener("resize", this.resizeHandler);
        this.resizeHandler = null;
      }

      // Remove document event listeners
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

      // Clean up map resources
      if (this.map) {
        // Remove all layers
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

        // Remove map from container
        this.map.remove();
        this.map = null;
      }

      if (this.eventsSocket) {
        try {
          this.eventsSocket.disconnect();
        } catch (error) {}
        this.eventsSocket = null;
      }

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

      // Clear node references
      this.nodes = {};

      // Clear modal state
      this.modal.visible = false;
      this.modal.title = "";
      this.modal.content = "";
      this.modal.onConfirm = () => {};

      // Reset resizing state
      this.resizing.active = false;
      this.resizing.panel = null;

      console.log("App cleanup completed");
    },

    // Setup page unload handlers for proper cleanup
    setupPageUnloadHandlers() {
      // Handle page unload
      const handlePageUnload = () => {
        this.cleanup();
      };

      // Handle before unload (when user navigates away)
      const handleBeforeUnload = () => {
        this.cleanup();
      };

      // Add event listeners for cleanup
      window.addEventListener("beforeunload", handleBeforeUnload);
      window.addEventListener("unload", handlePageUnload);

      // Also handle visibility change (tab switching)
      const handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          // Optional: cleanup when tab becomes hidden
          // this.cleanup();
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);

      // Store cleanup handlers for potential manual removal
      this._cleanupHandlers = {
        handlePageUnload,
        handleBeforeUnload,
        handleVisibilityChange,
      };
    },

    // Toggle panel visibility
    togglePanel(panelName) {
      this.panels[panelName].visible = !this.panels[panelName].visible;

      // Resize map immediately since animations were removed
      if (this.map) {
        this.map.invalidateSize();
      }
    },

    // Start resizing a panel
    startResize(panelName, event) {
      // Input validation
      if (!this.panels[panelName]) {
        console.warn(`Invalid panel: ${panelName}`);
        return;
      }

      if (panelName === "right") {
        const isMobile = window.matchMedia
          ? window.matchMedia("(max-width: 768px)").matches
          : window.innerWidth <= 768;
        if (!isMobile) {
          return;
        }
      }

      if (this.resizing.active) {
        console.warn("Resize already in progress");
        return;
      }

      // Handle both mouse and touch events
      const touch = event.touches?.[0] || event;
      if (!touch || typeof touch.clientX === "undefined") {
        console.warn("Invalid event coordinates");
        return;
      }

      this.resizing.active = true;
      this.resizing.panel = panelName;
      this.resizing.startX = touch.clientX;
      this.resizing.startY = touch.clientY;

      // Safely access panel dimensions with defaults
      const panel = this.panels[panelName];
      this.resizing.startWidth =
        panel.width || CONFIG.PANEL_SIZES[panelName]?.default || 300;
      this.resizing.startHeight =
        panel.height || CONFIG.PANEL_SIZES[panelName]?.default || 200;

      // Prevent text selection during resize
      document.body.style.userSelect = "none";
      document.body.style.cursor = this.getResizeCursor(panelName);

      // Prevent default touch behavior
      if (event.preventDefault) {
        event.preventDefault();
      }
    },

    // Handle panel resizing
    handleResize(event) {
      if (!this.resizing || !this.resizing.active) return;

      // Handle both mouse and touch events
      const touch = event.touches?.[0] || event;
      if (!touch || typeof touch.clientX === "undefined") return;

      const panel = this.panels[this.resizing.panel];

      const isMobile = window.matchMedia
        ? window.matchMedia("(max-width: 768px)").matches
        : window.innerWidth <= 768;

      if (this.resizing.panel === "left") {
        const newWidth =
          this.resizing.startWidth + (touch.clientX - this.resizing.startX);
        panel.width = Math.max(
          panel.minWidth,
          Math.min(panel.maxWidth, newWidth),
        );
      } else if (this.resizing.panel === "right") {
        if (isMobile) {
          const newHeight =
            this.resizing.startHeight - (touch.clientY - this.resizing.startY);
          panel.height = Math.max(
            panel.minHeight,
            Math.min(panel.maxHeight, newHeight),
          );
        }
      } else if (this.resizing.panel === "bottom") {
        const newHeight =
          this.resizing.startHeight - (touch.clientY - this.resizing.startY);
        panel.height = Math.max(
          panel.minHeight,
          Math.min(panel.maxHeight, newHeight),
        );
      }

      // Resize map during resize
      if (this.map && this.map._container && this.map._loaded) {
        try {
          this.map.invalidateSize();
        } catch (error) {
          console.warn("Map resize during panel resize failed:", error);
        }
      }

      // Prevent default touch behavior during resize
      // Touch devices can have conflicting scroll/resize gestures
      if (event.preventDefault) {
        event.preventDefault();
      }
    },

    // Stop resizing
    stopResize() {
      if (!this.resizing) return;

      this.resizing.active = false;
      this.resizing.panel = null;

      // Restore normal cursor and text selection after resize
      // Resize operation disables these for better UX, must restore when done
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

      const message =
        errorMessages[errorType] || "An unexpected error occurred.";
      console.error(`${errorType}: ${message}`);

      // Show user-facing error for critical issues
      if (errorMessages[errorType]) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "error-message";
        errorDiv.innerHTML = `
                    ${message}
                    <span class="close-btn" onclick="this.parentElement.remove()">×</span>
                `;
        document.body.appendChild(errorDiv);

        // Auto-remove after 5 seconds
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
        "node-details": () => {
          return {
            title: `Node ${this.sanitizeHtml(data.id)}`,
            content: `
                            <div class="space-y-2">
                                <div><strong>ID:</strong> ${this.sanitizeHtml(data.id)}</div>
                                <div><strong>Long Name:</strong> ${this.sanitizeHtml(data.long_name || data.name || "N/A")}</div>
                                <div><strong>Short Name:</strong> ${this.sanitizeHtml(data.short_name || "N/A")}</div>
                                <div><strong>Status:</strong> <span class="${data.online ? "text-green-600" : "text-red-600"}">${data.online ? "Online" : "Offline"}</span></div>
                                <div><strong>Last packet:</strong> ${this.sanitizeHtml(data.lastSeen)}</div>
                            </div>
                        `,
            onConfirm: () => this.closeModal(),
          };
        },
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
        // Add modal-open class to body
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
        // Remove modal-open class from body
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

      // Validate config structure
      if (
        !window.APP_CONFIG ||
        typeof window.APP_CONFIG.GIT_COMMIT !== "string"
      ) {
        commitElement.textContent = "unknown version";
        return;
      }

      const gitCommit = window.APP_CONFIG.GIT_COMMIT.trim();
      if (!gitCommit) {
        commitElement.textContent = "unknown version";
        return;
      }

      // Configuration: length of short SHA (standard git default is 7)
      const SHORT_SHA_LENGTH = 7;

      // Check if it looks like a git SHA (hexadecimal string)
      const isGitSha = /^[a-fA-F0-9]+$/.test(gitCommit);

      if (isGitSha) {
        // Shorten to specified length
        const shortCommit =
          gitCommit.length >= SHORT_SHA_LENGTH
            ? gitCommit.substring(0, SHORT_SHA_LENGTH)
            : gitCommit;
        commitElement.textContent = shortCommit;
        commitElement.title = `Full commit: ${gitCommit}`;
      } else {
        // Not a SHA, show as-is with "unknown version" fallback
        commitElement.textContent =
          gitCommit === "(unknown version)" ? "unknown version" : gitCommit;
        commitElement.title = gitCommit;
      }
    },

    // API utility functions
    buildApiUrl(params = {}) {
      const queryParams = new URLSearchParams();

      // Add includes
      const includes = params.includes || CONFIG.API.DEFAULT_INCLUDES;
      queryParams.append("include", includes.join(","));

      // Add filters
      const filters = { ...CONFIG.API.DEFAULT_FILTERS, ...params.filters };
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          queryParams.append(key, value.toString());
        }
      });

      // Add pagination
      if (params.limit) {
        queryParams.append(
          "limit",
          Math.min(params.limit, CONFIG.API.MAX_LIMIT),
        );
      } else {
        queryParams.append("limit", CONFIG.API.DEFAULT_LIMIT);
      }

      if (params.offset) {
        queryParams.append("offset", params.offset);
      }

      return `/api/nodes?${queryParams.toString()}`;
    },
    async loadNodes(options = {}) {
      try {
        this.loading.nodes = true;
        console.log("Loading nodes...");
        const url = this.buildApiUrl();
        const response = await fetch(url);
        const data = await response.json();

        console.log(`Loaded ${data.nodes.length} nodes`);

        // Add nodes to map
        data.nodes.forEach((node) => {
          this.addNodeToMap(node);
        });

        // Handle pagination iteratively to prevent stack overflow
        await this.loadAllPages(data);

        // Fit map to show all nodes
        if (
          options.fitBounds !== false &&
          this.nodeLayer.getLayers().length > 0 &&
          this.map &&
          this.map._loaded
        ) {
          try {
            const group = L.featureGroup(this.nodeLayer.getLayers());

            // On mobile, ensure map is properly sized before fitting bounds
            const isMobile = window.innerWidth <= 768;

            const fitBoundsWithFallback = (retryCount = 0) => {
              try {
                if (
                  this.map &&
                  this.map._loaded &&
                  this.nodeLayer.getLayers().length > 0
                ) {
                  const currentGroup = L.featureGroup(
                    this.nodeLayer.getLayers(),
                  );
                  const bounds = currentGroup.getBounds();
                  this.map.fitBounds(bounds.pad(0.1));
                }
              } catch (error) {
                // Retry on mobile up to 3 times with increasing delays
                if (isMobile && retryCount < 3) {
                  const delay = 200 * (retryCount + 1); // 200ms, 400ms, 600ms
                  setTimeout(
                    () => fitBoundsWithFallback(retryCount + 1),
                    delay,
                  );
                }
              }
            };

            if (isMobile) {
              // Invalidate map size to recalculate container dimensions
              this.map.invalidateSize();

              // Start fitting bounds with fallback
              setTimeout(() => fitBoundsWithFallback(), 100);
            } else {
              // Desktop - fit bounds immediately
              fitBoundsWithFallback();
            }
          } catch (error) {
            console.warn("Failed to setup map bounds fitting:", error);
          }
        }
        // Load nodes that have no position (not on map, but shown in node list)
        await this.loadPositionlessNodes();
      } catch (error) {
        console.error("Failed to load initial nodes:", error);
        this.showError("NODE_LOAD_FAILED");
      } finally {
        this.loading.nodes = false;
      }
    },

    async loadPositionlessNodes() {
      // Fetch all nodes (has_position=false means no filter), store only those
      // not already loaded (i.e. nodes without any recorded position)
      const url = this.buildApiUrl({
        includes: ["info"],
        filters: { has_position: false, active: false },
      });
      const response = await fetch(url);
      const data = await response.json();

      data.nodes.forEach((node) => {
        if (!this.nodes[node.id]) {
          this.nodes[node.id] = node;
          this.invalidateRoleCache();
        }
      });

      let hasMore = data.pagination.has_more;
      let offset = data.pagination.next_offset;
      const maxPages = 50;
      let pageCount = 1;

      while (hasMore && pageCount < maxPages) {
        const pageUrl = this.buildApiUrl({
          includes: ["info"],
          filters: { has_position: false, active: false },
          offset,
        });
        const pageResponse = await fetch(pageUrl);
        const pageData = await pageResponse.json();

        pageData.nodes.forEach((node) => {
          if (!this.nodes[node.id]) {
            this.nodes[node.id] = node;
            this.invalidateRoleCache();
          }
        });

        hasMore = pageData.pagination.has_more;
        offset = pageData.pagination.next_offset;
        pageCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      console.log(`Loaded ${pageCount} page(s) of position-less nodes`);
    },

    async loadAllPages(initialData) {
      let offset = initialData.pagination.next_offset;
      let hasMore = initialData.pagination.has_more;
      let pageCount = 1;
      const maxPages = 50; // Prevent infinite loops

      while (hasMore && pageCount < maxPages) {
        console.log(`Loading page ${pageCount + 1}...`);

        const url = this.buildApiUrl({ offset });
        const response = await fetch(url);
        const data = await response.json();

        data.nodes.forEach((node) => {
          this.addNodeToMap(node);
        });

        hasMore = data.pagination.has_more;
        offset = data.pagination.next_offset;
        pageCount++;

        // Small delay to prevent overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (pageCount >= maxPages) {
        console.warn("Reached maximum page limit, stopping pagination");
      } else {
        console.log(`Loaded ${pageCount} pages total`);
      }
    },

    filteredNodes() {
      const query = (this.nodeSearchQuery || "").toLowerCase().trim();
      let result = Object.values(this.nodes);
      if (query) {
        result = result.filter(
          (n) =>
            (n.short_name || "").toLowerCase().includes(query) ||
            (n.long_name || "").toLowerCase().includes(query) ||
            String(n.id || "").toLowerCase().includes(query),
        );
      }
      return result.sort((a, b) => {
        const aHasPos = !!a.position;
        const bHasPos = !!b.position;
        if (aHasPos !== bHasPos) return aHasPos ? -1 : 1;
        return (a.long_name || "").localeCompare(b.long_name || "");
      });
    },

    flyToNode(nodeId) {
      const node = this.nodes[nodeId];
      if (!node) return;

      if (!node.position || !node.marker) {
        // No map presence — just open the sidebar
        this.selectNode(nodeId);
        return;
      }

      const parent = this.nodeLayer.getVisibleParent(node.marker);
      if (parent === node.marker) {
        // Marker is visible (not inside a cluster)
        const zoom = Math.max(this.map.getZoom(), 14);
        this.map.flyTo(
          [node.position.latitude, node.position.longitude],
          zoom,
        );
        this.selectNode(nodeId);
      } else {
        // Marker is inside a cluster — expand it first, then select
        this.nodeLayer.zoomToShowLayer(node.marker, () => {
          this.selectNode(nodeId);
        });
      }
    },

    async loadMoreNodes(offset) {
      try {
        this.loading.pagination = true;
        const url = this.buildApiUrl({ offset });
        const response = await fetch(url);
        const data = await response.json();

        data.nodes.forEach((node) => {
          this.addNodeToMap(node);
        });

        // Continue pagination if needed
        if (data.pagination.has_more) {
          await this.loadMoreNodes(data.pagination.next_offset);
        }
      } catch (error) {
        console.error("Failed to load more nodes:", error);
        this.showError("NODE_LOAD_FAILED");
      } finally {
        this.loading.pagination = false;
      }
    },

    // Role-based icon mapping
    getIconForRole(role) {
      const roleIcons = {
        CLIENT: "mdi-radio-tower",
        CLIENT_MUTE: "mdi-volume-mute",
        CLIENT_BASE: "mdi-home",
        ROUTER: "mdi-hub-outline",
        ROUTER_LATE: "mdi-hubspot",
        REPEATER: "mdi-repeat",
        SENSOR: "mdi-thermometer",
        TRACKER: "mdi-crosshairs-gps",
        TAK: "mdi-radar",
        TAK_TRACKER: "mdi-radar",
      };
      return roleIcons[role] || "mdi-help-circle";
    },

    addNodeToMap(node) {
      // Check if map is ready
      if (!this.map || !this.map._loaded) {
        console.warn("Map not fully initialized yet, skipping node addition");
        return;
      }

      if (!node.position || !this.nodeLayer) {
        console.warn("Invalid node data or node layer not ready");
        return;
      }

      try {
        // Store node data
        this.nodes[node.id] = node;
        this.invalidateRoleCache(); // Invalidate cache when node is added

        const shouldShowDirection = this.isNodeMoving(node.position);

        const marker = L.marker([
          node.position.latitude,
          node.position.longitude,
        ]).addTo(this.nodeLayer);

        marker.on("click", () => {
          try {
            if (!this.map) return;
            this.selectNode(node.id);
          } catch (error) {
            console.error("Failed to handle marker click:", error);
          }
        });

        // Store marker reference
        node.marker = marker;

        this.updateNodeIcon(node, shouldShowDirection);

        // No overlap detection needed - built-in spiderfying handles it
      } catch (error) {
        console.error("Failed to add node to map:", error);
      }
    },

    createNodePopup(node) {
      const info = node.info || {};
      const position = node.position || {};
      const rawRole = node.role || "Unknown";
      const role = this.sanitizeHtml(rawRole);
      const roleIcon = this.getIconForRole(role);
      const safeName = this.sanitizeHtml(node.long_name || node.id);
      const safeShortName = this.sanitizeHtml(node.short_name || "");
      const safeHwModel = this.sanitizeHtml(node.hw_model || "");
      const safeId = this.sanitizeHtml(node.id);

      return `
                <div class="node-popup">
                    <h3>${safeName}</h3>
                    <div class="node-role-section">
                        <i class="mdi ${roleIcon} role-icon"></i>
                        <span class="role-badge">${role}</span>
                        ${safeHwModel ? `<span class="hw-model">${safeHwModel}</span>` : ""}
                    </div>
                    <div class="node-info">
                        <p><strong>ID:</strong> ${safeId}</p>
                        ${safeShortName ? `<p><strong>Short Name:</strong> ${safeShortName}</p>` : ""}
                        <p><strong>Status:</strong> <span class="status-badge ${this.getStatusClass(info.status)}">${this.getStatusLabel(info.status)}</span></p>
                        ${info.last_seen_hours_ago !== null ? `<p><strong>Last packet:</strong> ${this.getTimeAgoText(info.last_seen_hours_ago)}</p>` : ""}
                        ${node.last_channel !== null ? `<p><strong>Last heard on:</strong> Channel ${node.last_channel} (${node.last_channel_name || "Unknown"})</p>` : ""}
                        ${position.latitude ? `<p><strong>Position:</strong> ${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}</p>` : ""}
                        ${position.position_age_hours_ago != null ? `<p><strong>Last position:</strong> ${this.getTimeAgoText(position.position_age_hours_ago)}</p>` : position.latitude ? "<p><strong>Last position:</strong> Unknown</p>" : ""}
                        ${position.altitude ? `<p><strong>Altitude:</strong> ${position.altitude}m</p>` : ""}
                        ${this.getGroundSpeedKmph(position) !== null && this.getGroundSpeedKmph(position) > 0 ? `<p><strong>Ground Speed:</strong> ${this.getGroundSpeedKmph(position).toFixed(1)} km/h</p>` : ""}
                        ${position.heading !== null && position.heading !== undefined && this.getGroundSpeedKmph(position) !== null && this.getGroundSpeedKmph(position) > 0 ? `<p><strong>Heading:</strong> ${position.heading.toFixed(1)}° (${this.getCompassDirection(position.heading)})</p>` : ""}
                        ${info.is_unmessagable ? "<p><em>Node is unmessagable</em></p>" : ""}
                    </div>
                </div>
            `;
    },

    // New sidebar HTML generator for Design 1 card-based layout
    createNodeSidebarHtml(node) {
      const info = node.info || {};
      const position = node.position || {};
      const rawRole = node.role || "Unknown";
      const role = this.sanitizeHtml(rawRole);
      const roleIcon = this.getIconForRole(role);
      const safeName = this.sanitizeHtml(node.long_name || node.id);
      const safeShortName = this.sanitizeHtml(node.short_name || "");
      const safeHwModel = this.sanitizeHtml(node.hw_model || "");
      const safeId = this.sanitizeHtml(node.id);
      const safeMac = this.sanitizeHtml(node.mac_address || "");

      // Determine status badges
      const isMoving = this.getCurrentMovementState(node);
      const statusBadges = [];
      
      if (isMoving) {
        statusBadges.push('<span class="status-badge status-moving"><i class="mdi mdi-motion text-xs mr-1"></i>Moving</span>');
      } else {
        statusBadges.push('<span class="status-badge status-stationary"><i class="mdi mdi-motion-pause text-xs mr-1"></i>Stationary</span>');
      }
      
      if (info.is_unmessagable) {
        statusBadges.push('<span class="status-badge status-inactive"><i class="mdi mdi-message-off text-xs mr-1"></i>Unmessageable</span>');
      }
      
      const roleBadgeMap = {
        ROUTER: '<span class="device-type-badge device-router"><i class="mdi mdi-router-network text-xs mr-1"></i>ROUTER</span>',
        ROUTER_LATE: '<span class="device-type-badge device-router"><i class="mdi mdi-router-network text-xs mr-1"></i>ROUTER_LATE</span>',
        CLIENT: '<span class="device-type-badge device-client"><i class="mdi mdi-cellphone text-xs mr-1"></i>CLIENT</span>',
        CLIENT_MUTE: '<span class="device-type-badge device-client"><i class="mdi mdi-volume-mute text-xs mr-1"></i>CLIENT_MUTE</span>',
        CLIENT_BASE: '<span class="device-type-badge device-client"><i class="mdi mdi-home text-xs mr-1"></i>CLIENT_BASE</span>',
        REPEATER: '<span class="device-type-badge device-client"><i class="mdi mdi-repeat text-xs mr-1"></i>REPEATER</span>',
        SENSOR: '<span class="device-type-badge device-client"><i class="mdi mdi-thermometer text-xs mr-1"></i>SENSOR</span>',
        TRACKER: '<span class="device-type-badge device-client"><i class="mdi mdi-crosshairs-gps text-xs mr-1"></i>TRACKER</span>',
        TAK: '<span class="device-type-badge device-client"><i class="mdi mdi-radar text-xs mr-1"></i>TAK</span>',
        TAK_TRACKER: '<span class="device-type-badge device-client"><i class="mdi mdi-radar text-xs mr-1"></i>TAK_TRACKER</span>',
      };
      const deviceTypeBadge = roleBadgeMap[rawRole] || `<span class="device-type-badge device-client"><i class="mdi ${roleIcon} text-xs mr-1"></i>${rawRole}</span>`;

      const lastSeenText = info.last_seen_hours_ago !== null ? this.getTimeAgoText(info.last_seen_hours_ago) : "Unknown";

      return `
        <div class="space-y-4">
          <!-- Header with refresh button -->
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold text-gray-900">Node Details</h2>
            <div class="flex items-center gap-2">
              <button @click="refreshNodeData('${node.id}'); $event.currentTarget.blur()" 
                      :class="refreshingNodeId === '${node.id}' ? 'animate-spin' : ''"
                      class="w-7 h-7 flex items-center justify-center rounded-full border border-black bg-transparent text-gray-700 transition-colors duration-200 hover:bg-emerald-500 hover:text-white"
                      title="Refresh node data"
                      aria-label="Refresh node data">
                <i class="mdi mdi-refresh text-lg"></i>
              </button>
              <button @click="deselectNode(); panels.right.visible = false; $event.currentTarget.blur()"
                      class="w-7 h-7 flex items-center justify-center rounded-full border border-black bg-transparent text-gray-700 transition-colors duration-200 hover:bg-rose-500 hover:text-white"
                      title="Close sidebar"
                      aria-label="Close sidebar">
                <i class="mdi mdi-close text-lg"></i>
              </button>
            </div>
          </div>

          <!-- Header Card -->
          <div class="card p-4">
            <div class="flex items-center space-x-3">
              <div class="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0">
                <i class="mdi ${roleIcon} text-white text-lg"></i>
              </div>
              <div class="flex-1">
                <h3 class="font-semibold text-gray-900">${safeName}</h3>
                <div class="flex items-center space-x-2 flex-wrap gap-1">
                  ${statusBadges.join('')}
                  ${deviceTypeBadge}
                </div>
              </div>
            </div>
            <div class="mt-3 pt-3 border-t border-gray-100">
              <div class="flex justify-between text-sm">
                <span class="text-gray-500">Last seen</span>
                <span class="text-gray-700">${lastSeenText}</span>
              </div>
            </div>
          </div>

          <!-- Information Card -->
          <div class="card p-4">
            <h4 class="font-medium text-gray-900 mb-3 flex items-center">
              <i class="mdi mdi-information mr-2 text-blue-500"></i>
              Information
            </h4>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-gray-500">Long Name</span>
                <span class="text-gray-700">${safeName}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-500">Short Name</span>
                <span class="text-gray-700">${safeShortName || '—'}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-500">Node ID</span>
                <span class="text-gray-700 font-mono">${safeId}</span>
              </div>
              ${safeMac ? `
              <div class="flex justify-between">
                <span class="text-gray-500">MAC Address</span>
                <span class="text-gray-700 font-mono">${safeMac}</span>
              </div>
              ` : ''}
              <div class="flex justify-between">
                <span class="text-gray-500">Hardware</span>
                <span class="text-gray-700">${safeHwModel || '—'}</span>
              </div>
              ${node.last_channel !== null ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Last Channel</span>
                <span class="text-gray-700">Channel ${node.last_channel}${node.last_channel_name ? ` (${node.last_channel_name})` : ''}</span>
              </div>
              ` : ''}
            </div>
          </div>

          <!-- Location Card -->
          <div class="card p-4">
            <div class="flex items-center justify-between mb-3">
              <h4 class="font-medium text-gray-900 flex items-center">
                <i class="mdi mdi-map-marker mr-2 text-blue-500"></i>
                Location
              </h4>
              <div class="flex items-center gap-2">
                <span class="text-xs text-gray-500 font-medium">History</span>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" class="sr-only peer position-history-toggle" data-node-id="${node.id}" ${this.positionHistoryEnabled ? 'checked' : ''}>
                  <div class="w-10 h-5 bg-gray-300 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
                </label>
              </div>
            </div>
            ${this.positionHistoryEnabled ? `
            <div class="position-history-range-container mt-2 mb-1">
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs text-gray-400">History window</span>
                <span class="position-history-range-label text-xs font-medium text-blue-400">${this.formatHistoryRangeLabel(this.positionHistoryRangeHours)}</span>
              </div>
              <input type="range" class="position-history-range-slider w-full"
                     min="1" max="168" step="1" value="${this.positionHistoryRangeHours}">
            </div>
            ` : ''}
            <div class="space-y-2 text-sm">
              ${position.latitude ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Coordinates</span>
                <span class="text-gray-700 font-mono">${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}</span>
              </div>
              ` : ''}
              ${position.altitude ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Altitude</span>
                <span class="text-gray-700">${position.altitude}m</span>
              </div>
              ` : ''}
              ${this.getGroundSpeedKmph(position) !== null && this.getGroundSpeedKmph(position) > 0 ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Speed</span>
                <span class="text-gray-700">${this.getGroundSpeedKmph(position).toFixed(1)} km/h</span>
              </div>
              ` : ''}
              ${position.heading !== null && position.heading !== undefined && this.getGroundSpeedKmph(position) !== null && this.getGroundSpeedKmph(position) > 0 ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Heading</span>
                <span class="text-gray-700">${position.heading.toFixed(1)}° (${this.getCompassDirection(position.heading)})</span>
              </div>
              ` : ''}
              ${position.position_age_hours_ago != null ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Last position</span>
                <span class="text-gray-700">${this.getTimeAgoText(position.position_age_hours_ago)}</span>
              </div>
              ` : position.latitude ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Last position</span>
                <span class="text-gray-700">Unknown</span>
              </div>
              ` : ''}
            </div>
          </div>

          <!-- Telemetry Section -->
          <div class="card p-4">
            <div class="flex items-center justify-between mb-4">
              <h4 class="font-medium text-gray-900 flex items-center">
                <i class="mdi mdi-chart-line mr-2 text-green-500"></i>
                Telemetry
              </h4>
              <div class="flex items-center gap-2">
                <span class="text-xs text-gray-500 font-medium" data-telemetry-label="24h">24h</span>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" class="sr-only peer telemetry-window-toggle" data-node-id="${node.id}" ${this.telemetryWindow === 168 ? 'checked' : ''}>
                  <div class="w-10 h-5 bg-gray-300 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-green-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-500"></div>
                </label>
                <span class="text-xs text-gray-500 font-medium" data-telemetry-label="7d">7d</span>
              </div>
            </div>
            <div id="telemetry-charts" class="space-y-4">
              <!-- Charts will be loaded here -->
              <div class="text-center text-gray-500 py-8">
                <i class="mdi mdi-chart-line text-2xl mb-2"></i>
                <p>Loading telemetry data...</p>
              </div>
            </div>
          </div>
        </div>
      `;
    },

    getGroundSpeedKmph(position) {
      if (!position) return null;
      return position.ground_speed_kmph !== undefined && position.ground_speed_kmph !== null
        ? position.ground_speed_kmph
        : null;
    },

    // Helper method to safely get current movement state
    getCurrentMovementState(node) {
      try {
        if (!node.marker?._icon) {
          return false;
        }
        const iconElement = node.marker._icon.querySelector(".node-icon");
        return iconElement?.classList?.contains("moving") || false;
      } catch (error) {
        console.warn("DOM inspection failed for node movement state:", error);
        return false;
      }
    },

    // Helper method to update node icon with current movement state
    updateNodeIcon(node, shouldShowDirection) {
      const status = node.info?.status || "inactive";
      const statusClass = this.getStatusClass(status);
      const timeAgo = this.getTimeAgoText(node.info?.last_seen_hours_ago);
      const role = this.sanitizeHtml(node.role || "Unknown");
      const roleIcon = this.getIconForRole(role);
      const safeName = this.sanitizeHtml(node.long_name || node.id);
      const safeStatusLabel = this.sanitizeHtml(this.getStatusLabel(status));

      // Create updated icon with current movement status
      const movingClass = shouldShowDirection ? "moving" : "";
      const iconHtml = `<div class="node-icon ${statusClass} ${movingClass}" 
                                 title="${safeName}\nRole: ${role}\nStatus: ${safeStatusLabel}\nLast packet: ${timeAgo}">
                                <i class="mdi ${roleIcon}"></i>
                               </div>`;

      const icon = L.divIcon({
        className: "node-marker",
        html: iconHtml,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      node.marker.setIcon(icon);
    },

    updateNodePosition(nodeId, position) {
      const node = this.nodes[nodeId];
      if (!node || !node.marker || !this.map || !this.map._loaded) {
        console.warn(
          "Cannot update node position: map, node, or marker not available",
        );
        return;
      }

      if (this.isZooming) {
        this.pendingNodePositionUpdates[nodeId] = position;
        node.position = position;
        return;
      }

      try {
        // Update node position data
        node.position = position;

        const shouldShowDirection = this.isNodeMoving(position);

        // Animate marker to new position
        const newLatLng = L.latLng(position.latitude, position.longitude);
        node.marker.setLatLng(newLatLng);

        // Always update icon to ensure movement state is current
        // This fixes the race condition and ensures consistency
        this.updateNodeIcon(node, shouldShowDirection);

        try {
          if (typeof node.marker.getPopup === "function" && node.marker.getPopup()) {
            node.marker.setPopupContent(this.createNodePopup(node));
          }
        } catch (error) {}

        // Update precision circle if this node is selected
        this.updateSelectedNodeCircle(nodeId, position);
      } catch (error) {
        console.error("Failed to update node position:", error);
      }
    },

    // Status legend functions
    addStatusLegend() {
      const statusLegend = L.control({ position: "bottomleft" });

      statusLegend.onAdd = (map) => {
        const div = L.DomUtil.create("div", "status-legend");
        const thresholds = window.APP_CONFIG || {
          STATUS_CURRENTLY_ACTIVE_HOURS: 24,
          STATUS_RECENTLY_ACTIVE_HOURS: 72,
        };

        // Use cached roles for better performance
        const uniqueRoles = this.getUniqueRoles();

        div.innerHTML = `
                    <div style="font-weight: bold; margin-bottom: 8px;">Node Status</div>
                    <div class="legend-item">
                        <div class="node-icon currently-active"></div>
                        Currently Active (≤${thresholds.STATUS_CURRENTLY_ACTIVE_HOURS}h)
                    </div>
                    <div class="legend-item">
                        <div class="node-icon recently-active"></div>
                        Recently Active (≤${thresholds.STATUS_RECENTLY_ACTIVE_HOURS}h)
                    </div>
                    <div class="legend-item">
                        <div class="node-icon inactive"></div>
                        Inactive (>${thresholds.STATUS_RECENTLY_ACTIVE_HOURS}h)
                    </div>
                    ${
                      uniqueRoles.size > 0
                        ? `
                        <div class="legend-section-title">Device Roles</div>
                        ${Array.from(uniqueRoles)
                          .sort()
                          .map(
                            (role) => `
                            <div class="legend-item">
                                <div class="node-icon" style="background: #f9fafb; border: 2px solid #d1d5db; color: #374151;">
                                    <i class="mdi ${this.getIconForRole(role)}" style="font-size: 12px;"></i>
                                </div>
                                ${this.sanitizeHtml(role)}
                            </div>
                        `,
                          )
                          .join("")}
                    `
                        : ""
                    }
                `;
        return div;
      };

      statusLegend.addTo(this.map);
    },

    // Status helper functions
    getStatusClass(status) {
      switch (status) {
        case "currently_active":
          return "currently-active";
        case "recently_active":
          return "recently-active";
        case "inactive":
        default:
          return "inactive";
      }
    },

    getStatusLabel(status) {
      switch (status) {
        case "currently_active":
          return "Currently Active";
        case "recently_active":
          return "Recently Active";
        case "inactive":
        default:
          return "Inactive";
      }
    },

    getTimeAgoText(hoursAgo) {
      if (hoursAgo === null || hoursAgo === undefined) {
        return "Never seen";
      }

      if (
        typeof hoursAgo !== "number" ||
        Number.isNaN(hoursAgo) ||
        !Number.isFinite(hoursAgo)
      ) {
        return "Never seen";
      }

      if (hoursAgo < 0) {
        hoursAgo = 0;
      }

      if (hoursAgo < 1) {
        const minutes = Math.round(hoursAgo * 60);
        if (minutes < 1) {
          return "Less than 1 minute ago";
        } else if (minutes === 1) {
          return "1 minute ago";
        } else {
          return `${minutes} minutes ago`;
        }
      } else if (hoursAgo < 24) {
        let wholeHours = Math.floor(hoursAgo);
        let remainingMinutes = Math.round((hoursAgo - wholeHours) * 60);

        if (remainingMinutes === 60) {
          wholeHours += 1;
          remainingMinutes = 0;
        }

        if (wholeHours >= 24) {
          return "1 day ago";
        }

        if (remainingMinutes === 0) {
          return `${wholeHours} hour${wholeHours === 1 ? "" : "s"} ago`;
        } else {
          return `${wholeHours} hour${wholeHours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"} ago`;
        }
      } else {
        let days = Math.floor(hoursAgo / 24);
        let remainingHours = Math.round(hoursAgo % 24);

        if (remainingHours === 24) {
          days += 1;
          remainingHours = 0;
        }

        if (remainingHours === 0) {
          return `${days} day${days === 1 ? "" : "s"} ago`;
        } else {
          return `${days} day${days === 1 ? "" : "s"} ${remainingHours} hour${remainingHours === 1 ? "" : "s"} ago`;
        }
      }
    },

    removeNodeFromMap(nodeId) {
      try {
        const node = this.nodes[nodeId];
        if (!node || !node.marker) {
          console.warn("Node or marker not found for removal");
          return;
        }

        this.nodeLayer.removeLayer(node.marker);
        delete this.nodes[nodeId];
      } catch (error) {
        console.error("Failed to remove node from map:", error);
      }
    },

    // Manual cleanup method for testing or forced cleanup
    forceCleanup() {
      console.log("Force cleaning up app resources...");

      // Remove cleanup handlers first to prevent double cleanup
      if (this._cleanupHandlers) {
        window.removeEventListener(
          "beforeunload",
          this._cleanupHandlers.handleBeforeUnload,
        );
        window.removeEventListener(
          "unload",
          this._cleanupHandlers.handlePageUnload,
        );
        document.removeEventListener(
          "visibilitychange",
          this._cleanupHandlers.handleVisibilityChange,
        );
        this._cleanupHandlers = null;
      }

      // Deselect node to clean up precision circle
      this.deselectNode();

      // Perform full cleanup
      this.cleanup();
    },

    // Placeholder for future event-driven animations
    animateNodeEvent(nodeId, eventType, data) {
      // Future: blinking markers, communication lines, etc.
    },

    // Placeholder for event animation system
    initializeEventAnimations() {
      // Future: socket.io integration, event listeners
    },

    // Node selection and precision circle management
    selectNode(nodeId) {
      if (this.selectedNodeId === nodeId) {
        const node = this.nodes[nodeId];
        this.panels.right.visible = true;

        try {
          const currentNode = this.nodes?.[nodeId] || node;
          this.selectedNodeDetailsHtml = currentNode
            ? this.createNodeSidebarHtml(currentNode)
            : "";
        } catch (error) {
          this.selectedNodeDetailsHtml = "";
        }

        if (node?.position) {
          this.updateSelectedNodeCircle(nodeId, node.position);
        }

        queueMicrotask(() => {
          const toggle = document.querySelector('.position-history-toggle');
          if (!toggle) return;

          const existingHandler = toggle._handlePositionHistoryToggle;
          if (existingHandler) {
            toggle.removeEventListener('change', existingHandler);
          }

          const handlePositionHistoryToggle = (e) => {
            this.positionHistoryEnabled = !!e.target.checked;

            this._syncHistoryRangeSliderVisibility();

            if (!this.positionHistoryEnabled) {
              this.clearSelectedNodeHistoryLayer();
              return;
            }

            if (!this.selectedNodeId) return;
            if (!this.selectedNodeHistoryLayer || !this.selectedNodeHistory?.length) {
              this.loadNodeHistory(this.selectedNodeId);
            } else {
              this.renderNodeHistory();
            }
          };

          toggle._handlePositionHistoryToggle = handlePositionHistoryToggle;
          toggle.addEventListener('change', handlePositionHistoryToggle);

          this._wireHistoryRangeSlider();
        });

        if (this.positionHistoryEnabled) {
          if (!this.selectedNodeHistoryLayer || !this.selectedNodeHistory?.length) {
            this.loadNodeHistory(nodeId);
          }
        } else {
          this.clearSelectedNodeHistoryLayer();
        }
        // Fetch telemetry for the sidebar
        this.fetchTelemetrySummary(nodeId);
        return;
      }

      // Deselect previous node
      this.deselectNode();

      const node = this.nodes[nodeId];
      this.selectedNodeId = nodeId;

      this.panels.right.visible = true;
      try {
        const currentNode = this.nodes?.[nodeId] || node;
        this.selectedNodeDetailsHtml = currentNode
          ? this.createNodeSidebarHtml(currentNode)
          : "";
      } catch (error) {
        this.selectedNodeDetailsHtml = "";
      }

      queueMicrotask(() => {
        const toggle = document.querySelector('.position-history-toggle');
        if (!toggle) return;

        const existingHandler = toggle._handlePositionHistoryToggle;
        if (existingHandler) {
          toggle.removeEventListener('change', existingHandler);
        }

        const handlePositionHistoryToggle = (e) => {
          this.positionHistoryEnabled = !!e.target.checked;

          this._syncHistoryRangeSliderVisibility();

          if (!this.positionHistoryEnabled) {
            this.clearSelectedNodeHistoryLayer();
            return;
          }

          if (!this.selectedNodeId) return;
          if (!this.selectedNodeHistoryLayer || !this.selectedNodeHistory?.length) {
            this.loadNodeHistory(this.selectedNodeId);
          } else {
            this.renderNodeHistory();
          }
        };

        toggle._handlePositionHistoryToggle = handlePositionHistoryToggle;
        toggle.addEventListener('change', handlePositionHistoryToggle);

        this._wireHistoryRangeSlider();
      });

      if (!node || !node.position) {
        // Telemetry is independent from position and should load for position-less nodes too.
        this.fetchTelemetrySummary(nodeId);
        if (this.positionHistoryEnabled) {
          this.loadNodeHistory(nodeId);
        }
        return;
      }

      // Create precision circle if radius > 0
      if (node.position.radius && node.position.radius > 0) {
        this.selectedNodePrecisionCircle = L.circle(
          [node.position.latitude, node.position.longitude],
          {
            radius: node.position.radius,
            color: "#3b82f6", // subtle blue
            fillColor: "#3b82f6",
            fillOpacity: 0.12,
            weight: 1,
          }
        ).addTo(this.map);
      }

      // Load and display location history (only when enabled)
      if (this.positionHistoryEnabled) {
        this.loadNodeHistory(nodeId);
      }
      
      // Fetch telemetry for the sidebar
      this.fetchTelemetrySummary(nodeId);
    },

    deselectNode() {
      const circle = this.selectedNodePrecisionCircle;
      this.selectedNodePrecisionCircle = null;
      this.selectedNodeId = null;
      this.selectedNodeHistory = [];
      this.selectedNodeDetailsHtml = "";

      this.clearSelectedNodeHistoryLayer();

      if (!circle) return;

      try {
        if (!this.map) return;
        if (typeof this.map.hasLayer === "function" && !this.map.hasLayer(circle)) {
          return;
        }
        this.map.removeLayer(circle);
      } catch (error) {
      }
    },

    // Refresh data for the currently selected node
    async refreshNodeData(nodeId) {
      if (!nodeId || this.selectedNodeId !== nodeId) return;
      
      const node = this.nodes[nodeId];
      if (!node) return;

      // Set refreshing state
      this.refreshingNodeId = nodeId;

      try {
        // Update the sidebar HTML
        this.selectedNodeDetailsHtml = this.createNodeSidebarHtml(node);
        
        // Fetch fresh telemetry data
        await this.fetchTelemetrySummary(nodeId);
      } finally {
        // Clear refreshing state
        this.refreshingNodeId = null;
      }
    },

    // Update precision circle when selected node position changes
    updateSelectedNodeCircle(nodeId, position) {
      if (this.selectedNodeId !== nodeId) return;
      if (!this.map || !position) return;

      const hasRadius = position.radius && position.radius > 0;
      if (!hasRadius) {
        const circle = this.selectedNodePrecisionCircle;
        this.selectedNodePrecisionCircle = null;
        if (circle) {
          try {
            if (typeof this.map.hasLayer === "function" && !this.map.hasLayer(circle)) {
              return;
            }
            this.map.removeLayer(circle);
          } catch (error) {
          }
        }
        return;
      }

      // Create circle if selection existed before radius became available
      if (!this.selectedNodePrecisionCircle) {
        this.selectedNodePrecisionCircle = L.circle(
          [position.latitude, position.longitude],
          {
            radius: position.radius,
            color: "#3b82f6", // subtle blue
            fillColor: "#3b82f6",
            fillOpacity: 0.12,
            weight: 1,
          }
        ).addTo(this.map);
        return;
      }

      this.selectedNodePrecisionCircle.setLatLng([
        position.latitude,
        position.longitude,
      ]);
      this.selectedNodePrecisionCircle.setRadius(position.radius);
    },

    async loadNodeHistory(nodeId) {
      try {
        if (!nodeId || this.selectedNodeId !== nodeId) {
          return;
        }

        const startedAtMs =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();

        const requestSeq = ++this.selectedNodeHistoryRequestSeq;
        const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/positions`);

        if (requestSeq !== this.selectedNodeHistoryRequestSeq || this.selectedNodeId !== nodeId) {
          return;
        }

        if (!response.ok) {
          console.warn("Failed to load node history:", response.statusText);
          return;
        }

        const data = await response.json();
        if (
          requestSeq !== this.selectedNodeHistoryRequestSeq ||
          this.selectedNodeId !== nodeId ||
          !this.positionHistoryEnabled
        ) {
          return;
        }

        this.selectedNodeHistory = data.positions || [];
        this.selectedNodeHistoryRenderState.lastRenderedLength = 0;
        console.log("Node", nodeId, "history loaded:", this.selectedNodeHistory.length, "positions");
        this.logHistoryPerf("load", {
          nodeId,
          points: this.selectedNodeHistory.length,
          durationMs: Math.round(
            (
              (typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now()) - startedAtMs
            ) * 100
          ) / 100,
        });
        this.renderNodeHistory();
      } catch (error) {
        console.error("Error loading node history:", error);
      }
    },

    clearSelectedNodeHistoryLayer() {
      if (this.selectedNodeHistoryLayer && this.map) {
        try {
          this.map.removeLayer(this.selectedNodeHistoryLayer);
        } catch (error) {
          // Ignore removal errors
        }
      }
      this.selectedNodeHistoryLayer = null;
      this.selectedNodeHistoryRequestSeq += 1;
      this.selectedNodeHistoryRenderState.token += 1;
      this.selectedNodeHistoryRenderState.lastRenderedLength = 0;
      this.selectedNodeHistoryRenderState.rendering = false;
    },

    isHistoryPerfLoggingEnabled() {
      const config = window.APP_CONFIG || {};
      return !!config.HISTORY_PERF_LOG;
    },

    logHistoryPerf(eventName, payload) {
      if (!this.isHistoryPerfLoggingEnabled()) return;
      console.debug("[history-perf]", eventName, payload || {});
    },

    getHistorySpeedColor(kmph) {
      if (kmph == null || kmph <= 0) return "#9ca3af";
      if (kmph < 5) return "#9ca3af";
      if (kmph < 20) return "#f59e0b";
      return "#ef4444";
    },

    getHistoryAgeColor(createdAt, nowMs, oldestMs) {
      if (!createdAt) return "#9ca3af";
      const ageMs = nowMs - new Date(createdAt).getTime();
      if (ageMs <  1 * 3600 * 1000) return "#06b6d4";   // < 1h    → cyan
      if (ageMs <  6 * 3600 * 1000) return "#3b82f6";   // < 6h    → blue
      if (ageMs < 24 * 3600 * 1000) return "#6366f1";   // < 24h   → indigo
      if (ageMs < 72 * 3600 * 1000) return "#8b5cf6";   // < 3 days → violet
      return "#6b7280";                                   // older   → gray
    },

    createHistoryTooltipHtml(pos) {
      const ts = pos.created_at ? new Date(pos.created_at).toLocaleString() : "Unknown";
      const speed = pos.ground_speed_kmph != null ? `${pos.ground_speed_kmph.toFixed(1)} km/h` : "N/A";
      const heading = pos.heading != null ? `${pos.heading.toFixed(1)}°` : "N/A";
      return `Time: ${ts}<br>Lat: ${pos.latitude.toFixed(6)}<br>Lon: ${pos.longitude.toFixed(6)}<br>Speed: ${speed}<br>Heading: ${heading}`;
    },

    createHistoryPointLayer(pos) {
      if (!pos || pos.latitude == null || pos.longitude == null) return null;

      const markerColor = this.getHistorySpeedColor(pos.ground_speed_kmph);
      const isMoving = pos.heading != null && pos.ground_speed_kmph != null && pos.ground_speed_kmph > 0;
      let marker;

      if (isMoving) {
        const arrowIcon = L.divIcon({
          className: "history-arrow",
          html: `<div style="width: 12px; height: 12px; position: relative;">
                   <div style="position: absolute; top: 0; left: 0; width: 0; height: 0;
                       border-left: 6px solid transparent; border-right: 6px solid transparent;
                       border-bottom: 12px solid ${markerColor}; transform: rotate(${pos.heading}deg);
                       transform-origin: center 6px;"></div>
                 </div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });
        marker = L.marker([pos.latitude, pos.longitude], { icon: arrowIcon });
      } else {
        // Canvas renderer avoids one SVG element per marker; critical for large histories.
        if (!this.historyCanvasRenderer) {
          this.historyCanvasRenderer = L.canvas();
        }
        marker = L.circleMarker([pos.latitude, pos.longitude], {
          radius: 4,
          fillColor: markerColor,
          color: "#fff",
          weight: 1,
          opacity: 1,
          fillOpacity: 0.8,
          renderer: this.historyCanvasRenderer,
        });
      }

      marker.bindTooltip(this.createHistoryTooltipHtml(pos));
      return marker;
    },

    createHistorySegmentLayer(p1, p2, nowMs, oldestMs) {
      if (!p1 || !p2 || p1.latitude == null || p1.longitude == null || p2.latitude == null || p2.longitude == null) {
        return null;
      }
      const color = this.getHistoryAgeColor(p1.created_at, nowMs, oldestMs);
      return L.polyline([[p1.latitude, p1.longitude], [p2.latitude, p2.longitude]], {
        color,
        weight: 3,
        opacity: 0.7,
      });
    },

    // Returns the subset of selectedNodeHistory within the current slider window.
    filteredNodeHistory() {
      const history = this.selectedNodeHistory || [];
      const cutoffMs = Date.now() - this.positionHistoryRangeHours * 3600 * 1000;
      return history.filter(p => p.created_at && new Date(p.created_at).getTime() >= cutoffMs);
    },

    formatHistoryRangeLabel(hours) {
      if (hours < 24) return `${hours}h`;
      if (hours === 168) return '1 week';
      const days = Math.round(hours / 24);
      return `${days} day${days !== 1 ? 's' : ''}`;
    },

    // Inject or remove the slider container depending on toggle state.
    _syncHistoryRangeSliderVisibility() {
      // Find the location card by looking for the toggle's ancestor card
      const toggle = document.querySelector('.position-history-toggle');
      const card = toggle?.closest('.card');
      if (!card) return;
      const existing = card.querySelector('.position-history-range-container');
      const spaceDiv = card.querySelector('.space-y-2');
      if (this.positionHistoryEnabled) {
        if (!existing && spaceDiv) {
          const container = document.createElement('div');
          container.className = 'position-history-range-container mt-2 mb-1';
          container.innerHTML = `
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-gray-400">History window</span>
              <span class="position-history-range-label text-xs font-medium text-blue-400">${this.formatHistoryRangeLabel(this.positionHistoryRangeHours)}</span>
            </div>
            <input type="range" class="position-history-range-slider w-full"
                   min="1" max="168" step="1" value="${this.positionHistoryRangeHours}">
          `;
          spaceDiv.parentNode.insertBefore(container, spaceDiv);
          this._wireHistoryRangeSlider();
        }
      } else {
        existing?.remove();
      }
    },

    // Attach (or re-attach) the debounced input listener to the range slider.
    _wireHistoryRangeSlider() {
      const slider = document.querySelector('.position-history-range-slider');
      if (!slider) return;
      if (slider._rangeSliderHandler) {
        slider.removeEventListener('input', slider._rangeSliderHandler);
      }
      let debounceTimer = null;
      slider._rangeSliderHandler = (e) => {
        this.positionHistoryRangeHours = parseInt(e.target.value, 10);
        const label = document.querySelector('.position-history-range-label');
        if (label) label.textContent = this.formatHistoryRangeLabel(this.positionHistoryRangeHours);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.renderNodeHistory(), 100);
      };
      slider.addEventListener('input', slider._rangeSliderHandler);
    },

    renderNodeHistory() {
      if (!this.map || !this.positionHistoryEnabled) return;

      const history = this.filteredNodeHistory();
      if (!history.length) {
        this.clearSelectedNodeHistoryLayer();
        return;
      }

      if (!this.selectedNodeHistoryLayer) {
        this.selectedNodeHistoryLayer = L.layerGroup().addTo(this.map);
      } else {
        this.selectedNodeHistoryLayer.clearLayers();
      }

      const token = this.selectedNodeHistoryRenderState.token + 1;
      this.selectedNodeHistoryRenderState.token = token;
      this.selectedNodeHistoryRenderState.lastRenderedLength = 0;
      this.selectedNodeHistoryRenderState.rendering = true;

      const startedAtMs =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();

      const nowMs = Date.now();
      const oldestMs = history[0]?.created_at ? new Date(history[0].created_at).getTime() : nowMs;
      const newestIndex = history.length - 1;

      // Phase 1 (synchronous): merge consecutive same-color segments into a few
      // multi-point polylines instead of N individual 1-segment polylines. With 3
      // age-color buckets this produces <=3 DOM elements regardless of history
      // length, making the path visible immediately without blocking the browser.
      let currentColor = null;
      let currentRun = [];
      const flushPolylineRun = () => {
        if (currentRun.length >= 2 && this.selectedNodeHistoryRenderState.token === token) {
          this.selectedNodeHistoryLayer.addLayer(
            L.polyline(currentRun, { color: currentColor, weight: 3, opacity: 0.7 }),
          );
        }
      };
      for (let i = 0; i < newestIndex; i++) {
        const p1 = history[i], p2 = history[i + 1];
        if (!p1 || !p2 || p1.latitude == null || p2.latitude == null) continue;
        const color = this.getHistoryAgeColor(p1.created_at, nowMs, oldestMs);
        if (color !== currentColor) {
          flushPolylineRun();
          currentColor = color;
          currentRun = [[p1.latitude, p1.longitude]];
        }
        currentRun.push([p2.latitude, p2.longitude]);
      }
      flushPolylineRun();

      // Phase 2 (RAF-batched): draw point markers. Cap to MAX_MARKERS most-recent
      // points so tooltips are available on recent history; the path above already
      // covers the full route.
      const configuredMaxMarkers = Number(window.APP_CONFIG?.HISTORY_MAX_MARKERS);
      const MAX_MARKERS = Number.isFinite(configuredMaxMarkers)
        ? Math.max(50, Math.min(Math.floor(configuredMaxMarkers), 5000))
        : 500;
      const markerHistory = history.length > MAX_MARKERS ? history.slice(-MAX_MARKERS) : history;
      const markerNewestIndex = markerHistory.length - 1;
      let batchCount = 0;
      let renderedPoints = 0;
      const BATCH_SIZE = 500;
      let markerIndex = 0;

      const renderBatch = () => {
        if (this.selectedNodeHistoryRenderState.token !== token) {
          this.selectedNodeHistoryRenderState.rendering = false;
          this.logHistoryPerf("render_cancelled", {
            token,
            batches: batchCount,
            points: renderedPoints,
            segments: newestIndex,
          });
          return;
        }

        batchCount += 1;
        let ops = 0;
        while (markerIndex < markerNewestIndex && ops < BATCH_SIZE) {
          const marker = this.createHistoryPointLayer(markerHistory[markerIndex]);
          if (marker) {
            this.selectedNodeHistoryLayer.addLayer(marker);
            renderedPoints += 1;
          }
          markerIndex += 1;
          ops += 1;
        }

        if (markerIndex < markerNewestIndex) {
          try {
            requestAnimationFrame(renderBatch);
          } catch (error) {
            renderBatch();
          }
          return;
        }

        this.selectedNodeHistoryRenderState.lastRenderedLength = this.selectedNodeHistory.length;
        this.selectedNodeHistoryRenderState.rendering = false;
        this.logHistoryPerf("render_complete", {
          token,
          batches: batchCount,
          points: renderedPoints,
          segments: newestIndex,
          durationMs: Math.round(
            (
              (typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now()) - startedAtMs
            ) * 100
          ) / 100,
        });
      };

      try {
        requestAnimationFrame(renderBatch);
      } catch (error) {
        renderBatch();
      }
    },

    // Append realtime position to history and update incrementally when safe
    appendRealtimePosition(nodeId, position) {
      if (this.selectedNodeId !== nodeId || !this.selectedNodeHistory) return;

      const startedAtMs =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();

      const createdAt = position?.created_at ? position.created_at : new Date().toISOString();

      // Convert position to history format
      const historyEntry = {
        latitude: position.latitude,
        longitude: position.longitude,
        created_at: createdAt,
        altitude: position.altitude,
        precision_bits: position.precision_bits,
        radius: position.radius,
        ground_speed_kmph: position.ground_speed_kmph,
        heading: position.heading,
      };

      // Append and re-render
      this.selectedNodeHistory.push(historyEntry);

      if (!this.positionHistoryEnabled || !this.map || !this.selectedNodeHistoryLayer) {
        return;
      }

      const history = this.selectedNodeHistory;
      if (this.selectedNodeHistoryRenderState.rendering) {
        this.logHistoryPerf("append_skipped_rendering", {
          nodeId,
          historyLength: history.length,
        });
        return;
      }

      const expectedPreviousLength = history.length - 1;
      if (this.selectedNodeHistoryRenderState.lastRenderedLength !== expectedPreviousLength) {
        this.logHistoryPerf("append_fallback_full_render", {
          nodeId,
          historyLength: history.length,
          expectedPreviousLength,
          lastRenderedLength: this.selectedNodeHistoryRenderState.lastRenderedLength,
        });
        this.renderNodeHistory();
        return;
      }

      const prev = history[history.length - 2];
      const latest = history[history.length - 1];
      if (!prev || !latest) {
        this.logHistoryPerf("append_fallback_missing_points", {
          nodeId,
          historyLength: history.length,
        });
        this.renderNodeHistory();
        return;
      }

      // If the previous point is outside the current filter window, fall back to
      // a full re-render so no segment is drawn from an invisible point to the new one.
      const cutoffMs = Date.now() - this.positionHistoryRangeHours * 3600 * 1000;
      if (prev.created_at && new Date(prev.created_at).getTime() < cutoffMs) {
        this.renderNodeHistory();
        return;
      }

      const prevMarker = this.createHistoryPointLayer(prev);
      if (prevMarker) {
        this.selectedNodeHistoryLayer.addLayer(prevMarker);
      }

      const nowMs = Date.now();
      // Use cutoff as the oldest reference so age colors match the filtered renderNodeHistory view.
      const oldestMs = Math.max(
        cutoffMs,
        history[0]?.created_at ? new Date(history[0].created_at).getTime() : cutoffMs,
      );
      const latestSegment = this.createHistorySegmentLayer(prev, latest, nowMs, oldestMs);
      if (latestSegment) {
        this.selectedNodeHistoryLayer.addLayer(latestSegment);
      }

      this.selectedNodeHistoryRenderState.lastRenderedLength = history.length;
      this.logHistoryPerf("append_incremental", {
        nodeId,
        historyLength: history.length,
        durationMs: Math.round(
          (
            (typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now()) - startedAtMs
          ) * 100
        ) / 100,
      });
    },

    // Fetch node statistics for the sidebar
    // Fetch telemetry summary for the sidebar
    async fetchTelemetrySummary(nodeId, sinceHours = null) {
      const hours = sinceHours !== null ? sinceHours : this.telemetryWindow;
      try {
        const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/telemetry/summary?since_hours=${hours}`);
        if (!response.ok) {
          console.warn(`Failed to fetch telemetry summary for node ${nodeId}:`, response.status);
          if (this.selectedNodeId === nodeId) {
            this.updateTelemetryChartsErrorDisplay();
          }
          return;
        }
        const summary = await response.json();

        if (this.selectedNodeId !== nodeId) {
          return;
        }
        
        // Update the telemetry charts display
        this.updateTelemetryChartsDisplay(summary);
        
        // Set up the toggle listener
        this.setupTelemetryWindowToggle(nodeId);
      } catch (error) {
        console.error(`Error fetching telemetry summary for node ${nodeId}:`, error);
        if (this.selectedNodeId === nodeId) {
          this.updateTelemetryChartsErrorDisplay();
        }
      }
    },

    updateTelemetryChartsErrorDisplay() {
      const chartsContainer = document.getElementById('telemetry-charts');
      if (!chartsContainer) return;

      chartsContainer.innerHTML = `
        <div class="text-center text-red-500 py-8">
          <i class="mdi mdi-alert-circle-outline text-2xl mb-2"></i>
          <p>Failed to load telemetry data</p>
        </div>
      `;
    },

    // Set up the telemetry window toggle listener
    setupTelemetryWindowToggle(nodeId) {
      const toggle = document.querySelector('.telemetry-window-toggle');
      if (!toggle) return;

      // Remove existing listener if present
      const existingHandler = toggle._handleTelemetryToggle;
      if (existingHandler) {
        toggle.removeEventListener('change', existingHandler);
      }

      const handleTelemetryToggle = (e) => {
        const newWindow = e.target.checked ? 168 : 24;
        this.telemetryWindow = newWindow;
        
        // Refetch telemetry summary with new window
        this.fetchTelemetrySummary(nodeId, newWindow);
      };

      toggle._handleTelemetryToggle = handleTelemetryToggle;
      toggle.addEventListener('change', handleTelemetryToggle);
    },

    // Update the telemetry charts display in the sidebar
    updateTelemetryChartsDisplay(summary) {
      const chartsContainer = document.getElementById('telemetry-charts');
      if (!chartsContainer) return;

      if (!summary.metrics || summary.metrics.length === 0) {
        chartsContainer.innerHTML = `
          <div class="text-center text-gray-500 py-8">
            <i class="mdi mdi-chart-line text-2xl mb-2"></i>
            <p>No telemetry data available</p>
          </div>
        `;
        return;
      }

      // Create chart placeholders with IntersectionObserver for lazy loading
      const chartHtml = summary.metrics.slice(0, 20).map((metric, index) => `
        <div class="chart-container mb-4" data-metric-type="${metric.metric_type}" data-metric="${metric.metric}">
          <div class="chart-placeholder h-32 bg-gray-50 rounded border-2 border-dashed border-gray-200 flex items-center justify-center">
            <div class="text-center">
              <i class="mdi mdi-chart-line text-gray-400 text-xl mb-1"></i>
              <p class="text-sm text-gray-500">${metric.metric_type} - ${metric.metric}</p>
              <p class="text-xs text-gray-400">Loading chart...</p>
            </div>
          </div>
        </div>
      `).join('');

      chartsContainer.innerHTML = chartHtml;

      // Set up IntersectionObserver for lazy loading
      this.setupChartIntersectionObserver();
    },

    // Set up IntersectionObserver to load charts when they come into view
    setupChartIntersectionObserver() {
      const chartContainers = document.querySelectorAll('.chart-container');
      
      if (chartContainers.length === 0) return;

      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const container = entry.target;
            const metricType = container.dataset.metricType;
            const metric = container.dataset.metric;
            
            // Load the chart for this metric
            this.loadChartForMetric(container, metricType, metric);
            
            // Stop observing this element
            observer.unobserve(container);
          }
        });
      }, {
        root: document.getElementById('telemetry-charts'),
        rootMargin: '50px',
        threshold: 0.1
      });

      chartContainers.forEach(container => {
        observer.observe(container);
      });
    },

    // Load chart data for a specific metric
    async loadChartForMetric(container, metricType, metric) {
      let acquiredSlot = false;
      try {
        const initialNodeId = this.selectedNodeId;
        if (!initialNodeId) return;

        // Log if about to be throttled (before waiting)
        if (this.chartFetchInFlight >= this.chartFetchMaxConcurrent) {
          console.log(`Chart fetch throttled for node ${initialNodeId}: ${metricType}/${metric} - waiting for slot (${this.chartFetchInFlight}/${this.chartFetchMaxConcurrent} in flight)`);
        }

        while (this.chartFetchInFlight >= this.chartFetchMaxConcurrent) {
          await new Promise((resolve) => this.chartFetchWaiters.push(resolve));
        }

        const nodeId = this.selectedNodeId;
        if (!nodeId) return;

        this.chartFetchInFlight += 1;
        acquiredSlot = true;

        console.log(`Fetching chart data for node ${nodeId}: ${metricType}/${metric} (${this.telemetryWindow}h window)`);
        const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/metrics/series?metric_type=${encodeURIComponent(metricType)}&metric=${encodeURIComponent(metric)}&since_hours=${this.telemetryWindow}&max_points=100`);
        
        if (!response.ok) {
          console.warn(`Failed to load chart for node ${nodeId} (${metricType}/${metric}):`, response.status);
          return;
        }

        const data = await response.json();
        
        const placeholder = container.querySelector('.chart-placeholder');
        if (!placeholder) return;

        this.renderMetricChart(placeholder, metricType, metric, data);
      } catch (error) {
        console.error(`Error loading chart for ${metricType}/${metric}:`, error);
        const placeholder = container.querySelector('.chart-placeholder');
        if (placeholder) {
          placeholder.innerHTML = `
            <div class="text-center text-red-500 text-sm">
              Failed to load chart
            </div>
          `;
        }
      } finally {
        if (acquiredSlot) {
          this.chartFetchInFlight = Math.max(0, this.chartFetchInFlight - 1);
          const next = this.chartFetchWaiters.shift();
          if (next) next();
        }
      }
    },

    renderMetricChart(placeholder, metricType, metric, data) {
      const points = Array.isArray(data.series) ? data.series : [];
      if (points.length === 0) {
        placeholder.innerHTML = `
          <div class="text-center">
            <i class="mdi mdi-chart-line-off text-gray-400 text-xl mb-1"></i>
            <p class="text-sm text-gray-700">${metricType} - ${metric}</p>
            <p class="text-xs text-gray-500">No data available</p>
          </div>
        `;
        placeholder.classList.remove('h-32');
        return;
      }

      const width = 340;
      const height = 140;
      const marginLeft = 42;
      const marginRight = 10;
      const marginTop = 10;
      const marginBottom = 28;

      const plotLeft = marginLeft;
      const plotRight = width - marginRight;
      const plotTop = marginTop;
      const plotBottom = height - marginBottom;

      const plotWidth = Math.max(plotRight - plotLeft, 1);
      const plotHeight = Math.max(plotBottom - plotTop, 1);
      const values = points.map(point => point.value);
      const minValue = Math.min(...values);
      const maxValue = Math.max(...values);
      const range = Math.max(maxValue - minValue, 1);
      const startTs = points[0].ts;
      const endTs = points[points.length - 1].ts;
      const duration = Math.max(endTs - startTs, 1);

      const svgPoints = points.map(point => {
        const x = plotLeft + ((point.ts - startTs) / duration) * plotWidth;
        const y = plotBottom - ((point.value - minValue) / range) * plotHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');

      const formatTickValue = (v) => {
        if (!Number.isFinite(v)) return String(v);
        const abs = Math.abs(v);
        if (abs >= 100) return v.toFixed(0);
        if (abs >= 10) return v.toFixed(1);
        return v.toFixed(2);
      };

      const formatTickTime = (tsSeconds) => {
        const d = new Date(tsSeconds * 1000);
        if (isNaN(d.getTime())) return String(tsSeconds);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      };

      const midValue = (minValue + maxValue) / 2;
      const yTicks = [
        { value: maxValue, label: formatTickValue(maxValue) },
        { value: midValue, label: formatTickValue(midValue) },
        { value: minValue, label: formatTickValue(minValue) },
      ];

      const midTs = startTs + duration / 2;
      const xTicks = [
        { ts: startTs, label: formatTickTime(startTs), anchor: 'start', x: plotLeft },
        { ts: midTs, label: formatTickTime(midTs), anchor: 'middle', x: width / 2 },
        { ts: endTs, label: formatTickTime(endTs), anchor: 'end', x: plotRight },
      ];

      const svgCircles = points.map(point => {
        const x = plotLeft + ((point.ts - startTs) / duration) * plotWidth;
        const y = plotBottom - ((point.value - minValue) / range) * plotHeight;
        const ts = new Date(point.ts * 1000);
        const tsText = isNaN(ts.getTime()) ? String(point.ts) : ts.toLocaleString();
        const valueText = Number.isFinite(point.value) ? point.value.toFixed(3) : String(point.value);
        return `
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="transparent" stroke="transparent" style="pointer-events: all;">
            <title>${tsText}\n${metricType} · ${metric}: ${valueText}</title>
          </circle>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#10b981" opacity="0.95" style="pointer-events: none;"></circle>
        `;
      }).join('');

      const minLabel = minValue.toFixed(2);
      const maxLabel = maxValue.toFixed(2);
      const lastLabel = points[points.length - 1].value.toFixed(2);
      const title = `${metricType} · ${metric}`;
      const gradientId = `metric-gradient-${metricType}-${metric}`.replace(/[^a-zA-Z0-9_-]/g, '_');

      placeholder.innerHTML = `
        <div class="space-y-2">
          <div class="flex items-center justify-between text-sm font-medium text-gray-800">
            <span>${title}</span>
            <span class="text-xs text-gray-500">${data.points} pts</span>
          </div>
          <div class="rounded-lg bg-white border border-gray-200 p-2">
            <svg viewBox="0 0 ${width} ${height}" class="w-full h-32">
              <defs>
                <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="#10b981" stop-opacity="0.1" />
                </linearGradient>
              </defs>
              <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
              ${yTicks.map(tick => {
                const y = plotBottom - ((tick.value - minValue) / range) * plotHeight;
                return `
                  <line x1="${plotLeft.toFixed(1)}" y1="${y.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />
                  <text x="${(plotLeft - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#6b7280">${tick.label}</text>
                `;
              }).join('')}
              <polyline fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${svgPoints}" />
              <line x1="${plotLeft.toFixed(1)}" y1="${plotBottom.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${plotBottom.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />
              ${xTicks.map(tick => {
                return `
                  <text x="${tick.x.toFixed(1)}" y="${(plotBottom + 14).toFixed(1)}" text-anchor="${tick.anchor}" font-size="9" fill="#6b7280">${tick.label}</text>
                `;
              }).join('')}
              <text x="${(plotLeft + plotWidth / 2).toFixed(1)}" y="${(height - 2).toFixed(1)}" text-anchor="middle" font-size="10" fill="#6b7280">Time</text>
              <text x="12" y="${(plotTop + plotHeight / 2).toFixed(1)}" text-anchor="middle" font-size="10" fill="#6b7280" transform="rotate(-90 12 ${(plotTop + plotHeight / 2).toFixed(1)})">Value</text>
              ${svgCircles}
            </svg>
          </div>
          <div class="flex justify-between text-xs text-gray-500">
            <span>min ${minLabel}</span>
            <span>last ${lastLabel}</span>
            <span>max ${maxLabel}</span>
          </div>
        </div>
      `;
      placeholder.classList.remove('h-32', 'border-dashed', 'border-gray-200', 'bg-gray-50', 'flex', 'items-center', 'justify-center');
      placeholder.classList.add('border-solid', 'border-gray-200', 'bg-white', 'p-3');
    },
  };
}
