// Map / Leaflet / marker domain mixin.
// Owns map lifecycle, clustering, marker creation/update/flash, and position rendering.
// Pure helpers (sanitizeHtml, getIconForRole, etc.) are called as standalone functions
// from app-helpers.js, not via `this`.

function mapMixin() {
  return {
    isNodeMoving(position) {
      if (!position) return false;

      const speedKmph = getGroundSpeedKmph(position);
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
        this.invalidateRoleCache();

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
      const role = sanitizeHtml(rawRole);
      const roleIcon = getIconForRole(role);
      const safeName = sanitizeHtml(node.long_name || node.id);
      const safeShortName = sanitizeHtml(node.short_name || "");
      const safeHwModel = sanitizeHtml(node.hw_model || "");
      const safeId = sanitizeHtml(node.id);
      const speedKmph = getGroundSpeedKmph(position);

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
                        <p><strong>Status:</strong> <span class="status-badge ${getStatusClass(info.status)}">${getStatusLabel(info.status)}</span></p>
                        ${info.last_seen_hours_ago !== null ? `<p><strong>Last packet:</strong> ${getTimeAgoText(info.last_seen_hours_ago)}</p>` : ""}
                        ${node.last_channel !== null ? `<p><strong>Last heard on:</strong> Channel ${node.last_channel} (${node.last_channel_name || "Unknown"})</p>` : ""}
                        ${position.latitude ? `<p><strong>Position:</strong> ${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}</p>` : ""}
                        ${position.position_age_hours_ago != null ? `<p><strong>Last position:</strong> ${getTimeAgoText(position.position_age_hours_ago)}</p>` : position.latitude ? "<p><strong>Last position:</strong> Unknown</p>" : ""}
                        ${position.altitude ? `<p><strong>Altitude:</strong> ${position.altitude}m</p>` : ""}
                        ${speedKmph !== null && speedKmph > 0 ? `<p><strong>Ground Speed:</strong> ${speedKmph.toFixed(1)} km/h</p>` : ""}
                        ${position.heading !== null && position.heading !== undefined && speedKmph !== null && speedKmph > 0 ? `<p><strong>Heading:</strong> ${position.heading.toFixed(1)}° (${getCompassDirection(position.heading)})</p>` : ""}
                        ${info.is_unmessagable ? "<p><em>Node is unmessagable</em></p>" : ""}
                    </div>
                </div>
            `;
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

    // Helper method to safely get current movement state from DOM
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
      const statusClass = getStatusClass(status);
      const timeAgo = getTimeAgoText(node.info?.last_seen_hours_ago);
      const role = sanitizeHtml(node.role || "Unknown");
      const roleIcon = getIconForRole(role);
      const safeName = sanitizeHtml(node.long_name || node.id);
      const safeStatusLabel = sanitizeHtml(getStatusLabel(status));

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
                                    <i class="mdi ${getIconForRole(role)}" style="font-size: 12px;"></i>
                                </div>
                                ${sanitizeHtml(role)}
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
  };
}
