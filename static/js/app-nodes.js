// Node data / list / navigation domain mixin.
// Owns API fetching, pagination, node list filtering, and fly-to behaviour.

function nodesMixin() {
  return {
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

        // Add nodes to map (batch for performance)
        this.addNodesToMapBatch(data.nodes);

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

      const addPositionless = (nodes) => {
        let added = false;
        nodes.forEach((node) => {
          if (!this.nodes[node.id]) {
            this.nodes[node.id] = node;
            added = true;
          }
        });
        if (added) this.invalidateRoleCache();
      };
      addPositionless(data.nodes);

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

        addPositionless(pageData.nodes);

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

        this.addNodesToMapBatch(data.nodes);

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

    async loadMoreNodes(offset) {
      try {
        this.loading.pagination = true;
        const url = this.buildApiUrl({ offset });
        const response = await fetch(url);
        const data = await response.json();

        this.addNodesToMapBatch(data.nodes);

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

    filteredNodes() {
      const query = (this.nodeSearchQuery || "").toLowerCase().trim();
      const roleFilters = this.nodeRoleFilters || {};

      const selectedRoleGroups = Object.entries(roleFilters)
        .filter(([, enabled]) => !!enabled)
        .map(([group]) => group);

      const roleGroupMap = {
        client: new Set(["CLIENT", "CLIENT_BASE", "CLIENT_MUTE"]),
        router: new Set(["ROUTER", "ROUTER_LATE", "REPEATER"]),
        tracker: new Set(["TRACKER", "TAK", "TAK_TRACKER"]),
        sensor: new Set(["SENSOR"]),
      };

      let result = Object.values(this.nodes);

      if (selectedRoleGroups.length) {
        result = result.filter((n) => {
          const role = String(n.role || "CLIENT");
          return selectedRoleGroups.some((group) =>
            roleGroupMap[group]?.has(role),
          );
        });
      }

      if (query) {
        result = result.filter(
          (n) =>
            (n.short_name || "").toLowerCase().includes(query) ||
            (n.long_name || "").toLowerCase().includes(query) ||
            String(n.id || "").toLowerCase().includes(query),
        );
      }
      return result.sort((a, b) => {
        const aKey = String(a.short_name || a.long_name || a.id || "");
        const bKey = String(b.short_name || b.long_name || b.id || "");

        const byName = aKey.localeCompare(bKey, undefined, { sensitivity: "base" });
        if (byName !== 0) return byName;

        return String(a.id || "").localeCompare(String(b.id || ""));
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
  };
}
