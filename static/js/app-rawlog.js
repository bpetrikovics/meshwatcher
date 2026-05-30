// Raw-log / packets-socket domain mixin.
// Handles the second Socket.IO connection (/packets namespace), the scrollable
// bottom panel raw-log display, and all related state mutations.

// ---------------------------------------------------------------------------
// Module-level pure helpers (no `this` dependency)
// ---------------------------------------------------------------------------

function toHex(n, digits) {
  if (n === null || n === undefined) return null;
  const num = +n;
  if (!num && num !== 0) return null;
  try {
    return (BigInt(num)).toString(16).padStart(digits, "0");
  } catch (e) {
    return null;
  }
}

function formatTimestamp(timeValue) {
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
}

function getNodeDisplayName(nodeObj) {
  return nodeObj?.name || nodeObj?.short_name || nodeObj?.long_name;
}

function formatNodeWithName(idText, nameText) {
  return nameText ? `${idText} (${nameText})` : idText;
}

// ---------------------------------------------------------------------------
// Mixin
// ---------------------------------------------------------------------------

function rawLogMixin() {
  return {
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

      const dataCell = document.createElement("div");
      dataCell.className = "raw-log-cell raw-log-data";
      const dataText = this.rawLogDecodePacketData(p);
      if (dataText) {
        dataCell.textContent = dataText;
        dataCell.title = dataText;
      }
      row.appendChild(dataCell);

      const dupCell = document.createElement("div");
      dupCell.className = "raw-log-cell raw-log-right";
      if (p?.is_duplicate === true) {
        const badge = document.createElement("span");
        badge.className = "raw-log-dup";
        badge.textContent = "dup";
        dupCell.appendChild(badge);
      }
      row.appendChild(dupCell);

      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        const body = document.getElementById("packet-detail-body");
        const dialog = document.getElementById("packet-detail-dialog");
        if (body && dialog) {
          body.textContent = JSON.stringify(p, null, 2);
          dialog.showModal();
        }
      });

      return row;
    },

    rawLogDecodePacketData(p) {
      const portnum = p?.decoded?.portnum;
      if (!portnum) return "";

      let payload = p?.decoded?.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch (e) { /* keep as string */ }
      }

      if (portnum === "TEXT_MESSAGE_APP") {
        if (typeof payload === "string") return payload;
        if (payload && typeof payload === "object" && payload.text) return payload.text;
        return "";
      }

      if (portnum === "NODEINFO_APP") {
        if (payload && typeof payload === "object") {
          return payload.longName || payload.long_name || payload.shortName || payload.short_name || "";
        }
        return "";
      }

      if (portnum === "POSITION_APP") {
        if (payload && typeof payload === "object") {
          const latI = payload.latitudeI ?? payload.latitude_i;
          const lonI = payload.longitudeI ?? payload.longitude_i;
          if (latI != null && lonI != null) {
            const lat = (latI / 1e7).toFixed(5);
            const lon = (lonI / 1e7).toFixed(5);
            let str = `${lat}, ${lon}`;
            const speed = payload.groundSpeed ?? payload.ground_speed;
            const track = payload.groundTrack ?? payload.ground_track;
            if (speed != null) str += ` ${speed}km/h`;
            if (track != null) str += ` ${(track / 1e5).toFixed(0)}°`;
            return str;
          }
        }
        return "";
      }

      if (portnum === "TELEMETRY_APP") {
        if (payload != null) return JSON.stringify(payload);
        return "";
      }

      if (portnum === "TRACEROUTE_APP") {
        const isResponse = !!(p?.decoded?.requestId);
        if (!isResponse) return "↑";

        const nodeHex = (n) => {
          if (n == null) return "N/A";
          if (n === 4294967295) return "N/A";
          try { return `!${(BigInt(n)).toString(16).padStart(8, "0")}`; } catch (e) { return "N/A"; }
        };

        const fromName = p?.from_node?.short_name || nodeHex(p?.from_);
        const toName   = p?.to_node?.short_name   || nodeHex(p?.to);

        const buildPath = (startName, middleIds, endName, snrs) => {
          const nodes = [startName, ...(middleIds || []).map(nodeHex), endName];
          let s = nodes[0];
          for (let i = 1; i < nodes.length; i++) {
            const raw = (snrs || [])[i - 1];
            const snrStr = (raw != null && raw !== -128) ? `${(raw / 4).toFixed(1)}dB` : "?";
            s += ` →${snrStr}→ ${nodes[i]}`;
          }
          return s;
        };

        const fwd  = buildPath(toName,   payload?.route,      fromName, payload?.snrTowards);
        const back = buildPath(fromName, payload?.routeBack,  toName,   payload?.snrBack);
        return `↓ ${fwd} | ↑ ${back}`;
      }

      return "";
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
  };
}
