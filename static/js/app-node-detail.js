// Node detail / position history / telemetry chart domain mixin.
// Combined domain per user decision (history + telemetry together).
// Pure helpers (sanitizeHtml, getIconForRole, etc.) are called as standalone functions
// from app-helpers.js, not via `this`.

function nodeDetailMixin() {
  return {
    createNodeSidebarHtml(node) {
      const info = node.info || {};
      const position = node.position || {};
      const rawRole = node.role || "Unknown";
      const role = sanitizeHtml(rawRole);
      const roleIcon = getIconForRole(role);
      const safeName = sanitizeHtml(node.long_name || node.id);
      const safeShortName = sanitizeHtml(node.short_name || "");
      const safeHwModel = sanitizeHtml(node.hw_model || "");
      const safeId = sanitizeHtml(node.id);
      const safeMac = sanitizeHtml(node.mac_address || "");

      // Determine status badges
      const isMoving = this.getCurrentMovementState(node);
      const statusBadges = [];

      if (isMoving) {
        statusBadges.push(
          '<span class="status-badge status-moving"><i class="mdi mdi-motion text-xs mr-1"></i>Moving</span>',
        );
      } else {
        statusBadges.push(
          '<span class="status-badge status-stationary"><i class="mdi mdi-motion-pause text-xs mr-1"></i>Stationary</span>',
        );
      }

      if (info.is_unmessagable) {
        statusBadges.push(
          '<span class="status-badge status-inactive"><i class="mdi mdi-message-off text-xs mr-1"></i>Unmessageable</span>',
        );
      }

      const roleBadgeMap = {
        ROUTER:
          '<span class="device-type-badge device-router"><i class="mdi mdi-router-network text-xs mr-1"></i>ROUTER</span>',
        ROUTER_LATE:
          '<span class="device-type-badge device-router"><i class="mdi mdi-router-network text-xs mr-1"></i>ROUTER_LATE</span>',
        CLIENT:
          '<span class="device-type-badge device-client"><i class="mdi mdi-cellphone text-xs mr-1"></i>CLIENT</span>',
        CLIENT_MUTE:
          '<span class="device-type-badge device-client"><i class="mdi mdi-volume-mute text-xs mr-1"></i>CLIENT_MUTE</span>',
        CLIENT_BASE:
          '<span class="device-type-badge device-client"><i class="mdi mdi-home text-xs mr-1"></i>CLIENT_BASE</span>',
        REPEATER:
          '<span class="device-type-badge device-client"><i class="mdi mdi-repeat text-xs mr-1"></i>REPEATER</span>',
        SENSOR:
          '<span class="device-type-badge device-client"><i class="mdi mdi-thermometer text-xs mr-1"></i>SENSOR</span>',
        TRACKER:
          '<span class="device-type-badge device-client"><i class="mdi mdi-crosshairs-gps text-xs mr-1"></i>TRACKER</span>',
        TAK: '<span class="device-type-badge device-client"><i class="mdi mdi-radar text-xs mr-1"></i>TAK</span>',
        TAK_TRACKER:
          '<span class="device-type-badge device-client"><i class="mdi mdi-radar text-xs mr-1"></i>TAK_TRACKER</span>',
      };
      const deviceTypeBadge =
        roleBadgeMap[rawRole] ||
        `<span class="device-type-badge device-client"><i class="mdi ${roleIcon} text-xs mr-1"></i>${rawRole}</span>`;

      const lastSeenText =
        info.last_seen_hours_ago !== null
          ? getTimeAgoText(info.last_seen_hours_ago)
          : "Unknown";

      const speedKmph = getGroundSpeedKmph(position);

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
                  ${statusBadges.join("")}
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
                <span class="text-gray-700">${safeShortName || "—"}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-500">Node ID</span>
                <span class="text-gray-700 font-mono">${safeId}</span>
              </div>
              ${
                safeMac
                  ? `
              <div class="flex justify-between">
                <span class="text-gray-500">MAC Address</span>
                <span class="text-gray-700 font-mono">${safeMac}</span>
              </div>
              `
                  : ""
              }
              <div class="flex justify-between">
                <span class="text-gray-500">Hardware</span>
                <span class="text-gray-700">${safeHwModel || "—"}</span>
              </div>
              ${
                node.last_channel !== null
                  ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Last Channel</span>
                <span class="text-gray-700">Channel ${node.last_channel}${node.last_channel_name ? ` (${node.last_channel_name})` : ""}</span>
              </div>
              `
                  : ""
              }
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
                  <input type="checkbox" class="sr-only peer position-history-toggle" data-node-id="${node.id}" ${this.positionHistoryEnabled ? "checked" : ""}>
                  <div class="w-10 h-5 bg-gray-300 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
                </label>
              </div>
            </div>
            ${
              this.positionHistoryEnabled
                ? `
            <div class="position-history-range-container mt-2 mb-1">
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs text-gray-400">History window</span>
                <span class="position-history-range-label text-xs font-medium text-blue-400">${this.formatHistoryRangeLabel(this.positionHistoryRangeHours)}</span>
              </div>
              <input type="range" class="position-history-range-slider w-full"
                     min="1" max="168" step="1" value="${this.positionHistoryRangeHours}">
            </div>
            `
                : ""
            }
            <div class="space-y-2 text-sm">
              ${
                position.latitude
                  ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Coordinates</span>
                <span class="text-gray-700 font-mono">${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}</span>
              </div>
              `
                  : ""
              }
              ${
                position.altitude
                  ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Altitude</span>
                <span class="text-gray-700">${position.altitude}m</span>
              </div>
              `
                  : ""
              }
              ${
                speedKmph !== null && speedKmph > 0
                  ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Speed</span>
                <span class="text-gray-700">${speedKmph.toFixed(1)} km/h</span>
              </div>
              `
                  : ""
              }
              ${
                position.heading !== null &&
                position.heading !== undefined &&
                speedKmph !== null &&
                speedKmph > 0
                  ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Heading</span>
                <span class="text-gray-700">${position.heading.toFixed(1)}° (${getCompassDirection(position.heading)})</span>
              </div>
              `
                  : ""
              }
              ${
                position.position_age_hours_ago != null
                  ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Last position</span>
                <span class="text-gray-700">${getTimeAgoText(position.position_age_hours_ago)}</span>
              </div>
              `
                  : position.latitude
                    ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Last position</span>
                <span class="text-gray-700">Unknown</span>
              </div>
              `
                    : ""
              }
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
                  <input type="checkbox" class="sr-only peer telemetry-window-toggle" data-node-id="${node.id}" ${this.telemetryWindow === 168 ? "checked" : ""}>
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
          const toggle = document.querySelector(".position-history-toggle");
          if (!toggle) return;

          const existingHandler = toggle._handlePositionHistoryToggle;
          if (existingHandler) {
            toggle.removeEventListener("change", existingHandler);
          }

          const handlePositionHistoryToggle = (e) => {
            this.positionHistoryEnabled = !!e.target.checked;

            this._syncHistoryRangeSliderVisibility();

            if (!this.positionHistoryEnabled) {
              this.clearSelectedNodeHistoryLayer();
              return;
            }

            if (!this.selectedNodeId) return;
            if (
              !this.selectedNodeHistoryLayer ||
              !this.selectedNodeHistory?.length
            ) {
              this.loadNodeHistory(this.selectedNodeId);
            } else {
              this.renderNodeHistory();
            }
          };

          toggle._handlePositionHistoryToggle = handlePositionHistoryToggle;
          toggle.addEventListener("change", handlePositionHistoryToggle);

          this._wireHistoryRangeSlider();
        });

        if (this.positionHistoryEnabled) {
          if (
            !this.selectedNodeHistoryLayer ||
            !this.selectedNodeHistory?.length
          ) {
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
        const toggle = document.querySelector(".position-history-toggle");
        if (!toggle) return;

        const existingHandler = toggle._handlePositionHistoryToggle;
        if (existingHandler) {
          toggle.removeEventListener("change", existingHandler);
        }

        const handlePositionHistoryToggle = (e) => {
          this.positionHistoryEnabled = !!e.target.checked;

          this._syncHistoryRangeSliderVisibility();

          if (!this.positionHistoryEnabled) {
            this.clearSelectedNodeHistoryLayer();
            return;
          }

          if (!this.selectedNodeId) return;
          if (
            !this.selectedNodeHistoryLayer ||
            !this.selectedNodeHistory?.length
          ) {
            this.loadNodeHistory(this.selectedNodeId);
          } else {
            this.renderNodeHistory();
          }
        };

        toggle._handlePositionHistoryToggle = handlePositionHistoryToggle;
        toggle.addEventListener("change", handlePositionHistoryToggle);

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
          },
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
        if (
          typeof this.map.hasLayer === "function" &&
          !this.map.hasLayer(circle)
        ) {
          return;
        }
        this.map.removeLayer(circle);
      } catch (error) {}
    },

    // Refresh data for the currently selected node
    async refreshNodeData(nodeId) {
      if (!nodeId || this.selectedNodeId !== nodeId) return;

      const node = this.nodes[nodeId];
      if (!node) return;

      // Set refreshing state
      this.refreshingNodeId = nodeId;

      try {
        // Fetch fresh node data (position age + last seen are time-relative server computations)
        const include = encodeURIComponent("positions,info");
        const response = await fetch(
          `/api/nodes?include=${include}&node_id=${encodeURIComponent(nodeId)}&limit=1`,
        );

        if (response.ok) {
          const data = await response.json();
          const freshNode = data?.nodes?.[0];
          if (freshNode) {
            // Preserve client-side fields (e.g. marker) by merging into the existing node object.
            Object.assign(node, freshNode);
            if (freshNode.position !== undefined) node.position = freshNode.position;
            if (freshNode.info !== undefined) node.info = freshNode.info;
          }
        }

        // Update the sidebar HTML using the updated node object
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
            if (
              typeof this.map.hasLayer === "function" &&
              !this.map.hasLayer(circle)
            ) {
              return;
            }
            this.map.removeLayer(circle);
          } catch (error) {}
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
          },
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
          typeof performance !== "undefined" &&
          typeof performance.now === "function"
            ? performance.now()
            : Date.now();

        const requestSeq = ++this.selectedNodeHistoryRequestSeq;
        const sinceHours = Number.isFinite(this.positionHistoryRangeHours)
          ? this.positionHistoryRangeHours
          : 24;
        const maxPoints = 2000;
        const response = await fetch(
          `/api/nodes/${encodeURIComponent(nodeId)}/positions?since_hours=${encodeURIComponent(sinceHours)}&max_points=${encodeURIComponent(maxPoints)}`,
        );

        if (
          requestSeq !== this.selectedNodeHistoryRequestSeq ||
          this.selectedNodeId !== nodeId
        ) {
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
        console.log(
          "Node",
          nodeId,
          "history loaded:",
          this.selectedNodeHistory.length,
          "positions",
        );
        this.logHistoryPerf("load", {
          nodeId,
          points: this.selectedNodeHistory.length,
          durationMs:
            Math.round(
              ((typeof performance !== "undefined" &&
              typeof performance.now === "function"
                ? performance.now()
                : Date.now()) -
                startedAtMs) *
                100,
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
      if (ageMs < 1 * 3600 * 1000) return "#06b6d4"; // < 1h    → cyan
      if (ageMs < 6 * 3600 * 1000) return "#3b82f6"; // < 6h    → blue
      if (ageMs < 24 * 3600 * 1000) return "#6366f1"; // < 24h   → indigo
      if (ageMs < 72 * 3600 * 1000) return "#8b5cf6"; // < 3 days → violet
      return "#6b7280"; // older   → gray
    },

    createHistoryTooltipHtml(pos) {
      const ts = pos.created_at
        ? new Date(pos.created_at).toLocaleString()
        : "Unknown";
      const speed =
        pos.ground_speed_kmph != null
          ? `${pos.ground_speed_kmph.toFixed(1)} km/h`
          : "N/A";
      const heading =
        pos.heading != null ? `${pos.heading.toFixed(1)}°` : "N/A";
      return `Time: ${ts}<br>Lat: ${pos.latitude.toFixed(6)}<br>Lon: ${pos.longitude.toFixed(6)}<br>Speed: ${speed}<br>Heading: ${heading}`;
    },

    createHistoryPointLayer(pos) {
      if (!pos || pos.latitude == null || pos.longitude == null) return null;

      const markerColor = this.getHistorySpeedColor(pos.ground_speed_kmph);
      const isMoving =
        pos.heading != null &&
        pos.ground_speed_kmph != null &&
        pos.ground_speed_kmph > 0;
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
      if (
        !p1 ||
        !p2 ||
        p1.latitude == null ||
        p1.longitude == null ||
        p2.latitude == null ||
        p2.longitude == null
      ) {
        return null;
      }
      const color = this.getHistoryAgeColor(p1.created_at, nowMs, oldestMs);
      return L.polyline(
        [
          [p1.latitude, p1.longitude],
          [p2.latitude, p2.longitude],
        ],
        {
          color,
          weight: 3,
          opacity: 0.7,
        },
      );
    },

    // Returns the subset of selectedNodeHistory within the current slider window.
    filteredNodeHistory() {
      const history = this.selectedNodeHistory || [];
      const cutoffMs =
        Date.now() - this.positionHistoryRangeHours * 3600 * 1000;
      return history.filter(
        (p) =>
          p.created_at && new Date(p.created_at).getTime() >= cutoffMs,
      );
    },

    formatHistoryRangeLabel(hours) {
      if (hours < 24) return `${hours}h`;
      if (hours === 168) return "1 week";
      const days = Math.round(hours / 24);
      return `${days} day${days !== 1 ? "s" : ""}`;
    },

    // Inject or remove the slider container depending on toggle state.
    _syncHistoryRangeSliderVisibility() {
      // Find the location card by looking for the toggle's ancestor card
      const toggle = document.querySelector(".position-history-toggle");
      const card = toggle?.closest(".card");
      if (!card) return;
      const existing = card.querySelector(".position-history-range-container");
      const spaceDiv = card.querySelector(".space-y-2");
      if (this.positionHistoryEnabled) {
        if (!existing && spaceDiv) {
          const container = document.createElement("div");
          container.className = "position-history-range-container mt-2 mb-1";
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
      const slider = document.querySelector(".position-history-range-slider");
      if (!slider) return;
      if (slider._rangeSliderHandler) {
        slider.removeEventListener("input", slider._rangeSliderHandler);
      }
      let debounceTimer = null;
      slider._rangeSliderHandler = (e) => {
        this.positionHistoryRangeHours = parseInt(e.target.value, 10);
        const label = document.querySelector(
          ".position-history-range-label",
        );
        if (label)
          label.textContent = this.formatHistoryRangeLabel(
            this.positionHistoryRangeHours,
          );
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (!this.selectedNodeId || !this.positionHistoryEnabled) {
            return;
          }
          this.loadNodeHistory(this.selectedNodeId);
        }, 100);
      };
      slider.addEventListener("input", slider._rangeSliderHandler);
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
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now()
          : Date.now();

      const nowMs = Date.now();
      const oldestMs = history[0]?.created_at
        ? new Date(history[0].created_at).getTime()
        : nowMs;
      const newestIndex = history.length - 1;

      // Phase 1 (synchronous): merge consecutive same-color segments into a few
      // multi-point polylines instead of N individual 1-segment polylines. With 3
      // age-color buckets this produces <=3 DOM elements regardless of history
      // length, making the path visible immediately without blocking the browser.
      let currentColor = null;
      let currentRun = [];
      const flushPolylineRun = () => {
        if (
          currentRun.length >= 2 &&
          this.selectedNodeHistoryRenderState.token === token
        ) {
          this.selectedNodeHistoryLayer.addLayer(
            L.polyline(currentRun, {
              color: currentColor,
              weight: 3,
              opacity: 0.7,
            }),
          );
        }
      };
      for (let i = 0; i < newestIndex; i++) {
        const p1 = history[i],
          p2 = history[i + 1];
        if (
          !p1 ||
          !p2 ||
          p1.latitude == null ||
          p2.latitude == null
        )
          continue;
        const color = this.getHistoryAgeColor(
          p1.created_at,
          nowMs,
          oldestMs,
        );
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
      const configuredMaxMarkers = Number(
        window.APP_CONFIG?.HISTORY_MAX_MARKERS,
      );
      const MAX_MARKERS = Number.isFinite(configuredMaxMarkers)
        ? Math.max(50, Math.min(Math.floor(configuredMaxMarkers), 5000))
        : 500;
      const markerHistory =
        history.length > MAX_MARKERS ? history.slice(-MAX_MARKERS) : history;
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
          const marker = this.createHistoryPointLayer(
            markerHistory[markerIndex],
          );
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

        this.selectedNodeHistoryRenderState.lastRenderedLength =
          this.selectedNodeHistory.length;
        this.selectedNodeHistoryRenderState.rendering = false;
        this.logHistoryPerf("render_complete", {
          token,
          batches: batchCount,
          points: renderedPoints,
          segments: newestIndex,
          durationMs:
            Math.round(
              ((typeof performance !== "undefined" &&
              typeof performance.now === "function"
                ? performance.now()
                : Date.now()) -
                startedAtMs) *
                100,
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
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now()
          : Date.now();

      const createdAt = position?.created_at
        ? position.created_at
        : new Date().toISOString();

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

      if (
        !this.positionHistoryEnabled ||
        !this.map ||
        !this.selectedNodeHistoryLayer
      ) {
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
      if (
        this.selectedNodeHistoryRenderState.lastRenderedLength !==
        expectedPreviousLength
      ) {
        this.logHistoryPerf("append_fallback_full_render", {
          nodeId,
          historyLength: history.length,
          expectedPreviousLength,
          lastRenderedLength:
            this.selectedNodeHistoryRenderState.lastRenderedLength,
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
      const cutoffMs =
        Date.now() - this.positionHistoryRangeHours * 3600 * 1000;
      if (
        prev.created_at &&
        new Date(prev.created_at).getTime() < cutoffMs
      ) {
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
        history[0]?.created_at
          ? new Date(history[0].created_at).getTime()
          : cutoffMs,
      );
      const latestSegment = this.createHistorySegmentLayer(
        prev,
        latest,
        nowMs,
        oldestMs,
      );
      if (latestSegment) {
        this.selectedNodeHistoryLayer.addLayer(latestSegment);
      }

      this.selectedNodeHistoryRenderState.lastRenderedLength = history.length;
      this.logHistoryPerf("append_incremental", {
        nodeId,
        historyLength: history.length,
        durationMs:
          Math.round(
            ((typeof performance !== "undefined" &&
            typeof performance.now === "function"
              ? performance.now()
              : Date.now()) -
              startedAtMs) *
              100,
          ) / 100,
      });
    },

    // Fetch telemetry summary for the sidebar
    async fetchTelemetrySummary(nodeId, sinceHours = null) {
      const hours = sinceHours !== null ? sinceHours : this.telemetryWindow;
      try {
        const response = await fetch(
          `/api/nodes/${encodeURIComponent(nodeId)}/telemetry/summary?since_hours=${hours}`,
        );
        if (!response.ok) {
          console.warn(
            `Failed to fetch telemetry summary for node ${nodeId}:`,
            response.status,
          );
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
        console.error(
          `Error fetching telemetry summary for node ${nodeId}:`,
          error,
        );
        if (this.selectedNodeId === nodeId) {
          this.updateTelemetryChartsErrorDisplay();
        }
      }
    },

    updateTelemetryChartsErrorDisplay() {
      const chartsContainer = document.getElementById("telemetry-charts");
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
      const toggle = document.querySelector(".telemetry-window-toggle");
      if (!toggle) return;

      // Remove existing listener if present
      const existingHandler = toggle._handleTelemetryToggle;
      if (existingHandler) {
        toggle.removeEventListener("change", existingHandler);
      }

      const handleTelemetryToggle = (e) => {
        const newWindow = e.target.checked ? 168 : 24;
        this.telemetryWindow = newWindow;

        // Refetch telemetry summary with new window
        this.fetchTelemetrySummary(nodeId, newWindow);
      };

      toggle._handleTelemetryToggle = handleTelemetryToggle;
      toggle.addEventListener("change", handleTelemetryToggle);
    },

    // Update the telemetry charts display in the sidebar
    updateTelemetryChartsDisplay(summary) {
      const chartsContainer = document.getElementById("telemetry-charts");
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
      const chartHtml = summary.metrics
        .slice(0, 20)
        .map(
          (metric, index) => `
        <div class="chart-container mb-4" data-metric-type="${metric.metric_type}" data-metric="${metric.metric}">
          <div class="chart-placeholder h-32 bg-gray-50 rounded border-2 border-dashed border-gray-200 flex items-center justify-center">
            <div class="text-center">
              <i class="mdi mdi-chart-line text-gray-400 text-xl mb-1"></i>
              <p class="text-sm text-gray-500">${metric.metric_type} - ${metric.metric}</p>
              <p class="text-xs text-gray-400">Loading chart...</p>
            </div>
          </div>
        </div>
      `,
        )
        .join("");

      chartsContainer.innerHTML = chartHtml;

      // Set up IntersectionObserver for lazy loading
      this.setupChartIntersectionObserver();
    },

    // Set up IntersectionObserver to load charts when they come into view
    setupChartIntersectionObserver() {
      const chartContainers = document.querySelectorAll(".chart-container");

      if (chartContainers.length === 0) return;

      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
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
        },
        {
          root: document.getElementById("telemetry-charts"),
          rootMargin: "50px",
          threshold: 0.1,
        },
      );

      chartContainers.forEach((container) => {
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
          console.log(
            `Chart fetch throttled for node ${initialNodeId}: ${metricType}/${metric} - waiting for slot (${this.chartFetchInFlight}/${this.chartFetchMaxConcurrent} in flight)`,
          );
        }

        while (this.chartFetchInFlight >= this.chartFetchMaxConcurrent) {
          await new Promise((resolve) =>
            this.chartFetchWaiters.push(resolve),
          );
        }

        const nodeId = this.selectedNodeId;
        if (!nodeId) return;

        this.chartFetchInFlight += 1;
        acquiredSlot = true;

        console.log(
          `Fetching chart data for node ${nodeId}: ${metricType}/${metric} (${this.telemetryWindow}h window)`,
        );
        const response = await fetch(
          `/api/nodes/${encodeURIComponent(nodeId)}/metrics/series?metric_type=${encodeURIComponent(metricType)}&metric=${encodeURIComponent(metric)}&since_hours=${this.telemetryWindow}&max_points=100`,
        );

        if (!response.ok) {
          console.warn(
            `Failed to load chart for node ${nodeId} (${metricType}/${metric}):`,
            response.status,
          );
          return;
        }

        const data = await response.json();

        const placeholder = container.querySelector(".chart-placeholder");
        if (!placeholder) return;

        this.renderMetricChart(placeholder, metricType, metric, data);
      } catch (error) {
        console.error(
          `Error loading chart for ${metricType}/${metric}:`,
          error,
        );
        const placeholder = container.querySelector(".chart-placeholder");
        if (placeholder) {
          placeholder.innerHTML = `
            <div class="text-center text-red-500 text-sm">
              Failed to load chart
            </div>
          `;
        }
      } finally {
        if (acquiredSlot) {
          this.chartFetchInFlight = Math.max(
            0,
            this.chartFetchInFlight - 1,
          );
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
        placeholder.classList.remove("h-32");
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
      const values = points.map((point) => point.value);
      const minValue = Math.min(...values);
      const maxValue = Math.max(...values);
      const range = Math.max(maxValue - minValue, 1);
      const startTs = points[0].ts;
      const endTs = points[points.length - 1].ts;
      const duration = Math.max(endTs - startTs, 1);

      const svgPoints = points
        .map((point) => {
          const x =
            plotLeft + ((point.ts - startTs) / duration) * plotWidth;
          const y =
            plotBottom -
            ((point.value - minValue) / range) * plotHeight;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");

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
        return d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
      };

      const midValue = (minValue + maxValue) / 2;
      const yTicks = [
        { value: maxValue, label: formatTickValue(maxValue) },
        { value: midValue, label: formatTickValue(midValue) },
        { value: minValue, label: formatTickValue(minValue) },
      ];

      const midTs = startTs + duration / 2;
      const xTicks = [
        {
          ts: startTs,
          label: formatTickTime(startTs),
          anchor: "start",
          x: plotLeft,
        },
        {
          ts: midTs,
          label: formatTickTime(midTs),
          anchor: "middle",
          x: width / 2,
        },
        {
          ts: endTs,
          label: formatTickTime(endTs),
          anchor: "end",
          x: plotRight,
        },
      ];

      const svgCircles = points
        .map((point) => {
          const x =
            plotLeft + ((point.ts - startTs) / duration) * plotWidth;
          const y =
            plotBottom -
            ((point.value - minValue) / range) * plotHeight;
          const ts = new Date(point.ts * 1000);
          const tsText = isNaN(ts.getTime())
            ? String(point.ts)
            : ts.toLocaleString();
          const valueText = Number.isFinite(point.value)
            ? point.value.toFixed(3)
            : String(point.value);
          return `
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="transparent" stroke="transparent" style="pointer-events: all;">
            <title>${tsText}\n${metricType} · ${metric}: ${valueText}</title>
          </circle>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#10b981" opacity="0.95" style="pointer-events: none;"></circle>
        `;
        })
        .join("");

      const minLabel = minValue.toFixed(2);
      const maxLabel = maxValue.toFixed(2);
      const lastLabel = points[points.length - 1].value.toFixed(2);
      const title = `${metricType} · ${metric}`;
      const gradientId = `metric-gradient-${metricType}-${metric}`.replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );

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
              ${yTicks
                .map((tick) => {
                  const y =
                    plotBottom -
                    ((tick.value - minValue) / range) * plotHeight;
                  return `
                  <line x1="${plotLeft.toFixed(1)}" y1="${y.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />
                  <text x="${(plotLeft - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#6b7280">${tick.label}</text>
                `;
                })
                .join("")}
              <polyline fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${svgPoints}" />
              <line x1="${plotLeft.toFixed(1)}" y1="${plotBottom.toFixed(1)}" x2="${plotRight.toFixed(1)}" y2="${plotBottom.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />
              ${xTicks
                .map((tick) => {
                  return `
                  <text x="${tick.x.toFixed(1)}" y="${(plotBottom + 14).toFixed(1)}" text-anchor="${tick.anchor}" font-size="9" fill="#6b7280">${tick.label}</text>
                `;
                })
                .join("")}
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
      placeholder.classList.remove(
        "h-32",
        "border-dashed",
        "border-gray-200",
        "bg-gray-50",
        "flex",
        "items-center",
        "justify-center",
      );
      placeholder.classList.add(
        "border-solid",
        "border-gray-200",
        "bg-white",
        "p-3",
      );
    },
  };
}
