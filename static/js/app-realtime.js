// Realtime / Socket.IO domain mixin.
// Handles socket lifecycle, WS indicator pulse, version events, and incoming event dispatch.

function realtimeMixin() {
  return {
    initializeEventsSocket() {
      const config = window.APP_CONFIG || {};
      const namespace = config.SOCKET_NAMESPACE_EVENTS || "/events";

      if (this.eventsSocket && this.eventsSocket.connected) {
        console.log("Events socket already connected");
        return;
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
      console.log("reloadNodes() called");
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
  };
}
